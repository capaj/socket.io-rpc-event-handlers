var logger = require('debug');
var traverse = require('traverse');
var noop = function(){};

/**
 * @param {Object} socket
 * @param {Object} tree
 * @param {String} clientOrServer
 */
module.exports = function(socket, tree, clientOrServer) {
	var debug = logger('socket.io-rpc:' + clientOrServer);
	/**
	 * for external use, simple function is used rather than an event emitter, because we lack event emitter in the browser
	 * @type {{batchStarts: Function, batchEnds: Function, call: Function, response: Function}}
	 */
	var eventHandlers = {
		batchStarts: noop,
		batchEnds: noop,
		call: noop,
		response: noop
	};
	var socketId;
	var deferreds = [];

	var invocationCounter = 0;
	var endCounter = 0;
	var remoteCallEnded = function(Id) {
		if (deferreds[Id]) {
			delete deferreds[Id];
			endCounter++;
			eventHandlers.response(endCounter);

			if (endCounter == invocationCounter) {
				eventHandlers.batchEnds(endCounter);
				invocationCounter = 0;
				endCounter = 0;
			}
		} else {
			//the client can maliciously try and resolve/reject something more than once. We should not throw an error on this, just warn
			console.error("Deferred Id " + Id + " was resolved/rejected more than once, this should not occur.");
		}
	};

	/**
	 * @param {String} fnPath
	 * @returns {Function} which will call the backend/client when executed
	 */
	function prepareRemoteCall(fnPath) {
		return function remoteCall() {
			var args = Array.prototype.slice.call(arguments, 0);
			return new Promise(function (resolve, reject){
				if (rpc.reconnecting) {
					reject(new Error('socket ' + socketId + ' disconnected, call rejected'));
				}
				invocationCounter++;
				debug('calling ', fnPath, 'on ', socketId, ', invocation counter ', invocationCounter);
				socket.emit('call',
					{Id: invocationCounter, fnPath: fnPath, args: args}
				);
				if (invocationCounter == 1) {
					eventHandlers.batchStarts(invocationCounter);
				}
				deferreds[invocationCounter] = {resolve: resolve, reject: reject};
			});
		};
	}
	var rpc = prepareRemoteCall;
	socket.rpc = rpc;
	socket.rpc.events = eventHandlers;
	var remoteNodes = {};

	/**
	 * @type {boolean} indicates when client is reconnecting
	 */
	rpc.reconnecting = false;

	if (clientOrServer === 'client') {
		rpc.initializedP = new Promise(function (resolve, reject){
			var assignAndResolveInitP = function() {
				socketId = socket.io.engine.id;
				resolve();
			};
			socket.on('connect', function() {
				assignAndResolveInitP();
				debug('connected socket ', socketId);
			}).on('connect_error', function(err) {
				if (!socketId) {
					reject(err);
				}
			}).on('reconnect', function() {
				if (!socketId) {
					assignAndResolveInitP();
				}
				debug('reconnected rpc socket', socketId);
				rpc.reconnecting = false;
			});
		});
	} else {
		socketId = socket.id;
	}

	socket.on('disconnect', function onDisconnect() {
		rpc.reconnecting = true;
	}).on('connect_error', function(err) {
		debug('connect error: ', err);
		for (var nodePath in remoteNodes) {
			remoteNodes[nodePath].reject(err)
		}
	}).on('call', function(data) {
		debug('invocation with ', data);
		if (!(data && typeof data.Id === 'number')) {
			return socket.emit('rpcError', {
				reason: 'Id is a required property for a call data payload'
			});
		}
		var emitRes = function(type, resData) {
			resData.Id = data.Id;
			socket.emit(type, resData)
		};
		try {
			var method = traverse(tree).get(data.fnPath.split('.'));
		} catch (err) {
			debug('error when resolving an invocation', err);
			return emitRes('reject', {reason: err.toJSON()});
		}
		if (method && method.apply) {	//we could also check if it is a function, but this might be bit faster
			var retVal;
			try {
				retVal = method.apply(socket, data.args);
			} catch (err) {
				//we explicitly print the error into the console, because uncaught errors should not occur
				console.error('RPC method invocation ' + data.fnPath + ' thrown an error : ', err);
				emitRes('reject', {reason: err.toJSON()});
				return;
			}

			Promise.resolve(retVal).then(function(asyncRetVal) {
				emitRes('resolve', {value: asyncRetVal});
			}, function(error) {
				if (error instanceof Error) {
					error = error.toJSON();
				}
				emitRes('reject', {reason: error});
			});

		} else {
			var msg = 'function is not exposed: ' + data.fnPath;
			debug(msg);
			emitRes('reject', {reason: new Error(msg).toJSON()});
		}
	}).on('fetchNode', function(path) {
		debug('fetchNode handler, path ', path);

		var methods = tree;
		if (path) {
			methods = traverse(tree).get(path.split('.'));
		} else {
			methods = tree;
		}

		if (!methods) {
			socket.emit('noSuchNode', path);
			debug('socket ', socketId ,' requested node ' + path + ' which was not found');
			return;
		}
		var localFnTree = traverse(methods).map(function(el) {
			if (this.isLeaf) {
				return null;
			} else {
				return el;
			}
		});

		socket.emit('node', {path: path, tree: localFnTree});
		debug('socket ', socketId, ' requested node "' + path + '" which was sent as: ', localFnTree);

	}).on('node', function(data) {
		if (remoteNodes[data.path]) {
			var remoteMethods = traverse(data.tree).map(function(el) {
				if (this.isLeaf) {
					debug('path', this.path);
					var path = this.path.join('.');
					if (data.path) {
						path = data.path + '.' + path;
					}

					this.update(prepareRemoteCall(path));
				}
			});
			var promise = remoteNodes[data.path];
			promise.resolve(remoteMethods);
		} else {
			console.warn('socket ' + socketId + ' sent a node ' + data.path + ' which was not requested, ignoring');
		}
	}).on('noSuchNode', function(path) {
		var dfd = remoteNodes[path];
		var err = new Error('Node is not defined on the socket ' + socketId);
		err.path = path;
		dfd.reject(err);
	}).on('resolve', function(data) {
		deferreds[data.Id].resolve(data.value);
		remoteCallEnded(data.Id);
	}).on('reject', function(data) {
		deferreds[data.Id].reject(data.reason);
		remoteCallEnded(data.Id);
	});

	/**
	 *
	 * @param path
	 * @returns {*}
	 */
	socket.rpc.fetchNode = function(path) {

		if (remoteNodes.hasOwnProperty(path)) {
			return remoteNodes[path].promise;
		} else {
			return Promise.resolve(rpc.initializedP).then(function() {
				var p = new Promise(function (resolve, reject){
					remoteNodes[path] = {resolve: resolve, reject: reject, promise: p};
					socket.emit('fetchNode', path);
				});

				return p;
			});
		}
	};

};
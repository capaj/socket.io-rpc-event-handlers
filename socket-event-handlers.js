var logger = require('debug')
var traverse = require('traverse')
var co = require('co')
var errToPOJO = require('./lib/err-serialization')
var noop = function () {}

function isGeneratorFunction (fn) {
  return typeof fn === 'function' &&
    fn.constructor &&
    fn.constructor.name === 'GeneratorFunction'
}
/**
 * @param {Object} socket
 * @param {Object} tree
 * @param {String} clientOrServer
 */
module.exports = function (socket, tree, clientOrServer) {
  var debug = logger('socket.io-rpc:' + clientOrServer)
  /**
   * for external use, simple function is used rather than an event emitter, because we lack event emitter in the browser
   * @type {{batchStarts: Function, batchEnds: Function, wasCalled: Function, calling: Function, response: Function}}
   */
  var eventHandlers = {
    batchStarts: noop,
    batchEnds: noop,
    calling: noop,
    wasCalled: noop,
    response: noop
  }
  var socketId
  var deferreds = []

  var invocationCounter = 0
  var endCounter = 0
  var remoteCallEnded = function (Id) {
    if (deferreds[Id]) {
      delete deferreds[Id]
      endCounter++
      eventHandlers.response(endCounter)

      if (endCounter === invocationCounter) {
        eventHandlers.batchEnds(endCounter)
        invocationCounter = 0
        endCounter = 0
      }
    } else {
      // the client can maliciously try and resolve/reject something more than once. We should not throw an error on this, just warn
      throw new Error('Deferred Id ' + Id + ' was resolved/rejected more than once, this should not occur')
    }
  }

  /**
   * @param {String} fnPath
   * @returns {Function} which will call the backend/client when executed
   */
  function prepareRemoteCall (fnPath, argumentLength) {
    function remoteCall () {
      var args = Array.prototype.slice.call(arguments, 0)
      return new Promise(function (resolve, reject) {
        if (rpc.reconnecting) {
          reject(new Error('socket ' + socketId + ' disconnected, call rejected'))
        }
        invocationCounter++
        debug('calling ', fnPath, 'on ', socketId, ', invocation counter ', invocationCounter)
        var callParams = {Id: invocationCounter, fnPath: fnPath, args: args}
        socket.emit('call', callParams)
        eventHandlers.calling(callParams)
        if (invocationCounter === 1) {
          eventHandlers.batchStarts(invocationCounter)
        }
        deferreds[invocationCounter] = {resolve: resolve, reject: reject}
      })
    }

    remoteCall.remoteLength = argumentLength

    return remoteCall
  }
  var rpc = prepareRemoteCall
  socket.rpc = rpc
  socket.rpc.events = eventHandlers

  /**
   * @type {boolean} indicates when client is reconnecting
   */
  rpc.reconnecting = false

  if (clientOrServer === 'client') {
    rpc.initializedP = new Promise(function (resolve, reject) {
      var assignAndResolveInitP = function () {
        socketId = socket.io.engine.id
        resolve()
      }
      socket.on('connect', function () {
        assignAndResolveInitP()
        debug('connected socket ', socketId)
      }).on('connect_error', function (err) {
        if (!socketId) {
          reject(err)
        }
      }).on('reconnect', function () {
        if (!socketId) {
          assignAndResolveInitP()
        }
        debug('reconnected rpc socket', socketId)
        rpc.reconnecting = false
      })
    })
  } else {
    socketId = socket.id
  }

  socket.on('disconnect', function onDisconnect () {
    rpc.reconnecting = true
  }).on('connect_error', function (err) {
    debug('connect error: ', err)
  }).on('call', function (data) {
    debug('invocation with ', data)
    if (!(data && typeof data.Id === 'number')) {
      return socket.emit('rpcError', {
        reason: 'Id is a required property for a call data payload'
      })
    }

    /**
     * @param {String} resType
     * @param {*} resData
     */
    var emitRes = function (resType, resData) {
      resData.Id = data.Id
      socket.emit(resType, resData)
      eventHandlers.wasCalled(data, resData)
    }

    try {
      var method = traverse(tree).get(data.fnPath.split('.'))
    } catch (err) {
      debug(err, ' when resolving an invocation')
      return emitRes('reject', errToPOJO(err))
    }
    if (method && method.apply) { // we could also check if it is a function, but this might be bit faster
      var retVal
      if (isGeneratorFunction(method)) {
        method = co.wrap(method)
      }
      try {
        retVal = method.apply(socket, data.args)
      } catch (err) {
        debug('RPC method invocation ' + data.fnPath + 'from ' + socket.id + ' thrown an error : ', err.stack)
        emitRes('reject', errToPOJO(err))
        return
      }
      Promise.resolve(retVal).then(function (asyncRetVal) {
        emitRes('resolve', {value: asyncRetVal})
      }, function (error) {
        emitRes('reject', errToPOJO(error))
      })
    } else {
      var msg = 'no function exposed on: ' + data.fnPath
      debug(msg)
      emitRes('reject', {error: {message: msg}})
    }
  }).on('fetchNode', function (path, resCB) {
    debug('fetchNode handler, path ', path)

    var methods = tree
    if (path) {
      methods = traverse(tree).get(path.split('.'))
    } else {
      methods = tree
    }

    if (!methods) {
      resCB({path: path})
      debug('socket ', socketId, ' requested node ' + path + ' which was not found')
      return
    }
    var localFnTree = traverse(methods).map(function (el) {
      if (this.isLeaf) {
        return el.length
      } else {
        return el
      }
    })
    resCB({path: path, tree: localFnTree})
    debug('socket ', socketId, ' requested node "' + path + '" which was sent as: ', localFnTree)
  }).on('resolve', function (data) {
    deferreds[data.Id].resolve(data.value)
    remoteCallEnded(data.Id)
  }).on('reject', function (data) {
    deferreds[data.Id].reject(data.error)
    remoteCallEnded(data.Id)
  })

  /**
   * @param {String} path
   * @returns {Promise}
   */
  socket.rpc.fetchNode = function (path) {
    return new Promise(function (resolve, reject) {
      debug('fetchNode ', path)
      socket.emit('fetchNode', path, function (data) {
        if (data.tree) {
          var remoteMethods = traverse(data.tree).map(function (el) {
            if (this.isLeaf) {
              debug('path', this.path)
              var path = this.path.join('.')
              if (data.path) {
                path = data.path + '.' + path
              }

              this.update(prepareRemoteCall(path, el))
            }
          })
          resolve(remoteMethods)
        } else {
          var err = new Error('Node is not defined on the socket ' + socketId)
          err.path = data.path
          reject(err)
        }
      })
    })
  }
}

'use strict'
/* eslint-env node, mocha */
const expect = require('chai').expect
const socketMock = {
  on: () => {
    return socketMock
  },
  emit: () => {}
}

describe('err-serialization', function () {
  it('should remove a stack for any errors in production', function () {
    const nodeenv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const errToPOJO = require('../lib//err-serialization')
    var name = require.resolve('../lib//err-serialization')
    delete require.cache[name]  // delete the module after

    var a = {
      pok: 1,
      ee: {
        stack: 10
      },
      stack: 'a'
    }
    expect(errToPOJO(a).error.stack).to.be.undefined
    expect(errToPOJO(a).error.ee.stack).to.be.undefined
    process.env.NODE_ENV = nodeenv
  })
})

describe('socket-event-handlers', function () {
  it('should add "rpc" function for remote invocation to the socket', function () {
    const evHandlers = require('../socket-event-handlers')
    evHandlers(socketMock, {}, 'server')
    expect(typeof socketMock.rpc).to.equal('function')
  })
})

describe('error handling', function () {
  it('should reject a promise with "rpc" attribute providing a fnPath and arguments with which the call was made', function (done) {
    done()
  })
})

describe('resilience', function () {
  // socket.io connection is treated as something reliable-if we're reconnecting, we're optimistic about reconnection in the near future, so it makes little sense to reject an RPC call like we had previous to version 1.1.5
  it('should not reject an RPC call if reconnecting', function (done) {
    const emits = []
    const socketMock = {
      on: () => {
        return socketMock
      },
      id: 'fakeSocketId',
      emit: (emitName, params) => {
        emits.push({emitName, params})
      }
    }
    const evHandlers = require('../socket-event-handlers')
    evHandlers(socketMock, {}, 'server')
    socketMock.rpc.reconnecting = true
    socketMock.rpc('anyPath')().then(() => {
      setTimeout(() => {
        throw new Error('Must not happen')
      })
    }, () => {
      setTimeout(() => {
        throw new Error('Must not happen')
      })
    })
    expect(emits[0].emitName).to.equal('call')
    setTimeout(done, 50)
  })
})

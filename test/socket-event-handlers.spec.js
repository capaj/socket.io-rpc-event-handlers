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

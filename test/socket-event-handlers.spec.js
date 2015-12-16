'use strict'
/* eslint-env node, mocha */
const evHandlers = require('../socket-event-handlers')
const expect = require('chai').expect
const socketMock = {
  on: () => {
    return socketMock
  },
  emit: () => {}
}

describe('socket-event-handlers', function () {
  it('should add "rpc" function for remote invocation to the socket', function () {
    evHandlers(socketMock, {}, 'server')
    expect(typeof socketMock.rpc).to.equal('function')
  })
})

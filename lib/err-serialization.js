var traverse = require('traverse')
var serializeError = require('serialize-error')

var errToPOJO
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
  errToPOJO = function (err) {
    traverse(err).forEach(function (x) {
      if (this.key === 'stack') this.remove()
    })
    return {error: serializeError(err)}
  }
} else {
  errToPOJO = function (err) {
    return {error: serializeError(err)}
  }
}

module.exports = errToPOJO

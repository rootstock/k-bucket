'use strict'

var crypto = require('crypto')
var KBucket = require('../')

function getNextId () {
  seed = crypto.createHash('sha256').update(seed).digest()
  return seed
}

var seed = process.env.SEED || crypto.randomBytes(32).toString('hex')
console.log('Seed: ' + seed)
getNextId()

console.time('KBucket.add')
for (var i = 0; i < 1e1; ++i) {
  var bucket = new KBucket()
  for (var j = 0; j < 1e4; ++j) bucket.add({ id: getNextId() })
}
console.timeEnd('KBucket.add')
console.log('Memory: ', process.memoryUsage())

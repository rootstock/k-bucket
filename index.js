"use strict";

require('buffertools');

var assert = require('assert'),
    constants = require('./lib/constants.js'),
    crypto = require('crypto'),
    events = require('events'),
    util = require('util');

var KBucket = module.exports = function KBucket (options) {
    var self = this;
    options = options || {};
    events.EventEmitter.call(self);

    // the bucket array has least-recently-contacted at the "front/left" side
    // and the most-recently-contaced at the "back/right" side
    self.bucket = [];
    self.localNodeId = options.localNodeId || crypto.createHash('sha1').digest();
    if (!(self.localNodeId instanceof Buffer)) {
        self.localNodeId = new Buffer(self.localNodeId);
    }

    // V8 hints
    self.dontSplit = null;
    self.low = null;
    self.high = null;
};

util.inherits(KBucket, events.EventEmitter);

// contact: *required* the contact object to add
// bitIndex: the bitIndex to which bit to check in the Buffer for navigating 
//           the binary tree
KBucket.prototype.add = function add (contact, bitIndex) {
    var self = this;

    // first check whether we are an inner node or a leaf (with bucket contents)
    if (!self.bucket) {
        // this is not a leaf node but an inner node with 'low' and 'high'
        // branches; we will check the appropriate bit of the identifier and
        // delegate to the appropriate node for further processing
        bitIndex = bitIndex || 0;

        if (self.determineBucket(contact.id, bitIndex++) < 0) {
            return self.low.add(contact, bitIndex);
        } else {
            return self.high.add(contact, bitIndex);
        }
    }

    // check if the contact already exists
    var index = self.indexOf(contact);
    if (index >= 0) {
        self.update(contact, index);
        return self;
    }

    if (self.bucket.length < constants.DEFAULT_NUMBER_OF_NODES_PER_K_BUCKET) {
        self.bucket.push(contact);
        return self;
    }

    // the bucket is full
    if (self.dontSplit) {
        // we are not allowed to split the bucket
        // we need to ping the first constants.DEFAULT_NUMBER_OF_NODES_TO_PING
        // in order to determine if they are alive
        // only if one of the pinged nodes does not respond, can the new contact
        // be added (this prevents DoS flodding with new invalid contacts)

        // TODO: figure out how to implement handing over PING to someone else
        //       while at the same time being able to delete an old node later
        //       asynchronously

        return self;
    }
    
    return self.splitAndAdd(contact, bitIndex);
};

// Determines whether the id at the bitIndex is 0 or 1. If 0, returns -1, else 1
// id: a Buffer to compare localNodeId with
// bitIndex: the bitIndex to which bit to check in the id Buffer
KBucket.prototype.determineBucket = function determineBucket (id, bitIndex) {
    var self = this;

    bitIndex = bitIndex || 0;

    // **NOTE** remember that id is a Buffer and has granularity of 
    // bytes (8 bits), whereas the bitIndex is the _bit_ index (not byte)

    // id's that are too short are put in low bucket (1 byte = 8 bits)
    // parseInt(bitIndex / 8) finds how many bytes the bitIndex describes
    // bitIndex % 8 checks if we have extra bits beyond byte multiples
    // if number of bytes is <= no. of bytes described by bitIndex and there
    // are extra bits to consider, this means id has less bits than what 
    // bitIndex describes, id therefore is too short, and will be put in low 
    // bucket
    var bytesDescribedByBitIndex = parseInt(bitIndex / 8);
    var bitIndexWithinByte = bitIndex % 8;
    if ((id.length <= bytesDescribedByBitIndex)
        && (bitIndexWithinByte != 0)) return -1; 

    var byteUnderConsideration = id[bytesDescribedByBitIndex];

    // byteUnderConsideration is an integer from 0 to 255 represented by 8 bits 
    // where 255 is 11111111 and 0 is 00000000
    // in order to find out whether the bit at bitIndexWithinByte is set 
    // we construct Math.pow(2, (7 - bitIndexWithinByte)) which will consist 
    // of all bits being 0, with only one bit set to 1
    // for example, if bitIndexWithinByte is 3, we will construct 00010000 by
    // Math.pow(2, (7 - 3)) -> Math.pow(2, 4) -> 16
    if (byteUnderConsideration & Math.pow(2, (7 - bitIndexWithinByte))) {
        return 1;
    }

    return -1;
};

// Returns the index of the contact if it exists
// **NOTE**: indexOf() does not compare vectorClock
KBucket.prototype.indexOf = function indexOf (contact) {
    var self = this;
    for (var i = 0; i < self.bucket.length; i++) {
        if (self.bucket[i].id.equals(contact.id)) return i;
    }
    return -1;
};

// Splits the bucket, redistributes contacts to the new buckets, and marks the
// bucket that was split as an inner node of the binary tree of buckets by
// setting self.bucket = undefined;
// contact: *required* the contact object to add
// bitIndex: the bitIndex to which byte to check in the Buffer for navigating the
//          binary tree
KBucket.prototype.splitAndAdd = function splitAndAdd (contact, bitIndex) {
    var self = this;
    self.low = new KBucket({localNodeId: self.localNodeId});
    self.high = new KBucket({localNodeId: self.localNodeId});

    bitIndex = bitIndex || 0;

    // redistribute existing contacts amongst the two newly created buckets
    self.bucket.forEach(function (storedContact) {
        if (self.determineBucket(storedContact.id, bitIndex) < 0) {
            self.low.add(storedContact);
        } else {
            self.high.add(storedContact);
        }
    });

    self.bucket = undefined; // mark as inner tree node

    // don't split the "far away" bucket
    // we check where the local node would end up and mark the other one as
    // "dontSplit" (i.e. "far away")
    if (self.determineBucket(self.localNodeId, bitIndex) < 0) {
        // local node belongs to "low" bucket, so mark the other one
        self.high.dontSplit = true;
    } else {
        self.low.dontSplit = true;
    }
    
    // add the contact being added
    self.add(contact, bitIndex);

    return self;
};

// Updates the contact by comparing vector clocks.
// If new contact vector clock is deprecated, contact is abandoned (not added).
// If new contact vector clock is the same, contact is marked as most recently
// contacted (by being moved to the right/end of the bucket array).
// If new contact vector clock is more recent, the old contact is removed and
// the new contact is marked as most recently contacted.
// contact: *required* the contact to update
// index: *required* the index in the bucket where contact exists
//        (index has already been computed in a previous calculation)
KBucket.prototype.update = function update (contact, index) {
    var self = this;
    // sanity check
    assert.ok(self.bucket[index].id.equals(contact.id), 
        "indexOf() calculation resulted in wrong index");
    if (self.bucket[index].vectorClock > contact.vectorClock) return;
    self.bucket.push(self.bucket.splice(index, 1)[0]);
    self.bucket[self.bucket.length - 1].vectorClock = contact.vectorClock;
};
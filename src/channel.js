'use strict';

// A deliberately unhelpful link. Bit errors, and occasional dropouts that eat a
// run of bytes so the receiver has to find the sync marker again.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Channel {
  constructor(opts) {
    opts = opts || {};
    this.rnd = mulberry32(opts.seed === undefined ? 20270701 : opts.seed);
    this.ber = opts.ber === undefined ? 0 : opts.ber;          // per bit error rate
    this.dropoutRate = opts.dropoutRate === undefined ? 0 : opts.dropoutRate;
    this.dropoutBytes = opts.dropoutBytes === undefined ? 37 : opts.dropoutBytes;
    this.stats = { bytesIn: 0, bytesOut: 0, bitsFlipped: 0, dropouts: 0 };
  }

  transmit(bytes) {
    const out = [];
    this.stats.bytesIn += bytes.length;
    for (let i = 0; i < bytes.length; i++) {
      if (this.dropoutRate > 0 && this.rnd() < this.dropoutRate) {
        this.stats.dropouts += 1;
        i += this.dropoutBytes; // swallow a run of bytes
        continue;
      }
      let b = bytes[i];
      if (this.ber > 0) {
        for (let bit = 0; bit < 8; bit++) {
          if (this.rnd() < this.ber) { b ^= (1 << bit); this.stats.bitsFlipped += 1; }
        }
      }
      out.push(b);
    }
    this.stats.bytesOut += out.length;
    return Uint8Array.from(out);
  }
}

module.exports = { Channel, mulberry32 };

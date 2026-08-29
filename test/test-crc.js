'use strict';

const { test, assert, assertEqual } = require('./harness');
const { crc16, crc16Bitwise } = require('../src/crc');

module.exports = function run(out) {
  test('the published check value for CRC-16/CCITT-FALSE comes out right', () => {
    const msg = Uint8Array.from('123456789'.split('').map(c => c.charCodeAt(0)));
    assertEqual(crc16(msg), 0x29b1, 'table driven');
    assertEqual(crc16Bitwise(msg), 0x29b1, 'bitwise reference');
  });

  test('the lookup table agrees with the bitwise version on random data', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rnd() * 200);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
      assertEqual(crc16(b), crc16Bitwise(b), 'trial ' + trial);
    }
  });

  test('any single bit flip changes the checksum', () => {
    const base = new Uint8Array(64);
    for (let i = 0; i < 64; i++) base[i] = (i * 7 + 3) & 0xff;
    const good = crc16(base);
    let missed = 0;
    for (let byte = 0; byte < 64; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const copy = base.slice();
        copy[byte] ^= 1 << bit;
        if (crc16(copy) === good) missed += 1;
      }
    }
    assertEqual(missed, 0, 'all 512 single bit flips detected');
    if (out) out.singleBitFlips = { checked: 512, missed: missed };
  });

  test('all double bit flips inside one frame are detected too', () => {
    const base = new Uint8Array(24);
    for (let i = 0; i < 24; i++) base[i] = (i * 31 + 11) & 0xff;
    const good = crc16(base);
    const bits = 24 * 8;
    let checked = 0, missed = 0;
    for (let a = 0; a < bits; a++) {
      for (let b = a + 1; b < bits; b++) {
        const copy = base.slice();
        copy[a >> 3] ^= 1 << (a & 7);
        copy[b >> 3] ^= 1 << (b & 7);
        checked += 1;
        if (crc16(copy) === good) missed += 1;
      }
    }
    assertEqual(missed, 0, 'no undetected double bit error in ' + checked + ' pairs');
    if (out) out.doubleBitFlips = { checked: checked, missed: missed };
  });
};

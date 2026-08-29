'use strict';

// CRC-16/CCITT-FALSE. Polynomial 0x1021, initial value 0xFFFF, no reflection,
// no final xor. This is the variant used by CCSDS transfer frames, and the
// standard check value for the string "123456789" is 0x29B1, which the tests
// assert against.

const POLY = 0x1021;

function buildTable() {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ POLY) : (crc << 1);
      crc &= 0xffff;
    }
    table[i] = crc;
  }
  return table;
}

const TABLE = buildTable();

function crc16(bytes, seed) {
  let crc = seed === undefined ? 0xffff : seed;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// Bitwise reference. Slower, and used by the tests to prove the table is right
// rather than merely self consistent.
function crc16Bitwise(bytes, seed) {
  let crc = seed === undefined ? 0xffff : seed;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    crc &= 0xffff;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ POLY) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

module.exports = { crc16, crc16Bitwise, TABLE, POLY };

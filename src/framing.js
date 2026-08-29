'use strict';

const { crc16 } = require('./crc');

// Fixed length transfer frames, in the shape CCSDS uses: an attached sync
// marker, a small primary header, a fixed data field, and a trailing checksum.
// Fixed length is the point. A receiver that has lost lock can search for the
// marker and then know exactly where every following frame begins.

const ASM = [0x1a, 0xcf, 0xfc, 0x1d];   // the standard attached sync marker
const HEADER_BYTES = 6;
const CRC_BYTES = 2;
const DEFAULT_DATA_BYTES = 110;

function frameLength(dataBytes) {
  return ASM.length + HEADER_BYTES + (dataBytes === undefined ? DEFAULT_DATA_BYTES : dataBytes) + CRC_BYTES;
}

// header: version(2b) scid(10b) vcid(3b) | frameCount(24b) | flags(8b)
function encodeFrame(opts) {
  const dataBytes = opts.dataBytes === undefined ? DEFAULT_DATA_BYTES : opts.dataBytes;
  const payload = opts.payload || new Uint8Array(dataBytes);
  if (payload.length > dataBytes) throw new Error('payload of ' + payload.length + ' exceeds data field of ' + dataBytes);

  const frame = new Uint8Array(frameLength(dataBytes));
  frame.set(ASM, 0);
  let i = ASM.length;

  const version = (opts.version || 0) & 0x03;
  const scid = (opts.scid || 0) & 0x3ff;
  const vcid = (opts.vcid || 0) & 0x07;
  const word = (version << 14) | (scid << 4) | (vcid << 1);
  frame[i++] = (word >> 8) & 0xff;
  frame[i++] = word & 0xff;

  const count = (opts.frameCount || 0) >>> 0;
  frame[i++] = (count >> 16) & 0xff;
  frame[i++] = (count >> 8) & 0xff;
  frame[i++] = count & 0xff;
  frame[i++] = (opts.flags || 0) & 0xff;

  frame.set(payload, i);
  i += dataBytes;

  // The checksum covers the header and data field, not the sync marker.
  const crc = crc16(frame.subarray(ASM.length, i));
  frame[i++] = (crc >> 8) & 0xff;
  frame[i++] = crc & 0xff;
  return frame;
}

function decodeFrame(bytes, dataBytes) {
  const dl = dataBytes === undefined ? DEFAULT_DATA_BYTES : dataBytes;
  if (bytes.length !== frameLength(dl)) return { ok: false, reason: 'length' };
  for (let k = 0; k < ASM.length; k++) if (bytes[k] !== ASM[k]) return { ok: false, reason: 'sync' };

  const body = bytes.subarray(ASM.length, bytes.length - CRC_BYTES);
  const want = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const got = crc16(body);
  if (want !== got) return { ok: false, reason: 'crc', expected: want, computed: got };

  const word = (body[0] << 8) | body[1];
  return {
    ok: true,
    version: (word >> 14) & 0x03,
    scid: (word >> 4) & 0x3ff,
    vcid: (word >> 1) & 0x07,
    frameCount: (body[2] << 16) | (body[3] << 8) | body[4],
    flags: body[5],
    payload: body.subarray(HEADER_BYTES),
  };
}

// Walk a byte stream looking for the sync marker, then take fixed length
// frames from there. Any garbage before the first marker is discarded, which is
// how a receiver reacquires lock after a dropout.
function* frameSync(stream, dataBytes) {
  const dl = dataBytes === undefined ? DEFAULT_DATA_BYTES : dataBytes;
  const len = frameLength(dl);
  let i = 0;
  while (i + len <= stream.length) {
    let synced = true;
    for (let k = 0; k < ASM.length; k++) if (stream[i + k] !== ASM[k]) { synced = false; break; }
    if (!synced) { i += 1; continue; }
    yield { offset: i, result: decodeFrame(stream.subarray(i, i + len), dl) };
    i += len;
  }
}

module.exports = { ASM, HEADER_BYTES, CRC_BYTES, DEFAULT_DATA_BYTES, frameLength, encodeFrame, decodeFrame, frameSync };

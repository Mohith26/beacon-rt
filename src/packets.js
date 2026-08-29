'use strict';

const { encodeFrame, decodeFrame, DEFAULT_DATA_BYTES } = require('./framing');

// Space packets are variable length and frames are not, so packets get chopped
// across frames and put back together on the ground. The segmentation flags in
// each fragment header are what make reassembly unambiguous.

const PACKET_HEADER_BYTES = 6;
const SEG_CONTINUE = 0x00;
const SEG_FIRST = 0x01;
const SEG_LAST = 0x02;
const SEG_WHOLE = 0x03;

function encodePacket(apid, seq, payload) {
  const out = new Uint8Array(PACKET_HEADER_BYTES + payload.length);
  const idWord = ((0 & 0x07) << 13) | ((0 & 0x01) << 12) | ((0 & 0x01) << 11) | (apid & 0x7ff);
  out[0] = (idWord >> 8) & 0xff;
  out[1] = idWord & 0xff;
  const seqWord = (0x03 << 14) | (seq & 0x3fff);
  out[2] = (seqWord >> 8) & 0xff;
  out[3] = seqWord & 0xff;
  const lenField = payload.length - 1; // CCSDS stores length minus one
  out[4] = (lenField >> 8) & 0xff;
  out[5] = lenField & 0xff;
  out.set(payload, PACKET_HEADER_BYTES);
  return out;
}

function decodePacket(bytes) {
  if (bytes.length < PACKET_HEADER_BYTES) return null;
  const apid = ((bytes[0] << 8) | bytes[1]) & 0x7ff;
  const seq = ((bytes[2] << 8) | bytes[3]) & 0x3fff;
  const len = ((bytes[4] << 8) | bytes[5]) + 1;
  if (bytes.length < PACKET_HEADER_BYTES + len) return null;
  return { apid: apid, seq: seq, payload: bytes.subarray(PACKET_HEADER_BYTES, PACKET_HEADER_BYTES + len) };
}

// Cut one packet into frame sized fragments. Each fragment gets one leading
// byte of segmentation flags inside the data field.
function segment(packet, dataBytes) {
  const dl = (dataBytes === undefined ? DEFAULT_DATA_BYTES : dataBytes) - 1;
  const parts = [];
  const total = Math.ceil(packet.length / dl) || 1;
  for (let n = 0; n < total; n++) {
    const chunk = packet.subarray(n * dl, Math.min(packet.length, (n + 1) * dl));
    let flag;
    if (total === 1) flag = SEG_WHOLE;
    else if (n === 0) flag = SEG_FIRST;
    else if (n === total - 1) flag = SEG_LAST;
    else flag = SEG_CONTINUE;
    const field = new Uint8Array(dl + 1);
    field[0] = flag;
    field.set(chunk, 1);
    parts.push({ flag: flag, field: field, used: chunk.length });
  }
  return parts;
}

class Reassembler {
  constructor() { this.buffer = []; this.open = false; this.dropped = 0; }

  // Returns a completed packet, or null if this fragment did not finish one.
  push(field, used) {
    const flag = field[0];
    const chunk = field.subarray(1, 1 + used);
    if (flag === SEG_WHOLE) { this.open = false; this.buffer = []; return chunk; }
    if (flag === SEG_FIRST) {
      if (this.open) this.dropped += 1;  // previous packet never completed
      this.open = true;
      this.buffer = [chunk];
      return null;
    }
    if (!this.open) { this.dropped += 1; return null; } // continuation with no start
    this.buffer.push(chunk);
    if (flag !== SEG_LAST) return null;
    let total = 0;
    for (const c of this.buffer) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.buffer) { out.set(c, at); at += c.length; }
    this.open = false;
    this.buffer = [];
    return out;
  }
}

module.exports = {
  PACKET_HEADER_BYTES, SEG_CONTINUE, SEG_FIRST, SEG_LAST, SEG_WHOLE,
  encodePacket, decodePacket, segment, Reassembler,
};

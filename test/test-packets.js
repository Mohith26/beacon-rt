'use strict';

const { test, assert, assertEqual } = require('./harness');
const { encodePacket, decodePacket, segment, Reassembler, SEG_FIRST, SEG_LAST, SEG_WHOLE } = require('../src/packets');
const { encodeFrame, decodeFrame, DEFAULT_DATA_BYTES } = require('../src/framing');

function body(n, seed) {
  const p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = (i * 17 + seed * 5 + 1) & 0xff;
  return p;
}

module.exports = function run(out) {
  test('a packet round trips through its own header', () => {
    for (const len of [1, 2, 50, 255, 900]) {
      const payload = body(len, len);
      const p = decodePacket(encodePacket(0x2ab, 1234, payload));
      assertEqual(p.apid, 0x2ab, 'apid at length ' + len);
      assertEqual(p.seq, 1234, 'sequence count at length ' + len);
      assertEqual(p.payload.length, len, 'length field survives at ' + len);
      for (let i = 0; i < len; i++) assertEqual(p.payload[i], payload[i], 'byte ' + i);
    }
  });

  test('a short packet becomes exactly one whole segment', () => {
    const parts = segment(encodePacket(1, 1, body(20, 3)), DEFAULT_DATA_BYTES);
    assertEqual(parts.length, 1);
    assertEqual(parts[0].flag, SEG_WHOLE);
  });

  test('a long packet is split and the flags mark the ends', () => {
    const parts = segment(encodePacket(1, 1, body(700, 4)), DEFAULT_DATA_BYTES);
    assert(parts.length > 3, 'more than three fragments, got ' + parts.length);
    assertEqual(parts[0].flag, SEG_FIRST, 'first fragment flagged');
    assertEqual(parts[parts.length - 1].flag, SEG_LAST, 'last fragment flagged');
  });

  test('packets survive segmentation, framing and reassembly byte for byte', () => {
    const asm = new Reassembler();
    let sent = 0, recovered = 0, bytes = 0;
    const originals = [];
    const parts = [];
    for (let n = 0; n < 60; n++) {
      const payload = body(1 + ((n * 91) % 900), n);
      originals.push(encodePacket(0x101 + (n % 7), n, payload));
      sent += 1;
    }
    for (const pkt of originals) for (const seg of segment(pkt, DEFAULT_DATA_BYTES)) parts.push(seg);

    let frameCount = 0;
    for (const seg of parts) {
      const f = encodeFrame({ frameCount: frameCount++, payload: seg.field });
      const d = decodeFrame(f);
      assert(d.ok, 'frame decodes');
      const out2 = asm.push(d.payload, seg.used);
      if (out2) {
        const expected = originals[recovered];
        assertEqual(out2.length, expected.length, 'packet ' + recovered + ' length');
        for (let i = 0; i < expected.length; i++) assertEqual(out2[i], expected[i], 'packet ' + recovered + ' byte ' + i);
        recovered += 1;
        bytes += out2.length;
      }
    }
    assertEqual(recovered, sent, 'every packet came back');
    assertEqual(asm.dropped, 0, 'no orphaned fragments');
    if (out) out.reassembly = { packets: sent, frames: parts.length, bytes: bytes, recovered: recovered, dropped: asm.dropped };
  });

  test('a lost first fragment is noticed instead of silently corrupting the next packet', () => {
    const asm = new Reassembler();
    const parts = segment(encodePacket(1, 1, body(700, 9)), DEFAULT_DATA_BYTES);
    // Skip the opening fragment on purpose.
    for (let i = 1; i < parts.length; i++) asm.push(parts[i].field, parts[i].used);
    assert(asm.dropped > 0, 'the reassembler flagged the orphaned continuation');
  });
};

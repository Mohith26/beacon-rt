'use strict';

const { test, assert, assertEqual } = require('./harness');
const { encodeFrame, decodeFrame, frameSync, frameLength, ASM, DEFAULT_DATA_BYTES } = require('../src/framing');
const { Channel } = require('../src/channel');

function payloadOf(n, seed) {
  const p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = (i * 37 + seed * 13) & 0xff;
  return p;
}

module.exports = function run(out) {
  test('a frame round trips with every header field intact', () => {
    for (let n = 0; n < 50; n++) {
      const payload = payloadOf(DEFAULT_DATA_BYTES, n);
      const f = encodeFrame({ scid: 0x2a3, vcid: n % 8, frameCount: n * 1234, flags: n & 0xff, payload: payload });
      assertEqual(f.length, frameLength(), 'fixed frame length');
      const d = decodeFrame(f);
      assert(d.ok, 'decodes cleanly at ' + n);
      assertEqual(d.scid, 0x2a3, 'spacecraft id');
      assertEqual(d.vcid, n % 8, 'virtual channel');
      assertEqual(d.frameCount, n * 1234, 'frame counter');
      assertEqual(d.flags, n & 0xff, 'flags');
      for (let i = 0; i < payload.length; i++) assertEqual(d.payload[i], payload[i], 'payload byte ' + i);
    }
  });

  test('a corrupted frame is rejected rather than delivered', () => {
    const f = encodeFrame({ scid: 5, frameCount: 9, payload: payloadOf(DEFAULT_DATA_BYTES, 1) });
    for (const idx of [4, 9, 40, 90, f.length - 3]) {
      const bad = f.slice();
      bad[idx] ^= 0x40;
      const d = decodeFrame(bad);
      assertEqual(d.ok, false, 'corruption at byte ' + idx + ' is caught');
      assertEqual(d.reason, 'crc', 'and it is the checksum that catches it');
    }
  });

  test('a broken sync marker is reported as a sync failure, not a checksum failure', () => {
    const f = encodeFrame({ payload: payloadOf(DEFAULT_DATA_BYTES, 2) });
    const bad = f.slice();
    bad[1] ^= 0xff;
    assertEqual(decodeFrame(bad).reason, 'sync');
  });

  test('a clean stream of frames is recovered in order', () => {
    const frames = [];
    for (let n = 0; n < 40; n++) frames.push(encodeFrame({ frameCount: n, payload: payloadOf(DEFAULT_DATA_BYTES, n) }));
    let total = 0;
    for (const f of frames) total += f.length;
    const stream = new Uint8Array(total);
    let at = 0;
    for (const f of frames) { stream.set(f, at); at += f.length; }

    let seen = 0;
    for (const { result } of frameSync(stream)) {
      assert(result.ok, 'frame ' + seen + ' decodes');
      assertEqual(result.frameCount, seen, 'frames arrive in order');
      seen += 1;
    }
    assertEqual(seen, 40, 'all 40 frames recovered');
  });

  test('the receiver reacquires sync after the link eats a run of bytes', () => {
    const frames = [];
    for (let n = 0; n < 60; n++) frames.push(encodeFrame({ frameCount: n, payload: payloadOf(DEFAULT_DATA_BYTES, n) }));
    let total = 0;
    for (const f of frames) total += f.length;
    const clean = new Uint8Array(total);
    let at = 0;
    for (const f of frames) { clean.set(f, at); at += f.length; }

    const channel = new Channel({ seed: 7, dropoutRate: 0.0006, dropoutBytes: 41 });
    const received = channel.transmit(clean);
    assert(channel.stats.dropouts > 0, 'the channel actually dropped something');

    let good = 0;
    const counts = [];
    for (const { result } of frameSync(received)) {
      if (result.ok) { good += 1; counts.push(result.frameCount); }
    }
    assert(good >= 40, 'most frames still arrive after ' + channel.stats.dropouts + ' dropouts, got ' + good);
    for (let i = 1; i < counts.length; i++) assert(counts[i] > counts[i - 1], 'recovered counters stay increasing');
    if (out) out.resync = { framesSent: 60, dropouts: channel.stats.dropouts, framesRecovered: good };
  });

  test('bit errors are caught, and the miss rate is measured rather than assumed', () => {
    let sent = 0, delivered = 0, rejected = 0, corruptedButAccepted = 0;
    const channel = new Channel({ seed: 11, ber: 1e-4 });
    for (let n = 0; n < 400; n++) {
      const payload = payloadOf(DEFAULT_DATA_BYTES, n);
      const f = encodeFrame({ frameCount: n, payload: payload });
      const got = channel.transmit(f);
      sent += 1;
      const d = decodeFrame(got);
      if (!d.ok) { rejected += 1; continue; }
      delivered += 1;
      let identical = true;
      for (let i = 0; i < payload.length; i++) if (d.payload[i] !== payload[i]) { identical = false; break; }
      if (!identical) corruptedButAccepted += 1;
    }
    assert(channel.stats.bitsFlipped > 0, 'the channel actually flipped bits, got ' + channel.stats.bitsFlipped);
    assert(rejected > 0, 'some frames were rejected');
    assertEqual(corruptedButAccepted, 0, 'no corrupted frame was accepted as good');
    if (out) out.bitErrors = { frames: sent, bitsFlipped: channel.stats.bitsFlipped, rejected: rejected, delivered: delivered, undetected: corruptedButAccepted };
  });
};

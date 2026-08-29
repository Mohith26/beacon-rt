'use strict';

const { test, assert, assertEqual } = require('./harness');
const { RadioDevice, RadioDriver, REG, STATUS_UNDERRUN, IRQ_UNDERRUN } = require('../src/radio');
const { encodeFrame, decodeFrame, frameLength, DEFAULT_DATA_BYTES } = require('../src/framing');

function payloadOf(n, seed) {
  const p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = (i + seed * 3) & 0xff;
  return p;
}

module.exports = function run(out) {
  test('the fifo level register tracks what was written', () => {
    const dev = new RadioDevice({ fifoDepth: 32 });
    assertEqual(dev.read(REG.FIFO_LEVEL), 0, 'starts empty');
    for (let i = 0; i < 10; i++) dev.write(REG.FIFO_DATA, i);
    assertEqual(dev.read(REG.FIFO_LEVEL), 10, 'ten bytes queued');
    dev.write(REG.CTRL, 1 | 2); // enable plus flush
    assertEqual(dev.read(REG.FIFO_LEVEL), 0, 'flush empties it');
  });

  test('a full fifo refuses the write instead of dropping the byte quietly', () => {
    const dev = new RadioDevice({ fifoDepth: 8 });
    for (let i = 0; i < 8; i++) assert(dev.write(REG.FIFO_DATA, i), 'write ' + i + ' accepted');
    assertEqual(dev.write(REG.FIFO_DATA, 99), false, 'the ninth write is refused');
    assertEqual(dev.read(REG.FIFO_LEVEL), 8, 'and nothing was added');
  });

  test('the driver never writes a partial frame into a nearly full fifo', () => {
    const dev = new RadioDevice({ fifoDepth: frameLength() + 10, bytesPerTick: 4 });
    const drv = new RadioDriver(dev);
    for (let n = 0; n < 20; n++) drv.submit(encodeFrame({ frameCount: n, payload: payloadOf(DEFAULT_DATA_BYTES, n) }));
    for (let tick = 0; tick < 2000; tick++) {
      drv.pump();
      dev.step();
      drv.serviceIrq();
      if (drv.stats.framesWritten === 20 && dev.fifo.length === 0) break;
    }
    assertEqual(drv.stats.framesWritten, 20, 'all frames written');
    assert(drv.stats.backpressureEvents > 0, 'and backpressure was genuinely hit, got ' + drv.stats.backpressureEvents);
    assertEqual(drv.stats.bytesWritten % frameLength(), 0, 'byte count is a whole number of frames');
    if (out) out.backpressure = { frames: 20, backpressureEvents: drv.stats.backpressureEvents, fifoDepth: dev.fifoDepth };
  });

  test('every byte the device sends reassembles into the frames that went in', () => {
    const dev = new RadioDevice({ fifoDepth: 4096, bytesPerTick: 64 });
    const drv = new RadioDriver(dev);
    const sent = [];
    for (let n = 0; n < 50; n++) {
      const f = encodeFrame({ frameCount: n, payload: payloadOf(DEFAULT_DATA_BYTES, n) });
      sent.push(f);
      drv.submit(f);
    }
    for (let tick = 0; tick < 5000; tick++) {
      drv.pump();
      dev.step();
      drv.serviceIrq();
      if (drv.stats.framesWritten === 50 && dev.fifo.length === 0) break;
    }
    const air = Uint8Array.from(dev.sent);
    assertEqual(air.length, 50 * frameLength(), 'the air carries exactly the frames written');
    for (let n = 0; n < 50; n++) {
      const slice = air.subarray(n * frameLength(), (n + 1) * frameLength());
      const d = decodeFrame(slice);
      assert(d.ok, 'frame ' + n + ' decodes off the air');
      assertEqual(d.frameCount, n, 'frame ' + n + ' arrives in order');
    }
    if (out) out.airRoundTrip = { frames: 50, bytes: air.length, registerReads: dev.reads, registerWrites: dev.writes };
  });

  test('starving the radio raises an underrun that the driver sees and clears', () => {
    const dev = new RadioDevice({ fifoDepth: 64, bytesPerTick: 8 });
    const drv = new RadioDriver(dev);
    for (let i = 0; i < 5; i++) { dev.step(); drv.serviceIrq(); }
    assert(dev.read(REG.STATUS) & STATUS_UNDERRUN, 'the status bit latched');
    assertEqual(drv.stats.underrunIrqs, 5, 'the driver saw one interrupt per starved tick');
    assertEqual(dev.read(REG.IRQ_FLAGS) & IRQ_UNDERRUN, 0, 'and cleared the flag by writing one to it');
  });
};

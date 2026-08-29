'use strict';

const { encodeFrame, decodeFrame, frameSync, frameLength, DEFAULT_DATA_BYTES } = require('../src/framing');
const { encodePacket, segment, Reassembler } = require('../src/packets');
const { Channel } = require('../src/channel');
const { Scheduler } = require('../src/scheduler');
const { analyse } = require('../src/rta');
const { RadioDevice, RadioDriver } = require('../src/radio');

function now() {
  if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) return Number(process.hrtime.bigint()) / 1e6;
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}
function timed(fn) { const t0 = now(); const v = fn(); return { ms: now() - t0, value: v }; }

function payloadOf(n, seed) {
  const p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = (i * 29 + seed) & 0xff;
  return p;
}

function run() {
  const out = { frameBytes: frameLength(), dataFieldBytes: DEFAULT_DATA_BYTES };

  const N = 20000;
  const payload = payloadOf(DEFAULT_DATA_BYTES, 7);
  const enc = timed(() => { const acc = []; for (let i = 0; i < N; i++) acc.push(encodeFrame({ frameCount: i, payload: payload })); return acc; });
  const frames = enc.value;
  const dec = timed(() => { let ok = 0; for (const f of frames) if (decodeFrame(f).ok) ok++; return ok; });
  out.framing = {
    frames: N,
    encode_ms: +enc.ms.toFixed(2),
    decode_ms: +dec.ms.toFixed(2),
    encodeFramesPerSec: Math.round(N / (enc.ms / 1000)),
    decodeFramesPerSec: Math.round(N / (dec.ms / 1000)),
    decodeMbitPerSec: +((N * frameLength() * 8) / (dec.ms / 1000) / 1e6).toFixed(2),
    decodedOk: dec.value,
  };

  // Undetected error rate. Every frame is corrupted, so anything that decodes
  // cleanly and still differs from what was sent is a checksum miss.
  const trials = 40000;
  const channel = new Channel({ seed: 99, ber: 3e-4 });
  let accepted = 0, rejected = 0, undetected = 0, flipped = 0;
  for (let i = 0; i < trials; i++) {
    const f = encodeFrame({ frameCount: i, payload: payload });
    const before = channel.stats.bitsFlipped;
    const got = channel.transmit(f);
    const bits = channel.stats.bitsFlipped - before;
    if (bits === 0) continue;              // this frame was not actually hit
    flipped += bits;
    const d = decodeFrame(got);
    if (!d.ok) { rejected += 1; continue; }
    accepted += 1;
    let same = true;
    for (let k = 0; k < payload.length; k++) if (d.payload[k] !== payload[k]) { same = false; break; }
    if (!same) undetected += 1;
  }
  out.errorDetection = {
    corruptedFrames: rejected + accepted,
    bitsFlipped: flipped,
    rejected: rejected,
    acceptedAfterCorruption: accepted,
    undetectedCorruptions: undetected,
  };

  // Packets through the whole stack.
  const asm = new Reassembler();
  const packets = [];
  for (let i = 0; i < 4000; i++) packets.push(encodePacket(0x120 + (i % 5), i, payloadOf(1 + ((i * 61) % 800), i)));
  const stack = timed(() => {
    let recovered = 0, framesUsed = 0;
    for (const pkt of packets) {
      for (const seg of segment(pkt, DEFAULT_DATA_BYTES)) {
        const f = encodeFrame({ frameCount: framesUsed++, payload: seg.field });
        const d = decodeFrame(f);
        if (asm.push(d.payload, seg.used)) recovered += 1;
      }
    }
    return { recovered: recovered, framesUsed: framesUsed };
  });
  out.packetStack = {
    packets: packets.length,
    frames: stack.value.framesUsed,
    recovered: stack.value.recovered,
    dropped: asm.dropped,
    ms: +stack.ms.toFixed(2),
    packetsPerSec: Math.round(packets.length / (stack.ms / 1000)),
  };

  // Scheduler.
  const set = [
    { name: 'rx_isr', period: 10, wcet: 2 },
    { name: 'framer', period: 25, wcet: 4 },
    { name: 'telemetry', period: 50, wcet: 8 },
    { name: 'housekeep', period: 200, wcet: 20 },
  ].sort((a, b) => a.period - b.period);
  const sched = timed(() => new Scheduler(set).run(200000));
  const a = analyse(set);
  out.scheduler = {
    ticks: 200000,
    ms: +sched.ms.toFixed(2),
    ticksPerSec: Math.round(200000 / (sched.ms / 1000)),
    contextSwitches: sched.value.contextSwitches,
    utilisation: sched.value.utilisation,
    tasks: sched.value.tasks.map(t => ({
      name: t.name,
      predicted: a.tasks.find(x => x.name === t.name).worstCaseResponse,
      measured: t.worstResponse,
      jitter: t.jitter,
      misses: t.misses,
    })),
  };

  // Driver through the register interface.
  const dev = new RadioDevice({ fifoDepth: 2048, bytesPerTick: 128 });
  const drv = new RadioDriver(dev);
  const M = 4000;
  for (let i = 0; i < M; i++) drv.submit(encodeFrame({ frameCount: i, payload: payload }));
  const drive = timed(() => {
    let ticks = 0;
    while (drv.stats.framesWritten < M || dev.fifo.length > 0) {
      drv.pump(); dev.step(); drv.serviceIrq(); ticks += 1;
      if (ticks > 2000000) break;
    }
    return ticks;
  });
  out.driver = {
    frames: M,
    ticks: drive.value,
    ms: +drive.ms.toFixed(2),
    framesPerSec: Math.round(M / (drive.ms / 1000)),
    backpressureEvents: drv.stats.backpressureEvents,
    registerAccesses: dev.reads + dev.writes,
    bytesOnAir: dev.sent.length,
  };

  return out;
}

module.exports = { run: run };
if (require.main === module) console.log(JSON.stringify(run(), null, 2));

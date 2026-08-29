'use strict';

// A memory mapped radio, modelled as a register block plus a driver that talks
// to it. There is no real hardware here, but the shape is the part that matters:
// the driver may only touch the device through reads and writes at fixed
// offsets, and it has to cope with a FIFO that fills up.

const REG = {
  CTRL: 0x00,
  STATUS: 0x04,
  FIFO_DATA: 0x08,
  FIFO_LEVEL: 0x0c,
  IRQ_FLAGS: 0x10,
  IRQ_ENABLE: 0x14,
  FRAMES_SENT: 0x18,
};

const CTRL_ENABLE = 1 << 0;
const CTRL_FLUSH = 1 << 1;
const STATUS_READY = 1 << 0;
const STATUS_FULL = 1 << 1;
const STATUS_UNDERRUN = 1 << 2;
const IRQ_TX_DONE = 1 << 0;
const IRQ_UNDERRUN = 1 << 1;

class RadioDevice {
  constructor(opts) {
    opts = opts || {};
    this.fifoDepth = opts.fifoDepth || 256;
    this.bytesPerTick = opts.bytesPerTick || 16;
    this.regs = new Uint32Array(64);
    this.fifo = [];
    this.sent = [];
    this.regs[REG.STATUS >> 2] = STATUS_READY;
    this.reads = 0;
    this.writes = 0;
  }

  read(offset) {
    this.reads += 1;
    if (offset === REG.FIFO_LEVEL) return this.fifo.length;
    return this.regs[offset >> 2];
  }

  write(offset, value) {
    this.writes += 1;
    if (offset === REG.FIFO_DATA) {
      if (this.fifo.length >= this.fifoDepth) {
        this.regs[REG.STATUS >> 2] |= STATUS_FULL;
        return false;                     // the driver is expected to notice
      }
      this.fifo.push(value & 0xff);
      if (this.fifo.length >= this.fifoDepth) this.regs[REG.STATUS >> 2] |= STATUS_FULL;
      return true;
    }
    if (offset === REG.CTRL && (value & CTRL_FLUSH)) {
      this.fifo.length = 0;
      this.regs[REG.STATUS >> 2] &= ~STATUS_FULL;
      value &= ~CTRL_FLUSH;
    }
    if (offset === REG.IRQ_FLAGS) {       // write one to clear
      this.regs[REG.IRQ_FLAGS >> 2] &= ~value;
      return true;
    }
    this.regs[offset >> 2] = value >>> 0;
    return true;
  }

  // One tick of the radio draining its FIFO onto the air.
  step() {
    if (!(this.regs[REG.CTRL >> 2] & CTRL_ENABLE)) return;
    if (this.fifo.length === 0) {
      this.regs[REG.STATUS >> 2] |= STATUS_UNDERRUN;
      this.regs[REG.IRQ_FLAGS >> 2] |= IRQ_UNDERRUN;
      return;
    }
    const n = Math.min(this.bytesPerTick, this.fifo.length);
    for (let i = 0; i < n; i++) this.sent.push(this.fifo.shift());
    this.regs[REG.FRAMES_SENT >> 2] += n;
    if (this.fifo.length < this.fifoDepth) this.regs[REG.STATUS >> 2] &= ~STATUS_FULL;
    this.regs[REG.IRQ_FLAGS >> 2] |= IRQ_TX_DONE;
  }
}

// Pushes frames into the device, respecting backpressure. A frame is either
// written whole or not at all, so a full FIFO can never cut one in half.
class RadioDriver {
  constructor(device) {
    this.dev = device;
    this.queue = [];
    this.stats = { framesQueued: 0, framesWritten: 0, bytesWritten: 0, backpressureEvents: 0, underrunIrqs: 0, txDoneIrqs: 0 };
    this.dev.write(REG.CTRL, CTRL_ENABLE);
    this.dev.write(REG.IRQ_ENABLE, IRQ_TX_DONE | IRQ_UNDERRUN);
  }

  submit(frame) { this.queue.push(frame); this.stats.framesQueued += 1; }

  serviceIrq() {
    const flags = this.dev.read(REG.IRQ_FLAGS);
    if (flags & IRQ_TX_DONE) this.stats.txDoneIrqs += 1;
    if (flags & IRQ_UNDERRUN) this.stats.underrunIrqs += 1;
    if (flags) this.dev.write(REG.IRQ_FLAGS, flags);   // write one to clear
    return flags;
  }

  pump() {
    while (this.queue.length) {
      const frame = this.queue[0];
      const free = this.dev.fifoDepth - this.dev.read(REG.FIFO_LEVEL);
      if (free < frame.length) { this.stats.backpressureEvents += 1; return false; }
      for (let i = 0; i < frame.length; i++) {
        if (!this.dev.write(REG.FIFO_DATA, frame[i])) throw new Error('fifo write refused mid frame');
      }
      this.stats.bytesWritten += frame.length;
      this.stats.framesWritten += 1;
      this.queue.shift();
    }
    return true;
  }
}

module.exports = { RadioDevice, RadioDriver, REG, CTRL_ENABLE, CTRL_FLUSH, STATUS_READY, STATUS_FULL, STATUS_UNDERRUN, IRQ_TX_DONE, IRQ_UNDERRUN };

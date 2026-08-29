# BeaconRT

A simulated telemetry downlink for a small spacecraft, plus the scheduler that
would have to run it. Two halves that only make sense together: the timing side
decides when the framer gets to run, and the link side decides what survives
getting there.

Everything is simulated. There is no hardware attached to this repo, and no
dependencies either. What is real is that the timing numbers are checked against
the analysis that predicts them, and the checksum is checked against the
published value rather than against itself.

## The link side

Frames are fixed length, in the shape CCSDS uses:

```
| ASM 1ACFFC1D | header 6B | data field 110B | CRC-16 2B |   = 122 bytes
```

Fixed length is the entire point. A receiver that has lost lock scans for the
sync marker, and once it finds one it knows exactly where every following frame
starts. `src/framing.js` has a generator that does precisely that, and the test
suite feeds it a stream that a channel model has chewed runs of bytes out of.
Sixty frames sent through two dropouts, fifty seven recovered, and the recovered
frame counters stay strictly increasing.

The checksum is CRC-16/CCITT-FALSE, the variant CCSDS uses. There are two
implementations, a table driven one and a bitwise one, and the tests check both
against the standard check value: the CRC of `123456789` is `0x29B1`. That
matters more than it sounds. A CRC that is only checked against itself will
happily be wrong in a way that is perfectly self consistent.

What the checksum actually caught, measured rather than assumed:

| Test | Cases | Undetected |
| --- | --- | --- |
| Every single bit flip in a 64 byte block | 512 | 0 |
| Every pair of bit flips in a 24 byte block | 18,336 | 0 |
| Corrupted frames off a noisy channel at BER 3e-4 | 10,244 | 0 |

That last row is the one I care about. Every frame in it was genuinely hit by
the channel model (11,874 bits flipped in total), every one was rejected, and
nothing corrupt was ever handed upwards as good.

Above the frames, space packets are variable length, so they get chopped across
frames and put back together on the ground using segmentation flags. Four
thousand packets became 16,950 frames and came back as four thousand packets,
byte for byte, with no orphaned fragments. There is also a test that deletes the
opening fragment of a packet on purpose, to confirm the reassembler notices
rather than silently gluing the remains onto whatever comes next.

## The timing side

`src/scheduler.js` is a fixed priority preemptive scheduler simulated one
integer tick at a time, so a run is completely deterministic. `src/rta.js` is
the analysis: the Liu and Layland utilisation bound, and exact response time
analysis by fixed point iteration.

Having both is the interesting part, because they are supposed to agree. On the
nominal task set the simulated worst case response landed exactly on the
predicted value for every task:

| Task | Period | WCET | Predicted | Measured | Jitter | Misses |
| --- | --- | --- | --- | --- | --- | --- |
| rx_isr | 10 | 2 | 2 | 2 | 0 | 0 |
| framer | 25 | 4 | 6 | 6 | 2 | 0 |
| telemetry | 50 | 8 | 16 | 16 | 0 | 0 |
| housekeep | 200 | 20 | 46 | 46 | 0 | 0 |

Utilisation 0.62 against a four task bound of 0.757. Twenty thousand ticks,
3,300 jobs, zero deadline misses. Add a fifth task that pushes utilisation to
1.17 and the analysis refuses the set and the simulation misses 79 deadlines,
which is the result I wanted: the two methods fail together, not separately.

### Priority inversion

The scheduler models a shared lock, because that is where fixed priority
systems actually go wrong. The classic setup is three tasks: a high priority one
that needs a lock, a low priority one holding it, and a medium priority one that
wants neither and is free to preempt the holder. The high priority task ends up
waiting on the medium priority task, which it outranks.

Measured on that exact set, worst case blocking on the high priority task:

```
plain lock                33 ticks
with priority inheritance  3 ticks
```

A 91 percent reduction, and the remaining 3 ticks is the holder finishing its
critical section, which is the bound you actually want.

## The driver

`src/radio.js` models a memory mapped radio: a register block with a control
register, a status register, a TX FIFO, and interrupt flags that clear on write
one. The driver may only touch it through reads and writes at fixed offsets.

The rule the driver has to respect is that a frame goes into the FIFO whole or
not at all, so a full FIFO can never leave half a frame on the air. The test
deliberately sizes the FIFO at barely more than one frame, hits backpressure 577
times pushing 20 frames through, and then checks that the total bytes written is
an exact multiple of the frame length.

Starving the radio raises an underrun. The test steps the device with an empty
FIFO five times and confirms the status bit latched, the driver counted five
interrupts, and writing one back to the flag register cleared it.

Fifty frames pushed through the register interface came off the air as 6,100
bytes that decoded back into fifty frames in order.

## Numbers

From `results/results.json`, regenerated by `node test/run-all.js`. Measured on
Apple Silicon arm64, single threaded.

| What | Result |
| --- | --- |
| Tests | 27 tests, 34,448 assertions, 0 failures |
| Frame decode | 2,754,378 frames/sec, 2,688 Mbit/sec |
| Frame encode | 1,104,731 frames/sec |
| Packet stack | 4,000 packets through 16,950 frames, 0 lost, 212,854 packets/sec |
| Undetected corruptions | 0 of 10,244 corrupted frames |
| Scheduler | 30.0M ticks/sec, 25,000 context switches over 200,000 ticks |
| Driver | 4,000 frames, 488,000 bytes on air, 503,425 register accesses |

The assertion count is high because the byte for byte comparisons in the packet
tests each count as one. Twenty eight thousand of the total come from that suite
alone.

## What this is not

It is not an RTOS. There is no stack switching, no real interrupt latency, and
tasks are described by a worst case execution time rather than actually
executing anything. The scheduler answers a timing question, and only that one.

It is not a real CCSDS stack either. There is no Reed Solomon, no randomiser, no
convolutional coding, and the frame header carries a subset of the real fields.
Adding forward error correction is the obvious next step, and it would change
the error detection table above quite a bit, because right now a corrupted frame
is simply thrown away.

## Running it

```
node test/run-all.js    # tests then benchmark, writes results/results.json
node bench/bench.js     # benchmark only
```

Node 18 or newer. No dependencies, no build step.

## Layout

```
src/crc.js         CRC-16/CCITT-FALSE, table driven plus a bitwise reference
src/framing.js     fixed length transfer frames and the sync search
src/packets.js     space packets, segmentation, reassembly
src/channel.js     bit errors and dropouts, seeded
src/scheduler.js   fixed priority preemptive simulation, locks, inheritance
src/rta.js         utilisation bound and exact response time analysis
src/radio.js       register model and the driver that talks to it
```

## License

MIT

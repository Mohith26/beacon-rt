'use strict';

const { test, assert, assertEqual } = require('./harness');
const { Scheduler } = require('../src/scheduler');
const { analyse, utilisation, utilisationBound } = require('../src/rta');

// Periods in ticks. Numbers chosen so the hyperperiod is small enough to
// simulate exhaustively.
const NOMINAL = [
  { name: 'rx_isr',    period: 10,  wcet: 2 },
  { name: 'framer',    period: 25,  wcet: 4 },
  { name: 'telemetry', period: 50,  wcet: 8 },
  { name: 'housekeep', period: 200, wcet: 20 },
];

module.exports = function run(out) {
  test('the analysis agrees with itself on a set that is clearly fine', () => {
    const a = analyse(NOMINAL);
    assert(a.schedulable, 'response time analysis says schedulable');
    assert(a.utilisation < 1, 'utilisation under one, got ' + a.utilisation);
    assertEqual(a.utilisationBound, +utilisationBound(4).toFixed(6), 'bound for four tasks');
    if (out) out.rta = a;
  });

  test('simulated worst case response never exceeds the analytical bound', () => {
    const sorted = NOMINAL.slice().sort((a, b) => a.period - b.period);
    const sim = new Scheduler(sorted).run(4000);
    const a = analyse(NOMINAL);
    for (const row of sim.tasks) {
      const predicted = a.tasks.find(t => t.name === row.name).worstCaseResponse;
      assert(row.worstResponse <= predicted,
        row.name + ' measured ' + row.worstResponse + ' must not exceed predicted ' + predicted);
    }
    if (out) {
      out.simulation = sim.tasks.map(t => ({
        name: t.name,
        predicted: a.tasks.find(x => x.name === t.name).worstCaseResponse,
        measured: t.worstResponse,
        jitter: t.jitter,
        misses: t.misses,
      }));
      out.simulationSummary = { ticks: sim.ticks, contextSwitches: sim.contextSwitches, utilisation: sim.utilisation };
    }
  });

  test('a schedulable set misses nothing across a long run', () => {
    const sorted = NOMINAL.slice().sort((a, b) => a.period - b.period);
    const sim = new Scheduler(sorted).run(20000);
    let misses = 0, completions = 0;
    for (const t of sim.tasks) { misses += t.misses; completions += t.completions; }
    assertEqual(misses, 0, 'zero deadline misses over ' + completions + ' jobs');
    if (out) out.longRun = { ticks: 20000, jobs: completions, misses: misses };
  });

  test('an overloaded set does miss, and the analysis predicts it', () => {
    const heavy = NOMINAL.concat([{ name: 'hog', period: 40, wcet: 22 }]);
    assert(utilisation(heavy) > 1, 'this set is genuinely overloaded');
    const a = analyse(heavy);
    assert(!a.schedulable, 'analysis refuses it');
    const sim = new Scheduler(heavy.slice().sort((x, y) => x.period - y.period)).run(4000);
    const totalMisses = sim.tasks.reduce((acc, t) => acc + t.misses, 0);
    assert(totalMisses > 0, 'and the simulation actually misses deadlines');
    if (out) out.overload = { utilisation: +utilisation(heavy).toFixed(4), misses: totalMisses };
  });

  test('the highest priority task is never delayed by a lower one', () => {
    const sorted = NOMINAL.slice().sort((a, b) => a.period - b.period);
    const sim = new Scheduler(sorted).run(4000);
    const top = sim.tasks[0];
    assertEqual(top.worstResponse, top.wcet, 'top priority runs as soon as it is released');
    assertEqual(top.jitter, 0, 'and with no response jitter');
  });

  test('priority inheritance bounds the blocking that a shared lock causes', () => {
    // Classic inversion: a high priority task needs a lock held by a low
    // priority one, while a medium priority task with no interest in the lock
    // is free to preempt the holder.
    const set = [
      { name: 'high',   period: 100, wcet: 6,  offset: 12, locks: { resource: 'radio', startAt: 1, holdFor: 3 } },
      { name: 'medium', period: 100, wcet: 30, offset: 14 },
      { name: 'low',    period: 100, wcet: 20, offset: 0,  locks: { resource: 'radio', startAt: 2, holdFor: 12 } },
    ];
    const plain = new Scheduler(set, { priorityInheritance: false }).run(1000);
    const inherit = new Scheduler(set, { priorityInheritance: true }).run(1000);
    const blockedPlain = plain.tasks.find(t => t.name === 'high').worstBlocking;
    const blockedInherit = inherit.tasks.find(t => t.name === 'high').worstBlocking;
    assert(blockedPlain > 0, 'the plain lock does block the high priority task');
    assert(blockedInherit < blockedPlain,
      'inheritance shortens the block from ' + blockedPlain + ' to ' + blockedInherit + ' ticks');
    if (out) out.priorityInversion = {
      blockedTicksWithoutInheritance: blockedPlain,
      blockedTicksWithInheritance: blockedInherit,
      reduction: +(1 - blockedInherit / blockedPlain).toFixed(4),
    };
  });

  test('the same task set produces the same schedule every run', () => {
    const sorted = NOMINAL.slice().sort((a, b) => a.period - b.period);
    const a = new Scheduler(sorted, { trace: true }).run(600);
    const b = new Scheduler(sorted, { trace: true }).run(600);
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'deterministic');
  });
};

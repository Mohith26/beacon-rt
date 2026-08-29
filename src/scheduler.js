'use strict';

// A fixed priority preemptive scheduler, simulated one tick at a time. Ticks
// are integers, so a run is fully deterministic and the measured response times
// can be compared against the analytical ones exactly.
//
// Priority is by index: task 0 is the highest. The caller is expected to sort
// by period first if it wants rate monotonic ordering.

class Task {
  constructor(spec, priority) {
    this.name = spec.name;
    this.period = spec.period;
    this.wcet = spec.wcet;
    this.deadline = spec.deadline === undefined ? spec.period : spec.deadline;
    this.offset = spec.offset || 0;
    this.priority = priority;
    this.locks = spec.locks || null;      // { resource, startAt, holdFor }
    this.reset();
  }
  reset() {
    this.remaining = 0;
    this.releasedAt = -1;
    this.executed = 0;
    this.releases = 0;
    this.completions = 0;
    this.misses = 0;
    this.worstResponse = 0;
    this.responses = [];
    this.blockedFor = 0;
    this.holding = null;
    this.worstBlocking = 0;
  }
  get ready() { return this.remaining > 0; }
}

class Scheduler {
  constructor(specs, opts) {
    opts = opts || {};
    this.tasks = specs.map((s, i) => new Task(s, i));
    this.priorityInheritance = !!opts.priorityInheritance;
    this.resources = new Map();
    this.tick = 0;
    this.contextSwitches = 0;
    this.idleTicks = 0;
    this.current = null;
    this.log = [];
    this.trace = !!opts.trace;
  }

  _effectivePriority(task) {
    // Under inheritance a lock holder runs at the priority of the highest
    // priority task waiting on that lock.
    if (!this.priorityInheritance || !task.holding) return task.priority;
    let best = task.priority;
    for (const other of this.tasks) {
      if (other === task || !other.ready) continue;
      if (other.locks && other.locks.resource === task.holding && other.priority < best) best = other.priority;
    }
    return best;
  }

  _pick() {
    let chosen = null;
    let bestPriority = Infinity;
    for (const t of this.tasks) {
      if (!t.ready) continue;
      // A task that wants a held lock cannot run.
      if (t.locks && this._wantsLockNow(t)) {
        const holder = this.resources.get(t.locks.resource);
        if (holder && holder !== t) { t.blockedFor += 1; t.worstBlocking = Math.max(t.worstBlocking, t.blockedFor); continue; }
      }
      const p = this._effectivePriority(t);
      if (p < bestPriority) { bestPriority = p; chosen = t; }
    }
    return chosen;
  }

  _wantsLockNow(t) {
    const done = t.wcet - t.remaining;
    return done >= t.locks.startAt && done < t.locks.startAt + t.locks.holdFor;
  }

  run(ticks) {
    for (this.tick = 0; this.tick < ticks; this.tick++) {
      for (const t of this.tasks) {
        if (this.tick < t.offset) continue;
        if ((this.tick - t.offset) % t.period !== 0) continue;
        if (t.remaining > 0) t.misses += 1; // still busy when the next job arrived
        t.remaining = t.wcet;
        t.releasedAt = this.tick;
        t.releases += 1;
        t.blockedFor = 0;
      }

      const next = this._pick();
      if (next !== this.current) {
        if (next !== null && this.current !== null) this.contextSwitches += 1;
        this.current = next;
      }
      if (this.trace) this.log.push(next ? next.name : null);

      if (!next) { this.idleTicks += 1; continue; }

      if (next.locks) {
        const holder = this.resources.get(next.locks.resource);
        if (this._wantsLockNow(next)) {
          if (!holder) { this.resources.set(next.locks.resource, next); next.holding = next.locks.resource; }
        } else if (holder === next) {
          this.resources.delete(next.locks.resource);
          next.holding = null;
        }
      }

      next.remaining -= 1;
      next.executed += 1;

      if (next.remaining === 0) {
        if (next.holding) { this.resources.delete(next.holding); next.holding = null; }
        const response = this.tick + 1 - next.releasedAt;
        next.responses.push(response);
        next.completions += 1;
        if (response > next.worstResponse) next.worstResponse = response;
        if (response > next.deadline) next.misses += 1;
      }
    }
    return this.report();
  }

  report() {
    return {
      ticks: this.tick,
      contextSwitches: this.contextSwitches,
      idleTicks: this.idleTicks,
      utilisation: +(1 - this.idleTicks / this.tick).toFixed(6),
      tasks: this.tasks.map(t => ({
        name: t.name,
        period: t.period,
        wcet: t.wcet,
        deadline: t.deadline,
        releases: t.releases,
        completions: t.completions,
        misses: t.misses,
        worstResponse: t.worstResponse,
        jitter: t.responses.length ? Math.max.apply(null, t.responses) - Math.min.apply(null, t.responses) : 0,
        worstBlocking: t.worstBlocking,
      })),
    };
  }
}

module.exports = { Scheduler, Task };

'use strict';

// Rate monotonic analysis. Two independent checks on the same task set: the
// Liu and Layland utilisation bound, which is sufficient but pessimistic, and
// exact response time analysis, which is the one worth trusting.

function utilisation(tasks) {
  return tasks.reduce((acc, t) => acc + t.wcet / t.period, 0);
}

// n * (2^(1/n) - 1). Passing this guarantees schedulability under rate
// monotonic priorities. Failing it proves nothing.
function utilisationBound(n) {
  return n * (Math.pow(2, 1 / n) - 1);
}

// Fixed point iteration on R = C + sum over higher priority of ceil(R/T)*C.
// Tasks must be supplied highest priority first.
function responseTime(tasks, index) {
  const self = tasks[index];
  let r = self.wcet;
  for (let guard = 0; guard < 10000; guard++) {
    let next = self.wcet;
    for (let j = 0; j < index; j++) {
      next += Math.ceil(r / tasks[j].period) * tasks[j].wcet;
    }
    if (next === r) return { response: r, converged: true };
    if (next > (self.deadline === undefined ? self.period : self.deadline)) {
      return { response: next, converged: false }; // provably misses its deadline
    }
    r = next;
  }
  return { response: r, converged: false };
}

function analyse(tasks) {
  const sorted = tasks.slice().sort((a, b) => a.period - b.period); // rate monotonic
  const rows = sorted.map((t, i) => {
    const rt = responseTime(sorted, i);
    const deadline = t.deadline === undefined ? t.period : t.deadline;
    return {
      name: t.name,
      period: t.period,
      wcet: t.wcet,
      deadline: deadline,
      worstCaseResponse: rt.response,
      schedulable: rt.converged && rt.response <= deadline,
    };
  });
  const u = utilisation(sorted);
  return {
    tasks: rows,
    utilisation: +u.toFixed(6),
    utilisationBound: +utilisationBound(sorted.length).toFixed(6),
    passesUtilisationBound: u <= utilisationBound(sorted.length),
    schedulable: rows.every(r => r.schedulable),
  };
}

module.exports = { analyse, responseTime, utilisation, utilisationBound };

'use strict';

const state = { asserts: 0, tests: 0, failures: [] };

function assert(cond, message) {
  state.asserts += 1;
  if (!cond) throw new Error('assertion failed: ' + (message || ''));
}

function assertEqual(actual, expected, message) {
  state.asserts += 1;
  if (actual !== expected) {
    throw new Error('assertion failed: ' + (message || '') + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
  }
}

function assertClose(actual, expected, tol, message) {
  state.asserts += 1;
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error('assertion failed: ' + (message || '') + ' (expected ' + expected + ' +/- ' + tol + ', got ' + actual + ')');
  }
}

function assertThrows(fn, message) {
  state.asserts += 1;
  try { fn(); } catch (err) { return err; }
  throw new Error('assertion failed: expected a throw. ' + (message || ''));
}

function test(name, fn) {
  state.tests += 1;
  try { fn(); } catch (err) { state.failures.push({ name: name, error: err.message }); }
}

function report() { return { tests: state.tests, asserts: state.asserts, failures: state.failures.slice() }; }
function reset() { state.asserts = 0; state.tests = 0; state.failures = []; }

module.exports = { assert, assertEqual, assertClose, assertThrows, test, report, reset, state };

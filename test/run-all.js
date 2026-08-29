'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('./harness');

const suites = [
  ['crc', require('./test-crc')],
  ['framing', require('./test-framing')],
  ['packets', require('./test-packets')],
  ['scheduler', require('./test-scheduler')],
  ['radio', require('./test-radio')],
];

function main() {
  harness.reset();
  const evidence = {};
  const perSuite = [];
  let lastTests = 0, lastAsserts = 0;
  for (const [name, fn] of suites) {
    fn(evidence);
    perSuite.push({ suite: name, tests: harness.state.tests - lastTests, asserts: harness.state.asserts - lastAsserts });
    lastTests = harness.state.tests;
    lastAsserts = harness.state.asserts;
  }
  const rep = harness.report();
  const bench = require('../bench/bench').run();
  const results = {
    generatedAt: new Date().toISOString(),
    tests: { total: rep.tests, asserts: rep.asserts, failures: rep.failures },
    perSuite: perSuite,
    evidence: evidence,
    bench: bench,
  };
  const dir = path.join(__dirname, '..', 'results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
  for (const f of rep.failures) console.log('FAIL ' + f.name + ': ' + f.error);
  console.log(rep.failures.length === 0 ? 'PASS' : 'FAIL');
  console.log(rep.tests + ' tests, ' + rep.asserts + ' assertions, ' + rep.failures.length + ' failures');
  return rep.failures.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { main: main };

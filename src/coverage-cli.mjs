import fs from 'node:fs';
import path from 'node:path';
import { writeRunCoverage } from './coverage.mjs';
import { compileScenarios } from './scenario.mjs';

const found = process.argv.find((item) => item.startsWith('--run-id='));
const detailArg = process.argv.find((item) => item.startsWith('--markdown-detail='));
const markdownDetail = detailArg ? detailArg.slice('--markdown-detail='.length) : 'summary';
const runId = found ? found.slice('--run-id='.length) : '';
if (!/^[a-zA-Z0-9-]{1,40}$/.test(runId)) {
  console.error('Use --run-id=<id>');
  process.exit(1);
}
const directory = path.resolve('runs', runId);
const summaryFile = path.join(directory, 'summary.json');
if (!fs.existsSync(summaryFile)) {
  console.error('No summary.json for run ' + runId);
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
const count = Number(summary.count ?? 1);
const scenario = Number.isInteger(count) && count >= 1 ? compileScenarios(summary.seed, count).scenarios[0] : null;
const doc = await writeRunCoverage({ directory, summary, scenario, proofs: [], markdownDetail });
const slices = Object.fromEntries(Object.entries(doc.slices).map(([id, slice]) => [id, {
  status: slice.status,
  planned: slice.planned ?? 0,
  executed: slice.executed ?? 0,
  proved: slice.proved ?? 0,
  byVerdict: slice.byVerdict ?? {},
}]));
console.log(JSON.stringify({
  runId: doc.run.runId,
  seed: doc.run.seed,
  pass: doc.run.pass,
  aggregates: doc.aggregates,
  slices,
  journal: { lines: doc.journal.lines, missing: doc.journal.missing, truncated: doc.journal.truncated, unknown: doc.journal.unknownEvents?.length ?? 0 },
}, null, 2));

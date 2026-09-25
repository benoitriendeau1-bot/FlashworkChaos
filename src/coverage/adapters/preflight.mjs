import { callsOf } from '../journal.mjs';
import { coverageRecord, finish, reportedSlice } from '../shared.mjs';

function action(id, label, category) {
  return { id, label, kind: 'preflight', category, http: [200], accept: true };
}

function record(ctx, planned, judged, call) {
  return coverageRecord({
    slice: 'preflight',
    action: planned,
    judged,
    observed: {
      executed: judged.executed,
      status: call?.status ?? null,
      method: call?.method ?? null,
      route: call?.route ?? null,
      body: call?.body ?? null,
      errorText: call?.errorText ?? null,
      seqs: call?.seq == null ? [] : [call.seq],
    },
    summary: ctx.summary,
    scenarioId: 'preflight:' + planned.id,
  });
}

export function preflightSlice(ctx) {
  const journal = ctx.journal;
  const summary = ctx.summary ?? {};
  const health = callsOf(journal, 'setup', 'health').concat(callsOf(journal, 'preflight', 'health'));
  const catalog = callsOf(journal, 'setup', 'list sign-off requirements');
  const bootstrap = callsOf(journal, 'bootstrap', 'bootstrap sign-off reason');
  const users = [
    ['signatures', 'list users'],
    ['lifecycle', 'list lifecycle users'],
    ['andon', 'list andon users'],
    ['ncr', 'list ncr users'],
    ['variance', 'list variance users'],
    ['run', 'list run users'],
    ['service-visit', 'list visit users'],
  ].flatMap(([phase, label]) => callsOf(journal, phase, label));
  const rows = [];

  const healthAction = action('health', 'BE health', 'health');
  if (!health.length) {
    rows.push(record(ctx, healthAction, finish('not_executed', { message: 'health was not journaled' }), null));
  } else if (health[0].status >= 500 || health[0].status === 0) {
    rows.push(record(ctx, healthAction, finish('unhandled', { executed: true, findingSeverity: 'high', message: 'HTTP ' + health[0].status }), health[0]));
  } else if (health[0].status === 200) {
    rows.push(record(ctx, healthAction, finish('pass', { executed: true, proved: true }), health[0]));
  } else {
    rows.push(record(ctx, healthAction, finish('not_proved', { executed: true, message: 'health response was not 200' }), health[0]));
  }

  const client = action('client', 'client', 'identity');
  rows.push(record(ctx, client, finish('not_executed', { message: 'client id is not a journaled action' }), null));
  const user = action('user', 'user', 'identity');
  rows.push(record(ctx, user, finish('not_executed', { message: 'user id is not a journaled action' }), null));

  const actor = action('second-actor', 'list users', 'actor');
  if (!users.length) {
    rows.push(record(ctx, actor, finish('not_executed', { message: 'second actor was not probed' }), null));
  } else if (users[0].status === 200 && users[0].count != null && users[0].count >= 2) {
    rows.push(record(ctx, actor, finish('pass', { executed: true, proved: true }), users[0]));
  } else if (users[0].status === 200) {
    rows.push(record(ctx, actor, finish('not_proved', { executed: true, message: 'user list did not prove a second actor' }), users[0]));
  } else {
    rows.push(record(ctx, actor, finish('not_proved', { executed: true, message: 'user list was not reread' }), users[0]));
  }

  const requirements = action('sign-off-requirements', 'list sign-off requirements', 'sign-off');
  if (!catalog.length) {
    rows.push(record(ctx, requirements, finish('not_executed', { message: 'sign-off catalog was not read' }), null));
  } else if (catalog[0].count === 0) {
    rows.push(record(ctx, requirements, finish('harness_error', {
      executed: true, message: 'sign-off catalog was empty; environment gap, not an HTTP 500',
    }), catalog[0]));
  } else if (catalog[0].status === 200 && catalog[0].count > 0) {
    rows.push(record(ctx, requirements, finish('pass', { executed: true, proved: true }), catalog[0]));
  } else if (catalog[0].status >= 500 || catalog[0].status === 0) {
    rows.push(record(ctx, requirements, finish('unhandled', { executed: true, findingSeverity: 'high', message: 'HTTP ' + catalog[0].status }), catalog[0]));
  } else {
    rows.push(record(ctx, requirements, finish('not_proved', { executed: true, message: 'sign-off catalog response was not proved' }), catalog[0]));
  }

  const reasons = action('sign-off-reasons', 'bootstrap sign-off reason', 'sign-off');
  const failed = bootstrap.find((call) => call.status === 0 || call.status >= 500);
  const ok = bootstrap.find((call) => call.status >= 200 && call.status < 300);
  if (failed) {
    rows.push(record(ctx, reasons, finish('unhandled', { executed: true, findingSeverity: 'high', message: failed.errorText ?? 'HTTP ' + failed.status }), failed));
  } else if (ok && ok.content) {
    rows.push(record(ctx, reasons, finish('pass', { executed: true, proved: true }), ok));
  } else if (ok) {
    rows.push(record(ctx, reasons, finish('not_proved', { executed: true, message: 'sign-off reason response was not retained' }), ok));
  } else if (!summary.signOffReasons && summary.setupPass === false) {
    rows.push(record(ctx, reasons, finish('harness_error', {
      executed: false,
      message: 'Skip/Reopen reasons were not established; environment gap, not an HTTP 500',
    }), null));
  } else if (!summary.signOffReasons) {
    rows.push(record(ctx, reasons, finish('not_executed', {
      message: 'Skip/Reopen bootstrap was not journaled',
    }), null));
  } else {
    rows.push(record(ctx, reasons, finish('not_proved', { executed: false, message: 'reasons are in the summary but were not journaled' }), null));
  }

  return reportedSlice(null, rows);
}

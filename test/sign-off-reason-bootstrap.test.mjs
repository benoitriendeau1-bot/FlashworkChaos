import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAOS_REOPEN_REASON, CHAOS_SKIP_REASON, ensureChaosReason, ensureChaosSignOffReasons,
} from '../src/sign-off-reason-bootstrap.mjs';

const SKIP_ID = '11111111-1111-4111-8111-111111111111';
const REOPEN_ID = '22222222-2222-4222-8222-222222222222';

function row(spec, id, isActive) {
  return { [spec.idField]: id, reasonCode: spec.reasonCode, reasonName: spec.name, isActive };
}

function splitCatalog() {
  const skip = [];
  const reopen = [];
  const calls = [];
  function list(route) {
    if (route.startsWith('/sign-off-skip-reasons')) return { spec: CHAOS_SKIP_REASON, rows: skip };
    return { spec: CHAOS_REOPEN_REASON, rows: reopen };
  }
  return {
    calls, skip, reopen,
    async call(method, route, body) {
      calls.push({ method, route, body: body ?? null });
      const bucket = list(route);
      if (method === 'GET') {
        assert.equal(route, bucket.spec.listPath);
        return { status: 200, data: { reasons: bucket.rows.map((item) => ({ ...item })) } };
      }
      if (method === 'POST') {
        assert.equal(route, bucket.spec.createPath);
        assert.deepEqual(body, { reasonCode: bucket.spec.reasonCode, name: bucket.spec.name, isActive: true });
        const id = bucket.spec.kind === 'skip' ? SKIP_ID : REOPEN_ID;
        const created = row(bucket.spec, id, true);
        bucket.rows.push(created);
        return { status: 201, data: { ...created, reasonName: body.name } };
      }
      if (method === 'PATCH') {
        const id = decodeURIComponent(route.slice(bucket.spec.updatePath('').length));
        const found = bucket.rows.find((item) => item[bucket.spec.idField] === id);
        assert.ok(found);
        assert.deepEqual(body, { isActive: true });
        found.isActive = true;
        return { status: 200, data: { ...found } };
      }
      return { status: 500, data: { error: 'unexpected' } };
    },
  };
}

test('reuses an active Chaos reason and ignores earlier seed rows', async () => {
  const store = splitCatalog();
  store.skip.push(
    { signOffSkipReasonId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reasonCode: 'NOT_APPLICABLE', reasonName: 'Not applicable', isActive: true },
    row(CHAOS_SKIP_REASON, SKIP_ID, true),
  );
  const result = await ensureChaosReason(store.call, CHAOS_SKIP_REASON);
  assert.equal(result.ok, true);
  assert.equal(result.id, SKIP_ID);
  assert.equal(result.disposition, 'reused');
  assert.deepEqual(store.calls.map((item) => item.method), ['GET']);
});

test('creates both reasons on an empty catalog and reuses them on the next run', async () => {
  const store = splitCatalog();
  const first = await ensureChaosSignOffReasons(store.call);
  assert.equal(first.ok, true);
  assert.equal(first.skip.disposition, 'created');
  assert.equal(first.reopen.disposition, 'created');
  assert.equal(first.skip.id, SKIP_ID);
  assert.equal(first.reopen.id, REOPEN_ID);
  const posts = store.calls.filter((item) => item.method === 'POST');
  assert.equal(posts.length, 2);
  const second = await ensureChaosSignOffReasons(store.call);
  assert.equal(second.ok, true);
  assert.equal(second.skip.disposition, 'reused');
  assert.equal(second.reopen.disposition, 'reused');
  assert.equal(second.skip.id, SKIP_ID);
  assert.equal(second.reopen.id, REOPEN_ID);
  assert.equal(store.calls.filter((item) => item.method === 'POST').length, 2);
  assert.equal(store.skip.length, 1);
  assert.equal(store.reopen.length, 1);
});

test('reactivates an inactive Chaos reason without creating a duplicate', async () => {
  const store = splitCatalog();
  store.skip.push(row(CHAOS_SKIP_REASON, SKIP_ID, false));
  const result = await ensureChaosReason(store.call, CHAOS_SKIP_REASON);
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'reactivated');
  assert.equal(result.id, SKIP_ID);
  assert.equal(result.isActive, true);
  assert.equal(store.skip[0].isActive, true);
  assert.deepEqual(store.calls.map((item) => item.method), ['GET', 'PATCH']);
});

test('rereads and reuses the winner after a 409 create conflict', async () => {
  const store = splitCatalog();
  const original = store.call.bind(store);
  let posted = false;
  store.call = async (method, route, body) => {
    if (method === 'POST' && !posted) {
      posted = true;
      store.calls.push({ method, route, body });
      store.skip.push(row(CHAOS_SKIP_REASON, SKIP_ID, true));
      return { status: 409, data: { error: 'Skip reason code already exists' } };
    }
    return original(method, route, body);
  };
  const result = await ensureChaosReason(store.call, CHAOS_SKIP_REASON);
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'reused-after-conflict');
  assert.equal(result.id, SKIP_ID);
  assert.deepEqual(store.calls.map((item) => item.method), ['GET', 'POST', 'GET']);
});

test('activates an inactive winner found after a 409', async () => {
  const store = splitCatalog();
  const original = store.call.bind(store);
  store.call = async (method, route, body) => {
    if (method === 'POST') {
      store.calls.push({ method, route, body });
      store.reopen.push(row(CHAOS_REOPEN_REASON, REOPEN_ID, false));
      return { status: 409, data: { error: 'Reopen reason code already exists' } };
    }
    return original(method, route, body);
  };
  const result = await ensureChaosReason(store.call, CHAOS_REOPEN_REASON);
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'reactivated-after-conflict');
  assert.equal(result.id, REOPEN_ID);
  assert.equal(store.reopen[0].isActive, true);
  assert.equal(store.calls.filter((item) => item.method === 'POST').length, 1);
});

test('fails setup when the catalog cannot yield an active Chaos reason', async () => {
  const missing = await ensureChaosReason(async () => ({ status: 500, data: { error: 'Failed to load skip reasons' } }), CHAOS_SKIP_REASON);
  assert.equal(missing.ok, false);
  assert.equal(missing.id, null);
  assert.match(missing.error, /list failed/);

  const rejected = await ensureChaosReason(async (method) => {
    if (method === 'GET') return { status: 200, data: { reasons: [] } };
    return { status: 403, data: { error: 'Forbidden' } };
  }, CHAOS_REOPEN_REASON);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /create failed: Forbidden/);

  const lostRace = await ensureChaosReason(async (method) => {
    if (method === 'GET') return { status: 200, data: { reasons: [] } };
    return { status: 409, data: { error: 'Skip reason code already exists' } };
  }, CHAOS_SKIP_REASON);
  assert.equal(lostRace.ok, false);
  assert.match(lostRace.error, /conflict winner was not found/);

  const both = await ensureChaosSignOffReasons(async () => ({ status: 403, data: { error: 'Forbidden' } }));
  assert.equal(both.ok, false);
  assert.equal(both.skip.ok, false);
  assert.equal(both.reopen.ok, false);
});

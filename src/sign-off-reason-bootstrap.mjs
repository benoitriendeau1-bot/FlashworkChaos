/** Stable Skip/Reopen catalogs Chaos establishes itself. Codes stay out of plan hashes. */

export const CHAOS_SKIP_REASON = {
  kind: 'skip',
  reasonCode: 'CHAOS_SKIP',
  name: 'Chaos skip',
  idField: 'signOffSkipReasonId',
  listPath: '/sign-off-skip-reasons?activeOnly=false',
  createPath: '/sign-off-skip-reasons',
  updatePath: (id) => '/sign-off-skip-reasons/' + encodeURIComponent(id),
};

export const CHAOS_REOPEN_REASON = {
  kind: 'reopen',
  reasonCode: 'CHAOS_REOPEN',
  name: 'Chaos reopen',
  idField: 'signOffReopenReasonId',
  listPath: '/sign-off-reopen-reasons?activeOnly=false',
  createPath: '/sign-off-reopen-reasons',
  updatePath: (id) => '/sign-off-reopen-reasons/' + encodeURIComponent(id),
};

function reasonRows(data) {
  if (Array.isArray(data?.reasons)) return data.reasons;
  return [];
}

function findReasonByCode(rows, reasonCode) {
  const code = String(reasonCode).trim().toUpperCase();
  return rows.find((row) => String(row?.reasonCode ?? '').trim().toUpperCase() === code) ?? null;
}

function errorText(data, status) {
  const message = data && typeof data === 'object' ? [data.error, data.message].filter(Boolean).join(' ') : '';
  return message || ('HTTP ' + status);
}

function failure(spec, error, status) {
  return {
    ok: false,
    kind: spec.kind,
    reasonCode: spec.reasonCode,
    id: null,
    disposition: null,
    isActive: false,
    error,
    status: status ?? null,
  };
}

function success(spec, id, disposition) {
  return {
    ok: true,
    kind: spec.kind,
    reasonCode: spec.reasonCode,
    id,
    disposition,
    isActive: true,
    error: null,
    status: null,
  };
}

function httpOk(result) {
  return result && result.status >= 200 && result.status < 300;
}

/**
 * @param {(method: string, route: string, body?: object) => Promise<{ status: number, data: unknown }>} call
 */
export async function ensureChaosReason(call, spec) {
  const listed = await call('GET', spec.listPath);
  if (!httpOk(listed)) return failure(spec, 'list failed: ' + errorText(listed?.data, listed?.status), listed?.status);

  const existing = findReasonByCode(reasonRows(listed.data), spec.reasonCode);
  if (existing) return activateOrReuse(call, spec, existing, 'reused', 'reactivated');

  const created = await call('POST', spec.createPath, {
    reasonCode: spec.reasonCode,
    name: spec.name,
    isActive: true,
  });
  if (created?.status === 409) {
    const again = await call('GET', spec.listPath);
    if (!httpOk(again)) return failure(spec, 'reread after conflict failed: ' + errorText(again?.data, again?.status), again?.status);
    const winner = findReasonByCode(reasonRows(again.data), spec.reasonCode);
    if (!winner) return failure(spec, 'conflict winner was not found', again.status);
    return activateOrReuse(call, spec, winner, 'reused-after-conflict', 'reactivated-after-conflict');
  }
  if (!httpOk(created)) return failure(spec, 'create failed: ' + errorText(created?.data, created?.status), created?.status);
  const createdId = created.data?.[spec.idField];
  if (!createdId || created.data?.isActive !== true) {
    return failure(spec, 'create did not return an active reason', created.status);
  }
  return success(spec, createdId, 'created');
}

async function activateOrReuse(call, spec, row, reuseDisposition, reactivateDisposition) {
  const id = row?.[spec.idField];
  if (!id) return failure(spec, 'reason has no id', null);
  if (row.isActive === true) return success(spec, id, reuseDisposition);
  const patched = await call('PATCH', spec.updatePath(id), { isActive: true });
  if (!httpOk(patched) || patched.data?.isActive !== true) {
    return failure(spec, 'reactivation failed: ' + errorText(patched?.data, patched?.status), patched?.status);
  }
  return success(spec, patched.data?.[spec.idField] ?? id, reactivateDisposition);
}

/** Ensures both Chaos reasons. A failure of one does not skip the other. */
export async function ensureChaosSignOffReasons(call) {
  const skip = await ensureChaosReason(call, CHAOS_SKIP_REASON);
  const reopen = await ensureChaosReason(call, CHAOS_REOPEN_REASON);
  return { ok: skip.ok === true && reopen.ok === true, skip, reopen };
}

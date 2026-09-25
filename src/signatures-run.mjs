import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { redactSecrets } from './signatures-redact.mjs';
import { emptySignatureCounters, judgeCancellationRace, judgeIdentityNoop, judgeRefusedStart, judgeSignatureObservation, recordSignatureOutcome, signatureVerdict } from './signatures-judge.mjs';
import { bindSignaturesPlan, SIGN_RACE_REPEATS, signaturesCapturePlan } from './signatures-plan.mjs';
import { resolveWorkOrderIds, signoffEventSignature } from './wo-resolve.mjs';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const UNKNOWN_USER = '00000000-0000-4000-8000-000000000099';

function errorText(data) {
  if (!data || typeof data !== 'object') return '';
  const details = data.details && typeof data.details === 'object' ? JSON.stringify(data.details) : '';
  return [data.error, data.message, data.code, details].filter(Boolean).join(' ');
}

function listOf(data, key) {
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.data?.[key])) return data.data[key];
  return [];
}

function plannedCancellationRaces(plan) {
  return plan.actions.filter((action) => action.id.startsWith('cancel-vs-') && action.kind !== 'not-applicable');
}

function summarizeCancellationRaces(plan, concurrency, blocked) {
  const planned = plannedCancellationRaces(plan);
  const races = concurrency.filter((item) => item.id.startsWith('cancel-vs-'));
  const blockedRows = blocked.filter((item) => !item.optional && (String(item.id).startsWith('cancel-vs-') || String(item.id).startsWith('prepare-cancel-vs-')));
  const violations = races.filter((item) => item.outcome !== 'accepted');
  return {
    plannedActions: planned.length,
    executedActions: races.length,
    repetitions: races.length,
    actionWins: races.filter((item) => item.winner === 'signature').length,
    cancellationWins: races.filter((item) => item.winner === 'cancellation').length,
    validLinearizations: races.filter((item) => item.outcome === 'accepted').length,
    unexpectedAcceptances: races.filter((item) => item.outcome === 'unexpected-acceptance').length,
    unexpectedRejections: races.filter((item) => item.outcome === 'unexpected-rejection').length,
    invariantChecks: races.length,
    invariantViolations: violations.length,
    blockedActions: blockedRows.length,
    unhandledActions: races.filter((item) => item.outcome === 'unhandled' || (item.status ?? []).some((status) => status == null || status === 0 || status >= 500)).length,
    findings: violations.length,
    pass: planned.length > 0 && races.length === planned.length && violations.length === 0 && blockedRows.length === 0
      && races.every((item) => item.outcome !== 'unhandled' && (item.status ?? []).every((status) => status !== 0 && status != null && status < 500)),
    races,
  };
}

function emptyCancellationRaces(plan, executed) {
  const planned = plannedCancellationRaces(plan).length;
  return {
    plannedActions: planned,
    executedActions: executed,
    repetitions: executed,
    actionWins: 0,
    cancellationWins: 0,
    validLinearizations: 0,
    unexpectedAcceptances: 0,
    unexpectedRejections: 0,
    invariantChecks: executed,
    invariantViolations: 0,
    blockedActions: planned,
    unhandledActions: 0,
    findings: 0,
    pass: false,
    races: [],
  };
}

function blockedReport(plan, reason) {
  const counters = emptySignatureCounters();
  for (const action of plan.actions) {
    const bucket = counters[action.action] ?? counters.pass;
    bucket.plannedActions++;
    if (action.kind !== 'not-applicable') bucket.blockedActions++;
  }
  const verdict = signatureVerdict(counters, 1);
  return {
    setupPass: false, ...verdict, setupError: reason, signaturesPlanHash: plan.signaturesPlanHash,
    actions: decorate(counters), findings: [], contractDecisions: [], concurrency: [],
    blocked: [{ id: 'setup', reason }], notApplicable: [], skipped: [],
    cancellationRaces: emptyCancellationRaces(plan, 0),
  };
}

function decorate(counters) {
  return {
    pass: { ...counters.pass },
    skip: { ...counters.skip },
    reopen: { ...counters.reopen },
  };
}

function normalizeSignoff(row) {
  if (!row) return null;
  return {
    proStepSignoffId: row.proStepSignoffId,
    outcome: row.outcome ?? null,
    signedBy: row.signedBy ?? null,
    signedAt: row.signedAt ?? null,
    comment: row.comment ?? null,
    skipReasonId: row.skipReasonId ?? null,
    level: row.level ?? null,
  };
}

export async function runSignaturesCapture({
  setup, call, seed, runId, prefix, effectivityDate, envUserId,
  skipReasonId, reopenReasonId,
}) {
  const plan = bindSignaturesPlan(signaturesCapturePlan(seed), runId);
  if (!skipReasonId || !reopenReasonId) return blockedReport(plan, 'chaos skip or reopen reason was not established');
  const token = String(runId).replaceAll('-', '').toUpperCase().slice(0, 12);
  const masterItemNo = 'MI-' + prefix + token + 'SIG';
  const orderNo = 'PO' + prefix + token + 'S1';

  const actorContext = await resolveActors(call, envUserId);
  if (!actorContext.primary) return blockedReport(plan, actorContext.reason ?? 'the authenticated user could not be resolved to a UUID');

  const categoryIds = {};
  for (const name of ['Operator', 'QA', 'Inspector']) {
    const created = await setup('create sign-off category', 'POST', '/sign-off-categories', { name: name + ' ' + token });
    const id = created.ok ? identifier(created.data, ['signOffCategorieId']) : null;
    if (!id) return blockedReport(plan, 'sign-off category ' + name + ' was not created');
    categoryIds[name] = id;
  }
  const privileges = { operator: 'signoff.operator', qa: 'signoff.qa', inspector: 'signoff.inspector' };
  const requirements = {};
  for (const role of ['operator', 'qa', 'inspector']) {
    const created = await setup('create sign-off requirement', 'POST', '/sign-off-requirements', {
      name: role + ' ' + token,
      signOffCategorieId: categoryIds[role === 'operator' ? 'Operator' : role === 'qa' ? 'QA' : 'Inspector'],
      requiredPrivilege: privileges[role],
      requiresUniqueSignerWithinStep: true,
      scope: 'step',
      level: 1,
    });
    const id = created.ok ? identifier(created.data, ['signOffRequirementId']) : null;
    if (!id) return blockedReport(plan, 'sign-off requirement ' + role + ' was not created');
    requirements[role] = id;
  }

  const category = await setup('create signature part category', 'POST', '/part-categories', {
    categoryName: 'SIG' + token,
    description: 'Chaos signatures ' + runId,
  });
  const partCategorieId = category.ok ? identifier(category.data, ['partCategorieId']) : null;
  if (!partCategorieId) return blockedReport(plan, 'signature part category was not created');
  const part = await setup('create signature part', 'POST', '/parts', {
    partNumber: 'P' + token + 'SIG',
    description: 'Signature bundle part ' + token,
    traceabilityMode: 'None',
    partCategorieId,
  });
  const partId = part.ok ? identifier(part.data, ['partId']) : null;
  if (!partId) return blockedReport(plan, 'signature part was not created');
  const serialPart = await setup('create signature serial part', 'POST', '/parts', {
    partNumber: 'P' + token + 'SIGS',
    description: 'Signature serial part ' + token,
    traceabilityMode: 'Serial',
    partCategorieId,
  });
  const serialPartId = serialPart.ok ? identifier(serialPart.data, ['partId']) : null;
  if (!serialPartId) return blockedReport(plan, 'signature serial part was not created');
  const lotPart = await setup('create signature lot part', 'POST', '/parts', {
    partNumber: 'P' + token + 'SIGL',
    description: 'Signature lot part ' + token,
    traceabilityMode: 'Lot',
    partCategorieId,
  });
  const lotPartId = lotPart.ok ? identifier(lotPart.data, ['partId']) : null;
  if (!lotPartId) return blockedReport(plan, 'signature lot part was not created');
  const tool = await setup('create signature tool', 'POST', '/tools', {
    toolNumber: 'T' + token + 'SIG',
    name: 'Signature torque wrench ' + token,
    description: 'Required tool for the signature bundle',
    calibrationBasis: 'none',
    defaultCapturePolicy: 'required',
  });
  const toolId = tool.ok ? identifier(tool.data, ['toolId']) : null;
  if (!toolId) return blockedReport(plan, 'signature tool was not created');
  const assetTag = 'TAG-' + token + '-SIG';
  const instance = await setup('create signature instance', 'POST', '/tool-instances', {
    toolId, assetTag, serialNo: assetTag, status: 'active',
  });
  if (!instance.ok) return blockedReport(plan, 'signature tool instance was not created');
  const assetTagB = 'TAG-' + token + '-SIGB';
  const secondInstance = await setup('create signature replacement instance', 'POST', '/tool-instances', {
    toolId, assetTag: assetTagB, serialNo: assetTagB, status: 'active',
  });
  if (!secondInstance.ok) return blockedReport(plan, 'signature replacement tool instance was not created');
  const assetTagInactive = 'TAG-' + token + '-SIGX';
  const inactiveInstance = await setup('create inactive signature instance', 'POST', '/tool-instances', {
    toolId, assetTag: assetTagInactive, serialNo: assetTagInactive, status: 'inactive',
  });
  if (!inactiveInstance.ok) return blockedReport(plan, 'inactive signature tool instance was not created');
  const obsoleteTool = await setup('create obsolete signature tool', 'POST', '/tools', {
    toolNumber: 'T' + token + 'SIGO',
    name: 'Signature obsolete tool ' + token,
    description: 'Tool retired before the refused scan',
    calibrationBasis: 'none',
    defaultCapturePolicy: 'required',
  });
  const obsoleteToolId = obsoleteTool.ok ? identifier(obsoleteTool.data, ['toolId']) : null;
  if (!obsoleteToolId) return blockedReport(plan, 'obsolete signature tool was not created');
  const assetTagObsolete = 'TAG-' + token + '-OBSIG';
  const obsoleteInstance = await setup('create obsolete signature instance', 'POST', '/tool-instances', {
    toolId: obsoleteToolId, assetTag: assetTagObsolete, serialNo: assetTagObsolete, status: 'active',
  });
  if (!obsoleteInstance.ok) return blockedReport(plan, 'obsolete signature tool instance was not created');

  const root = '/master-items/' + encodeURIComponent(masterItemNo);
  const made = await setup('create signature master', 'POST', '/master-items', {
    masterItemNo, masterType: 'Prod', description: 'Chaos signatures ' + runId, seedInitialStructure: false,
  });
  if (!made.ok) return blockedReport(plan, 'signature master item was not created');

  const stepSlots = new Map();
  const authoredSlots = [];
  for (const slot of plan.slots) {
    if (authoredSlots.some((item) => item.operationNo === slot.operationNo && item.stepNo === slot.stepNo && item.level === slot.level && item.role === slot.role)) continue;
    authoredSlots.push(slot);
  }
  for (const slot of authoredSlots) {
    const key = slot.operationNo + ':' + slot.stepNo;
    if (!stepSlots.has(key)) stepSlots.set(key, []);
    stepSlots.get(key).push(slot);
  }
  async function authorOperation(operationNo, title, mustCompleteBeforeLater) {
    const created = await setup('add signature operation', 'POST', root + '/operations', {
      operationNo, operationTitle: title, operationDescription: 'Chaos signatures ' + operationNo, mustCompleteBeforeLater,
    });
    if (!created.ok) return false;
    const groups = [...stepSlots.entries()].filter(([key]) => key.startsWith(operationNo + ':'))
      .sort((left, right) => Number(left[0].split(':')[1]) - Number(right[0].split(':')[1]));
    const planned = groups.map(([key]) => ({
      stepNo: Number(key.split(':')[1]),
      stepTitle: title + ' étape ' + key.split(':')[1],
      stepDescription: 'Signature de l’étape ' + key.split(':')[1] + '.',
    }));
    const authored = stepsAfterSeededOperation(created.data, planned);
    if (!authored.seeded) return false;
    const named = await setup('name signature step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) return false;
    const stepIds = new Map([[String(authored.seeded.stepNo), authored.seeded.masOpeStepId]]);
    for (const spec of authored.creates) {
      const step = await setup('add signature step', 'POST', root + '/steps', {
        masOpeId: identifier(created.data, ['masOpeId', 'id']), ...spec,
      });
      const stepId = step.ok ? identifier(step.data, ['masOpeStepId', 'id']) : null;
      if (!stepId) return false;
      stepIds.set(String(spec.stepNo), stepId);
    }
    for (const [key, slots] of groups) {
      const stepId = stepIds.get(key.split(':')[1]);
      if (!stepId) return false;
      if (slots.some((slot) => slot.captures || slot.dataOnly)) {
        const data = await setup('add signature data', 'POST', root + '/data-points', {
          masOpeStepId: stepId, referenceCode: 'S' + key.split(':')[1], label: 'Contrôle de signature',
          dataType: 'text', isMandatory: true,
        });
        if (!data.ok) return false;
      }
      if (slots.some((slot) => slot.captures || slot.partOnly)) {
        const attachedPart = await setup('add signature part', 'POST', root + '/parts', {
          masOpeStepId: stepId, partId, quantityRequired: 1,
        });
        if (!attachedPart.ok) return false;
      }
      if (slots.some((slot) => slot.serialPart)) {
        const attachedSerial = await setup('add signature serial part', 'POST', root + '/parts', {
          masOpeStepId: stepId, partId: serialPartId, quantityRequired: 1,
        });
        if (!attachedSerial.ok) return false;
      }
      if (slots.some((slot) => slot.serialUnits)) {
        const attachedUnits = await setup('add signature serial units', 'POST', root + '/parts', {
          masOpeStepId: stepId, partId: serialPartId, quantityRequired: 2,
        });
        if (!attachedUnits.ok) return false;
      }
      if (slots.some((slot) => slot.numberData)) {
        const number = await setup('add signature number', 'POST', root + '/data-points', {
          masOpeStepId: stepId, referenceCode: 'S' + key.split(':')[1], label: 'Mesure refusée',
          dataType: 'number', isMandatory: true, minValue: 1, maxValue: 10, nominalValue: 5,
        });
        if (!number.ok) return false;
      }
      if (slots.some((slot) => slot.lotPart)) {
        const attachedLot = await setup('add signature lot part', 'POST', root + '/parts', {
          masOpeStepId: stepId, partId: lotPartId, quantityRequired: 2,
        });
        if (!attachedLot.ok) return false;
      }
      if (slots.some((slot) => slot.captures || slot.toolOnly)) {
        const attachedTool = await setup('add signature tool', 'POST', root + '/tools', {
          masOpeStepId: stepId, toolId, capturePolicy: 'required', useQty: null,
          specText: 'Scanner ' + assetTag + ' avant la signature.',
        });
        if (!attachedTool.ok) return false;
      }
      if (slots.some((slot) => slot.obsoleteTool)) {
        const attachedObsolete = await setup('add obsolete signature tool', 'POST', root + '/tools', {
          masOpeStepId: stepId, toolId: obsoleteToolId, capturePolicy: 'required', useQty: null,
          specText: 'Scanner ' + assetTagObsolete + ' après le retrait du service.',
        });
        if (!attachedObsolete.ok) return false;
      }
      const blocks = await setup('write signature instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(
        'Compléter les exigences obligatoires, puis signer dans l’ordre des niveaux.',
      ));
      if (!blocks.ok) return false;
      for (const slot of slots) {
        const sign = await setup('add signature requirement', 'POST', root + '/signoffs', {
          masOpeStepId: stepId, signOffRequirementId: requirements[slot.role], level: slot.level,
        });
        if (!sign.ok) return false;
      }
      if (slots.some((slot) => slot.identity)) {
        const identity = await setup('add signature unit identity', 'POST', root + '/unit-identities', {
          masOpeStepId: stepId, policy: 'required', label: 'Numéro de série de l’unité',
        });
        if (!identity.ok) return false;
      }
    }
    return true;
  }
  if (!await authorOperation('10', 'Signer l’opération courante', true)) return blockedReport(plan, 'signature operation 10 was not authored');
  if (!await authorOperation('20', 'Signature bloquée par l’opération précédente', false)) return blockedReport(plan, 'signature operation 20 was not authored');
  const released = await setup('release signature master', 'PATCH', root, { status: 'Released' });
  if (!released.ok) return blockedReport(plan, 'signature master item was not released');
  const obsolete = await setup('obsolete signature tool', 'POST', '/tools/' + obsoleteToolId + '/obsolete', {});
  const obsoleteOk = obsolete.ok === true || (obsolete.status >= 200 && obsolete.status < 300);
  const order = await setup('create signature PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: plan.unitCount, executionMode: 'sequential',
  });
  if (!order.ok) return blockedReport(plan, 'signature production order was not created');
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  const rel = await setup('release signature PO', 'POST', orderRoot + '/release', {});
  if (!rel.ok) return blockedReport(plan, 'signature production order was not released');

  const workOrders = [];
  for (let unit = 1; unit <= plan.unitCount; unit++) {
    const wo = await setup('create signature WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    const workOrderId = wo.ok ? identifier(wo.data, ['workOrderId', 'id']) : null;
    if (!workOrderId) return blockedReport(plan, 'signature work order ' + unit + ' was not created');
    const detail = await setup('read signature WO', 'GET', orderRoot + '/work-orders/' + workOrderId);
    const resolved = detail.ok ? resolveWorkOrderIds(detail.data) : { ok: false, error: 'work order detail was not readable' };
    if (!resolved.ok) return blockedReport(plan, resolved.error);
    workOrders.push({ workOrderId, detail: detail.data, resolved });
  }

  function locate(slotKey, woNumber, rows) {
    const slot = plan.slots.find((item) => item.key === slotKey);
    const wo = rows[woNumber - 1];
    if (!slot || !wo) return null;
    for (const operation of wo.resolved.operations) {
      if (operation.operationNo !== slot.operationNo) continue;
      for (const step of operation.steps) {
        if (step.stepNo !== slot.stepNo) continue;
        const signoff = step.signoffs.find((item) => item.level === slot.level && item.signOffRequirementId === requirements[slot.role]);
        if (!signoff) return null;
        return { wo, operation, step, signoff, slot };
      }
    }
    return null;
  }
  for (const slot of plan.slots) {
    const found = locate(slot.key, slot.wo ?? 1, workOrders);
    if (!found?.signoff?.proStepSignoffId) return blockedReport(plan, 'snapshot is missing sign-off ' + slot.key);
    if (found.signoff.outcome) return blockedReport(plan, 'sign-off ' + slot.key + ' is not pending in the snapshot');
  }

  const reasons = { skip: skipReasonId, reopen: reopenReasonId };
  const counters = emptySignatureCounters();
  for (const action of plan.actions) (counters[action.action] ?? counters.pass).plannedActions++;
  const findings = [];
  const contractDecisions = [];
  const refusedStarts = [];
  const concurrency = [];
  const blocked = [];
  const observed = [];
  let coreBlocked = 0;
  let holdOk = false;
  let cancelOk = false;
  const ctx = { ...actorContext, reasons, holdOk, cancelOk, obsoleteOk };

  function userFor(actor) {
    if (actor === 'primary' || actor === 'witness' || actor === 'witness-wrong' || !actor) return ctx.primary;
    if (actor === 'qa') return ctx.actors.qa;
    if (actor === 'unprivileged') return ctx.actors.unprivileged;
    if (actor === 'obsolete') return ctx.actors.obsolete;
    if (actor === 'unknown') return UNKNOWN_USER;
    if (actor === 'malformed') return 'not-a-uuid';
    if (actor === 'missing') return null;
    return ctx.primary;
  }

  function bodyFor(action, item = action) {
    const body = { ...(item.body ?? action.body ?? {}) };
    const route = item.route ?? action.route;
    if (route === 'skip' && !body.skipReasonId && reasons.skip) body.skipReasonId = reasons.skip;
    if (route === 'reopen' && !body.reopenReasonId && reasons.reopen) body.reopenReasonId = reasons.reopen;
    if ((item.actor ?? action.actor) === 'witness') {
      body.identifier = process.env.FLASHWORK_WITNESS_IDENTIFIER;
      body.password = process.env.FLASHWORK_WITNESS_PASSWORD;
    }
    if ((item.actor ?? action.actor) === 'witness-wrong') {
      body.identifier = process.env.FLASHWORK_WITNESS_IDENTIFIER;
      body.password = 'incorrect-proof';
    }
    return body;
  }

  async function reload(woNumber) {
    const current = workOrders[woNumber - 1];
    const detail = await call('reread signature WO', 'GET', orderRoot + '/work-orders/' + current.workOrderId, undefined, { userId: ctx.primary });
    if (detail.status < 200 || detail.status >= 300) return null;
    const resolved = resolveWorkOrderIds(detail.data);
    if (!resolved.ok) return null;
    current.detail = detail.data;
    current.resolved = resolved;
    return current;
  }

  async function readEvents(located) {
    const response = await call('read signature events', 'GET', orderRoot + '/work-orders/' + located.wo.workOrderId
      + '/steps/' + located.step.proOpeStepId + '/signoffs/' + located.signoff.proStepSignoffId + '/events', undefined, { userId: ctx.primary });
    if (response.status < 200 || response.status >= 300) return null;
    const events = response.data?.events ?? response.data?.data?.events;
    return Array.isArray(events) ? signoffEventSignature(events) : null;
  }

  function fingerprint(wo, ignoreSignoffId, ignoreDataId, ignorePartId, ignoreToolId) {
    return wo.resolved.operations.flatMap((operation) => operation.steps.flatMap((step) => ({
      operationNo: operation.operationNo,
      stepNo: step.stepNo,
      signoffs: step.signoffs.filter((item) => item.proStepSignoffId !== ignoreSignoffId).map(normalizeSignoff),
      data: step.dataPoints.filter((point) => point.proStepDataId !== ignoreDataId).map((point) => ({ id: point.proStepDataId, text: point.capturedValueText ?? null, status: point.captureStatus ?? null })),
      parts: step.parts.filter((partRow) => partRow.proStepPartId !== ignorePartId).map((partRow) => ({ id: partRow.proStepPartId, quantityActual: partRow.quantityActual ?? null })),
      tools: step.tools.filter((toolRow) => toolRow.proStepToolId !== ignoreToolId).map((toolRow) => ({ id: toolRow.proStepToolId, toolInstanceId: toolRow.toolInstanceId ?? null, calibrationStatus: toolRow.calibrationStatus ?? null })),
    })));
  }

  function woMeta(detail) {
    const row = detail?.workOrder ?? {};
    return {
      status: row.status ?? null,
      startedAt: row.startedAt ?? null,
      cancelledAt: row.cancelledAt ?? null,
      cancelReason: row.cancelReason ?? null,
      currentVarianceId: row.currentVarianceId ?? null,
    };
  }

  function rawStep(wo, stepId) {
    for (const operation of wo?.detail?.operations ?? []) {
      for (const step of operation.steps ?? []) {
        if (step.proOpeStepId === stepId) return step;
      }
    }
    return null;
  }

  function captureSnapshot(located, kind) {
    if (kind === 'data') {
      const point = located?.step?.dataPoints?.[0];
      return {
        text: point?.capturedValueText ?? null,
        number: point?.capturedValueNumber ?? null,
        status: point?.captureStatus ?? null,
      };
    }
    if (kind === 'part' || kind === 'part-unit' || kind === 'lot-lines') {
      const partRow = located?.step?.parts?.[0];
      return {
        quantityActual: partRow?.quantityActual ?? null,
        serialNo: kind === 'part-unit' ? (partRow?.units?.[0]?.serialNo ?? null) : (partRow?.serialNo ?? null),
        lotNo: partRow?.lotNo ?? null,
        units: (partRow?.units ?? []).map((unit) => ({ proStepPartUnitId: unit.proStepPartUnitId, serialNo: unit.serialNo ?? null })),
        lines: (partRow?.lotLines ?? []).map((line) => ({ quantity: line.quantity ?? null, lotNo: line.lotNo ?? null })),
      };
    }
    if (kind === 'tool') {
      const toolRow = located?.step?.tools?.[0] ?? {};
      const rawTools = rawStep(located?.wo, located?.step?.proOpeStepId)?.tools ?? [];
      const raw = rawTools.find((tool) => tool?.proStepToolId === toolRow.proStepToolId) ?? rawTools[0] ?? {};
      const source = { ...raw, ...toolRow };
      const snapshot = {};
      for (const field of [
        'toolInstanceId', 'assetTag', 'serialNo', 'toolSerialNo', 'calibrationStatus', 'captureStatus',
        'useQty', 'calibrationCheckedAt', 'lastCalibratedAt', 'calibrationDueDate', 'usedBy', 'usedAt',
        'toolId', 'toolNumber', 'capturePolicy',
      ]) snapshot[field] = source[field] ?? null;
      return snapshot;
    }
    if (kind === 'identity') {
      const identity = rawStep(located?.wo, located?.step?.proOpeStepId)?.unitIdentity ?? null;
      return { identityValue: identity?.identityValue ?? null, captured: identity?.captured === true };
    }
    return null;
  }

  async function readPortrait(woNumber) {
    const current = await reload(woNumber);
    if (!current) return null;
    const order = await call('read signature order', 'GET', orderRoot, undefined, { userId: ctx.primary });
    const audit = await call('read signature order audit', 'GET', orderRoot + '/audit-events', undefined, { userId: ctx.primary });
    if (order.status < 200 || order.status >= 300 || audit.status < 200 || audit.status >= 300) return null;
    const unitIndex = current.detail?.workOrder?.unitIndex ?? null;
    const unit = (order.data?.units ?? []).find((item) => item.unitIndex === unitIndex);
    const events = (audit.data?.auditEvents ?? [])
      .filter((event) => event?.proAuditEventId)
      .map((event) => ({
        id: event.proAuditEventId,
        eventType: event.eventType ?? null,
        eventTime: event.eventTime ?? event.createdAt ?? null,
        workOrderId: event.payloadJson?.workOrderId ?? null,
        payload: event.payloadJson ?? null,
      }));
    return {
      wo: woMeta(current.detail),
      unitStatus: unit?.status ?? null,
      poStatus: order.data?.order?.status ?? null,
      audit: events,
    };
  }

  for (const action of plan.actions) {
    if (action.kind === 'not-applicable') {
      blocked.push({ id: action.id, reason: action.reason, optional: true });
      continue;
    }
    const reason = blockReason(action, ctx);
    if (reason) {
      blocked.push({ id: action.id, reason, optional: action.optionalCoverage === true });
      recordSignatureOutcome(counters, action, { outcome: 'blocked' });
      if (!action.optionalCoverage) coreBlocked++;
      continue;
    }
    const slotWo = plan.slots.find((item) => item.key === action.slot)?.wo;
    const woNumber = action.wo ?? slotWo ?? 1;
    const located = action.route === 'status' || action.route === 'cancel'
      ? { wo: workOrders[(action.wo ?? 1) - 1] }
      : locate(action.slot, woNumber, workOrders);
    if (!located) {
      blocked.push({ id: action.id, reason: 'sign-off was not on the work order snapshot' });
      recordSignatureOutcome(counters, action, { outcome: 'blocked' });
      if (!action.optionalCoverage) coreBlocked++;
      continue;
    }
    if (action.route === 'status') {
      const response = await call(action.id, 'PATCH', orderRoot + '/status', action.body, { userId: ctx.primary });
      const ok = response.status >= 200 && response.status < 300;
      if (action.id === 'po-on-hold' && ok) ctx.holdOk = true;
      if (action.id === 'po-resume' && ok) ctx.holdOk = false;
      const judgment = ok ? { outcome: 'accepted', finding: false } : { outcome: 'unexpected-rejection', finding: true, invariant: 'production order status was rejected' };
      recordSignatureOutcome(counters, action, judgment);
      continue;
    }
    if (action.route === 'cancel' && !action.parallel) {
      const response = await call(action.id, 'POST', orderRoot + '/work-orders/' + located.wo.workOrderId + '/cancel', action.body, { userId: ctx.primary });
      cancelOk = response.status >= 200 && response.status < 300;
      ctx.cancelOk = cancelOk;
      const judgment = cancelOk ? { outcome: 'accepted', finding: false } : { outcome: 'unexpected-rejection', finding: true, invariant: 'work order cancel was rejected' };
      recordSignatureOutcome(counters, action, judgment);
      if (judgment.finding) findings.push(finding(action, located, response, judgment.invariant));
      continue;
    }

    const beforeWo = await reload(woNumber);
    if (!beforeWo) {
      blocked.push({ id: action.id, reason: 'work order could not be reread' });
      recordSignatureOutcome(counters, action, { outcome: 'blocked' });
      if (!action.optionalCoverage) coreBlocked++;
      continue;
    }
    const beforeLocated = locate(action.slot, woNumber, workOrders);
    const beforeEvents = await readEvents(beforeLocated);
    if (!beforeEvents) {
      blocked.push({ id: action.id, reason: 'signature events could not be read' });
      recordSignatureOutcome(counters, action, { outcome: 'blocked' });
      if (!action.optionalCoverage) coreBlocked++;
      continue;
    }
    const versus = action.oracle?.cancelVersus;
    const ignoreDataId = (action.parallel ?? []).some((item) => item.route === 'data') || versus === 'data'
      ? beforeLocated.step.dataPoints[0]?.proStepDataId
      : null;
    const ignorePartId = versus === 'part' || versus === 'lot-lines' || versus === 'part-unit'
      ? beforeLocated.step.parts[0]?.proStepPartId
      : null;
    const ignoreToolId = versus === 'tool' ? beforeLocated.step.tools[0]?.proStepToolId : null;
    const beforeFingerprint = fingerprint(beforeWo, beforeLocated.signoff.proStepSignoffId, ignoreDataId, ignorePartId, ignoreToolId);
    const needsAudit = Boolean(action.oracle?.cancelVersus || action.oracle?.noStart || action.oracle?.identityNoop);
    const beforePortrait = needsAudit ? await readPortrait(woNumber) : null;
    if (needsAudit && !beforePortrait) {
      const judgment = { outcome: 'invariant', finding: true, invariant: 'cancellation race was judged without a persistent reread and audit' };
      recordSignatureOutcome(counters, action, judgment);
      findings.push(finding(action, beforeLocated, { status: 0, data: null }, judgment.invariant));
      continue;
    }
    const targets = action.parallel ?? [{ route: action.route, actor: action.actor, body: action.body, slot: action.slot }];
    let arrival = 0;
    const calls = await Promise.all(targets.map(async (item, index) => {
      const waitMs = Number(item.delayMs ?? 0);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const target = locate(item.slot ?? action.slot, woNumber, workOrders);
      const routeName = item.route ?? action.route;
      const response = await send(routeName, action, item, target, index, woNumber);
      arrival += 1;
      return { index, arrival, response, routeName };
    }));
    const responses = calls.slice().sort((left, right) => left.index - right.index).map((item) => item.response);
    const arrived = calls.slice().sort((left, right) => left.arrival - right.arrival);
    const afterWo = await reload(woNumber);
    const afterLocated = afterWo ? locate(action.slot, woNumber, workOrders) : null;
    const afterEvents = afterLocated ? await readEvents(afterLocated) : null;
    if (!afterWo || !afterEvents) {
      const judgment = { outcome: 'invariant', finding: true, invariant: 'signature state could not be reread' };
      recordSignatureOutcome(counters, action, judgment);
      findings.push(finding(action, beforeLocated, responses[0], judgment.invariant));
      continue;
    }
    const dataPoint = afterLocated.step.dataPoints[0];
    const afterPortrait = needsAudit ? await readPortrait(woNumber) : null;
    const observation = {
      oracle: action.oracle,
      status: responses[0].status,
      statuses: responses.map((item) => item.status),
      errors: responses.map((item) => errorText(item.data)),
      errorText: responses.map((item) => errorText(item.data)).join(' '),
      before: normalizeSignoff(beforeLocated.signoff),
      after: normalizeSignoff(afterLocated.signoff),
      beforeEvents,
      afterEvents,
      siblingsChanged: JSON.stringify(beforeFingerprint) !== JSON.stringify(fingerprint(afterWo, afterLocated.signoff.proStepSignoffId, ignoreDataId, ignorePartId, ignoreToolId)),
      actors: ctx.actors,
      dataCaptured: Boolean(dataPoint?.capturedValueText),
      cancelled: afterWo.detail?.workOrder?.status === 'Cancelled',
      captureOk: captureStored(action, afterLocated),
      performedBy: afterEvents.at(-1)?.performedBy ?? null,
      audited: Boolean(afterPortrait),
      workOrderId: beforeWo.workOrderId,
      woBefore: beforePortrait?.wo ?? null,
      woAfter: afterPortrait?.wo ?? null,
      unitBefore: beforePortrait?.unitStatus ?? null,
      unitAfter: afterPortrait?.unitStatus ?? null,
      poBefore: beforePortrait?.poStatus ?? null,
      poAfter: afterPortrait?.poStatus ?? null,
      auditBefore: beforePortrait?.audit ?? [],
      auditAfter: afterPortrait?.audit ?? [],
      captureBefore: captureSnapshot(beforeLocated, action.oracle?.cancelVersus ?? action.oracle?.capture),
      captureAfter: captureSnapshot(afterLocated, action.oracle?.cancelVersus ?? action.oracle?.capture),
      rows: Object.fromEntries(plan.slots.filter((slot) => (slot.wo ?? 1) === woNumber).map((slot) => {
        const row = locate(slot.key, woNumber, workOrders);
        return [slot.key, normalizeSignoff(row?.signoff)];
      })),
    };
    const judgment = action.oracle?.cancelVersus
      ? judgeCancellationRace(observation)
      : action.oracle?.noStart
        ? judgeRefusedStart(observation)
        : action.oracle?.identityNoop
          ? judgeIdentityNoop(observation)
          : judgeSignatureObservation(observation);
    recordSignatureOutcome(counters, action, judgment);
    observed.push({ id: action.id, status: observation.statuses, code: responses.map((item) => item.data?.code ?? null) });
    if (action.kind === 'concurrency') {
      const addedSignoff = (observation.afterEvents ?? []).length - (observation.beforeEvents ?? []).length;
      concurrency.push({
        id: action.id,
        status: observation.statuses,
        arrival: arrived.map((item) => ({ index: item.index + 1, status: item.response.status, code: item.response.data?.code ?? null, error: errorText(item.response.data) || null })),
        outcome: judgment.outcome,
        ...(action.oracle?.cancelVersus ? {
          cancelVersus: action.oracle.cancelVersus,
          family: action.id.startsWith('cancel-vs-') ? action.id.replace(/^cancel-vs-/, '').replace(/-\d+$/, '') : 'pass-ready-legacy',
          plannedOrder: (action.parallel ?? []).map((item) => item.route ?? action.route),
          commitOrder: action.oracle?.commitOrder ?? 'simultaneous',
          delayMs: (action.parallel ?? []).map((item) => Number(item.delayMs ?? 0)),
          messages: observation.errors,
          before: { wo: observation.woBefore, unit: observation.unitBefore, po: observation.poBefore },
          after: { wo: observation.woAfter, unit: observation.unitAfter, po: observation.poAfter },
          signature: observation.after,
          captureBefore: observation.captureBefore,
          capture: observation.captureAfter,
          newSignoffEvents: addedSignoff,
          newAuditEvents: (observation.auditAfter ?? []).filter((event) => !(observation.auditBefore ?? []).some((prior) => prior.id === event.id)).map((event) => ({ type: event.eventType, at: event.eventTime, workOrderId: event.workOrderId, payload: event.payload ?? null })).sort((left, right) => String(left.at).localeCompare(String(right.at)) || String(left.type).localeCompare(String(right.type))),
          winner: judgment.winner ?? null,
          executed: true,
        } : {}),
      });
    }
    if (judgment.outcome === 'contract-decision') {
      contractDecisions.push({
        id: action.id,
        action: action.action,
        decision: judgment.decision,
        status: observation.status,
        request: redactSecrets({ method: 'PATCH', route: action.route, body: action.body ?? null }),
        before: observation.woBefore ?? null,
        after: observation.woAfter ?? null,
        captureBefore: observation.captureBefore ?? null,
        captureAfter: observation.captureAfter ?? null,
      });
    }
    if (action.oracle?.noStart) {
      refusedStarts.push({
        id: action.id,
        status: observation.status,
        error: observation.errorText,
        before: { wo: observation.woBefore, unit: observation.unitBefore, po: observation.poBefore },
        after: { wo: observation.woAfter, unit: observation.unitAfter, po: observation.poAfter },
        captureBefore: observation.captureBefore,
        captureAfter: observation.captureAfter,
        newAuditEvents: (observation.auditAfter ?? []).filter((event) => !(observation.auditBefore ?? []).some((prior) => prior.id === event.id)).map((event) => ({ type: event.eventType, at: event.eventTime, workOrderId: event.workOrderId })),
        outcome: judgment.outcome,
        invariant: judgment.invariant ?? null,
      });
    }
    if (judgment.finding) {
      findings.push(finding(action, beforeLocated, responses, judgment.invariant, observation, arrived));
    }
  }

  const verdict = signatureVerdict(counters, coreBlocked);
  const cancellationRaces = summarizeCancellationRaces(plan, concurrency, blocked);
  const families = ['race-same-pass', 'race-two-actors', 'race-pass-skip', 'race-two-reopen', 'race-pass-reopen', 'race-capture-pass', 'race-ordered-levels', 'race-pass-cancel'];
  const familyOk = families.every((prefix) => {
    const runs = concurrency.filter((item) => item.id === prefix || item.id.startsWith(prefix + '-'));
    return runs.length === SIGN_RACE_REPEATS && runs.every((item) => item.outcome === 'accepted');
  });
  const chaosPass = verdict.chaosPass && cancellationRaces.pass && familyOk && concurrency.filter((item) => !item.id.includes('reset')).every((item) => item.optional || item.outcome === 'accepted');
  return {
    setupPass: true,
    capturePass: verdict.capturePass,
    chaosPass,
    pass: verdict.capturePass && chaosPass,
    signaturesPlanHash: plan.signaturesPlanHash,
    orderNo,
    workOrderIds: workOrders.map((item) => item.workOrderId),
    actors: { primary: ctx.primary, qa: ctx.actors.qa ?? null, witness: ctx.actors.witness ?? null, debugPrivileges: ctx.debugPrivileges },
    actions: decorate(counters),
    findings,
    contractDecisions,
    concurrency,
    blocked,
    observed,
    notApplicable: plan.actions.filter((item) => item.kind === 'not-applicable'),
    cancellationRaces,
    refusedStarts,
  };

  async function send(routeName, action, item, target, index, woNumber) {
    const actor = item.actor ?? action.actor ?? 'primary';
    const body = bodyFor(action, item);
    const userId = userFor(actor);
    const label = action.id + (action.parallel ? '-' + (index + 1) : '');
    if (routeName === 'cancel') {
      return call(label, 'POST', orderRoot + '/work-orders/' + target.wo.workOrderId + '/cancel', body, { userId });
    }
    if (routeName === 'data') {
      const point = target.step.dataPoints[0];
      const dataId = action.unknownDataId ? MISSING_ID : point.proStepDataId;
      return call(label, 'PATCH', orderRoot + '/work-orders/' + target.wo.workOrderId + '/steps/' + target.step.proOpeStepId + '/data/' + dataId, body, { userId });
    }
    if (routeName === 'part') {
      const partRow = target.step.parts[0];
      return call(label, 'PATCH', orderRoot + '/work-orders/' + target.wo.workOrderId + '/steps/' + target.step.proOpeStepId + '/parts/' + partRow.proStepPartId, body, { userId });
    }
    if (routeName === 'tool') {
      const toolRow = target.step.tools[0];
      const scanCode = body.scan === 'second' ? assetTagB
        : body.scan === 'inactive' ? assetTagInactive
          : body.scan === 'obsolete' ? assetTagObsolete
            : body.scan === 'tool-number' ? ('T' + token + 'SIG')
              : (body.scanCode ?? assetTag);
      const payload = body.clearScan ? { clearScan: true } : { scanCode };
      return call(label, 'PATCH', orderRoot + '/work-orders/' + target.wo.workOrderId + '/steps/' + target.step.proOpeStepId + '/tools/' + toolRow.proStepToolId, payload, { userId });
    }
    if (routeName === 'lot-lines') {
      const partRow = target.step.parts[0];
      return call(label, 'PATCH', orderRoot + '/work-orders/' + target.wo.workOrderId + '/steps/' + target.step.proOpeStepId + '/parts/' + partRow.proStepPartId + '/lot-lines', body, { userId });
    }
    if (routeName === 'part-unit') {
      const partRow = target.step.parts[0];
      const unit = partRow?.units?.[0];
      if (!unit?.proStepPartUnitId) return { status: 0, data: { error: 'part unit was not on the work order snapshot' } };
      return call(label, 'PATCH', orderRoot + '/work-orders/' + target.wo.workOrderId + '/steps/' + target.step.proOpeStepId + '/parts/' + partRow.proStepPartId + '/units/' + unit.proStepPartUnitId, body, { userId });
    }
    if (routeName === 'identity') {
      const identity = rawStep(target.wo, target.step.proOpeStepId)?.unitIdentity;
      if (!identity?.proStepUnitIdentityId) return { status: 0, data: { error: 'unit identity was not on the work order snapshot' } };
      return call(label, 'PATCH', orderRoot + '/work-orders/' + target.wo.workOrderId + '/steps/' + target.step.proOpeStepId + '/unit-identities/' + identity.proStepUnitIdentityId, body, { userId });
    }
    let signoffId = target.signoff.proStepSignoffId;
    let stepId = target.step.proOpeStepId;
    if (action.missingId) signoffId = MISSING_ID;
    if (action.malformedId) signoffId = 'not-a-uuid';
    if (action.foreign === 'step') {
      const other = target.wo.resolved.operations.find((operation) => operation.operationNo === '10')
        ?.steps.find((step) => step.stepNo === '3');
      stepId = other?.proOpeStepId ?? stepId;
    }
    if (action.foreign === 'wo') {
      const otherWo = workOrders[woNumber === 1 ? 1 : 0];
      const other = locate(action.slot, woNumber === 1 ? 2 : 1, workOrders);
      return call(label, 'PATCH', orderRoot + '/work-orders/' + otherWo.workOrderId + '/steps/' + target.step.proOpeStepId + '/signoffs/' + (other?.signoff.proStepSignoffId ?? signoffId) + '/' + routeName, body, { userId });
    }
    return call(label, 'PATCH', orderRoot + '/work-orders/' + target.wo.workOrderId + '/steps/' + stepId + '/signoffs/' + signoffId + '/' + routeName, body, { userId });
  }

  function finding(action, located, response, invariant, observation, arrived) {
    const responses = Array.isArray(response) ? response : [response];
    return {
      severity: 'high',
      seed, runId,
      signaturesPlanHash: plan.signaturesPlanHash,
      orderNo,
      workOrderId: located?.wo?.workOrderId ?? null,
      operationNo: located?.operation?.operationNo ?? located?.slot?.operationNo ?? null,
      stepNo: located?.step?.stepNo ?? null,
      proStepSignoffId: located?.signoff?.proStepSignoffId ?? null,
      category: located?.signoff?.category ?? null,
      actor: ctx.primary,
      action: action.action,
      request: redactSecrets({ method: 'PATCH', route: action.route, body: action.body ?? null }),
      response: responses.map((item) => ({ status: item?.status ?? null, body: redactSecrets(item?.data ?? null) })),
      arrival: arrived?.map((item) => ({ index: item.index + 1, status: item.response.status, code: item.response.data?.code ?? null })) ?? null,
      expected: action.oracle,
      before: observation?.before ?? null,
      after: observation?.after ?? null,
      beforeEvents: observation?.beforeEvents ?? null,
      afterEvents: observation?.afterEvents ?? null,
      invariant,
      reproduce: 'npm start -- --seed=' + seed + ' --po=1 --run-id=' + runId,
    };
  }
}

function captureStored(action, located) {
  if (action.oracle?.capture === 'data') return Boolean(located.step.dataPoints[0]?.capturedValueText);
  if (action.oracle?.capture === 'part') return Number(located.step.parts[0]?.quantityActual) >= 1;
  if (action.oracle?.capture === 'tool') return Boolean(located.step.tools[0]?.toolInstanceId) && located.step.tools[0]?.calibrationStatus === 'Pass';
  return true;
}

function blockReason(action, ctx) {
  if (action.requiresEnforcedPrivileges && ctx.debugPrivileges) return 'debug mode grants every privilege, so this rejection cannot be observed';
  if (action.requiresActor === 'qa' && !ctx.actors.qa) return 'no second active user was found';
  if (action.requiresActorAbsent === 'qa' && ctx.actors.qa) return 'the second actor already covers this ordered signature';
  if (action.requiresWitness && !ctx.actors.witness) return 'FLASHWORK_WITNESS_IDENTIFIER and FLASHWORK_WITNESS_PASSWORD are not set, or that user was not found';
  if (action.requiresObsoleteUser && !ctx.actors.obsolete) return 'no obsolete user exists in this tenant';
  if (action.requiresUnprivileged && !ctx.actors.unprivileged) return 'no user without the sign-off privilege was found';
  if ((action.requiresSkipReason || action.route === 'skip') && !ctx.reasons.skip && action.kind !== 'invalid') return 'no active skip reason is configured';
  if (action.requiresSkipReason && !ctx.reasons.skip) return 'no active skip reason is configured';
  if (action.requiresReopenReason && !ctx.reasons.reopen) return 'no active reopen reason is configured';
  if (action.requiresHold && !ctx.holdOk) return 'production order was not placed on hold';
  if (action.requiresCancel && !ctx.cancelOk) return 'work order was not cancelled';
  if (action.requiresObsolete && !ctx.obsoleteOk) return 'the obsolete tool could not be retired';
  return null;
}

async function resolveActors(call, envUserId) {
  const debug = await call('probe privileges', 'GET', '/app/me/privileges', undefined, { userId: null });
  const debugPrivileges = debug.status >= 200 && debug.status < 300;
  const listed = await call('list users', 'GET', '/admin/users', undefined, { userId: envUserId });
  const users = listOf(listed.data, 'users');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let primary = uuid.test(String(envUserId ?? '')) ? String(envUserId) : null;
  if (!primary) {
    const match = users.find((user) => String(user.email ?? '').toLowerCase() === String(envUserId ?? '').toLowerCase()
      || String(user.badge ?? '').toLowerCase() === String(envUserId ?? '').toLowerCase());
    primary = match?.userId ?? null;
  }
  if (!primary) return { primary: null, reason: 'FLASHWORK_USER_ID did not match a user UUID, email, or badge' };
  const active = users.filter((user) => user.status === 'active' && user.userId !== primary);
  const qa = active.find((user) => (user.roles ?? []).some((role) => role.name === 'QA')) ?? active[0] ?? null;
  const obsolete = users.find((user) => user.status === 'obsolete') ?? null;
  const witnessId = process.env.FLASHWORK_WITNESS_IDENTIFIER;
  const witness = witnessId && process.env.FLASHWORK_WITNESS_PASSWORD
    ? users.find((user) => String(user.email ?? '').toLowerCase() === witnessId.toLowerCase() || String(user.badge ?? '').toLowerCase() === witnessId.toLowerCase())
    : null;
  let unprivileged = null;
  for (const user of active) {
    if (user.userId === qa?.userId) continue;
    const privileges = await call('read actor privileges', 'GET', '/app/me/privileges', undefined, { userId: user.userId });
    const keys = privileges.data?.privilegeKeys ?? [];
    if (!debugPrivileges && !keys.includes('signoff.operator') && !keys.includes('*')) {
      unprivileged = user;
      break;
    }
  }
  return {
    primary,
    debugPrivileges,
    actors: {
      primary,
      qa: qa?.userId ?? null,
      witness: witness?.userId ?? null,
      obsolete: obsolete?.userId ?? null,
      unprivileged: unprivileged?.userId ?? null,
    },
  };
}

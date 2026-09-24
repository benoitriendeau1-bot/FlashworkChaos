import fs from 'node:fs';
import path from 'node:path';

export function rng(seed) {
  let state = Number(seed) >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}
export const integer = (random, low, high) => low + Math.floor(random() * (high - low + 1));
/** Quantity sketch kept for the step-collision regression. Manufacturing content is compileScenarios. */
export function plan(seed, count) {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    operations: integer(random, 3, 12),
    stepsPerOperation: Array.from({ length: 12 }, () => integer(random, 1, 3)),
    dataPerStep: Array.from({ length: 36 }, () => integer(random, 1, 4)),
    units: integer(random, 1, 8),
    invalidNumeric: 1,
  }));
}
export class Api {
  constructor(base, clientId, userId, timeout = 15000) {
    this.base = base.replace(/\/$/, '');
    this.clientId = clientId;
    this.userId = userId;
    this.timeout = timeout;
    this.cookie = '';
  }
  async call(method, route, body, options = {}) {
    const userId = Object.prototype.hasOwnProperty.call(options, 'userId') ? options.userId : this.userId;
    const response = await fetch(this.base + route, {
      method,
      headers: { 'content-type': 'application/json', 'X-Client-Id': this.clientId,
        ...(userId ? { 'X-User-Id': userId } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw.slice(0, 1000); }
    return { status: response.status, data };
  }
}
export function identifier(data, names) {
  const candidates = [data, data?.data, data?.result, data?.item, data?.value];
  for (const obj of candidates) for (const name of names) {
    if (obj && typeof obj === 'object' && typeof obj[name] === 'string') return obj[name];
  }
  return undefined;
}

function payloadObjects(data) {
  return [data, data?.data, data?.result, data?.item, data?.value];
}

/** Creating an operation inserts step 1. Posting that number again is a 409. */
export function seededStepFromOperation(data) {
  for (const obj of payloadObjects(data)) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.steps)) continue;
    const step = obj.steps.find((row) => row && Number(row.stepNo) === 1 && typeof row.masOpeStepId === 'string')
      ?? obj.steps.find((row) => row && typeof row.masOpeStepId === 'string');
    if (step) return { masOpeStepId: step.masOpeStepId, stepNo: Number(step.stepNo) };
  }
  return undefined;
}

export function stepsAfterSeededOperation(operation, planned) {
  const seeded = seededStepFromOperation(operation);
  const plannedSteps = Array.isArray(planned)
    ? planned
    : Array.from({ length: Number.isInteger(planned) ? planned : 0 }, (_, index) => ({
        stepNo: index + 1,
        stepTitle: 'Inspect and record ' + (index + 1),
        toolsFirst: false,
      }));
  if (!seeded || plannedSteps.length < 1) {
    return { seeded: seeded ?? null, name: null, creates: [] };
  }
  const first = plannedSteps[0];
  const description = first.stepDescription ?? first.instruction;
  return {
    seeded,
    name: {
      stepTitle: first.stepTitle ?? first.title ?? 'Inspect and record 1',
      ...(description ? { stepDescription: description } : {}),
      toolsFirst: false,
    },
    creates: plannedSteps.slice(1).map((step, index) => {
      const stepDescription = step.stepDescription ?? step.instruction;
      return {
        stepNo: step.stepNo ?? seeded.stepNo + index + 1,
        stepTitle: step.stepTitle ?? step.title ?? 'Inspect and record ' + (index + 2),
        ...(stepDescription ? { stepDescription } : {}),
        toolsFirst: false,
      };
    }),
  };
}

export function classifyAuthoringConflict(status, error) {
  if (status !== 409 || typeof error !== 'string') return null;
  const step = /^Step number (\d+) is already used in this operation$/.exec(error);
  if (step) return { kind: 'step-number', stepNo: Number(step[1]) };
  const operation = /^Operation number (.+) already exists on this master item$/.exec(error);
  if (operation) return { kind: 'operation-number', operationNo: operation[1] };
  return { kind: 'other', error };
}

export function releaseSignoffGap(error) {
  if (typeof error !== 'string') return null;
  const match = /^Every step must have at least one sign-off before release \(operation (.+) step (\d+)\)\.$/.exec(error);
  return match ? { operationNo: match[1], stepNo: Number(match[2]) } : null;
}

export function pickReleasableSignoffRequirement(payload) {
  const rows = Array.isArray(payload?.requirements)
    ? payload.requirements
    : Array.isArray(payload?.data?.requirements)
      ? payload.data.requirements
      : [];
  const active = rows.filter((row) =>
    row
    && typeof row.signOffRequirementId === 'string'
    && row.isActive !== false
    && !row.requiresSignOffRequirementId);
  const stepScoped = active.filter((row) => row.scope == null || row.scope === 'step');
  const pool = stepScoped.length > 0 ? stepScoped : active;
  return pool.find((row) => row.level == null || Number(row.level) === 1) ?? pool[0] ?? null;
}

export function signoffForRelease(masOpeStepId, requirement) {
  return {
    masOpeStepId,
    signOffRequirementId: requirement.signOffRequirementId,
    level: 1,
  };
}

export const PART_TRACEABILITY_MODES = [
  'None', 'Serial', 'Lot', 'Heat', 'SerialLot', 'SerialHeat', 'LotHeat', 'SerialLotHeat',
];
export const TOOL_CAPTURE_POLICIES = ['required', 'optional', 'info_only'];

export function runToken(runId) {
  return String(runId).replaceAll('-', '').toUpperCase().slice(0, 20);
}

export function catalogSpec(runId) {
  const token = runToken(runId);
  const calibratedAt = '2020-01-15T12:00:00.000Z';
  const calibrations = [
    { calibrationBasis: 'none' },
    { calibrationBasis: 'calendar', defaultCalibrationIntervalDays: 365, lastCalibratedAt: calibratedAt },
    { calibrationBasis: 'usage', defaultCalibrationIntervalUses: 50, lastCalibratedAt: calibratedAt },
  ];
  return {
    categoryName: 'CH' + token,
    parts: PART_TRACEABILITY_MODES.map((traceabilityMode, index) => ({
      partNumber: 'P' + token + String(index + 1).padStart(2, '0'),
      description: traceabilityMode + ' component ' + token,
      traceabilityMode,
    })),
    tools: TOOL_CAPTURE_POLICIES.map((defaultCapturePolicy, index) => ({
      toolNumber: 'T' + token + String(index + 1).padStart(2, '0'),
      name: defaultCapturePolicy + ' tool ' + token,
      description: 'Capture policy ' + defaultCapturePolicy,
      defaultCapturePolicy,
      ...calibrations[index],
      assetTag: 'AT' + token + String(index + 1).padStart(2, '0'),
      serialNo: 'SN' + token + String(index + 1).padStart(2, '0'),
    })),
  };
}

export function stepInstruction(operationNo, stepNo) {
  return 'Operation ' + operationNo + ' step ' + stepNo
    + ': clean the mating faces, install the called component, torque the fastener inside the recorded limits, and confirm the tool identity before sign-off.';
}

export function instructionBlocksBody(text) {
  return {
    blocks: [{
      blockOrder: 0,
      locationKey: 'top',
      blockType: 'INSTRUCTION',
      contentJson: {
        version: 4,
        rows: [{
          layout: '1',
          blocks: [{
            type: 'text',
            docJson: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            },
          }],
        }],
      },
    }],
  };
}

const NUMERIC_SPECS = [
  { label: 'Fastener torque', minValue: 12, maxValue: 18, nominalValue: 15 },
  { label: 'Flange gap', minValue: 0.05, maxValue: 0.3, nominalValue: 0.15 },
  { label: 'Surface temperature', minValue: 15, maxValue: 35, nominalValue: 22 },
];

export function distribute(stepCount, itemCount) {
  const buckets = Array.from({ length: stepCount }, () => []);
  if (stepCount < 1 || itemCount < 1) return buckets;
  for (let i = 0; i < itemCount; i++) buckets[i % stepCount].push(i);
  for (let i = 0; i < stepCount; i++) {
    if (buckets[i].length === 0) buckets[i].push(i % itemCount);
  }
  return buckets;
}

export function dataPointBody(stepId, seq) {
  const referenceCode = 'D' + String(seq).padStart(4, '0');
  const kind = seq % 3;
  if (kind === 0) {
    const spec = NUMERIC_SPECS[Math.floor(seq / 3) % NUMERIC_SPECS.length];
    return {
      masOpeStepId: stepId, referenceCode, label: spec.label + ' ' + seq,
      dataType: 'number', isMandatory: false,
      minValue: spec.minValue, maxValue: spec.maxValue, nominalValue: spec.nominalValue,
    };
  }
  if (kind === 1) {
    return {
      masOpeStepId: stepId, referenceCode, label: 'Inspection note ' + seq,
      dataType: 'text', isMandatory: false,
    };
  }
  return {
    masOpeStepId: stepId, referenceCode, label: 'Condition confirmed ' + seq,
    dataType: 'boolean', isMandatory: false,
  };
}

function stepTexts(step) {
  const texts = [];
  if (typeof step.stepDescription === 'string' && step.stepDescription.trim()) texts.push(step.stepDescription.trim());
  for (const block of step.blocks ?? []) {
    const rows = block?.contentJson?.rows ?? [];
    for (const row of rows) for (const child of row?.blocks ?? []) {
      for (const node of child?.docJson?.content ?? []) {
        for (const span of node?.content ?? []) {
          if (typeof span?.text === 'string' && span.text.trim()) texts.push(span.text.trim());
        }
      }
    }
  }
  return texts;
}

export function snapshotFacts(detail) {
  const steps = [];
  for (const operation of detail?.operations ?? []) {
    for (const step of operation.steps ?? []) {
      steps.push({
        operationNo: String(operation.operationNo ?? ''),
        operationTitle: operation.operationTitle ?? operation.operationName ?? null,
        stepNo: step.stepNo ?? step.stepOrder,
        stepTitle: step.stepTitle ?? null,
        stepId: step.masOpeStepId ?? step.proOpeStepId ?? null,
        texts: stepTexts(step),
        parts: (step.parts ?? []).map((part) => ({
          partId: part.part?.partId ?? part.partId ?? null,
          partNumber: part.part?.partNumber ?? part.partNumber ?? null,
          traceabilityMode: part.part?.traceabilityMode ?? part.traceabilityMode ?? null,
          quantity: part.quantityRequired ?? null,
        })),
        tools: (step.tools ?? []).map((tool) => ({
          toolId: tool.tool?.toolId ?? tool.toolId ?? null,
          toolNumber: tool.tool?.toolNumber ?? tool.toolNumber ?? null,
          capturePolicy: tool.capturePolicy ?? tool.tool?.defaultCapturePolicy ?? null,
        })),
        dataPoints: (step.dataPoints ?? []).map((point) => ({
          referenceCode: point.referenceCode ?? null,
          label: point.label ?? null,
          dataType: point.dataType ?? null,
          unit: point.unit ?? point.unitOfMeasure ?? null,
          minValue: point.minValue ?? point.validationRule?.minValue ?? null,
          maxValue: point.maxValue ?? point.validationRule?.maxValue ?? null,
          nominalValue: point.nominalValue ?? point.validationRule?.nominalValue ?? null,
          defaultValue: point.defaultValue ?? point.validationRule?.defaultValue ?? null,
        })),
        signoffCount: (step.signoffs ?? []).length,
        signoffIds: (step.signoffs ?? []).map((signoff) => signoff.signOffRequirementId).filter(Boolean),
      });
    }
  }
  return { operationCount: (detail?.operations ?? []).length, steps };
}

function boundedNumber(point) {
  if (point.dataType !== 'number' && point.dataType !== 'measurement') return false;
  const min = Number(point.minValue);
  const max = Number(point.maxValue);
  const nominal = Number(point.nominalValue);
  return Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(nominal) && min < nominal && nominal < max;
}

export function catalogGaps(records) {
  const gaps = [];
  const parts = records?.parts ?? [];
  const tools = records?.tools ?? [];
  for (const part of parts) {
    if (!part.partId) gaps.push({ level: 'catalog', reason: 'part has no API id', ids: { partNumber: part.partNumber } });
    if (part.partId && !part.confirmed) {
      gaps.push({ level: 'catalog', reason: 'part was not confirmed by a catalog read', ids: { partId: part.partId, partNumber: part.partNumber } });
    }
  }
  for (const tool of tools) {
    if (!tool.toolId) gaps.push({ level: 'catalog', reason: 'tool has no API id', ids: { toolNumber: tool.toolNumber } });
    if (tool.toolId && !tool.confirmed) {
      gaps.push({ level: 'catalog', reason: 'tool was not confirmed by a catalog read', ids: { toolId: tool.toolId, toolNumber: tool.toolNumber } });
    }
    if (!tool.toolInstanceId) {
      gaps.push({ level: 'catalog', reason: 'tool instance has no API id', ids: { toolId: tool.toolId ?? null, toolNumber: tool.toolNumber } });
    }
  }
  return gaps;
}

export function masterItemGaps(detail) {
  const gaps = [];
  const masterItemNo = detail?.masterItem?.masterItemNo ?? null;
  const operations = detail?.operations ?? [];
  if (operations.length < 3) {
    gaps.push({ level: 'masterItem', reason: 'fewer than 3 operations on the master item read-back', ids: { masterItemNo, operationCount: operations.length } });
  }
  for (const operation of operations) {
    if ((operation.steps ?? []).length === 0) {
      gaps.push({
        level: 'masterItem',
        reason: 'operation has no steps on the master item read-back',
        ids: { masterItemNo, masOpeId: operation.masOpeId ?? null, operationNo: operation.operationNo ?? null },
      });
    }
  }
  const facts = snapshotFacts(detail);
  const modes = new Set();
  const policies = new Set();
  const types = new Set();
  let numericBounded = false;
  for (const step of facts.steps) {
    const ids = { masterItemNo, stepId: step.stepId, operationNo: step.operationNo, stepNo: step.stepNo };
    if (!step.texts.some((text) => text.startsWith('Operation ' + step.operationNo + ' step ' + step.stepNo + ':'))) {
      gaps.push({ level: 'masterItem', reason: 'step has no work instruction', ids });
    }
    if (step.signoffCount < 1) gaps.push({ level: 'masterItem', reason: 'step has no sign-off', ids });
    if (step.parts.length < 1) gaps.push({ level: 'masterItem', reason: 'step has no part', ids });
    if (step.tools.length < 1) gaps.push({ level: 'masterItem', reason: 'step has no tool', ids });
    for (const part of step.parts) if (part.traceabilityMode) modes.add(part.traceabilityMode);
    for (const tool of step.tools) if (tool.capturePolicy) policies.add(tool.capturePolicy);
    for (const point of step.dataPoints) {
      if (point.dataType) types.add(point.dataType);
      if (boundedNumber(point)) numericBounded = true;
    }
  }
  for (const mode of PART_TRACEABILITY_MODES) {
    if (!modes.has(mode)) gaps.push({ level: 'masterItem', reason: 'master item missing part traceability mode ' + mode, ids: { masterItemNo, traceabilityMode: mode } });
  }
  for (const policy of TOOL_CAPTURE_POLICIES) {
    if (!policies.has(policy)) gaps.push({ level: 'masterItem', reason: 'master item missing tool capture policy ' + policy, ids: { masterItemNo, capturePolicy: policy } });
  }
  for (const type of ['number', 'text', 'boolean']) {
    if (!types.has(type)) gaps.push({ level: 'masterItem', reason: 'master item missing ' + type + ' DATA', ids: { masterItemNo, dataType: type } });
  }
  if (!numericBounded) gaps.push({ level: 'masterItem', reason: 'no numeric DATA with min < nominal < max', ids: { masterItemNo } });
  return gaps;
}

function factIndex(facts) {
  return {
    partNumbers: new Set(facts.steps.flatMap((step) => step.parts.map((part) => part.partNumber).filter(Boolean))),
    toolNumbers: new Set(facts.steps.flatMap((step) => step.tools.map((tool) => tool.toolNumber).filter(Boolean))),
    referenceCodes: new Set(facts.steps.flatMap((step) => step.dataPoints.map((point) => point.referenceCode).filter(Boolean))),
    dataTypes: new Set(facts.steps.flatMap((step) => step.dataPoints.map((point) => point.dataType).filter(Boolean))),
    modes: new Set(facts.steps.flatMap((step) => step.parts.map((part) => part.traceabilityMode).filter(Boolean))),
    policies: new Set(facts.steps.flatMap((step) => step.tools.map((tool) => tool.capturePolicy).filter(Boolean))),
    texts: facts.steps.flatMap((step) => step.texts),
  };
}

export function workOrderGaps(masterDetail, workOrderDetail) {
  const gaps = [];
  const workOrderId = workOrderDetail?.workOrder?.workOrderId ?? null;
  const master = snapshotFacts(masterDetail);
  const snapshot = snapshotFacts(workOrderDetail);
  const wanted = factIndex(master);
  const found = factIndex(snapshot);
  for (const partNumber of wanted.partNumbers) {
    if (!found.partNumbers.has(partNumber)) {
      gaps.push({ level: 'workOrder', reason: 'snapshot missing part', ids: { workOrderId, partNumber } });
    }
  }
  for (const toolNumber of wanted.toolNumbers) {
    if (!found.toolNumbers.has(toolNumber)) {
      gaps.push({ level: 'workOrder', reason: 'snapshot missing tool', ids: { workOrderId, toolNumber } });
    }
  }
  for (const referenceCode of wanted.referenceCodes) {
    if (!found.referenceCodes.has(referenceCode)) {
      gaps.push({ level: 'workOrder', reason: 'snapshot missing DATA', ids: { workOrderId, referenceCode } });
    }
  }
  for (const dataType of wanted.dataTypes) {
    if (!found.dataTypes.has(dataType)) {
      gaps.push({ level: 'workOrder', reason: 'snapshot missing ' + dataType + ' DATA', ids: { workOrderId, dataType } });
    }
  }
  for (const mode of wanted.modes) {
    if (!found.modes.has(mode)) {
      gaps.push({ level: 'workOrder', reason: 'snapshot missing part traceability mode ' + mode, ids: { workOrderId, traceabilityMode: mode } });
    }
  }
  for (const policy of wanted.policies) {
    if (!found.policies.has(policy)) {
      gaps.push({ level: 'workOrder', reason: 'snapshot missing tool capture policy ' + policy, ids: { workOrderId, capturePolicy: policy } });
    }
  }
  for (const step of master.steps) {
    const mirroredText = snapshot.steps.find((candidate) => candidate.operationNo === step.operationNo && String(candidate.stepNo) === String(step.stepNo));
    if (step.texts.some((text) => text.length > 0) && !step.texts.every((text) => (mirroredText?.texts ?? []).some((found) => found.includes(text)))) {
      gaps.push({ level: 'workOrder', reason: 'snapshot missing work instruction', ids: { workOrderId, operationNo: step.operationNo, stepNo: step.stepNo } });
    }
    const mirrored = snapshot.steps.find((candidate) => candidate.operationNo === step.operationNo && String(candidate.stepNo) === String(step.stepNo));
    if (step.signoffCount > 0 && (!mirrored || mirrored.signoffCount < 1)) {
      gaps.push({ level: 'workOrder', reason: 'snapshot step has no sign-off', ids: { workOrderId, operationNo: step.operationNo, stepNo: step.stepNo, stepId: mirrored?.stepId ?? null } });
    }
  }
  const numeric = snapshot.steps.flatMap((step) => step.dataPoints).find((point) => boundedNumber(point));
  if ((wanted.dataTypes.has('number') || wanted.dataTypes.has('measurement')) && !numeric) {
    gaps.push({ level: 'workOrder', reason: 'snapshot numeric DATA has no min < nominal < max', ids: { workOrderId } });
  }
  return gaps;
}

export function levelCounts(records, masterDetails, workOrderDetails) {
  const masterFacts = masterDetails.map(snapshotFacts);
  const workFacts = workOrderDetails.map(snapshotFacts);
  const countSteps = (groups, pick) => groups.reduce((sum, facts) => sum + facts.steps.reduce((inner, step) => inner + pick(step), 0), 0);
  return {
    catalog: {
      parts: (records?.parts ?? []).filter((part) => part.confirmed && part.partId).length,
      tools: (records?.tools ?? []).filter((tool) => tool.confirmed && tool.toolId).length,
      toolInstances: (records?.tools ?? []).filter((tool) => tool.toolInstanceId).length,
    },
    masterItems: {
      masterItems: masterDetails.length,
      operations: masterFacts.reduce((sum, facts) => sum + facts.operationCount, 0),
      steps: masterFacts.reduce((sum, facts) => sum + facts.steps.length, 0),
      instructions: countSteps(masterFacts, (step) => step.texts.length > 0 ? 1 : 0),
      parts: countSteps(masterFacts, (step) => step.parts.length),
      tools: countSteps(masterFacts, (step) => step.tools.length),
      numericData: countSteps(masterFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'number').length),
      measurementData: countSteps(masterFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'measurement').length),
      textData: countSteps(masterFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'text').length),
      booleanData: countSteps(masterFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'boolean').length),
      dateData: countSteps(masterFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'date').length),
      enumData: countSteps(masterFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'enum').length),
      signoffs: countSteps(masterFacts, (step) => step.signoffCount),
    },
    workOrders: {
      workOrders: workOrderDetails.length,
      instructions: countSteps(workFacts, (step) => step.texts.length > 0 ? 1 : 0),
      parts: countSteps(workFacts, (step) => step.parts.length),
      tools: countSteps(workFacts, (step) => step.tools.length),
      numericData: countSteps(workFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'number').length),
      measurementData: countSteps(workFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'measurement').length),
      textData: countSteps(workFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'text').length),
      booleanData: countSteps(workFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'boolean').length),
      dateData: countSteps(workFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'date').length),
      enumData: countSteps(workFacts, (step) => step.dataPoints.filter((point) => point.dataType === 'enum').length),
      signoffs: countSteps(workFacts, (step) => step.signoffCount),
    },
  };
}
export function reportWriter(dir, seed) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  return {
    file,
    write(event) { fs.appendFileSync(file, JSON.stringify({ seed, ...event }) + '\n'); },
    finish(summary) { fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); },
  };
}

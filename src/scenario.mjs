import { createHash } from 'node:crypto';
import { integer, rng, snapshotFacts } from './engine.mjs';
import {
  CONSUMABLE_MODES, DATA_ROLES, ENUM_SETS, FAMILIES, LOT_MODES, PART_ROLES, SERIAL_MODES, TOOL_ROLES,
} from './manufacturing.mjs';

const BIASES = ['center', 'low', 'high'];
const NOTE_LINES = [
  'Vérifier la pièce (µ) et noter toute trace anormale.',
  'Contrôle visuel: absence de bavure, copeau ou résidu.',
  'La surface doit rester propre avant de continuer.',
];

function pick(random, list) {
  return list[integer(random, 0, list.length - 1)];
}

function shuffle(items, random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function specBounds(nominal, tolerance, places, bias) {
  const step = 10 ** -places;
  let min = roundTo(nominal - tolerance, places);
  let max = roundTo(nominal + tolerance, places);
  if (!(max > min)) max = roundTo(min + step * 2, places);
  const ratio = bias === 'low' ? 0.25 : bias === 'high' ? 0.75 : 0.5;
  let value = roundTo(min + (max - min) * ratio, places);
  if (!(value > min)) value = roundTo(min + step, places);
  if (!(value < max)) value = roundTo(max - step, places);
  if (!(value > min && value < max)) {
    min = roundTo(nominal - step, places);
    max = roundTo(nominal + step, places);
    value = roundTo(nominal, places);
  }
  return { minValue: min, maxValue: max, nominalValue: value };
}

function padText(base, length) {
  const extra = ' Noter le résultat du contrôle et l\'état de la pièce (µ).';
  let text = base;
  while (text.length < length) text += extra;
  return text.slice(0, Math.max(length, base.length));
}

function selectOperations(family, random) {
  const required = family.operations.filter((operation) => operation.required)
    .map((operation, index) => ({ ...operation, orderKey: index }));
  const optional = family.operations.filter((operation) => !operation.required)
    .map((operation) => ({ ...operation }));
  const shuffled = shuffle(optional, random);
  shuffled.forEach((operation, index) => {
    operation.orderKey = index + 1;
  });
  const target = integer(random, required.length, family.operations.length);
  const selected = required.concat(shuffled.slice(0, target - required.length));
  selected.sort((a, b) => a.phase - b.phase || a.orderKey - b.orderKey);
  return selected;
}

function expandData(role, random, context) {
  const spec = DATA_ROLES[role];
  const nominal = pick(random, spec.nominals ?? [0]);
  const tolerance = pick(random, spec.tolerances ?? [0]);
  const bias = pick(random, BIASES);
  const point = {
    role,
    label: spec.label,
    dataType: spec.dataType,
    unit: spec.dataType === 'measurement' ? spec.unit : null,
    minValue: null,
    maxValue: null,
    nominalValue: null,
    defaultValue: null,
    description: null,
  };
  if (spec.dataType === 'measurement' || spec.dataType === 'number') {
    Object.assign(point, specBounds(nominal, tolerance, spec.places, bias));
  } else if (spec.dataType === 'text') {
    point.label = 'Note de contrôle — pièce µ';
    point.description = padText(context.noteLine, context.longTextLength);
  } else if (spec.dataType === 'enum') {
    point.defaultValue = context.enumSet.join('|');
    point.description = 'Choix permis: ' + context.enumSet.join(', ') + '.';
  } else if (spec.dataType === 'date') {
    point.description = 'Enregistrer la date calendaire de fin de cette étape, sans heure.';
  } else if (spec.dataType === 'boolean') {
    point.description = 'Oui seulement si le contrôle visuel de {product} est acceptable.'.replaceAll('{product}', context.productName);
  }
  return point;
}

function compileScenario(random, index) {
  const family = FAMILIES[integer(random, 0, FAMILIES.length - 1)];
  const product = family.products[integer(random, 0, family.products.length - 1)];
  const units = integer(random, 1, 8);
  const operations = selectOperations(family, random);
  const enumSet = pick(random, ENUM_SETS);
  const longTextLength = integer(random, 400, 520);
  const noteLine = pick(random, NOTE_LINES);
  const context = { enumSet, longTextLength, noteLine, productName: product.name };
  let reference = 0;
  const compiledOps = operations.map((operation, operationIndex) => {
    const steps = operation.steps.map((step, stepIndex) => {
      const parts = step.parts.map((role) => {
        const spec = PART_ROLES[role];
        return {
          role,
          key: null,
          name: spec.name,
          traceabilityMode: pick(random, spec.modes),
          quantity: pick(random, spec.quantities),
        };
      });
      for (const part of parts) part.key = part.role + '|' + part.traceabilityMode;
      const tools = step.tools.map((role) => {
        const spec = TOOL_ROLES[role];
        const capturePolicy = pick(random, spec.policies);
        return {
          role,
          key: role + '|' + capturePolicy + '|' + spec.calibration,
          name: spec.name,
          capturePolicy,
          calibrationBasis: spec.calibration,
          defaultCalibrationIntervalDays: spec.days ?? null,
          defaultCalibrationIntervalUses: spec.uses ?? null,
        };
      });
      const dataPoints = step.data.map((role) => expandData(role, random, context));
      for (const point of dataPoints) {
        reference += 1;
        point.referenceCode = 'D' + String(reference).padStart(4, '0');
      }
      const instruction = padText(
        step.instruction.replaceAll('{product}', product.name),
        stepIndex === operation.steps.length - 1 && operation.id === 'final' ? longTextLength : 0,
      );
      return {
        stepNo: stepIndex + 1,
        title: step.title,
        instruction,
        signoff: { ...step.signoff },
        parts,
        tools,
        dataPoints,
      };
    });
    return {
      operationNo: String((operationIndex + 1) * 10),
      phase: operation.phase,
      title: operation.title,
      description: operation.description,
      mustCompleteBeforeLater: false,
      steps,
    };
  });
  for (let i = 0; i < compiledOps.length; i++) {
    const next = compiledOps[i + 1];
    compiledOps[i].mustCompleteBeforeLater = Boolean(next && next.phase > compiledOps[i].phase);
  }
  applyEdges(compiledOps);
  return {
    index,
    familyId: family.id,
    familyLabel: family.label,
    productName: product.name,
    description: (product.name + '. ' + family.label + '.').slice(0, 255),
    units,
    invalidNumeric: 1,
    operations: compiledOps,
  };
}

function applyEdges(operations) {
  const points = operations.flatMap((operation) => operation.steps.flatMap((step) => step.dataPoints));
  const zero = points.find((point) => DATA_ROLES[point.role]?.allowMinZero);
  if (zero && zero.nominalValue > 0 && zero.maxValue > zero.nominalValue) zero.minValue = 0;
  const centered = points.find((point) =>
    (point.dataType === 'measurement' || point.dataType === 'number') && point !== zero);
  if (centered) {
    const places = DATA_ROLES[centered.role].places;
    const mid = roundTo((centered.minValue + centered.maxValue) / 2, places);
    if (mid > centered.minValue && mid < centered.maxValue) centered.nominalValue = mid;
  }
}

export function compileScenarios(seed, count) {
  const random = rng(seed);
  const scenarios = [];
  for (let index = 0; index < count; index++) scenarios.push(compileScenario(random, index + 1));
  return { seed, count, planHash: planHash(scenarios), scenarios };
}

export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function planHash(scenarios) {
  return createHash('sha256').update(stableStringify(scenarios)).digest('hex');
}

export function bindPlan(compiled, { prefix, runId }) {
  const token = String(runId).replaceAll('-', '').toUpperCase().slice(0, 12);
  const parts = [];
  const tools = [];
  const partIndex = new Map();
  const toolIndex = new Map();
  const scenarios = compiled.scenarios.map((scenario) => {
    const suffix = String(scenario.index).padStart(4, '0');
    const masterItemNo = 'MI-' + prefix + token + suffix;
    const orderNo = 'PO' + prefix + token + suffix;
    const operations = scenario.operations.map((operation) => ({
      ...operation,
      steps: operation.steps.map((step) => ({
        ...step,
        parts: step.parts.map((part) => {
          if (!partIndex.has(part.key)) {
            const number = 'P' + token + String(parts.length + 1).padStart(3, '0');
            partIndex.set(part.key, number);
            parts.push({
              key: part.key,
              role: part.role,
              partNumber: number,
              description: (part.name + '. Traçabilité ' + part.traceabilityMode + '.').slice(0, 255),
              traceabilityMode: part.traceabilityMode,
            });
          }
          return { ...part, partNumber: partIndex.get(part.key) };
        }),
        tools: step.tools.map((tool) => {
          if (!toolIndex.has(tool.key)) {
            const number = 'T' + token + String(tools.length + 1).padStart(3, '0');
            const serial = String(tools.length + 1).padStart(3, '0');
            toolIndex.set(tool.key, number);
            tools.push({
              key: tool.key,
              role: tool.role,
              toolNumber: number,
              name: tool.name,
              description: ('Capture ' + tool.capturePolicy + ', calibration ' + tool.calibrationBasis).slice(0, 255),
              capturePolicy: tool.capturePolicy,
              calibrationBasis: tool.calibrationBasis,
              defaultCalibrationIntervalDays: tool.defaultCalibrationIntervalDays,
              defaultCalibrationIntervalUses: tool.defaultCalibrationIntervalUses,
              assetTag: 'AT' + token + serial,
              serialNo: 'SN' + token + serial,
              lastCalibratedAt: tool.calibrationBasis === 'none' ? null : '2020-01-15T12:00:00.000Z',
            });
          }
          return { ...tool, toolNumber: toolIndex.get(tool.key) };
        }),
      })),
    }));
    return { ...scenario, masterItemNo, orderNo, operations };
  });
  return {
    ...compiled,
    runId,
    prefix,
    scenarios,
    catalog: { categoryName: ('CH' + token).slice(0, 100), parts, tools },
  };
}

export function coherenceViolations(scenario) {
  const violations = [];
  let previousPhase = -1;
  scenario.operations.forEach((operation, index) => {
    if (operation.phase < previousPhase) {
      violations.push({ reason: 'operation phase goes backwards', ids: { operationNo: operation.operationNo } });
    }
    previousPhase = operation.phase;
    const next = scenario.operations[index + 1];
    const blocking = Boolean(next && next.phase > operation.phase);
    if (operation.mustCompleteBeforeLater !== blocking) {
      violations.push({ reason: 'mustCompleteBeforeLater does not follow the phase sequence', ids: { operationNo: operation.operationNo } });
    }
    for (const step of operation.steps) {
      const ids = { operationNo: operation.operationNo, stepNo: step.stepNo };
      if (!step.instruction || step.instruction.length > 2000) {
        violations.push({ reason: 'step instruction missing or over 2000 characters', ids });
      }
      for (const point of step.dataPoints) {
        const spec = DATA_ROLES[point.role];
        if (!spec) {
          violations.push({ reason: 'unknown data role', ids: { ...ids, role: point.role } });
          continue;
        }
        if (point.referenceCode.length > 20) violations.push({ reason: 'reference code over 20 characters', ids });
        if (spec.dataType === 'measurement') {
          if (point.unit !== spec.unit) violations.push({ reason: 'measurement unit does not match the data role', ids: { ...ids, role: point.role, unit: point.unit } });
          if (!(point.minValue < point.nominalValue && point.nominalValue < point.maxValue)) {
            violations.push({ reason: 'measurement bounds are not min < nominal < max', ids: { ...ids, referenceCode: point.referenceCode } });
          }
          const tool = step.tools.find((item) => spec.toolRoles.includes(item.role) && item.capturePolicy === 'required');
          if (spec.toolRoles.length > 0 && !tool) {
            violations.push({ reason: 'measurement has no required tool of the matching role', ids: { ...ids, role: point.role } });
          }
        }
        if (spec.dataType === 'number' && point.unit) violations.push({ reason: 'count data carries a unit', ids });
        if (spec.dataType !== 'measurement' && spec.dataType !== 'number' && (point.minValue != null || point.maxValue != null || point.nominalValue != null)) {
          violations.push({ reason: 'non-numeric data has numeric bounds', ids: { ...ids, dataType: spec.dataType } });
        }
        if ((point.dataType === 'boolean' || point.dataType === 'text' || point.dataType === 'date' || point.dataType === 'enum') && point.unit) {
          violations.push({ reason: 'non-measurement data has a unit', ids });
        }
      }
      for (const part of step.parts) {
        const spec = PART_ROLES[part.role];
        if (!spec.modes.includes(part.traceabilityMode)) {
          violations.push({ reason: 'part traceability is not allowed for its role', ids: { ...ids, role: part.role, traceabilityMode: part.traceabilityMode } });
        }
        if (spec.kind === 'consumable' && !CONSUMABLE_MODES.has(part.traceabilityMode)) {
          violations.push({ reason: 'consumable is not traced by lot or heat', ids: { ...ids, role: part.role } });
        }
        if (spec.kind === 'critical' && !SERIAL_MODES.has(part.traceabilityMode)) {
          violations.push({ reason: 'critical part is not serialized', ids: { ...ids, role: part.role } });
        }
        if (!(part.quantity > 0)) violations.push({ reason: 'part quantity is not positive', ids });
      }
      for (const tool of step.tools) {
        const spec = TOOL_ROLES[tool.role];
        if (!spec.policies.includes(tool.capturePolicy)) {
          violations.push({ reason: 'tool capture policy is not allowed for its role', ids: { ...ids, role: tool.role, capturePolicy: tool.capturePolicy } });
        }
        if (spec.policies.length === 1 && spec.policies[0] === 'required' && tool.capturePolicy !== 'required') {
          violations.push({ reason: 'measuring tool is not required', ids: { ...ids, role: tool.role } });
        }
        if (tool.calibrationBasis !== spec.calibration) {
          violations.push({ reason: 'tool calibration does not match its role', ids: { ...ids, role: tool.role } });
        }
      }
    }
  });
  return violations;
}

export function coverageViolations(scenario) {
  const violations = [];
  const ids = { masterItemNo: scenario.masterItemNo ?? null, index: scenario.index };
  if (scenario.operations.length < 3) violations.push({ reason: 'fewer than 3 operations', ids });
  const points = scenario.operations.flatMap((operation) => operation.steps.flatMap((step) => step.dataPoints));
  const parts = scenario.operations.flatMap((operation) => operation.steps.flatMap((step) => step.parts));
  const tools = scenario.operations.flatMap((operation) => operation.steps.flatMap((step) => step.tools));
  for (const type of ['measurement', 'number', 'text', 'boolean', 'date', 'enum']) {
    if (!points.some((point) => point.dataType === type)) violations.push({ reason: 'missing ' + type + ' DATA', ids });
  }
  if (!parts.some((part) => SERIAL_MODES.has(part.traceabilityMode))) violations.push({ reason: 'missing serialized part', ids });
  if (!parts.some((part) => LOT_MODES.has(part.traceabilityMode))) violations.push({ reason: 'missing lot-traced part', ids });
  if (!tools.some((tool) => tool.capturePolicy === 'required')) violations.push({ reason: 'missing required tool capture', ids });
  if (!tools.some((tool) => tool.capturePolicy === 'optional' || tool.capturePolicy === 'info_only')) {
    violations.push({ reason: 'missing optional or info-only tool capture', ids });
  }
  if (!points.some((point) => point.dataType === 'measurement' && point.minValue === 0 && point.nominalValue > 0 && point.nominalValue < point.maxValue)) {
    violations.push({ reason: 'missing measurement with min 0', ids });
  }
  if (!points.some((point) => (point.dataType === 'measurement' || point.dataType === 'number')
    && point.minValue != null && Math.abs(point.nominalValue - (point.minValue + point.maxValue) / 2) < 0.0001)) {
    violations.push({ reason: 'missing centered nominal', ids });
  }
  if (!points.some((point) => point.dataType === 'measurement' && !Number.isInteger(point.nominalValue))) {
    violations.push({ reason: 'missing decimal measurement', ids });
  }
  const texts = scenario.operations.flatMap((operation) => operation.steps.flatMap((step) =>
    [step.instruction, ...step.dataPoints.map((point) => point.label + ' ' + (point.description ?? ''))]));
  if (!texts.some((text) => text.includes('µ') || text.includes('contrôle') || text.includes('pièce'))) {
    violations.push({ reason: 'missing unicode text', ids });
  }
  if (!texts.some((text) => text.length >= 400 && text.length <= 2000)) violations.push({ reason: 'missing long text near a reasonable limit', ids });
  for (const operation of scenario.operations) {
    if (operation.steps.length < 1) violations.push({ reason: 'operation has no steps', ids: { operationNo: operation.operationNo } });
    for (const step of operation.steps) {
      const stepIds = { ...ids, operationNo: operation.operationNo, stepNo: step.stepNo };
      if (!step.instruction.trim()) violations.push({ reason: 'step has no instruction', ids: stepIds });
      if (step.parts.length < 1) violations.push({ reason: 'step has no part', ids: stepIds });
      if (step.tools.length < 1) violations.push({ reason: 'step has no tool', ids: stepIds });
      if (step.dataPoints.length < 1) violations.push({ reason: 'step has no DATA', ids: stepIds });
      if (!step.signoff?.role || step.signoff.level !== 1) violations.push({ reason: 'step has no level-1 sign-off intent', ids: stepIds });
    }
  }
  return violations;
}

function requirementRows(payload) {
  const rows = Array.isArray(payload?.requirements) ? payload.requirements : [];
  return rows.filter((row) =>
    row && typeof row.signOffRequirementId === 'string' && row.isActive !== false && !row.requiresSignOffRequirementId
    && (row.scope == null || row.scope === 'step'));
}

export function resolveSignoffRequirement(payload, intent) {
  const sorted = requirementRows(payload).slice().sort((a, b) => a.signOffRequirementId.localeCompare(b.signOffRequirementId));
  const levelOk = (row) => row.level == null || Number(row.level) === (intent.level ?? 1);
  const textOf = (row) => [row.name, row.description, row.requiredPrivilege].filter(Boolean).join(' ');
  const wanted = intent.role === 'inspector'
    ? sorted.filter((row) => /inspect|qualit|vérif|verif|check/i.test(textOf(row)))
    : sorted.filter((row) => /opérat|operat|assembl|production|fabric/i.test(textOf(row)));
  const match = wanted.find(levelOk) ?? null;
  const fallback = sorted.find(levelOk) ?? sorted[0] ?? null;
  return { requirement: match ?? fallback, matched: Boolean(match), role: intent.role };
}

function sameNumber(actual, expected) {
  if (expected == null) return actual == null || actual === '';
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.00015;
}

export function diffScenario(scenario, detail, options = {}) {
  const differences = [];
  const masterItemNo = scenario.masterItemNo ?? null;
  if (!detail) {
    differences.push({ severity: 'material', reason: 'master item read-back missing', ids: { masterItemNo } });
    return differences;
  }
  if (detail.masterItem && (detail.masterItem.description ?? null) !== scenario.description) {
    differences.push({ severity: 'material', reason: 'master item description differs', ids: { masterItemNo } });
  }
  const facts = snapshotFacts(detail);
  if (facts.operationCount !== scenario.operations.length) {
    differences.push({
      severity: 'material',
      reason: 'operation count differs',
      ids: { masterItemNo, planned: scenario.operations.length, observed: facts.operationCount },
    });
  }
  for (const operation of scenario.operations) {
    const observedSteps = facts.steps.filter((step) => step.operationNo === operation.operationNo);
    if (observedSteps.length !== operation.steps.length) {
      differences.push({
        severity: 'material',
        reason: 'step count differs',
        ids: { masterItemNo, operationNo: operation.operationNo, planned: operation.steps.length, observed: observedSteps.length },
      });
    }
    for (const step of operation.steps) {
      const observed = observedSteps.find((candidate) => String(candidate.stepNo) === String(step.stepNo));
      const ids = { masterItemNo, operationNo: operation.operationNo, stepNo: step.stepNo };
      if (!observed) {
        differences.push({ severity: 'material', reason: 'planned step missing on read-back', ids });
        continue;
      }
      if (observed.operationTitle && observed.operationTitle !== operation.title) {
        differences.push({ severity: 'material', reason: 'operation title differs', ids: { ...ids, planned: operation.title, observed: observed.operationTitle } });
      }
      if (!observed.texts.some((text) => text.includes(step.instruction))) {
        differences.push({ severity: 'material', reason: 'instruction text missing on read-back', ids });
      }
      if (observed.signoffCount < 1) differences.push({ severity: 'material', reason: 'step has no sign-off', ids });
      const expectedSignoff = options.signoffIds?.[step.signoff.role] ?? null;
      if (expectedSignoff && !(observed.signoffIds ?? []).includes(expectedSignoff)) {
        differences.push({ severity: 'material', reason: 'sign-off requirement differs', ids: { ...ids, signOffRequirementId: expectedSignoff } });
      }
      for (const part of step.parts) {
        const found = observed.parts.find((item) => item.partNumber === part.partNumber);
        if (!found) differences.push({ severity: 'material', reason: 'planned part missing', ids: { ...ids, partNumber: part.partNumber } });
        else if (found.traceabilityMode !== part.traceabilityMode) {
          differences.push({ severity: 'material', reason: 'part traceability differs', ids: { ...ids, partNumber: part.partNumber } });
        } else if (!sameNumber(found.quantity, part.quantity)) {
          differences.push({ severity: 'material', reason: 'part quantity differs', ids: { ...ids, partNumber: part.partNumber } });
        }
      }
      for (const tool of step.tools) {
        const found = observed.tools.find((item) => item.toolNumber === tool.toolNumber);
        if (!found) differences.push({ severity: 'material', reason: 'planned tool missing', ids: { ...ids, toolNumber: tool.toolNumber } });
        else if (found.capturePolicy !== tool.capturePolicy) {
          differences.push({ severity: 'material', reason: 'tool capture policy differs', ids: { ...ids, toolNumber: tool.toolNumber } });
        }
      }
      for (const point of step.dataPoints) {
        const found = observed.dataPoints.find((item) => item.referenceCode === point.referenceCode);
        if (!found) {
          differences.push({ severity: 'material', reason: 'planned DATA missing', ids: { ...ids, referenceCode: point.referenceCode } });
          continue;
        }
        if (found.dataType !== point.dataType) differences.push({ severity: 'material', reason: 'DATA type differs', ids: { ...ids, referenceCode: point.referenceCode } });
        if ((point.unit ?? null) !== (found.unit ?? null)) differences.push({ severity: 'material', reason: 'DATA unit differs', ids: { ...ids, referenceCode: point.referenceCode, planned: point.unit, observed: found.unit } });
        if (point.dataType === 'measurement' || point.dataType === 'number') {
          if (!sameNumber(found.minValue, point.minValue) || !sameNumber(found.nominalValue, point.nominalValue) || !sameNumber(found.maxValue, point.maxValue)) {
            differences.push({ severity: 'material', reason: 'DATA bounds differ', ids: { ...ids, referenceCode: point.referenceCode } });
          }
        }
        if (point.defaultValue && found.defaultValue !== point.defaultValue && options.surface !== 'workOrder') {
          differences.push({ severity: 'material', reason: 'DATA choices differ', ids: { ...ids, referenceCode: point.referenceCode } });
        }
        if (point.defaultValue && options.surface === 'workOrder' && found.defaultValue && found.defaultValue !== point.defaultValue) {
          differences.push({ severity: 'material', reason: 'DATA choices differ', ids: { ...ids, referenceCode: point.referenceCode } });
        }
      }
    }
  }
  return differences;
}

export function summarizeScenario(scenario) {
  const steps = scenario.operations.flatMap((operation) => operation.steps);
  return {
    index: scenario.index,
    familyId: scenario.familyId,
    familyLabel: scenario.familyLabel,
    productName: scenario.productName,
    description: scenario.description,
    units: scenario.units,
    masterItemNo: scenario.masterItemNo ?? null,
    orderNo: scenario.orderNo ?? null,
    operations: scenario.operations.map((operation) => ({
      operationNo: operation.operationNo,
      phase: operation.phase,
      title: operation.title,
      mustCompleteBeforeLater: operation.mustCompleteBeforeLater,
      steps: operation.steps.map((step) => ({
        stepNo: step.stepNo,
        title: step.title,
        instruction: step.instruction,
        signoff: step.signoff,
        parts: step.parts.map((part) => ({
          name: part.name, traceabilityMode: part.traceabilityMode, quantity: part.quantity, partNumber: part.partNumber ?? null,
        })),
        tools: step.tools.map((tool) => ({
          name: tool.name, capturePolicy: tool.capturePolicy, calibrationBasis: tool.calibrationBasis, toolNumber: tool.toolNumber ?? null,
        })),
        data: step.dataPoints.map((point) => ({
          referenceCode: point.referenceCode, label: point.label, dataType: point.dataType, unit: point.unit,
          minValue: point.minValue, nominalValue: point.nominalValue, maxValue: point.maxValue, defaultValue: point.defaultValue,
        })),
      })),
    })),
    counts: {
      operations: scenario.operations.length,
      steps: steps.length,
      parts: steps.reduce((sum, step) => sum + step.parts.length, 0),
      tools: steps.reduce((sum, step) => sum + step.tools.length, 0),
      data: steps.reduce((sum, step) => sum + step.dataPoints.length, 0),
      signoffs: steps.length,
    },
  };
}

export function summarizeObserved(detail) {
  const facts = snapshotFacts(detail);
  const points = facts.steps.flatMap((step) => step.dataPoints);
  return {
    masterItemNo: detail?.masterItem?.masterItemNo ?? null,
    description: detail?.masterItem?.description ?? null,
    operations: facts.operationCount,
    steps: facts.steps.length,
    instructions: facts.steps.filter((step) => step.texts.length > 0).length,
    parts: facts.steps.reduce((sum, step) => sum + step.parts.length, 0),
    tools: facts.steps.reduce((sum, step) => sum + step.tools.length, 0),
    signoffs: facts.steps.reduce((sum, step) => sum + step.signoffCount, 0),
    dataTypes: [...new Set(points.map((point) => point.dataType).filter(Boolean))].sort(),
    traceabilityModes: [...new Set(facts.steps.flatMap((step) => step.parts.map((part) => part.traceabilityMode).filter(Boolean)))].sort(),
    capturePolicies: [...new Set(facts.steps.flatMap((step) => step.tools.map((tool) => tool.capturePolicy).filter(Boolean)))].sort(),
  };
}

export function dataPointRequest(stepId, point) {
  const body = {
    masOpeStepId: stepId,
    referenceCode: point.referenceCode,
    label: point.label,
    dataType: point.dataType,
    isMandatory: false,
  };
  if (point.description) body.description = point.description;
  if (point.dataType === 'measurement' || point.dataType === 'number') {
    body.minValue = point.minValue;
    body.maxValue = point.maxValue;
    body.nominalValue = point.nominalValue;
  }
  if (point.dataType === 'measurement') body.unit = point.unit;
  if (point.defaultValue) body.defaultValue = point.defaultValue;
  if (point.dataType === 'enum') {
    const choices = String(point.defaultValue ?? '').split('|').map((item) => item.trim()).filter(Boolean);
    if (choices.length > 0) body.enumChoices = choices;
  }
  return body;
}

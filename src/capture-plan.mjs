import { createHash } from 'node:crypto';
import { DATA_ROLES } from './manufacturing.mjs';
import { stableStringify } from './scenario.mjs';

function fixed(value, places) {
  return Number(value).toFixed(places);
}

function shift(value, places, direction) {
  const step = 10 ** -places;
  return (Number(value) + direction * step).toFixed(places);
}

function needsSerial(mode) {
  return String(mode).includes('Serial');
}
function needsLot(mode) {
  return String(mode).includes('Lot');
}
function needsHeat(mode) {
  return String(mode).includes('Heat');
}

function identityToken(operationNo, stepNo, role, suffix) {
  return [suffix, operationNo, stepNo, role].join('-').replaceAll('|', '-').slice(0, 40);
}

/**
 * Numeric capture and attack plan for the first numeric DATA point.
 * Built only from the seeded scenario. No clock and no network.
 */
export function numericCapturePlan(scenario) {
  let target = null;
  for (const operation of scenario?.operations ?? []) {
    for (const step of operation.steps ?? []) {
      for (const point of step.dataPoints ?? []) {
        if (point.dataType === 'number' || point.dataType === 'measurement') {
          target = { operation, step, point };
          break;
        }
      }
      if (target) break;
    }
    if (target) break;
  }
  if (!target) {
    const plan = { category: 'numeric', blocked: true, reason: 'scenario has no numeric DATA', setup: [], actions: [] };
    return { ...plan, capturePlanHash: capturePlanHash(plan) };
  }

  const spec = DATA_ROLES[target.point.role];
  const places = spec?.places ?? 4;
  const nominal = fixed(target.point.nominalValue, places);
  const min = fixed(target.point.minValue, places);
  const max = fixed(target.point.maxValue, places);
  const below = shift(target.point.minValue, places, -1);
  const above = shift(target.point.maxValue, places, 1);
  const locator = {
    operationNo: target.operation.operationNo,
    stepNo: String(target.step.stepNo),
    referenceCode: target.point.referenceCode,
    dataType: target.point.dataType,
    role: target.point.role,
  };
  const targetIndex = scenario.operations.findIndex((operation) => operation.operationNo === target.operation.operationNo);
  const setup = [];
  for (const operation of scenario.operations.slice(0, targetIndex)) {
    if (!operation.mustCompleteBeforeLater) continue;
    for (const step of operation.steps) {
      for (const part of step.parts) {
        const mode = part.traceabilityMode;
        if (mode === 'None') continue;
        const serial = needsSerial(mode);
        const lot = needsLot(mode);
        const heat = needsHeat(mode);
        const quantity = Number(part.quantity);
        if (serial && quantity >= 2) {
          setup.push({
            id: 'setup-part-units-' + operation.operationNo + '-' + step.stepNo + '-' + part.role,
            phase: 'setup',
            kind: 'setup-part-units',
            operationNo: operation.operationNo,
            stepNo: String(step.stepNo),
            partRole: part.role,
            blocked: true,
            reason: 'Serial quantity above 1 uses unit rows; that setup is not part of the numeric slice',
          });
          continue;
        }
        if (!serial && quantity >= 2 && (lot || heat)) {
          setup.push({
            id: 'setup-part-lots-' + operation.operationNo + '-' + step.stepNo + '-' + part.role,
            phase: 'setup',
            kind: 'setup-part-lots',
            operationNo: operation.operationNo,
            stepNo: String(step.stepNo),
            partRole: part.role,
            body: {
              lines: [{
                quantity,
                ...(lot ? { lotNo: identityToken(operation.operationNo, step.stepNo, part.role, 'LOT') } : {}),
                ...(heat ? { heatNo: identityToken(operation.operationNo, step.stepNo, part.role, 'HEAT') } : {}),
              }],
            },
            oracle: { http: [200], accept: true },
          });
          continue;
        }
        setup.push({
          id: 'setup-part-' + operation.operationNo + '-' + step.stepNo + '-' + part.role,
          phase: 'setup',
          kind: 'setup-part',
          operationNo: operation.operationNo,
          stepNo: String(step.stepNo),
          partRole: part.role,
          body: {
            ...(serial ? { serialNo: identityToken(operation.operationNo, step.stepNo, part.role, 'SN') } : {}),
            ...(lot ? { lotNo: identityToken(operation.operationNo, step.stepNo, part.role, 'LOT') } : {}),
            ...(heat ? { heatNo: identityToken(operation.operationNo, step.stepNo, part.role, 'HEAT') } : {}),
          },
          oracle: { http: [200], accept: true },
        });
      }
      for (const tool of step.tools) {
        if (tool.capturePolicy !== 'required') continue;
        setup.push({
          id: 'setup-tool-' + operation.operationNo + '-' + step.stepNo + '-' + tool.role,
          phase: 'setup',
          kind: 'setup-tool',
          operationNo: operation.operationNo,
          stepNo: String(step.stepNo),
          toolRole: tool.role,
          oracle: { http: [200], accept: true },
        });
      }
      setup.push({
        id: 'setup-signoff-' + operation.operationNo + '-' + step.stepNo,
        phase: 'setup',
        kind: 'setup-signoff',
        operationNo: operation.operationNo,
        stepNo: String(step.stepNo),
        body: {},
        oracle: { http: [200], accept: true },
      });
    }
  }

  const data = (id, kind, body, oracle, extra = {}) => ({
    id, phase: 'chaos', category: 'numeric', kind, locator, body, oracle, requiresSetup: true, ...extra,
  });
  const accept = (captureStatus, value) => ({
    http: [200],
    accept: true,
    captureStatus,
    value,
    text: value == null || value === '' ? null : String(value),
    unchanged: false,
  });
  const reject = { http: [400, 422], accept: false, unchanged: true };
  // Omitted text is kept by the API, so a numeric write must send both columns.
  // First write is SET_VALUE. Later writes are REPLACE_VALUE or CLEAR_VALUE and require a comment.
  const numericBody = (value, withComment) => ({
    capturedValueNumber: value,
    capturedValueText: value,
    ...(withComment ? { comment: 'Chaos numeric replace' } : {}),
  });

  const actions = [
    data('numeric-nominal', 'valid', numericBody(nominal, false), accept('Captured', nominal)),
    data('numeric-min', 'edge', numericBody(min, true), accept('Captured', min)),
    data('numeric-max', 'edge', numericBody(max, true), accept('Captured', max)),
    data('numeric-repeat-max', 'repeat', numericBody(max, true), accept('Captured', max)),
    data('numeric-below-min', 'edge', numericBody(below, true), accept('Invalid', below), { designedOutcome: 'accepted-invalid' }),
    data('numeric-above-max', 'edge', numericBody(above, true), accept('Invalid', above), { designedOutcome: 'accepted-invalid' }),
    data('numeric-clear-null', 'edge', numericBody(null, true), accept('Captured', null)),
    data('numeric-clear-empty', 'edge', numericBody('', true), accept('Captured', null)),
    data('numeric-not-a-number', 'invalid', numericBody('potato', true), reject, {
      note: 'decimal(12,4) cannot store a word; a controlled 4xx must leave the previous value unchanged. HTTP 500 is an unhandled error.',
    }),
    data('numeric-huge', 'invalid', numericBody('999999999999', true), reject, {
      note: 'Value exceeds decimal(12,4). A controlled 4xx must leave the previous value unchanged.',
    }),
    data('numeric-bad-shape', 'invalid', { capturedValueNumber: { bad: true }, capturedValueText: 'x', comment: 'Chaos numeric replace' }, reject),
    {
      id: 'numeric-concurrent',
      phase: 'chaos',
      category: 'numeric',
      kind: 'concurrency',
      locator,
      requiresSetup: true,
      parallel: [
        { body: numericBody(nominal, true), oracle: { http: [200], accept: true } },
        { body: numericBody(min, true), oracle: { http: [200], accept: true } },
      ],
      oracle: {
        http: [200],
        accept: true,
        oneOf: [accept('Captured', nominal), accept('Captured', min)],
      },
    },
    {
      id: 'numeric-cancel',
      phase: 'chaos',
      category: 'numeric',
      kind: 'cancel',
      body: { reason: 'Chaos numeric slice cancel' },
      oracle: { http: [200], accept: true },
    },
    data('numeric-after-cancel', 'invalid', numericBody(nominal, true), {
      http: [400],
      accept: false,
      unchanged: true,
      errorIncludes: 'cancelled',
    }, { requiresCancel: true }),
  ];

  const plan = {
    category: 'numeric',
    blocked: false,
    locator,
    bounds: { min, nominal, max, below, above, places },
    setup,
    actions,
  };
  return { ...plan, capturePlanHash: capturePlanHash(plan) };
}

export function capturePlanHash(plan) {
  const { capturePlanHash: _ignored, ...rest } = plan;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

const DATA_COMMENT = 'Chaos data replace';
const TEXT_LENGTH = 4000;

function findPoint(scenario, dataType) {
  for (const operation of scenario?.operations ?? []) {
    for (const step of operation.steps ?? []) {
      for (const point of step.dataPoints ?? []) {
        if (point.dataType === dataType) return { operation, step, point };
      }
    }
  }
  return null;
}

function locatorFor(found) {
  return {
    operationNo: found.operation.operationNo,
    stepNo: String(found.step.stepNo),
    referenceCode: found.point.referenceCode,
    dataType: found.point.dataType,
    isMandatory: found.point.isMandatory === true,
  };
}

function operationSetup(operation) {
  const setup = [];
  for (const step of operation.steps) {
    for (const part of step.parts) {
      const mode = part.traceabilityMode;
      if (mode === 'None') continue;
      const serial = needsSerial(mode);
      const lot = needsLot(mode);
      const heat = needsHeat(mode);
      const quantity = Number(part.quantity);
      if (serial && quantity >= 2) {
        setup.push({
          id: 'setup-part-units-' + operation.operationNo + '-' + step.stepNo + '-' + part.role,
          phase: 'setup',
          kind: 'setup-part-units',
          operationNo: operation.operationNo,
          stepNo: String(step.stepNo),
          partRole: part.role,
          blocked: true,
          reason: 'Serial quantity above 1 uses unit rows; that setup is not part of the data slice',
        });
        continue;
      }
      if (!serial && quantity >= 2 && (lot || heat)) {
        setup.push({
          id: 'setup-part-lots-' + operation.operationNo + '-' + step.stepNo + '-' + part.role,
          phase: 'setup',
          kind: 'setup-part-lots',
          operationNo: operation.operationNo,
          stepNo: String(step.stepNo),
          partRole: part.role,
          body: {
            lines: [{
              quantity,
              ...(lot ? { lotNo: identityToken(operation.operationNo, step.stepNo, part.role, 'LOT') } : {}),
              ...(heat ? { heatNo: identityToken(operation.operationNo, step.stepNo, part.role, 'HEAT') } : {}),
            }],
          },
          oracle: { http: [200], accept: true },
        });
        continue;
      }
      setup.push({
        id: 'setup-part-' + operation.operationNo + '-' + step.stepNo + '-' + part.role,
        phase: 'setup',
        kind: 'setup-part',
        operationNo: operation.operationNo,
        stepNo: String(step.stepNo),
        partRole: part.role,
        body: {
          ...(serial ? { serialNo: identityToken(operation.operationNo, step.stepNo, part.role, 'SN') } : {}),
          ...(lot ? { lotNo: identityToken(operation.operationNo, step.stepNo, part.role, 'LOT') } : {}),
          ...(heat ? { heatNo: identityToken(operation.operationNo, step.stepNo, part.role, 'HEAT') } : {}),
        },
        oracle: { http: [200], accept: true },
      });
    }
    for (const tool of step.tools) {
      if (tool.capturePolicy !== 'required') continue;
      const calendar = tool.calibrationBasis === 'calendar';
      setup.push({
        id: 'setup-tool-' + operation.operationNo + '-' + step.stepNo + '-' + tool.role,
        phase: 'setup',
        kind: 'setup-tool',
        operationNo: operation.operationNo,
        stepNo: String(step.stepNo),
        toolRole: tool.role,
        bypassCalibration: calendar,
        comment: calendar ? 'Chaos calibration bypass' : undefined,
        oracle: { http: [200], accept: true },
      });
    }
    setup.push({
      id: 'setup-signoff-' + operation.operationNo + '-' + step.stepNo,
      phase: 'setup',
      kind: 'setup-signoff',
      operationNo: operation.operationNo,
      stepNo: String(step.stepNo),
      body: {},
      oracle: { http: [200], accept: true },
    });
  }
  return setup;
}

function textActions(found) {
  const locator = locatorFor(found);
  const stored = (text) => ({ http: [200], accept: true, captureStatus: 'Captured', text, value: null, bool: null, unchanged: false });
  const reject = { http: [400, 422], accept: false, unchanged: true };
  const comment = { comment: DATA_COMMENT };
  const ascii = 'Inspection note 1';
  const french = 'Contrôle accepté, pièce µ.';
  const unicode = '検査 Ω 東京';
  const punctuated = 'Lot A, ligne 1.\nSuite: OK.';
  const long = 'N'.repeat(TEXT_LENGTH);
  const action = (id, kind, body, oracle, extra = {}) => ({
    id, phase: 'chaos', category: 'text', kind, locator, body, oracle, requiresSetup: false, ...extra,
  });
  return [
    action('text-ascii', 'valid', { capturedValueText: ascii }, stored(ascii)),
    action('text-french', 'edge', { capturedValueText: french, ...comment }, stored(french)),
    action('text-unicode', 'edge', { capturedValueText: unicode, ...comment }, stored(unicode)),
    action('text-punctuation', 'edge', { capturedValueText: punctuated, ...comment }, stored(punctuated)),
    action('text-long', 'edge', { capturedValueText: long, ...comment }, stored(long)),
    action('text-repeat-long', 'repeat', { capturedValueText: long, ...comment }, stored(long)),
    action('text-wrong-number', 'edge', { capturedValueNumber: 12, ...comment }, stored(long), {
      note: 'A number sent without capturedValueText is ignored. The previous text must stay.',
    }),
    action('text-wrong-bool', 'edge', { capturedValueBool: true, ...comment }, stored(long), {
      note: 'A boolean sent without capturedValueText is ignored. The previous text must stay.',
    }),
    action('text-object', 'invalid', { capturedValueText: { bad: true }, ...comment }, reject),
    action('text-array', 'invalid', { capturedValueText: ['x'], ...comment }, reject),
    action('text-mixed-fields', 'edge', {
      capturedValueText: ascii, capturedValueNumber: 5, capturedValueBool: true, ...comment,
    }, stored(ascii), {
      note: 'Text capture keeps capturedValueText and clears the other value columns.',
    }),
    action('text-replace-without-comment', 'invalid', { capturedValueText: 'replacement refused' }, reject),
    action('text-clear-without-comment', 'invalid', { capturedValueText: null }, reject),
    action('text-clear-empty', 'edge', { capturedValueText: '', ...comment }, stored(null), { designedOutcome: 'accepted-clear' }),
    action('text-clear-null', 'edge', { capturedValueText: null, ...comment }, stored(null), { designedOutcome: 'accepted-clear' }),
    {
      id: 'text-over-max',
      phase: 'chaos',
      category: 'text',
      kind: 'not-applicable',
      locator,
      reason: 'captured_value_text is unbounded text and the capture schema sets no maximum length',
      oracle: { applicable: false, reason: 'no maximum length' },
    },
    {
      id: 'text-concurrent',
      phase: 'chaos',
      category: 'text',
      kind: 'concurrency',
      locator,
      requiresSetup: false,
      parallel: [
        { body: { capturedValueText: ascii, ...comment }, oracle: { http: [200], accept: true } },
        { body: { capturedValueText: french, ...comment }, oracle: { http: [200], accept: true } },
      ],
      oracle: { http: [200], accept: true, oneOf: [stored(ascii), stored(french)] },
    },
    action('text-after-cancel', 'invalid', { capturedValueText: ascii, ...comment }, {
      http: [400], accept: false, unchanged: true, errorIncludes: 'cancelled',
    }, { requiresCancel: true }),
  ];
}

function booleanActions(found) {
  const locator = locatorFor(found);
  const action = (id, kind, body, oracle, extra = {}) => ({
    id, phase: 'chaos', category: 'boolean', kind, locator, body, oracle, requiresSetup: false, ...extra,
  });
  const stored = (bool) => ({ http: [200], accept: true, captureStatus: 'Captured', bool, text: null, value: null, unchanged: false });
  const reject = { http: [400, 422], accept: false, unchanged: true };
  const comment = { comment: DATA_COMMENT };
  const clear = { capturedValueBool: null, capturedValueText: null, ...comment };
  return [
    action('boolean-true', 'valid', { capturedValueBool: true }, stored(true)),
    action('boolean-false', 'valid', { capturedValueBool: false, ...comment }, stored(false)),
    action('boolean-repeat-false', 'repeat', { capturedValueBool: false, ...comment }, stored(false)),
    action('boolean-empty-keeps-false', 'edge', { capturedValueText: '', ...comment }, stored(false), {
      note: 'An omitted boolean is kept. An empty text does not clear a stored false.',
    }),
    action('boolean-clear-null', 'edge', clear, stored(null), { designedOutcome: 'accepted-clear' }),
    action('boolean-text-true', 'edge', { capturedValueText: 'true', ...comment }, stored(true), {
      note: 'Contract to confirm, not a defect: when no boolean is stored, the text tokens true/false and the numbers 1/0 are parsed as booleans.',
    }),
    action('boolean-clear-before-text-false', 'edge', clear, stored(null), { designedOutcome: 'accepted-clear' }),
    action('boolean-text-false', 'edge', { capturedValueText: 'false', ...comment }, stored(false)),
    action('boolean-clear-before-number', 'edge', clear, stored(null), { designedOutcome: 'accepted-clear' }),
    action('boolean-number-one', 'edge', { capturedValueNumber: 1, ...comment }, stored(true)),
    action('boolean-clear-before-zero', 'edge', clear, stored(null), { designedOutcome: 'accepted-clear' }),
    action('boolean-number-zero', 'edge', { capturedValueNumber: 0, ...comment }, stored(false)),
    action('boolean-clear-before-garbage', 'edge', clear, stored(null), { designedOutcome: 'accepted-clear' }),
    action('boolean-garbage', 'invalid', { capturedValueText: 'maybe', ...comment }, reject),
    action('boolean-bool-string', 'invalid', { capturedValueBool: 'true', ...comment }, reject),
    action('boolean-object', 'invalid', { capturedValueBool: { bad: true }, ...comment }, reject),
    action('boolean-conflict', 'edge', { capturedValueBool: false, capturedValueText: 'true', ...comment }, stored(false), {
      note: 'An explicit boolean wins over a conflicting text token.',
    }),
    action('boolean-replace-without-comment', 'invalid', { capturedValueBool: true }, reject),
    {
      id: 'boolean-concurrent',
      phase: 'chaos',
      category: 'boolean',
      kind: 'concurrency',
      locator,
      requiresSetup: false,
      parallel: [
        { body: { capturedValueBool: true, ...comment }, oracle: { http: [200], accept: true } },
        { body: { capturedValueBool: false, ...comment }, oracle: { http: [200], accept: true } },
      ],
      oracle: { http: [200], accept: true, oneOf: [stored(true), stored(false)] },
    },
    action('boolean-after-cancel', 'invalid', { capturedValueBool: true, ...comment }, {
      http: [400], accept: false, unchanged: true, errorIncludes: 'cancelled',
    }, { requiresCancel: true }),
  ];
}

function dateActions(found) {
  const locator = locatorFor(found);
  const action = (id, kind, body, oracle, extra = {}) => ({
    id, phase: 'chaos', category: 'date', kind, locator, body, oracle, requiresSetup: false, ...extra,
  });
  const stored = (text) => ({ http: [200], accept: true, captureStatus: 'Captured', text, value: null, bool: null, unchanged: false });
  const reject = { http: [400, 422], accept: false, unchanged: true };
  const comment = { comment: DATA_COMMENT };
  const normal = '2024-06-15';
  const leap = '2024-02-29';
  const yearEnd = '2025-12-31';
  const yearStart = '2026-01-01';
  return [
    action('date-normal', 'valid', { capturedValueText: normal }, stored(normal)),
    action('date-leap', 'edge', { capturedValueText: leap, ...comment }, stored(leap)),
    action('date-year-end', 'edge', { capturedValueText: yearEnd, ...comment }, stored(yearEnd)),
    action('date-year-start', 'edge', { capturedValueText: yearStart, ...comment }, stored(yearStart)),
    action('date-repeat', 'repeat', { capturedValueText: yearStart, ...comment }, stored(yearStart)),
    action('date-non-leap', 'invalid', { capturedValueText: '2025-02-29', ...comment }, reject),
    action('date-month-13', 'invalid', { capturedValueText: '2026-13-01', ...comment }, reject),
    action('date-day-00', 'invalid', { capturedValueText: '2026-01-00', ...comment }, reject),
    action('date-ambiguous', 'invalid', { capturedValueText: '09/10/2026', ...comment }, reject),
    action('date-text', 'invalid', { capturedValueText: 'tomorrow', ...comment }, reject),
    action('date-timestamp', 'invalid', { capturedValueText: '2026-01-01T00:00:00.000Z', ...comment }, reject),
    action('date-object', 'invalid', { capturedValueText: { bad: true }, ...comment }, reject),
    action('date-mixed-fields', 'edge', { capturedValueText: normal, capturedValueNumber: 1, ...comment }, stored(normal)),
    action('date-replace-without-comment', 'invalid', { capturedValueText: leap }, reject),
    action('date-clear-empty', 'edge', { capturedValueText: '', ...comment }, stored(null), { designedOutcome: 'accepted-clear' }),
    action('date-clear-null', 'edge', { capturedValueText: null, ...comment }, stored(null), { designedOutcome: 'accepted-clear' }),
    {
      id: 'date-concurrent',
      phase: 'chaos',
      category: 'date',
      kind: 'concurrency',
      locator,
      requiresSetup: false,
      parallel: [
        { body: { capturedValueText: normal, ...comment }, oracle: { http: [200], accept: true } },
        { body: { capturedValueText: leap, ...comment }, oracle: { http: [200], accept: true } },
      ],
      oracle: { http: [200], accept: true, oneOf: [stored(normal), stored(leap)] },
    },
    action('date-after-cancel', 'invalid', { capturedValueText: normal, ...comment }, {
      http: [400], accept: false, unchanged: true, errorIncludes: 'cancelled',
    }, { requiresCancel: true }),
  ];
}

function enumActions(found) {
  const locator = locatorFor(found);
  const choices = String(found.point.defaultValue ?? '').split('|').map((item) => item.trim()).filter(Boolean);
  if (choices.length === 0) {
    return { blocked: true, reason: 'enum DATA has no choices in defaultValue', actions: [] };
  }
  const action = (id, kind, body, oracle, extra = {}) => ({
    id, phase: 'chaos', category: 'enum', kind, locator, body, oracle, requiresSetup: false, choices, ...extra,
  });
  const stored = (text) => ({ http: [200], accept: true, captureStatus: 'Captured', text, value: null, bool: null, unchanged: false });
  const reject = { http: [400, 422], accept: false, unchanged: true };
  const membershipReject = {
    http: [400],
    accept: false,
    unchanged: true,
    historyUnchanged: true,
    errorIncludes: 'not an allowed enum value',
  };
  const comment = { comment: DATA_COMMENT };
  const first = choices[0];
  const second = choices[1] ?? choices[0];
  const flipped = first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase();
  const unknown = choices.includes('NotAChoice') ? 'NotAChoice-x' : 'NotAChoice';
  const actions = choices.map((choice, index) => action(
    'enum-choice-' + (index + 1),
    index === 0 ? 'valid' : 'edge',
    { capturedValueText: choice, ...(index === 0 ? {} : comment) },
    stored(choice),
  ));
  actions.push(action('enum-repeat', 'repeat', { capturedValueText: choices[choices.length - 1], ...comment }, stored(choices[choices.length - 1])));
  actions.push(action('enum-unknown', 'invalid', { capturedValueText: unknown, ...comment }, membershipReject, {
    note: 'defaultValue choices are the allowed capture set. An unknown value must be refused and must not be stored.',
  }));
  if (!choices.includes(flipped)) {
    actions.push(action('enum-case', 'invalid', { capturedValueText: flipped, ...comment }, membershipReject, {
      note: 'Enum matching is case-sensitive. A different case must be refused and must not be stored.',
    }));
  }
  actions.push(action('enum-padded', 'edge', { capturedValueText: ' ' + first + ' ', ...comment }, stored(first), {
    note: 'Leading and trailing spaces are trimmed by the API before storage.',
  }));
  actions.push(action('enum-replace-without-comment', 'invalid', {
    capturedValueText: second !== first ? second : unknown,
  }, reject));
  actions.push(action('enum-clear-empty', 'edge', { capturedValueText: '', ...comment }, stored(null), { designedOutcome: 'accepted-clear' }));
  actions.push(action('enum-clear-null', 'edge', { capturedValueText: null, ...comment }, stored(null), { designedOutcome: 'accepted-clear' }));
  if (!choices.includes('1')) {
    actions.push(action('enum-number', 'invalid', { capturedValueText: '1', ...comment }, membershipReject, {
      note: 'A numeric text absent from defaultValue choices must be refused and must not be stored.',
    }));
  }
  actions.push(action('enum-object', 'invalid', { capturedValueText: { bad: true }, ...comment }, reject));
  actions.push(action('enum-array', 'invalid', { capturedValueText: [first], ...comment }, reject));
  actions.push(action('enum-mixed-fields', 'edge', {
    capturedValueText: second, capturedValueNumber: 3, capturedValueBool: false, ...comment,
  }, stored(second)));
  if (choices.length >= 2) {
    actions.push({
      id: 'enum-concurrent',
      phase: 'chaos',
      category: 'enum',
      kind: 'concurrency',
      locator,
      requiresSetup: false,
      parallel: [
        { body: { capturedValueText: first, ...comment }, oracle: { http: [200], accept: true } },
        { body: { capturedValueText: second, ...comment }, oracle: { http: [200], accept: true } },
      ],
      oracle: { http: [200], accept: true, oneOf: [stored(first), stored(second)] },
    });
  } else {
    actions.push({
      id: 'enum-concurrent',
      phase: 'chaos',
      category: 'enum',
      kind: 'not-applicable',
      locator,
      reason: 'enum has fewer than two choices, so two concurrent values cannot be planned',
      oracle: { applicable: false, reason: 'fewer than two choices' },
    });
  }
  actions.push(action('enum-after-cancel', 'invalid', { capturedValueText: first, ...comment }, {
    http: [400], accept: false, unchanged: true, errorIncludes: 'cancelled',
  }, { requiresCancel: true }));
  return { blocked: false, choices, actions };
}

/**
 * Full data capture plan. Numeric action bodies and oracles stay those of numericCapturePlan.
 * Cancellation is one shared step after every type, so a numeric cancel cannot block the others.
 */
export function dataCapturePlan(scenario) {
  const numeric = numericCapturePlan(scenario);
  const groups = new Map();
  const blockedTypes = {};
  const add = (operationNo, action) => {
    const gated = (scenario.operations ?? []).some((operation) =>
      operation.mustCompleteBeforeLater && Number(operation.operationNo) < Number(operationNo));
    if (gated && action.kind !== 'not-applicable') action.requiresSetup = true;
    if (!groups.has(operationNo)) groups.set(operationNo, []);
    groups.get(operationNo).push(action);
  };
  const take = (name, dataType, builder) => {
    const found = findPoint(scenario, dataType);
    if (!found) {
      blockedTypes[name] = { blocked: true, reason: 'scenario has no ' + dataType + ' DATA' };
      return;
    }
    const built = builder(found);
    if (built.blocked) {
      blockedTypes[name] = built;
      return;
    }
    const actions = Array.isArray(built) ? built : built.actions;
    for (const action of actions) {
      if (action.requiresCancel) continue;
      add(found.operation.operationNo, action);
    }
    return actions.filter((action) => action.requiresCancel);
  };
  const textAfter = take('text', 'text', textActions) ?? [];
  const booleanAfter = take('boolean', 'boolean', booleanActions) ?? [];
  const dateAfter = take('date', 'date', dateActions) ?? [];
  const enumBuilt = findPoint(scenario, 'enum');
  let enumAfter = [];
  if (!enumBuilt) blockedTypes.enum = { blocked: true, reason: 'scenario has no enum DATA' };
  else {
    const built = enumActions(enumBuilt);
    if (built.blocked) blockedTypes.enum = built;
    else {
      for (const action of built.actions) {
        if (!action.requiresCancel) add(enumBuilt.operation.operationNo, action);
      }
      enumAfter = built.actions.filter((action) => action.requiresCancel);
    }
  }
  if (!numeric.blocked && numeric.locator) {
    for (const action of numeric.actions) {
      if (action.kind === 'cancel' || action.requiresCancel) continue;
      add(numeric.locator.operationNo, action);
    }
  } else {
    blockedTypes.number = { blocked: true, reason: numeric.reason ?? 'scenario has no numeric DATA' };
  }

  const captureOps = [...groups.keys()].sort((left, right) => Number(left) - Number(right));
  const steps = [];
  let previous = null;
  for (const operationNo of captureOps) {
    for (const operation of scenario.operations ?? []) {
      if (!operation.mustCompleteBeforeLater) continue;
      const current = Number(operation.operationNo);
      if (current >= Number(operationNo)) continue;
      if (previous != null && current < Number(previous)) continue;
      steps.push(...operationSetup(operation));
    }
    steps.push(...groups.get(operationNo));
    previous = operationNo;
  }
  const cancel = numeric.actions?.find((action) => action.kind === 'cancel') ?? {
    id: 'data-cancel',
    phase: 'chaos',
    category: 'number',
    kind: 'cancel',
    body: { reason: 'Chaos data slice cancel' },
    oracle: { http: [200], accept: true },
  };
  steps.push(cancel);
  const numericAfter = (numeric.actions ?? []).filter((action) => action.requiresCancel);
  for (const action of [...textAfter, ...booleanAfter, ...dateAfter, ...enumAfter, ...numericAfter]) {
    action.requiresSetup = false;
    steps.push(action);
  }

  const plan = {
    category: 'data',
    blockedTypes,
    steps,
  };
  return { ...plan, capturePlanHash: capturePlanHash(plan) };
}

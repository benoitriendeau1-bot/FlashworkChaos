import { createHash } from 'node:crypto';
import { integer, rng } from './engine.mjs';
import { stableStringify } from './scenario.mjs';

/** Names from FlashWorkBE part-traceability-mode.ts. Do not invent aliases. */
export const PART_TRACEABILITY_MODES = [
  'None', 'Serial', 'Lot', 'Heat', 'SerialLot', 'SerialHeat', 'LotHeat', 'SerialLotHeat',
];

const SERIAL = new Set(['Serial', 'SerialLot', 'SerialHeat', 'SerialLotHeat']);
const LOT = new Set(['Lot', 'SerialLot', 'LotHeat', 'SerialLotHeat']);
const HEAT = new Set(['Heat', 'SerialHeat', 'LotHeat', 'SerialLotHeat']);
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/**
 * One catalog part per capture shape.
 * Inline when Serial* qty 1 (build count 1) or Lot/Heat/LotHeat qty 1 or None.
 * Unit rows when Serial* qty >= 2. Lot lines when Lot/Heat/LotHeat qty >= 2.
 * The gate part sits on operation 20 behind mustCompleteBeforeLater.
 */
export const PART_SLOTS = [
  { key: 'none', mode: 'None', shape: 'inline', quantity: 1, operationNo: '10', code: 'NNN' },
  { key: 'serial', mode: 'Serial', shape: 'inline', quantity: 1, operationNo: '10', code: 'SER' },
  { key: 'serial-units', mode: 'Serial', shape: 'units', quantity: 2, operationNo: '10', code: 'SUN' },
  { key: 'lot', mode: 'Lot', shape: 'inline', quantity: 1, operationNo: '10', code: 'LOT' },
  { key: 'lot-lines', mode: 'Lot', shape: 'lot-lines', quantity: 2, operationNo: '10', code: 'LLN' },
  { key: 'heat', mode: 'Heat', shape: 'inline', quantity: 1, operationNo: '10', code: 'HEA' },
  { key: 'heat-lines', mode: 'Heat', shape: 'lot-lines', quantity: 2, operationNo: '10', code: 'HLN' },
  { key: 'lotheat', mode: 'LotHeat', shape: 'inline', quantity: 1, operationNo: '10', code: 'LHE' },
  { key: 'lotheat-lines', mode: 'LotHeat', shape: 'lot-lines', quantity: 2, operationNo: '10', code: 'LHL' },
  { key: 'seriallot', mode: 'SerialLot', shape: 'inline', quantity: 1, operationNo: '10', code: 'SLO' },
  { key: 'serialheat', mode: 'SerialHeat', shape: 'inline', quantity: 1, operationNo: '10', code: 'SHE' },
  { key: 'seriallotheat', mode: 'SerialLotHeat', shape: 'inline', quantity: 1, operationNo: '10', code: 'SLH' },
  { key: 'gate', mode: 'None', shape: 'inline', quantity: 1, operationNo: '20', code: 'GAT' },
];

function tag(prefix, slot, suffix = '') {
  return prefix + '-{{RUN}}-' + slot + suffix;
}

function identity(mode, slot, suffix = '') {
  const body = {};
  if (SERIAL.has(mode)) body.serialNo = tag('SN', slot, suffix);
  if (LOT.has(mode)) body.lotNo = tag('LOT', slot, suffix);
  if (HEAT.has(mode)) body.heatNo = tag('HEAT', slot, suffix);
  return body;
}

function expectInline(mode, slot, quantity, suffix = '') {
  const id = identity(mode, slot, suffix);
  return {
    quantityActual: String(quantity),
    serialNo: id.serialNo ?? null,
    lotNo: id.lotNo ?? null,
    heatNo: id.heatNo ?? null,
  };
}

function line(mode, slot, suffix, quantity = 1) {
  return { quantity, ...identity(mode, slot, suffix) };
}

function expectLines(mode, specs) {
  return {
    quantityActual: '2',
    serialNo: null,
    lotNo: null,
    heatNo: null,
    lotLines: specs.map((spec) => ({
      quantity: String(spec.quantity),
      lotNo: spec.lotNo ?? null,
      heatNo: spec.heatNo ?? null,
    })),
  };
}

function expectUnits(serials) {
  return {
    quantityActual: '2',
    serialNo: null,
    lotNo: null,
    heatNo: null,
    units: serials.map((serialNo, index) => ({
      unitIndex: index + 1,
      serialNo,
      lotNo: null,
      heatNo: null,
    })),
  };
}

function reject(status, errorIncludes) {
  return {
    http: Array.isArray(status) ? status : [status],
    accept: false,
    unchanged: true,
    historyUnchanged: true,
    ...(errorIncludes ? { errorIncludes } : {}),
  };
}

function contract(text, forbidden) {
  return {
    contract: text,
    ...(forbidden ? { forbidden } : {}),
  };
}

function primaryField(mode) {
  if (SERIAL.has(mode)) return 'serialNo';
  if (LOT.has(mode)) return 'lotNo';
  return 'heatNo';
}

function withIdentity(mode, slot, field, value, suffix = '') {
  return { quantityActual: 1, ...identity(mode, slot, suffix), [field]: value };
}

function happyBody(slot) {
  if (slot.shape === 'units') {
    return {
      units: [1, 2].map((unitIndex) => ({
        unitIndex,
        serialNo: tag('SN', slot.key, '-' + unitIndex),
      })),
    };
  }
  if (slot.shape === 'lot-lines') {
    return { lines: [line(slot.mode, slot.key, '-A'), line(slot.mode, slot.key, '-B')] };
  }
  return { quantityActual: slot.quantity, ...identity(slot.mode, slot.key) };
}

function happyExpect(slot) {
  if (slot.shape === 'units') {
    return expectUnits([tag('SN', slot.key, '-1'), tag('SN', slot.key, '-2')]);
  }
  if (slot.shape === 'lot-lines') {
    return expectLines(slot.mode, [line(slot.mode, slot.key, '-A'), line(slot.mode, slot.key, '-B')]);
  }
  return expectInline(slot.mode, slot.key, slot.quantity);
}

function routeFor(slot) {
  if (slot.shape === 'units') return 'units';
  if (slot.shape === 'lot-lines') return 'lot-lines';
  return 'part';
}

function act(spec) {
  return {
    wo: spec.wo ?? 1,
    mode: spec.mode ?? null,
    slot: spec.slot ?? null,
    kind: spec.kind,
    id: spec.id,
    route: spec.route,
    body: spec.body ?? null,
    parallel: spec.parallel ?? null,
    foreign: spec.foreign ?? null,
    optional: spec.optional === true,
    requiresCancel: spec.requiresCancel === true,
    requiresResume: spec.requiresResume === true,
    requiresComplete: spec.requiresComplete === true,
    requiresHold: spec.requiresHold === true,
    oracle: spec.oracle,
  };
}

function probesFor(slot) {
  const mode = slot.mode;
  const field = primaryField(mode);
  const probes = [];
  if (slot.shape === 'inline' && mode !== 'None') {
    probes.push(act({
      id: slot.key + '-missing-identity',
      mode, slot: slot.key, kind: 'contract', route: 'part',
      body: { quantityActual: 1, ...identity(mode, slot.key), [field]: null },
      oracle: contract(
        mode + ' capture omitted ' + field + '. Option A: reject until every required identity is present. Option B: persist a partial capture and enforce completeness at sign-off.',
      ),
    }));
    probes.push(act({
      id: slot.key + '-blank-identity',
      mode, slot: slot.key, kind: 'contract', route: 'part',
      body: withIdentity(mode, slot.key, field, ''),
      oracle: contract(mode + ' received an empty ' + field + '. Trim makes it the same as a missing identity.'),
    }));
    probes.push(act({
      id: slot.key + '-whitespace-identity',
      mode, slot: slot.key, kind: 'contract', route: 'part',
      body: withIdentity(mode, slot.key, field, '   '),
      oracle: contract(mode + ' received a whitespace ' + field + '. The API trims before save.'),
    }));
  }
  if (slot.shape === 'units') {
    probes.push(act({
      id: slot.key + '-inline-identity',
      mode, slot: slot.key, kind: 'invalid', route: 'part',
      body: { quantityActual: 2, serialNo: tag('SN', slot.key, '-INLINE') },
      oracle: reject(400, 'unit endpoints'),
    }));
    probes.push(act({
      id: slot.key + '-missing-serial',
      mode, slot: slot.key, kind: 'contract', route: 'units',
      body: { units: [{ unitIndex: 1, serialNo: null }, { unitIndex: 2, serialNo: tag('SN', slot.key, '-2') }] },
      oracle: contract('A serial unit was saved without a serial. Completeness is a sign-off rule; save may still accept the partial unit.'),
    }));
  }
  if (slot.shape === 'lot-lines') {
    probes.push(act({
      id: slot.key + '-inline-before-lines',
      mode, slot: slot.key, kind: 'contract', route: 'part',
      body: { quantityActual: 2, ...identity(mode, slot.key, '-INLINE') },
      oracle: contract(
        mode + ' qty 2 was sent to the inline part endpoint. requiresLotLineCapture says to use lot lines, but capturePart redirects only after a lot line already exists.',
      ),
    }));
    const blankLine = { quantity: 1, ...identity(mode, slot.key, '-A'), [field]: null };
    const otherLine = line(mode, slot.key, '-B');
    probes.push(act({
      id: slot.key + '-missing-line-identity',
      mode, slot: slot.key, kind: 'contract', route: 'lot-lines',
      body: { lines: [blankLine, otherLine] },
      oracle: contract(mode + ' lot lines summed to the requirement with a missing ' + field + '. Presence is not required on save; sign-off checks completeness.'),
    }));
  }
  if (mode === 'SerialLot' || mode === 'SerialHeat' || mode === 'LotHeat' || mode === 'SerialLotHeat') {
    const partial = { quantityActual: 1, ...identity(mode, slot.key, '-PART') };
    delete partial[field];
    probes.push(act({
      id: slot.key + '-partial-combination',
      mode, slot: slot.key, kind: 'contract', route: 'part',
      body: partial,
      oracle: contract(mode + ' was sent without ' + field + '. Option A: reject the partial combination. Option B: store it and block sign-off until the identity is complete.'),
    }));
  }
  return probes;
}

function limitsFor(slot) {
  const mode = slot.mode;
  const field = primaryField(mode);
  const limits = [];
  if (mode !== 'None') {
    const over = { ...withIdentity(mode, slot.key, field, { $over: 256 }) };
    const wrap = (body) => (slot.shape === 'units'
      ? { units: [{ unitIndex: 1, ...body }, { unitIndex: 2, serialNo: tag('SN', slot.key, '-2') }] }
      : slot.shape === 'lot-lines'
        ? { lines: [{ quantity: 1, ...body }, line(mode, slot.key, '-B')] }
        : body);
    limits.push(act({
      id: slot.key + '-over-length',
      mode, slot: slot.key, kind: 'invalid', route: routeFor(slot),
      body: wrap(slot.shape === 'inline' ? over : { ...identity(mode, slot.key), [field]: { $over: 256 } }),
      oracle: reject(400),
    }));
    limits.push(act({
      id: slot.key + '-wrong-type',
      mode, slot: slot.key, kind: 'invalid', route: routeFor(slot),
      body: wrap(slot.shape === 'inline'
        ? withIdentity(mode, slot.key, field, { bad: true })
        : { [field]: { bad: true } }),
      oracle: reject(400),
    }));
    if (slot.shape === 'inline') {
      limits.push(act({
        id: slot.key + '-max-length',
        mode, slot: slot.key, kind: 'edge', route: 'part',
        body: withIdentity(mode, slot.key, field, { $fill: 255 }, '-MAX'),
        oracle: {
          http: [200],
          accept: true,
          expect: { ...expectInline(mode, slot.key, 1, '-MAX'), [field]: { $fill: 255 } },
        },
      }));
    }
  }
  if (slot.shape === 'inline' && mode !== 'None') {
    limits.push(act({
      id: slot.key + '-unicode',
      mode, slot: slot.key, kind: 'edge', route: 'part',
      body: withIdentity(mode, slot.key, field, '{{UNICODE}}-{{RUN}}-' + slot.key),
      oracle: {
        http: [200], accept: true,
        expect: { ...expectInline(mode, slot.key, 1), [field]: '{{UNICODE}}-{{RUN}}-' + slot.key },
      },
    }));
  }
  return limits;
}

function quantityAttacks(slot) {
  if (slot.key !== 'none' && slot.shape !== 'lot-lines') return [];
  if (slot.key === 'none') {
    const stored = (quantityActual) => ({
      http: [200],
      accept: true,
      expect: { ...expectInline('None', 'none', 1), quantityActual: String(quantityActual) },
    });
    const cases = [
      ['numeric-string', '1', 'edge', { http: [200], accept: true, unchanged: true, historyUnchanged: true, expect: expectInline('None', 'none', 1) }],
      ['exact-scale', '1.2345', 'edge', stored('1.2345')],
      ['zero', 0, 'edge', stored(0)],
      ['decimal', '1.5', 'edge', stored('1.5')],
      ['above', 2, 'edge', stored(2)],
      ['negative', -1, 'invalid', reject(400, 'PART_QUANTITY_NEGATIVE')],
      ['non-numeric', 'potato', 'invalid', reject(400, 'PART_QUANTITY_INVALID')],
      // JSON numbers NaN and Infinity collapse to null, so they are not transmissible. The strings are.
      ['nan', 'NaN', 'invalid', reject(400, 'PART_QUANTITY_INVALID')],
      ['infinity', 'Infinity', 'invalid', reject(400, 'PART_QUANTITY_INVALID')],
      ['huge', '999999999999', 'invalid', reject(400, 'PART_QUANTITY_OVERFLOW')],
      ['scale', '1.23456', 'invalid', reject(400, 'PART_QUANTITY_OVERFLOW')],
      ['null', null, 'invalid', reject(400)],
      ['wrong-type', { bad: true }, 'invalid', reject(400)],
    ];
    return cases.map(([name, quantityActual, kind, oracle]) => act({
      id: 'none-qty-' + name,
      mode: 'None', slot: 'none', kind, route: 'part',
      body: { quantityActual },
      oracle,
    })).concat(act({
      id: 'none-qty-omitted',
      mode: 'None', slot: 'none', kind: 'contract', route: 'part',
      body: {},
      oracle: contract('An inline part patch omitted quantityActual. Option A: reject an empty capture. Option B: leave the previous quantity in place.'),
    }));
  }
  const bad = [
    ['under', [{ quantity: 1, ...identity(slot.mode, slot.key, '-A') }]],
    ['over', [{ quantity: 2, ...identity(slot.mode, slot.key, '-A') }, { quantity: 1, ...identity(slot.mode, slot.key, '-B') }]],
    ['zero', [{ quantity: 0, ...identity(slot.mode, slot.key, '-A') }, line(slot.mode, slot.key, '-B')]],
    ['negative', [{ quantity: -1, ...identity(slot.mode, slot.key, '-A') }, line(slot.mode, slot.key, '-B')]],
    ['decimal', [{ quantity: 1.5, ...identity(slot.mode, slot.key, '-A') }]],
    ['huge', [{ quantity: '999999999999', ...identity(slot.mode, slot.key, '-A') }]],
    ['non-numeric', [{ quantity: 'potato', ...identity(slot.mode, slot.key, '-A') }]],
    ['null', [{ quantity: null, ...identity(slot.mode, slot.key, '-A') }]],
  ];
  const lotLineCode = {
    under: 'PART_LOT_LINE_QTY_MISMATCH',
    over: 'PART_LOT_LINE_QTY_MISMATCH',
    decimal: 'PART_LOT_LINE_QTY_MISMATCH',
    // Zero and negative fail the positive-number schema before the service code is assigned.
    huge: 'PART_LOT_LINE_QTY_OVERFLOW',
    'non-numeric': 'PART_LOT_LINE_QTY_INVALID',
  };
  return bad.map(([name, lines]) => act({
    id: slot.key + '-qty-' + name,
    mode: slot.mode, slot: slot.key, kind: 'invalid', route: 'lot-lines',
    body: { lines },
    oracle: reject(400, lotLineCode[name]),
  }));
}

const FORBIDDEN_IDENTITY = {
  none: ['serialNo', 'lotNo', 'heatNo'],
  lot: ['serialNo', 'heatNo'],
  serial: ['lotNo', 'heatNo'],
  heat: ['serialNo', 'lotNo'],
  seriallot: ['heatNo'],
  serialheat: ['lotNo'],
  lotheat: ['serialNo'],
  seriallotheat: [],
};

function forbiddenIdentityActions(slot) {
  if (slot.shape !== 'inline') return [];
  return (FORBIDDEN_IDENTITY[slot.key] ?? []).map((field) => act({
    id: slot.key + '-forbidden-' + field,
    mode: slot.mode, slot: slot.key, kind: 'invalid', route: 'part',
    body: {
      quantityActual: slot.quantity,
      ...identity(slot.mode, slot.key),
      [field]: tag('X', slot.key, '-' + field),
    },
    oracle: reject(400, 'PART_IDENTITY_NOT_ALLOWED'),
  }));
}

function followUps(slot) {
  const extra = [];
  if (slot.shape === 'inline' && SERIAL.has(slot.mode) && slot.quantity === 1) {
    extra.push(act({
      id: slot.key + '-replace',
      mode: slot.mode, slot: slot.key, kind: 'edge', route: 'part',
      body: { quantityActual: 1, ...identity(slot.mode, slot.key, '-NEW') },
      oracle: { http: [200], accept: true, expect: expectInline(slot.mode, slot.key, 1, '-NEW') },
    }));
    extra.push(act({
      id: slot.key + '-clear',
      mode: slot.mode, slot: slot.key, kind: 'edge', route: 'part',
      body: { quantityActual: 1, ...identity(slot.mode, slot.key, '-NEW'), [primaryField(slot.mode)]: null },
      oracle: {
        http: [200], accept: true,
        expect: { ...expectInline(slot.mode, slot.key, 1, '-NEW'), [primaryField(slot.mode)]: null },
      },
    }));
  }
  if (slot.key === 'serial') {
    extra.push(act({
      id: 'serial-two-serials-on-qty-1',
      mode: 'Serial', slot: 'serial', kind: 'invalid', route: 'units',
      body: {
        units: [
          { proStepPartUnitId: MISSING_ID, serialNo: tag('SN', 'serial', '-X') },
          { proStepPartUnitId: MISSING_ID, serialNo: tag('SN', 'serial', '-Y') },
        ],
      },
      oracle: reject(400, 'multi-unit'),
    }));
  }
  if (slot.shape === 'units') {
    extra.push(act({
      id: 'serial-duplicate-same-requirement',
      mode: 'Serial', slot: slot.key, kind: 'invalid', route: 'units',
      body: {
        units: [1, 2].map((unitIndex) => ({ unitIndex, serialNo: tag('SN', slot.key, '-DUP') })),
      },
      oracle: reject(400, 'Duplicate serial'),
    }));
  }
  if (slot.shape === 'lot-lines') {
    const reversed = [line(slot.mode, slot.key, '-B'), line(slot.mode, slot.key, '-A')];
    extra.push(act({
      id: slot.key + '-reorder',
      mode: slot.mode, slot: slot.key, kind: 'edge', route: 'lot-lines',
      body: { lines: reversed },
      oracle: { http: [200], accept: true, expect: happyExpect(slot) },
    }));
    extra.push(act({
      id: slot.key + '-duplicate-lines',
      mode: slot.mode, slot: slot.key, kind: 'edge', route: 'lot-lines',
      body: { lines: [line(slot.mode, slot.key, '-A'), line(slot.mode, slot.key, '-A')] },
      oracle: { http: [200], accept: true, expect: expectLines(slot.mode, [line(slot.mode, slot.key, '-A'), line(slot.mode, slot.key, '-A')]) },
    }));
    extra.push(act({
      id: slot.key + '-replace-lines',
      mode: slot.mode, slot: slot.key, kind: 'edge', route: 'lot-lines',
      body: { lines: [line(slot.mode, slot.key, '-C'), line(slot.mode, slot.key, '-D')] },
      oracle: { http: [200], accept: true, expect: expectLines(slot.mode, [line(slot.mode, slot.key, '-C'), line(slot.mode, slot.key, '-D')]) },
    }));
  }
  return extra;
}

export const LOT_LINE_CONCURRENCY_REPEATS = 3;

function concurrencyActions() {
  const lotLineSets = ['-P', '-Q'].map((suffix) => ({
    body: { lines: [line('Lot', 'lot-lines', suffix + '1'), line('Lot', 'lot-lines', suffix + '2')] },
  }));
  const lotLineOracle = {
    accept: true,
    oneOf: ['-P', '-Q'].map((suffix) => expectLines('Lot', [line('Lot', 'lot-lines', suffix + '1'), line('Lot', 'lot-lines', suffix + '2')])),
    conflictHttp: [409],
    conflictCode: 'PART_LOT_LINE_CONFLICT',
  };
  const repeats = Array.from({ length: LOT_LINE_CONCURRENCY_REPEATS }, (_, index) => act({
    id: index === 0 ? 'lot-lines-concurrent' : 'lot-lines-concurrent-' + (index + 1),
    mode: 'Lot', slot: 'lot-lines', kind: 'concurrency', route: 'lot-lines',
    parallel: lotLineSets,
    oracle: lotLineOracle,
  }));
  return [
    act({
      id: 'serial-concurrent',
      mode: 'Serial', slot: 'serial', kind: 'concurrency', route: 'part',
      parallel: ['-A', '-B'].map((suffix) => ({ body: { quantityActual: 1, serialNo: tag('SN', 'serial', suffix) } })),
      oracle: {
        accept: true,
        oneOf: ['-A', '-B'].map((suffix) => expectInline('Serial', 'serial', 1, suffix)),
      },
    }),
    act({
      id: 'serial-units-concurrent',
      mode: 'Serial', slot: 'serial-units', kind: 'concurrency', route: 'units',
      parallel: ['-A', '-B'].map((suffix) => ({
        body: { units: [{ unitIndex: 1, serialNo: tag('SN', 'serial-units', suffix) }] },
      })),
      oracle: {
        accept: true,
        oneOf: ['-A', '-B'].map((suffix) => expectUnits([tag('SN', 'serial-units', suffix), tag('SN', 'serial-units', '-2')])),
      },
    }),
    act({
      id: 'serial-units-same-serial-concurrent',
      mode: 'Serial', slot: 'serial-units', kind: 'concurrency', route: 'units',
      parallel: [1, 2].map((unitIndex) => ({
        body: { units: [{ unitIndex, serialNo: tag('SN', 'serial-units', '-SAME') }] },
      })),
      oracle: { accept: true, duplicateSerial: true, submittedSerial: tag('SN', 'serial-units', '-SAME') },
    }),
    ...repeats,
  ];
}

export function partsCapturePlan(seed) {
  const random = rng(seed);
  const pad = ['A', 'B', 'C', 'D'][integer(random, 0, 3)];
  const unicode = ['é', 'Ω', '中', 'ñ'][integer(random, 0, 3)];
  const variant = integer(random, 0, 999983);
  const actions = [
    act({
      id: 'gate-before-previous-operation',
      mode: 'None', slot: 'gate', kind: 'invalid', route: 'part',
      body: { quantityActual: 1 },
      oracle: reject(409, 'Complete Op'),
    }),
  ];
  for (const slot of PART_SLOTS) {
    if (slot.key === 'gate') continue;
    actions.push(...probesFor(slot));
    actions.push(act({
      id: slot.key + '-happy',
      mode: slot.mode, slot: slot.key, kind: 'valid', route: routeFor(slot),
      body: happyBody(slot),
      oracle: { http: [200], accept: true, expect: happyExpect(slot) },
    }));
    actions.push(act({
      id: slot.key + '-repeat',
      mode: slot.mode, slot: slot.key, kind: 'edge', route: routeFor(slot),
      body: happyBody(slot),
      oracle: { http: [200], accept: true, unchanged: true, historyUnchanged: true, expect: happyExpect(slot) },
    }));
    actions.push(...limitsFor(slot).filter((item) => item.kind !== 'edge' || item.id.endsWith('-wrong-type') || item.id.endsWith('-over-length')));
    actions.push(...limitsFor(slot).filter((item) => item.kind === 'edge'));
    actions.push(...quantityAttacks(slot));
    actions.push(...followUps(slot));
    actions.push(...forbiddenIdentityActions(slot));
  }
  actions.push(...concurrencyActions());
  actions.push(act({
    id: 'serial-reuse-other-requirement',
    mode: 'Serial', slot: 'seriallot', kind: 'contract', route: 'part',
    body: { quantityActual: 1, serialNo: tag('SN', 'serial'), lotNo: tag('LOT', 'seriallot', '-REUSE') },
    oracle: contract('The same serial was used on two requirements of one work order. Uniqueness in the schema is per pro_step_part_id. Option A: reject it as a PO-wide serial. Option B: store it on the second requirement.'),
  }));
  for (const foreign of [
    ['part-missing-id', 'missing'],
    ['part-other-step', 'other-step'],
    ['part-other-requirement', 'other-requirement'],
    ['part-other-wo', 'other-wo'],
  ]) {
    actions.push(act({
      id: foreign[0],
      mode: null, slot: 'serial', kind: 'invalid', route: 'part', foreign: foreign[1],
      body: { quantityActual: 1, serialNo: tag('SN', 'serial', '-FOREIGN') },
      oracle: reject(404),
    }));
  }
  actions.push(
    act({
      id: 'po-in-progress', mode: null, kind: 'state', route: 'status', optional: true,
      body: { status: 'InProgress' },
      oracle: { http: [200], accept: true },
    }),
    act({
      id: 'po-on-hold', mode: null, kind: 'state', route: 'status', optional: true,
      body: { status: 'OnHold' },
      oracle: { http: [200], accept: true },
    }),
    act({
      id: 'capture-while-po-on-hold',
      mode: null, slot: 'none', kind: 'contract', route: 'part', optional: true, requiresHold: true,
      body: { quantityActual: 1 },
      oracle: contract('A work order has no OnHold status. The execution gate allows Ready and InProgress only. Option A: a PO OnHold still blocks capture. Option B: capture succeeds because the gate does not read the PO status.'),
    }),
    act({
      id: 'po-resume', mode: null, kind: 'state', route: 'status', optional: true, requiresHold: true,
      body: { status: 'InProgress' },
      oracle: { http: [200], accept: true },
    }),
    act({
      id: 'wo-cancel', mode: null, kind: 'cancel', route: 'cancel',
      body: { reason: 'Chaos parts cancel' },
      oracle: { http: [200], accept: true },
    }),
    act({
      id: 'capture-after-cancel',
      mode: 'None', slot: 'none', kind: 'invalid', route: 'part', requiresCancel: true,
      body: { quantityActual: 1 },
      oracle: reject(400, 'cancelled'),
    }),
  );
  for (const slot of PART_SLOTS) {
    if (slot.key === 'gate') continue;
    const suffix = '-U2';
    const body = slot.shape === 'units'
      ? { units: [1, 2].map((unitIndex) => ({ unitIndex, serialNo: tag('SN', slot.key, suffix + unitIndex) })) }
      : slot.shape === 'lot-lines'
        ? { lines: [line(slot.mode, slot.key, suffix + 'A'), line(slot.mode, slot.key, suffix + 'B')] }
        : { quantityActual: slot.quantity, ...identity(slot.mode, slot.key, suffix) };
    const expect = slot.shape === 'units'
      ? expectUnits([tag('SN', slot.key, suffix + '1'), tag('SN', slot.key, suffix + '2')])
      : slot.shape === 'lot-lines'
        ? expectLines(slot.mode, [line(slot.mode, slot.key, suffix + 'A'), line(slot.mode, slot.key, suffix + 'B')])
        : expectInline(slot.mode, slot.key, slot.quantity, suffix);
    actions.push(act({
      id: slot.key + '-happy-wo2',
      wo: 2, mode: slot.mode, slot: slot.key, kind: 'valid', route: routeFor(slot),
      requiresResume: true,
      body, oracle: { http: [200], accept: true, expect },
    }));
  }
  actions.push(act({
    id: 'serial-reuse-other-wo',
    wo: 2, mode: 'Serial', slot: 'serial', kind: 'contract', route: 'part', requiresResume: true,
    body: { quantityActual: 1, serialNo: tag('SN', 'serial') },
    oracle: contract('The serial captured on work order 1 was sent to the same requirement on work order 2. Option A: reject cross-WO reuse. Option B: store it because uniqueness does not cross work orders.'),
  }));
  actions.push(
    act({
      id: 'signoff-op10', wo: 2, mode: null, slot: 'none', kind: 'state', route: 'signoff', optional: true, requiresResume: true,
      oracle: { http: [200], accept: true },
    }),
    act({
      id: 'signoff-op20', wo: 2, mode: null, slot: 'gate', kind: 'state', route: 'signoff', optional: true, requiresResume: true,
      oracle: { http: [200], accept: true },
    }),
    act({
      id: 'capture-after-complete',
      wo: 2, mode: null, slot: 'gate', kind: 'invalid', route: 'part', optional: true, requiresComplete: true,
      body: { quantityActual: 1 },
      oracle: reject([400, 409]),
    }),
  );
  const ids = actions.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Parts plan has duplicate action ids');
  }
  if (actions.some((item) => !item.oracle)) {
    throw new Error('Parts plan has an action without an oracle');
  }
  const plan = {
    seed,
    variant,
    pad,
    unicode,
    modes: PART_TRACEABILITY_MODES,
    slots: PART_SLOTS,
    actions,
  };
  return { ...plan, partsPlanHash: partsPlanHash(plan) };
}

export function partsPlanHash(plan) {
  const { partsPlanHash: ignored, ...rest } = plan;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

export function expandPartsValue(value, token, pad, unicode) {
  if (Array.isArray(value)) return value.map((item) => expandPartsValue(item, token, pad, unicode));
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, '$fill')) {
      return ('L' + token + String(pad).repeat(value.$fill)).slice(0, value.$fill);
    }
    if (Object.prototype.hasOwnProperty.call(value, '$over')) {
      return ('X' + token + String(pad).repeat(value.$over + token.length + 2)).slice(0, value.$over);
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = expandPartsValue(value[key], token, pad, unicode);
    return out;
  }
  if (typeof value === 'string') {
    return value.replaceAll('{{RUN}}', token).replaceAll('{{UNICODE}}', unicode);
  }
  return value;
}

export function bindPartsPlan(plan, runId) {
  const token = String(runId).replaceAll('-', '').toUpperCase().slice(0, 12);
  const bound = expandPartsValue(plan, token, plan.pad, plan.unicode);
  bound.partsPlanHash = plan.partsPlanHash;
  bound.runToken = token;
  return bound;
}

export function summarizePartsPlan(plan) {
  const byTraceabilityMode = {};
  for (const mode of PART_TRACEABILITY_MODES) {
    const rows = plan.actions.filter((item) => item.mode === mode);
    byTraceabilityMode[mode] = {
      plannedActions: rows.length,
      valid: rows.filter((item) => item.kind === 'valid').length,
      edge: rows.filter((item) => item.kind === 'edge').length,
      invalid: rows.filter((item) => item.kind === 'invalid').length,
      concurrency: rows.filter((item) => item.kind === 'concurrency').length,
      contract: rows.filter((item) => item.kind === 'contract').length,
    };
  }
  return {
    partsPlanHash: plan.partsPlanHash,
    actionCount: plan.actions.length,
    byTraceabilityMode,
  };
}

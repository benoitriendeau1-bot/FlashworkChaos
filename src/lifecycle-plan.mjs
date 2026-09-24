import { createHash } from 'node:crypto';
import { integer, rng } from './engine.mjs';
import { stableStringify } from './scenario.mjs';

/** Fixed before any HTTP call. Same seed and options always rebuild this list. */
export const LIFECYCLE_RACE_REPEATS = 2;
export const LIFECYCLE_CLEAR_REPEATS = 5;
export const LIFECYCLE_LOT_LINE_REPEATS = 5;
export const LIFECYCLE_UNIT_COUNT = 21;

const CAPTURE_DATE = '2026-09-23';

function hashPlan(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function reject(errorIncludes) {
  return { http: [400, 404, 409, 422], accept: false, unchanged: true, errorIncludes: errorIncludes ?? null };
}

/**
 * Deterministic lifecycle of one dedicated master item.
 * The captured note embeds a seeded mark so two seeds cannot collide.
 * Effectivity date and run id stay outside the hash.
 */
export function lifecyclePlan(seed) {
  const random = rng(seed);
  const mark = integer(random, 1000, 9999);
  const note = 'Filetage conforme, couple contrôlé, marque ' + mark;
  const expected = {
    note,
    torque: 15,
    torqueUnit: 'N·m',
    visual: true,
    date: CAPTURE_DATE,
    disposition: 'Accept',
    serialNo: 'SN-{{RUN}}-SER',
    lotNo: 'LOT-{{RUN}}-LOT',
    heatNo: 'HEAT-{{RUN}}-HEA',
    identityValue: 'UNITE-{{RUN}}',
    noneQuantity: 1,
    lotLines: [
      { quantity: 1, lotNo: 'LOT-{{RUN}}-LLA' },
      { quantity: 1, lotNo: 'LOT-{{RUN}}-LLB' },
    ],
    tags: {
      required: 'TAG-{{RUN}}-REQ',
      optional: 'TAG-{{RUN}}-OPT',
      info: 'TAG-{{RUN}}-INF',
      second: 'TAG-{{RUN}}-RQ2',
    },
    instructions: {
      '10': 'Serrer au couple, identifier la pièce et signer avant de poursuivre.',
      '20': 'Contrôler le visuel, la date et la nuance, puis signer la clôture.',
    },
  };
  const catalog = {
    parts: [
      { key: 'none', mode: 'None', code: 'NN', operationNo: '10', quantity: 1 },
      { key: 'serial', mode: 'Serial', code: 'SE', operationNo: '10', quantity: 1 },
      { key: 'lot', mode: 'Lot', code: 'LO', operationNo: '10', quantity: 1 },
      { key: 'heat', mode: 'Heat', code: 'HE', operationNo: '20', quantity: 1 },
      { key: 'lot-lines', mode: 'Lot', code: 'LL', operationNo: '20', quantity: 2 },
    ],
    tools: [
      { key: 'required', code: 'RQ', policy: 'required', tag: expected.tags.required, operationNo: '10' },
      { key: 'optional', code: 'OP', policy: 'optional', tag: expected.tags.optional, operationNo: '10' },
      { key: 'info', code: 'IN', policy: 'info_only', tag: expected.tags.info, operationNo: '10' },
      { key: 'second', code: 'R2', policy: 'required', tag: expected.tags.second, operationNo: '20' },
    ],
    data: [
      { referenceCode: 'LC-NOTE', operationNo: '10', dataType: 'text', isMandatory: true, label: 'Constat de filetage' },
      { referenceCode: 'LC-TRQ', operationNo: '10', dataType: 'measurement', isMandatory: true, label: 'Couple de serrage', minValue: 10, maxValue: 20, nominalValue: 15, unit: 'N·m' },
      { referenceCode: 'LC-VIS', operationNo: '20', dataType: 'boolean', isMandatory: true, label: 'Contrôle visuel' },
      { referenceCode: 'LC-DATE', operationNo: '20', dataType: 'date', isMandatory: true, label: 'Date du contrôle' },
      { referenceCode: 'LC-DISP', operationNo: '20', dataType: 'enum', isMandatory: true, label: 'Disposition', enumChoices: ['Accept', 'Rework', 'Reject'] },
    ],
  };
  const actions = [
    { id: 'gate-future-operation', unit: 1, kind: 'data', operationNo: '20', referenceCode: 'LC-VIS', body: { capturedValueBool: true }, oracle: { http: [409], accept: false, capturesUnchanged: true, startsOnTouch: true, errorIncludes: 'Complete Op' } },
    { id: 'capture-note', unit: 1, kind: 'data', operationNo: '10', referenceCode: 'LC-NOTE', body: { capturedValueText: note }, oracle: { http: [200], accept: true, captureStatus: 'Captured' } },
    { id: 'capture-torque', unit: 1, kind: 'data', operationNo: '10', referenceCode: 'LC-TRQ', body: { capturedValueNumber: expected.torque }, oracle: { http: [200], accept: true, captureStatus: 'Captured' } },
    { id: 'capture-none', unit: 1, kind: 'part', operationNo: '10', partKey: 'none', body: { quantityActual: 1 }, oracle: { http: [200], accept: true } },
    { id: 'capture-serial', unit: 1, kind: 'part', operationNo: '10', partKey: 'serial', body: { quantityActual: 1, serialNo: expected.serialNo }, oracle: { http: [200], accept: true } },
    { id: 'capture-lot', unit: 1, kind: 'part', operationNo: '10', partKey: 'lot', body: { quantityActual: 1, lotNo: expected.lotNo }, oracle: { http: [200], accept: true } },
    { id: 'capture-tool-required', unit: 1, kind: 'tool', operationNo: '10', toolKey: 'required', body: { scanCode: expected.tags.required }, oracle: { http: [200], accept: true } },
    { id: 'capture-tool-optional', unit: 1, kind: 'tool', operationNo: '10', toolKey: 'optional', body: { scanCode: expected.tags.optional }, oracle: { http: [200], accept: true } },
    { id: 'pass-op10', unit: 1, kind: 'pass', operationNo: '10', oracle: { http: [200], accept: true, outcome: 'Passed' } },
    { id: 'capture-visual', unit: 1, kind: 'data', operationNo: '20', referenceCode: 'LC-VIS', body: { capturedValueBool: expected.visual }, oracle: { http: [200], accept: true, captureStatus: 'Captured' } },
    { id: 'capture-date', unit: 1, kind: 'data', operationNo: '20', referenceCode: 'LC-DATE', body: { capturedValueText: expected.date }, oracle: { http: [200], accept: true, captureStatus: 'Captured' } },
    { id: 'capture-disposition', unit: 1, kind: 'data', operationNo: '20', referenceCode: 'LC-DISP', body: { capturedValueText: expected.disposition }, oracle: { http: [200], accept: true, captureStatus: 'Captured' } },
    { id: 'capture-heat', unit: 1, kind: 'part', operationNo: '20', partKey: 'heat', body: { quantityActual: 1, heatNo: expected.heatNo }, oracle: { http: [200], accept: true } },
    { id: 'capture-tool-second', unit: 1, kind: 'tool', operationNo: '20', toolKey: 'second', body: { scanCode: expected.tags.second }, oracle: { http: [200], accept: true } },
    { id: 'capture-lot-lines', unit: 1, kind: 'lot-lines', operationNo: '20', partKey: 'lot-lines', body: { lines: expected.lotLines }, oracle: { http: [200], accept: true } },
    { id: 'capture-identity', unit: 1, kind: 'identity', operationNo: '20', body: { identityValue: expected.identityValue }, oracle: { http: [200], accept: true } },
    { id: 'pass-op20', unit: 1, kind: 'pass', operationNo: '20', oracle: { http: [200], accept: true, outcome: 'Passed' } },
    { id: 'complete-happy', unit: 1, kind: 'complete', body: {}, oracle: { http: [200], accept: true, status: 'Completed', completionEvents: 1 } },
    { id: 'immutable-data', unit: 1, kind: 'data', operationNo: '10', referenceCode: 'LC-NOTE', body: { capturedValueText: note + ' modifié', comment: 'Tentative après clôture' }, oracle: reject('completed'), immutable: true },
    { id: 'immutable-clear-data', unit: 1, kind: 'data', operationNo: '10', referenceCode: 'LC-NOTE', body: { capturedValueText: null, comment: 'Effacement après clôture' }, oracle: reject('completed'), immutable: true },
    { id: 'immutable-part', unit: 1, kind: 'part', operationNo: '10', partKey: 'serial', body: { quantityActual: 1, serialNo: 'SN-CHANGED' }, oracle: reject('completed'), immutable: true },
    { id: 'immutable-lot', unit: 1, kind: 'part', operationNo: '10', partKey: 'lot', body: { quantityActual: 1, lotNo: 'LOT-CHANGED' }, oracle: reject('completed'), immutable: true },
    { id: 'immutable-tool', unit: 1, kind: 'tool', operationNo: '10', toolKey: 'required', body: { scanCode: expected.tags.optional }, oracle: reject('completed'), immutable: true },
    { id: 'immutable-other-tool', unit: 1, kind: 'tool', operationNo: '10', toolKey: 'info', body: { scanCode: expected.tags.info }, oracle: reject('completed'), immutable: true },
    { id: 'immutable-pass', unit: 1, kind: 'pass', operationNo: '10', oracle: reject('completed'), immutable: true },
    { id: 'immutable-skip', unit: 1, kind: 'skip', operationNo: '10', oracle: reject('completed'), immutable: true },
    { id: 'immutable-reopen', unit: 1, kind: 'reopen', operationNo: '10', oracle: reject('completed'), immutable: true },
    { id: 'immutable-clear-evidence', unit: 1, kind: 'clear', operationNo: '10', body: { comment: 'Effacement de preuve après clôture' }, oracle: reject('completed'), immutable: true },
    { id: 'immutable-complete-again', unit: 1, kind: 'complete', body: {}, oracle: { http: [200], accept: true, status: 'Completed', completionEvents: 1, idempotent: true }, immutable: true },
    { id: 'attack-before-capture', unit: 2, kind: 'complete', body: {}, oracle: reject() },
    { id: 'attack-negative-qty', unit: 2, kind: 'complete', body: { quantityCompleted: -1 }, oracle: reject() },
    { id: 'attack-over-qty', unit: 2, kind: 'complete', body: { quantityCompleted: 99 }, oracle: reject() },
    { id: 'attack-qty-text', unit: 2, kind: 'complete', body: { quantityCompleted: 'beaucoup' }, oracle: reject() },
    { id: 'attack-unknown-field', unit: 2, kind: 'complete', body: { surprise: true }, oracle: reject() },
    { id: 'attack-bad-actor', unit: 2, kind: 'complete', body: { eventBy: 'not-a-user' }, oracle: reject() },
    { id: 'attack-wrong-id', unit: 2, kind: 'complete', workOrderId: '00000000-0000-4000-8000-000000000000', body: {}, oracle: { http: [404], accept: false, unchanged: true } },
    { id: 'attack-other-po', unit: 2, kind: 'complete', foreignOrder: true, body: {}, oracle: { http: [404], accept: false, unchanged: true } },
    { id: 'attack-missing-data', unit: 2, kind: 'complete', body: {}, oracle: reject(), note: 'Still missing every mandatory capture.' },
    { id: 'attack-partial-op10', unit: 2, kind: 'data', operationNo: '10', referenceCode: 'LC-NOTE', body: { capturedValueText: note }, oracle: { http: [200], accept: true } },
    { id: 'attack-complete-partial', unit: 2, kind: 'complete', body: {}, oracle: reject() },
    { id: 'attack-cancel', unit: 2, kind: 'cancel', body: { reason: 'Attaque de clôture, ordre retiré du flux' }, oracle: { http: [200], accept: true, status: 'Cancelled' } },
    { id: 'attack-complete-cancelled', unit: 2, kind: 'complete', body: {}, oracle: { http: [400], accept: false, unchanged: true, status: 'Cancelled', errorIncludes: 'cancelled', code: 'WORK_ORDER_NOT_IN_PROGRESS' } },
    { id: 'attack-complete-twice-cancelled', unit: 2, kind: 'complete', body: {}, oracle: { http: [400], accept: false, unchanged: true, status: 'Cancelled' } },
    { id: 'skip-data-prepare', unit: 9, kind: 'recipe', recipe: 'except-visual' },
    { id: 'skip-data-pending', unit: 9, kind: 'skip', operationNo: '20', oracle: { http: [200], accept: true, outcome: 'Skipped', holdOpen: true, dossier: 'open', gap: 'LC-VIS' } },
    { id: 'complete-while-data-pending', unit: 9, kind: 'complete', body: {}, oracle: { http: [400], accept: false, unchanged: true, code: 'WORK_ORDER_CAPTURES_INCOMPLETE', holdOpen: true } },
    { id: 'capture-last-visual', unit: 9, kind: 'data', operationNo: '20', referenceCode: 'LC-VIS', body: { capturedValueBool: true }, oracle: { http: [200], accept: true, closed: true, dossier: 'closed' } },
    { id: 'skip-part-prepare', unit: 10, kind: 'recipe', recipe: 'except-heat' },
    { id: 'skip-part-pending', unit: 10, kind: 'skip', operationNo: '20', oracle: { http: [200], accept: true, outcome: 'Skipped', holdOpen: true, gap: 'heat' } },
    { id: 'capture-last-heat', unit: 10, kind: 'part', operationNo: '20', partKey: 'heat', body: { quantityActual: 1, heatNo: expected.heatNo }, oracle: { http: [200], accept: true, closed: true } },
    { id: 'skip-tool-prepare', unit: 11, kind: 'recipe', recipe: 'except-tool' },
    { id: 'skip-tool-pending', unit: 11, kind: 'skip', operationNo: '20', oracle: { http: [200], accept: true, outcome: 'Skipped', holdOpen: true, gap: 'second' } },
    { id: 'capture-last-tool', unit: 11, kind: 'tool', operationNo: '20', toolKey: 'second', body: { scanCode: expected.tags.second }, oracle: { http: [200], accept: true, closed: true } },
    { id: 'skip-identity-prepare', unit: 12, kind: 'recipe', recipe: 'except-identity' },
    { id: 'skip-identity-pending', unit: 12, kind: 'skip', operationNo: '20', oracle: { http: [200], accept: true, outcome: 'Skipped', holdOpen: true, gap: 'identity' } },
    { id: 'capture-last-identity', unit: 12, kind: 'identity', operationNo: '20', body: { identityValue: expected.identityValue }, oracle: { http: [200], accept: true, closed: true } },
  ];
  const capture = (kind, operationNo, key, body) => ({ kind, operationNo, key, body });
  const op10 = [
    capture('data', '10', 'LC-NOTE', { capturedValueText: note }),
    capture('data', '10', 'LC-TRQ', { capturedValueNumber: expected.torque }),
    capture('part', '10', 'none', { quantityActual: 1 }),
    capture('part', '10', 'serial', { quantityActual: 1, serialNo: expected.serialNo }),
    capture('part', '10', 'lot', { quantityActual: 1, lotNo: expected.lotNo }),
    capture('tool', '10', 'required', { scanCode: expected.tags.required }),
    capture('pass', '10', null, null),
  ];
  const op20 = {
    visual: capture('data', '20', 'LC-VIS', { capturedValueBool: true }),
    date: capture('data', '20', 'LC-DATE', { capturedValueText: expected.date }),
    disposition: capture('data', '20', 'LC-DISP', { capturedValueText: expected.disposition }),
    heat: capture('part', '20', 'heat', { quantityActual: 1, heatNo: expected.heatNo }),
    tool: capture('tool', '20', 'second', { scanCode: expected.tags.second }),
    lotLines: capture('lot-lines', '20', 'lot-lines', { lines: expected.lotLines }),
    identity: capture('identity', '20', null, { identityValue: expected.identityValue }),
    pass: capture('pass', '20', null, null),
    skip: capture('skip', '20', null, null),
  };
  const rest = (omit) => ['date', 'disposition', 'heat', 'tool', 'lotLines', 'identity', 'visual'].filter((key) => key !== omit).map((key) => op20[key]);
  const recipes = {
    fulfill: [...op10, ...rest(null), op20.pass],
    'captures-only': [...op10, ...rest(null)],
    'except-visual': [...op10, ...rest('visual')],
    'except-visual-then-skip': [...op10, ...rest('visual'), op20.skip],
    'except-heat': [...op10, ...rest('heat')],
    'except-tool': [...op10, ...rest('tool')],
    'except-identity': [...op10, ...rest('identity')],
    'except-lot-lines-then-skip': [...op10, ...rest('lotLines'), op20.skip],
  };
  const races = [
    {
      id: 'race-two-completes',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 3,
      prepare: 'fulfill',
      parallel: [{ kind: 'complete', body: {} }, { kind: 'complete', body: {} }],
      oracle: { no500: true, status: 'Completed', completionEvents: 1 },
    },
    {
      id: 'race-signoff-complete',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 4,
      prepare: 'captures-only',
      parallel: [{ kind: 'pass', operationNo: '20' }, { kind: 'complete', body: {} }],
      oracle: { no500: true, linear: 'last-requirement' },
    },
    {
      id: 'race-capture-complete',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 5,
      prepare: 'except-visual-then-skip',
      parallel: [
        { kind: 'data', operationNo: '20', referenceCode: 'LC-VIS', body: { capturedValueBool: true } },
        { kind: 'complete', body: {} },
      ],
      oracle: { no500: true, linear: 'closure' },
    },
    {
      id: 'race-skip-data',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 13,
      prepare: 'except-visual',
      parallel: [
        { kind: 'skip', operationNo: '20' },
        { kind: 'data', operationNo: '20', referenceCode: 'LC-VIS', body: { capturedValueBool: true } },
      ],
      oracle: { no500: true, linear: 'closure' },
    },
    {
      id: 'race-skip-clear-data',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 14,
      prepare: 'captures-only',
      parallel: [
        { kind: 'skip', operationNo: '20' },
        { kind: 'data', operationNo: '10', referenceCode: 'LC-NOTE', body: { capturedValueText: null, comment: 'Effacement pendant le skip' } },
      ],
      oracle: { no500: true, linear: 'closure' },
    },
    {
      id: 'race-skip-part',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 15,
      prepare: 'except-heat',
      parallel: [
        { kind: 'skip', operationNo: '20' },
        { kind: 'part', operationNo: '20', partKey: 'heat', body: { quantityActual: 1, heatNo: expected.heatNo } },
      ],
      oracle: { no500: true, linear: 'closure' },
    },
    {
      id: 'race-skip-tool',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 16,
      prepare: 'except-tool',
      parallel: [
        { kind: 'skip', operationNo: '20' },
        { kind: 'tool', operationNo: '20', toolKey: 'second', body: { scanCode: expected.tags.second } },
      ],
      oracle: { no500: true, linear: 'closure' },
    },
    {
      id: 'race-complete-cancel',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 6,
      prepare: 'captures-only',
      parallel: [{ kind: 'complete', body: {} }, { kind: 'cancel', body: { reason: 'Course clôture contre annulation' } }],
      oracle: { no500: true, linear: 'complete-cancel' },
    },
    {
      id: 'race-complete-clear',
      repeats: LIFECYCLE_CLEAR_REPEATS,
      unit: 7,
      prepare: 'captures-only',
      parallel: [
        { kind: 'skip', operationNo: '20' },
        { kind: 'clear', operationNo: '10', body: { comment: 'Course clôture contre effacement' } },
      ],
      oracle: { no500: true, linear: 'closure' },
    },
    {
      id: 'race-two-units',
      repeats: LIFECYCLE_RACE_REPEATS,
      units: [3, 8],
      prepare: 'fulfill',
      parallel: [{ kind: 'complete', unit: 3, body: {} }, { kind: 'complete', unit: 8, body: {} }],
      oracle: { no500: true, eachStatus: 'Completed' },
    },
    {
      id: 'race-export-during-complete',
      repeats: LIFECYCLE_RACE_REPEATS,
      unit: 8,
      prepare: 'fulfill',
      parallel: [{ kind: 'complete', body: {} }, { kind: 'traveler' }, { kind: 'export' }],
      oracle: { no500: true, coherentExport: true },
    },
    {
      id: 'race-same-unit-second-wo',
      repeats: LIFECYCLE_RACE_REPEATS,
      notApplicable: true,
      reason: 'A sequential line accepts one open work order per unit. A second work order returns WORK_ORDER_EXISTS.',
    },
    {
      id: 'race-lot-lines-complete',
      repeats: 1,
      units: [17, 18, 19, 20, 21],
      eachUnit: true,
      prepare: 'except-lot-lines-then-skip',
      parallel: [
        { kind: 'lot-lines', operationNo: '20', partKey: 'lot-lines', body: { lines: expected.lotLines } },
        { kind: 'complete', body: {} },
      ],
      oracle: { no500: true, linear: 'closure' },
    },
    {
      id: 'formula-pending',
      notApplicable: true,
      reason: 'A mandatory formula needs a released expression and sample slots. That authoring is outside this closure slice.',
    },
  ];
  const body = {
    seed,
    mark,
    unitCount: LIFECYCLE_UNIT_COUNT,
    raceRepeats: LIFECYCLE_RACE_REPEATS,
    catalog,
    expected,
    recipes,
    actions,
    races,
    poRule: 'The production order completes only when every non-cancelled unit is Completed. One completed work order must not complete the order.',
  };
  return { ...body, lifecyclePlanHash: hashPlan(body) };
}

export function bindLifecyclePlan(plan, runId) {
  const token = String(runId).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
  const replace = (value) => {
    if (typeof value === 'string') return value.replaceAll('{{RUN}}', token);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  const bound = replace(plan);
  bound.lifecyclePlanHash = plan.lifecyclePlanHash;
  bound.runToken = token;
  return bound;
}

export function summarizeLifecyclePlan(plan) {
  return {
    lifecyclePlanHash: plan.lifecyclePlanHash,
    actionCount: plan.actions.length,
    raceCount: plan.races.length,
    operations: ['10', '20'],
    requiredCaptures: plan.catalog.data.length + plan.catalog.parts.length + plan.catalog.tools.filter((tool) => tool.policy === 'required').length + 3,
  };
}

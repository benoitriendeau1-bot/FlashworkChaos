import { createHash } from 'node:crypto';
import { integer, rng } from './engine.mjs';
import { stableStringify } from './scenario.mjs';

/** Names from FlashWorkBE constants/capture-policy.ts. */
export const CAPTURE_POLICIES = ['required', 'optional', 'info_only'];

/** Fixed before any HTTP call. Not drawn from the seed. */
export const TOOL_RACE_REPEATS = 2;

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/**
 * One requirement per capture policy, plus a second required requirement of the
 * same tool on another step, a distinct tool for a wrong association, and a
 * tool that can be obsoleted after publication. Operation 20 stays behind
 * mustCompleteBeforeLater.
 */
export const TOOL_SLOTS = [
  { key: 'required', policy: 'required', tool: 'required', operationNo: '10', stepNo: '1', code: 'REQ', useQty: null },
  { key: 'required-copy', policy: 'required', tool: 'required', operationNo: '10', stepNo: '4', code: 'REQ', useQty: null },
  { key: 'optional', policy: 'optional', tool: 'optional', operationNo: '10', stepNo: '2', code: 'OPT', useQty: null },
  { key: 'obsolete', policy: 'optional', tool: 'obsolete', operationNo: '10', stepNo: '2', code: 'OBS', useQty: null },
  { key: 'info', policy: 'info_only', tool: 'info', operationNo: '10', stepNo: '3', code: 'INF', useQty: null },
  { key: 'gate', policy: 'required', tool: 'gate', operationNo: '20', stepNo: '1', code: 'GAT', useQty: null },
];

export const TOOL_INSTANCES = [
  { key: 'required-a', tool: 'required', suffix: 'REQ-A', status: 'active' },
  { key: 'required-b', tool: 'required', suffix: 'REQ-B', status: 'active' },
  { key: 'required-off', tool: 'required', suffix: 'REQ-X', status: 'inactive' },
  { key: 'optional-a', tool: 'optional', suffix: 'OPT-A', status: 'active' },
  { key: 'info-a', tool: 'info', suffix: 'INF-A', status: 'active' },
  { key: 'other-a', tool: 'other', suffix: 'OTH-A', status: 'active' },
  { key: 'gate-a', tool: 'gate', suffix: 'GAT-A', status: 'active' },
  { key: 'obsolete-a', tool: 'obsolete', suffix: 'OBS-A', status: 'active' },
];

const TOOL_DEFS = [
  { key: 'required', code: 'REQ', name: 'Clé dynamométrique' },
  { key: 'optional', code: 'OPT', name: 'Pied à coulisse' },
  { key: 'info', code: 'INF', name: 'Gabarit de référence' },
  { key: 'other', code: 'OTH', name: 'Tournevis de contrôle' },
  { key: 'gate', code: 'GAT', name: 'Clé de l’opération suivante' },
  { key: 'obsolete', code: 'OBS', name: 'Outil à retirer du service' },
];

function tagOf(key) {
  const instance = TOOL_INSTANCES.find((item) => item.key === key);
  return 'TAG-{{RUN}}-' + instance.suffix;
}

function slotOf(key) {
  return TOOL_SLOTS.find((item) => item.key === key);
}

function act(action) {
  if (!action.oracle && action.kind !== 'not-applicable' && action.kind !== 'state' && action.kind !== 'cancel') {
    throw new Error('Tool action ' + action.id + ' has no oracle');
  }
  return action;
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

function contract(text) {
  return { contract: text };
}

function captured(instanceKey, slotKey) {
  const slot = slotOf(slotKey);
  return {
    http: [200],
    accept: true,
    eventType: 'RESOLVE_TOOL',
    expect: {
      capturePolicy: slot.policy,
      useQty: slot.useQty,
      instanceKey,
      assetTag: tagOf(instanceKey),
      toolSerialNo: tagOf(instanceKey),
      calibrationStatus: 'Pass',
    },
  };
}

function freeSerial(code, slotKey, eventType) {
  const slot = slotOf(slotKey);
  return {
    http: [200],
    accept: true,
    eventType,
    expect: {
      capturePolicy: slot.policy,
      useQty: slot.useQty,
      toolInstanceId: null,
      assetTag: null,
      toolSerialNo: code,
      calibrationStatus: null,
    },
  };
}

function cleared(slotKey) {
  const slot = slotOf(slotKey);
  return {
    http: [200],
    accept: true,
    eventType: 'CLEAR_TOOL',
    expect: {
      capturePolicy: slot.policy,
      useQty: slot.useQty,
      toolInstanceId: null,
      assetTag: null,
      toolSerialNo: null,
      calibrationStatus: null,
    },
  };
}

export function toolsCapturePlan(seed) {
  const random = rng(seed);
  const pad = ['A', 'B', 'C', 'D'][integer(random, 0, 3)];
  const actions = [];
  const seen = new Set();
  const push = (action) => {
    if (seen.has(action.id)) throw new Error('Duplicate tool action ' + action.id);
    seen.add(action.id);
    actions.push(action);
  };

  push(act({
    id: 'gate-before-previous-operation',
    policy: 'required', slot: 'gate', kind: 'invalid', route: 'tool',
    body: { scanCode: tagOf('gate-a') },
    oracle: reject(409, 'Complete Op'),
  }));

  const schemaAttacks = [
    ['empty', { scanCode: '' }],
    ['whitespace', { scanCode: '   ' }],
    ['null', { scanCode: null }],
    ['object', { scanCode: { bad: true } }],
    ['array', { scanCode: ['TAG'] }],
    ['unknown-field', { toolInstanceId: MISSING_ID }],
    ['malformed-instance-field', { toolInstanceId: 'not-a-uuid' }],
    ['clear-and-scan', { clearScan: true, scanCode: tagOf('required-a') }],
    ['use-qty-zero', { useQty: 0, scanCode: tagOf('required-a') }],
    ['use-qty-negative', { useQty: -1, scanCode: tagOf('required-a') }],
    ['use-qty-decimal', { useQty: 1.5, scanCode: tagOf('required-a') }],
  ];
  for (const [name, body] of schemaAttacks) {
    push(act({
      id: 'required-' + name,
      policy: 'required', slot: 'required', kind: 'invalid', route: 'tool',
      body,
      oracle: reject(400),
    }));
  }

  push(act({
    id: 'required-missing-id',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool', missingId: true,
    body: { scanCode: tagOf('required-a') },
    oracle: reject(404),
  }));
  push(act({
    id: 'required-malformed-route',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool', malformedId: true,
    body: { scanCode: tagOf('required-a') },
    oracle: reject(400),
  }));
  push(act({
    id: 'required-other-step',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool', foreign: 'step',
    body: { scanCode: tagOf('required-a') },
    oracle: reject(404),
  }));
  push(act({
    id: 'required-other-requirement',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool', foreign: 'requirement',
    body: { scanCode: tagOf('required-a') },
    oracle: reject(404),
  }));
  push(act({
    id: 'required-other-wo',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool', foreign: 'wo',
    body: { scanCode: tagOf('required-a') },
    oracle: reject(404),
  }));

  push(act({
    id: 'required-free-serial-empty',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { scanCode: 'TAG-{{RUN}}-FREE1' },
    oracle: freeSerial('TAG-{{RUN}}-FREE1', 'required', 'SET_SERIAL'),
  }));
  push(act({
    id: 'required-free-serial-replace',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { scanCode: 'TAG-{{RUN}}-FREE2' },
    oracle: freeSerial('TAG-{{RUN}}-FREE2', 'required', 'REPLACE_SERIAL'),
  }));
  push(act({
    id: 'required-happy',
    policy: 'required', slot: 'required', kind: 'valid', route: 'tool',
    body: { scanCode: tagOf('required-a') },
    oracle: captured('required-a', 'required'),
  }));
  push(act({
    id: 'required-repeat',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { scanCode: tagOf('required-a') },
    oracle: { ...captured('required-a', 'required'), unchanged: true, historyUnchanged: true, eventType: null },
  }));
  push(act({
    id: 'required-replace',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { scanCode: tagOf('required-b') },
    oracle: { ...captured('required-b', 'required'), eventType: 'REPLACE_TOOL' },
  }));
  push(act({
    id: 'required-replace-without-comment',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { scanCode: tagOf('required-a') },
    oracle: { ...captured('required-a', 'required'), eventType: 'REPLACE_TOOL' },
  }));
  push(act({
    id: 'required-clear',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { clearScan: true },
    oracle: cleared('required'),
  }));
  push(act({
    id: 'required-clear-again',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { clearScan: true },
    oracle: { ...cleared('required'), unchanged: true, historyUnchanged: true, eventType: null },
  }));
  push(act({
    id: 'required-restore',
    policy: 'required', slot: 'required', kind: 'valid', route: 'tool',
    body: { scanCode: tagOf('required-a') },
    oracle: captured('required-a', 'required'),
  }));

  push(act({
    id: 'required-use-qty-authored',
    policy: 'required', slot: 'required', kind: 'contract', route: 'tool',
    body: { useQty: 1, scanCode: tagOf('required-b') },
    oracle: contract('useQty n’influence pas la capture. Avec une base de calibration none ou calendar, le snapshot le laisse nul. Avec usage ou both, il est rédigé et le sign-off l’ajoute au compteur d’usage. Option A : refuser toute modification à la capture. Option B : l’enregistrer comme quantité consommée. Recommandation : le laisser rédigé et l’appliquer seulement au sign-off.'),
  }));

  push(act({
    id: 'optional-happy',
    policy: 'optional', slot: 'optional', kind: 'valid', route: 'tool',
    body: { scanCode: tagOf('optional-a') },
    oracle: captured('optional-a', 'optional'),
  }));
  push(act({
    id: 'optional-repeat',
    policy: 'optional', slot: 'optional', kind: 'edge', route: 'tool',
    body: { scanCode: tagOf('optional-a') },
    oracle: { ...captured('optional-a', 'optional'), unchanged: true, historyUnchanged: true, eventType: null },
  }));
  push(act({
    id: 'optional-clear',
    policy: 'optional', slot: 'optional', kind: 'edge', route: 'tool',
    body: { clearScan: true },
    oracle: cleared('optional'),
  }));

  push(act({
    id: 'info-capture-attempt',
    policy: 'info_only', slot: 'info', kind: 'invalid', route: 'tool',
    body: { scanCode: tagOf('info-a') },
    oracle: reject(400, 'info_only'),
  }));
  push(act({
    id: 'required-unknown-on-resolved',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool',
    body: { scanCode: 'TAG-{{RUN}}-MISSING' },
    oracle: reject(409, 'TOOL_SCAN_WOULD_REPLACE'),
  }));
  push(act({
    id: 'required-other-tool-tag',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool',
    body: { scanCode: tagOf('optional-a') },
    oracle: reject(409, 'TOOL_INSTANCE_MISMATCH'),
  }));
  push(act({
    id: 'required-other-catalog-tool',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool',
    body: { scanCode: tagOf('other-a') },
    oracle: reject(409, 'TOOL_INSTANCE_MISMATCH'),
  }));
  push(act({
    id: 'required-tool-number-as-scan',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool',
    body: { scanCode: 'T{{RUN}}REQ' },
    oracle: reject(400, 'TOOL_SCAN_INVALID'),
  }));
  push(act({
    id: 'required-inactive-instance',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool',
    body: { scanCode: tagOf('required-off') },
    oracle: reject(409, 'TOOL_INSTANCE_INACTIVE'),
  }));
  push(act({
    id: 'required-scan-and-serial',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool',
    body: { scanCode: tagOf('required-b'), toolSerialNo: 'FREE-TEXT' },
    oracle: { ...captured('required-b', 'required'), eventType: 'REPLACE_TOOL' },
  }));

  const raceId = (base, index) => index === 0 ? base : base + '-' + (index + 1);
  for (let index = 0; index < TOOL_RACE_REPEATS; index++) {
    push(act({
      id: raceId('required-concurrent-two-instances', index),
      policy: 'required', slot: 'required', kind: 'concurrency', route: 'tool',
      parallel: [
        { slot: 'required', body: { scanCode: tagOf('required-a') } },
        { slot: 'required', body: { scanCode: tagOf('required-b') } },
      ],
      oracle: {
        accept: true,
        oneOf: [captured('required-a', 'required').expect, captured('required-b', 'required').expect],
      },
    }));
  }
  for (let index = 0; index < TOOL_RACE_REPEATS; index++) {
    push(act({
      id: raceId('required-concurrent-same-instance', index),
      policy: 'required', slot: 'required', kind: 'concurrency', route: 'tool',
      parallel: [
        { slot: 'required', body: { scanCode: tagOf('required-a') } },
        { slot: 'required', body: { scanCode: tagOf('required-a') } },
      ],
      oracle: { accept: true, oneOf: [captured('required-a', 'required').expect] },
    }));
  }
  push(act({
    id: 'required-concurrent-capture-clear',
    policy: 'required', slot: 'required', kind: 'concurrency', route: 'tool',
    parallel: [
      { slot: 'required', body: { scanCode: tagOf('required-a') } },
      { slot: 'required', body: { clearScan: true } },
    ],
    oracle: {
      accept: true,
      oneOf: [captured('required-a', 'required').expect, cleared('required').expect],
    },
  }));
  for (let index = 0; index < TOOL_RACE_REPEATS; index++) {
    push(act({
      id: raceId('required-concurrent-free-and-instance', index),
      policy: 'required', slot: 'required-copy', kind: 'concurrency', route: 'tool',
      parallel: [
        { slot: 'required-copy', body: { scanCode: 'TAG-{{RUN}}-RACE-FREE' } },
        { slot: 'required-copy', body: { scanCode: tagOf('required-b') } },
      ],
      oracle: {
        accept: true,
        conflictHttp: [409],
        conflictCode: 'TOOL_SCAN_WOULD_REPLACE',
        oneOf: [
          freeSerial('TAG-{{RUN}}-RACE-FREE', 'required-copy').expect,
          captured('required-b', 'required-copy').expect,
        ],
      },
    }));
    push(act({
      id: raceId('required-copy-reset-after-free-instance', index),
      policy: 'required', slot: 'required-copy', kind: 'edge', route: 'tool',
      body: { clearScan: true },
      oracle: { http: [200], accept: true, expect: cleared('required-copy').expect },
    }));
  }
  for (let index = 0; index < TOOL_RACE_REPEATS; index++) {
    push(act({
      id: raceId('required-concurrent-two-free-serials', index),
      policy: 'required', slot: 'required-copy', kind: 'concurrency', route: 'tool',
      parallel: [
        { slot: 'required-copy', body: { scanCode: 'TAG-{{RUN}}-RACE-A' } },
        { slot: 'required-copy', body: { scanCode: 'TAG-{{RUN}}-RACE-B' } },
      ],
      oracle: {
        accept: true,
        oneOf: [
          freeSerial('TAG-{{RUN}}-RACE-A', 'required-copy').expect,
          freeSerial('TAG-{{RUN}}-RACE-B', 'required-copy').expect,
        ],
      },
    }));
    push(act({
      id: raceId('required-copy-reset-after-two-free', index),
      policy: 'required', slot: 'required-copy', kind: 'edge', route: 'tool',
      body: { clearScan: true },
      oracle: { http: [200], accept: true, expect: cleared('required-copy').expect },
    }));
  }
  for (let index = 0; index < TOOL_RACE_REPEATS; index++) {
    push(act({
      id: raceId('required-concurrent-resolve-and-free', index),
      policy: 'required', slot: 'required-copy', kind: 'concurrency', route: 'tool',
      parallel: [
        { slot: 'required-copy', body: { scanCode: tagOf('required-a') } },
        { slot: 'required-copy', body: { scanCode: 'TAG-{{RUN}}-RACE-LATE' } },
      ],
      oracle: {
        accept: true,
        conflictHttp: [409],
        conflictCode: 'TOOL_SCAN_WOULD_REPLACE',
        oneOf: [captured('required-a', 'required-copy').expect],
      },
    }));
    if (index < TOOL_RACE_REPEATS - 1) {
      push(act({
        id: raceId('required-copy-reset-after-resolve', index),
        policy: 'required', slot: 'required-copy', kind: 'edge', route: 'tool',
        body: { clearScan: true },
        oracle: { http: [200], accept: true, expect: cleared('required-copy').expect },
      }));
    }
  }
  push(act({
    id: 'required-concurrent-two-requirements',
    policy: 'required', slot: 'required', kind: 'concurrency', route: 'tool',
    parallel: [
      { slot: 'required', body: { scanCode: tagOf('required-a') } },
      { slot: 'required-copy', body: { scanCode: tagOf('required-a') } },
    ],
    oracle: {
      accept: true,
      each: [
        { slot: 'required', expect: captured('required-a', 'required').expect },
        { slot: 'required-copy', expect: captured('required-a', 'required-copy').expect },
      ],
    },
  }));
  for (let index = 0; index < TOOL_RACE_REPEATS; index++) {
    push(act({
      id: raceId('required-concurrent-scan-deactivate', index),
      policy: 'required', slot: 'required', kind: 'concurrency', route: 'tool',
      parallel: [
        { slot: 'required', body: { scanCode: tagOf('required-a') } },
        { route: 'deactivate', instanceKey: 'required-a' },
      ],
      oracle: {
        accept: true,
        conflictHttp: [409],
        conflictCode: 'TOOL_INSTANCE_INACTIVE',
        oneOf: [captured('required-a', 'required').expect],
      },
    }));
  }

  push(act({
    id: 'required-deactivate-instance',
    policy: 'required', slot: 'required', kind: 'edge', route: 'deactivate', instanceKey: 'required-a',
    oracle: { http: [200], accept: true, unchanged: true, historyUnchanged: true },
  }));
  push(act({
    id: 'required-scan-after-deactivate',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool',
    body: { scanCode: tagOf('required-a') },
    oracle: reject(409, 'TOOL_INSTANCE_INACTIVE'),
  }));
  push(act({
    id: 'obsolete-tool',
    policy: 'optional', slot: 'obsolete', kind: 'state', route: 'obsolete',
    oracle: { http: [200], accept: true, unchanged: true, historyUnchanged: true },
  }));
  push(act({
    id: 'obsolete-scan-active-instance',
    policy: 'optional', slot: 'obsolete', kind: 'invalid', route: 'tool', requiresObsolete: true,
    body: { scanCode: tagOf('obsolete-a') },
    oracle: reject(409, 'TOOL_OBSOLETE'),
  }));

  push(act({
    id: 'po-in-progress', policy: null, kind: 'state', route: 'status', optional: true,
    body: { status: 'InProgress' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'po-on-hold', policy: null, kind: 'state', route: 'status', optional: true,
    body: { status: 'OnHold' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'capture-while-po-on-hold',
    policy: null, slot: 'required', kind: 'contract', route: 'tool', optional: true, requiresHold: true,
    body: { scanCode: tagOf('required-b') },
    oracle: contract('Le WO n’a pas de statut OnHold. Le gate d’exécution lit Ready et InProgress. Option A : un PO OnHold bloque encore la capture. Option B : la capture réussit parce que le gate ne lit pas le statut du PO.'),
  }));
  push(act({
    id: 'po-resume', policy: null, kind: 'state', route: 'status', optional: true, requiresHold: true,
    body: { status: 'InProgress' },
    oracle: { http: [200], accept: true },
  }));

  push(act({
    id: 'required-signoff-before-capture',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'signoff', wo: 2,
    body: {},
    oracle: reject(400, 'Complete all required fields'),
  }));
  push(act({
    id: 'required-free-serial-wo2',
    policy: 'required', slot: 'required', kind: 'edge', route: 'tool', wo: 2,
    body: { scanCode: 'TAG-{{RUN}}-FREE1' },
    oracle: freeSerial('TAG-{{RUN}}-FREE1', 'required', 'SET_SERIAL'),
  }));
  push(act({
    id: 'required-signoff-unresolved',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'signoff', wo: 2,
    body: {},
    oracle: reject(400, 'TOOL_UNRESOLVED'),
  }));
  push(act({
    id: 'required-happy-wo2',
    policy: 'required', slot: 'required', kind: 'valid', route: 'tool', wo: 2,
    body: { scanCode: tagOf('required-b') },
    oracle: captured('required-b', 'required'),
  }));
  push(act({
    id: 'required-copy-happy-wo2',
    policy: 'required', slot: 'required-copy', kind: 'valid', route: 'tool', wo: 2,
    body: { scanCode: tagOf('required-b') },
    oracle: captured('required-b', 'required-copy'),
  }));
  push(act({
    id: 'required-signoff-after-capture',
    policy: 'required', slot: 'required', kind: 'edge', route: 'signoff', wo: 2,
    body: {},
    oracle: { http: [200], accept: true, unchanged: true, historyUnchanged: true },
  }));
  push(act({
    id: 'optional-signoff-without-capture',
    policy: 'optional', slot: 'optional', kind: 'edge', route: 'signoff', wo: 2,
    body: {},
    oracle: { http: [200], accept: true, unchanged: true, historyUnchanged: true },
  }));
  push(act({
    id: 'info-signoff-without-capture',
    policy: 'info_only', slot: 'info', kind: 'edge', route: 'signoff', wo: 2,
    body: {},
    oracle: { http: [200], accept: true, unchanged: true, historyUnchanged: true },
  }));
  push(act({
    id: 'capture-after-complete',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool', wo: 2, requiresComplete: true,
    body: { scanCode: tagOf('required-b') },
    oracle: reject(409, 'STEP_LOCKED_AFTER_SIGNOFF'),
  }));

  push(act({
    id: 'wo-cancel', policy: null, kind: 'cancel', route: 'cancel',
    body: { reason: 'Chaos tools cancel' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'capture-after-cancel',
    policy: 'required', slot: 'required', kind: 'invalid', route: 'tool', requiresCancel: true,
    body: { scanCode: tagOf('required-b') },
    oracle: reject(400, 'cancelled'),
  }));

  push({
    id: 'other-tenant-instance',
    policy: null,
    kind: 'not-applicable',
    reason: 'Cette session n’a qu’un tenant. Une instance d’un autre tenant ne peut pas être créée par l’API publique sans un second client.',
  });
  push({
    id: 'wo-on-hold',
    policy: null,
    kind: 'not-applicable',
    reason: 'Le work order n’a pas de statut OnHold. Les statuts d’exécution sont Ready, InProgress, VarianceDraft, Andon, Completed et Cancelled.',
  });

  const plan = {
    seed,
    pad,
    slots: TOOL_SLOTS,
    tools: TOOL_DEFS,
    instances: TOOL_INSTANCES.map((instance) => ({
      ...instance,
      assetTag: tagOf(instance.key),
      serialNo: tagOf(instance.key),
    })),
    actions,
  };
  return { ...plan, toolsPlanHash: toolsPlanHash(plan) };
}

export function toolsPlanHash(plan) {
  const { toolsPlanHash: ignored, ...rest } = plan;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

export function expandToolsValue(value, token) {
  if (Array.isArray(value)) return value.map((item) => expandToolsValue(item, token));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = expandToolsValue(value[key], token);
    return out;
  }
  if (typeof value === 'string') return value.replaceAll('{{RUN}}', token);
  return value;
}

export function bindToolsPlan(plan, runId) {
  const token = String(runId).replaceAll('-', '').toUpperCase().slice(0, 12);
  const bound = expandToolsValue(plan, token);
  bound.toolsPlanHash = plan.toolsPlanHash;
  bound.runToken = token;
  return bound;
}

export function summarizeToolsPlan(plan) {
  const byCapturePolicy = {};
  for (const policy of CAPTURE_POLICIES) {
    const rows = plan.actions.filter((item) => item.policy === policy);
    byCapturePolicy[policy] = {
      plannedActions: rows.length,
      valid: rows.filter((item) => item.kind === 'valid').length,
      edge: rows.filter((item) => item.kind === 'edge').length,
      invalid: rows.filter((item) => item.kind === 'invalid').length,
      concurrency: rows.filter((item) => item.kind === 'concurrency').length,
      contract: rows.filter((item) => item.kind === 'contract').length,
    };
  }
  return {
    toolsPlanHash: plan.toolsPlanHash,
    actionCount: plan.actions.length,
    byCapturePolicy,
  };
}

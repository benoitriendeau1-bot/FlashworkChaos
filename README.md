# FlashworkChaos

Seeded API load and validation harness for an **isolated FlashWork development tenant**. Node 20+; no package install required.

## Quick start

```bash
npm test
npm run plan -- --seed=847291 --po=50
```

The plan shows minimum expected richness. It does not contact the backend. To write data:

```bash
export FLASHWORK_BASE_URL=http://localhost:3001
export FLASHWORK_CLIENT_ID=SharkInc
export FLASHWORK_USER_ID=<development-user-uuid>
npm start -- --seed=847291 --po=20 --run-id=trial001
```

PowerShell: set the same variables with `$env:FLASHWORK_BASE_URL='http://localhost:3001'` etc. Use the backend's development auth bypass with an authorized user. Remote hosts require `FLASHWORK_ALLOW_REMOTE=yes`; this is deliberately an explicit opt in. Never target a production tenant. Run names are unique: the same seed repeats the action choices, while a fresh `--run-id` avoids unique-number collisions. To replay precisely, use the same seed, run ID and a database restored to the same starting snapshot.

## Coverage and limits

Each scenario attempts one new Master Item with 3–12 operations, 1–3 steps per operation, 1–4 DATA per step (numeric and text), one deliberately invalid numeric boundary, one production order and 1–8 work orders. IDs use the `MI-CH...` and `POCH...` prefixes. The summary fails if the required counts are missing or a request fails. Every HTTP request, status and response is appended to `runs/<run-id>/events.jsonl`, and the quota summary is in `summary.json`. These logs can contain tenant data: do not commit them.

**Current integration limit:** This is a first executable slice, not a finished simulation of the ten-year life cycle. Production DATA capture requires mapping published snapshot identifiers; parts, tools, Andon, NCR, Run 2+, SV2+ and concurrent mutations are not yet implemented. Their counts are not reported as covered. The negative check currently exercises the authoring numeric limit, not execution capture. Production order creation depends on the tenant's Master Item release/effectivity rules; a blocked transition is recorded as a failure. The backend may return mutation payloads with different wrappers; the ID extractor supports `data`, `result`, `item` and `value`, and reports missing IDs as blocked instead of silently skipping them.

Keep the first run small and inspect `events.jsonl` for tenant-specific release rules before increasing `--po`. No automatic cleanup exists yet. Run against a disposable tenant or restore its database snapshot.

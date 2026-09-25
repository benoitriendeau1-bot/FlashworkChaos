<template>
  <section>
    <p><router-link to="/">Liste des runs</router-link></p>
    <p v-if="loading" role="status">Chargement du run…</p>
    <ErrorPanel v-if="error" :error="error" @retry="load" />
    <template v-if="run">
      <header class="top">
        <div>
          <h2>{{ run.runId }}</h2>
          <p class="meta">
            <span>seed {{ run.seed ?? 'unknown' }}</span>
            <span>{{ formatDate(run.finishedAt) }}</span>
            <span class="badge" :data-tone="statusTone(run)">{{ badgeLabel(run) }}</span>
            <span>verdict {{ verdictText }}</span>
          </p>
        </div>
        <label v-if="run.status === 'incomplete'">
          <input v-model="autoPoll" type="checkbox" />
          Rafraîchir toutes les 5 s
        </label>
      </header>
      <p v-if="polling" role="status">Lecture automatique en cours.</p>
      <div v-if="(run.findings ?? 0) > 0" class="banner finding" role="alert">
        {{ formatNumber(run.findings) }} finding produit. Ce run n’est pas un succès.
      </div>
      <div v-else-if="(run.harnessErrors ?? 0) > 0" class="banner harness" role="status">
        {{ formatNumber(run.harnessErrors) }} erreur de harnais. L’absence de finding ne rend pas ce run réussi.
      </div>
      <div v-if="run.status === 'incomplete'" class="banner info">Run incomplet. Le résumé ou la couverture n’est pas final.</div>
      <div v-if="run.status === 'coverage_missing'" class="banner info">COVERAGE MISSING. Le résumé existe, la couverture non. Ce n’est pas un échec produit et ce n’est pas un PASS de couverture.</div>
      <div v-if="run.status === 'fatal'" class="banner fatal" role="alert">FATAL. Le run s’est arrêté avant un verdict normal.</div>

      <div class="stats">
        <article class="stat"><span>planned</span><strong>{{ formatNumber(run.planned) }}</strong></article>
        <article class="stat"><span>executed</span><strong>{{ formatNumber(run.executed) }}</strong></article>
        <article class="stat"><span>proved</span><strong>{{ formatNumber(run.proved) }}</strong></article>
        <article class="stat not-proved"><span>not proved</span><strong>{{ formatNumber(count('not_proved')) }}</strong></article>
        <article class="stat" :class="{ finding: (count('finding') ?? 0) > 0 }"><span>findings</span><strong>{{ formatNumber(count('finding')) }}</strong></article>
        <article class="stat"><span>harness errors</span><strong>{{ formatNumber(count('harness_error')) }}</strong></article>
        <article class="stat"><span>blocked</span><strong>{{ formatNumber(count('blocked')) }}</strong></article>
        <article class="stat"><span>unhandled</span><strong>{{ formatNumber(count('unhandled')) }}</strong></article>
        <article class="stat"><span>contract decisions</span><strong>{{ formatNumber(count('contract_decision')) }}</strong></article>
        <article class="stat"><span>not applicable</span><strong>{{ formatNumber(count('not_applicable')) }}</strong></article>
        <article class="stat"><span>not executed</span><strong>{{ formatNumber(count('not_executed')) }}</strong></article>
      </div>
      <p class="note">
        <strong>executed</strong> signifie que l’action a atteint le runner ou l’API.
        <strong>proved</strong> signifie que son oracle a été vérifié.
        <strong>not_proved</strong> n’est ni un succès ni nécessairement un bug.
      </p>

      <div class="quick" aria-label="Accès rapides">
        <button v-for="item in quick" :key="item.verdict" type="button" :data-hot="item.hot" :data-warm="item.warm" @click="set({ verdict: item.verdict, page: 1 })">
          {{ item.label }} · {{ formatNumber(count(item.key)) }}
        </button>
      </div>

      <div class="grid-2">
        <section class="note">
          <h3>Reproduction</h3>
          <p>Un nouvel identifiant est obligatoire. Ne réutilisez pas <code>{{ run.runId }}</code>.</p>
          <p class="hash">{{ command }}</p>
          <button type="button" @click="copy(command)">Copier la commande</button>
        </section>
        <section class="note">
          <h3>Fichiers et schéma</h3>
          <p>Schéma {{ run.schemaVersion ?? 'unknown' }}</p>
          <ul>
            <li v-for="(file, name) in run.files" :key="name">{{ name }} · {{ file.present ? formatBytes(file.size) : 'absent' }}</li>
          </ul>
          <p v-if="run.warnings?.length">Avertissements : {{ run.warnings.join(', ') }}</p>
        </section>
      </div>
      <JsonBlock title="Options" :value="run.options" />
      <JsonBlock title="Commits" :value="run.commits" />
      <JsonBlock title="Hashes des plans" :value="run.hashes" />

      <h3>Tranches</h3>
      <ErrorPanel v-if="sliceError" :error="sliceError" @retry="loadSlices" />
      <div v-else class="cards">
        <button v-for="card in cards" :key="card.id" type="button" class="card" :data-tone="card.tone" :data-active="state.slice === card.id" @click="set({ slice: card.id, page: 1 })">
          <h3>{{ card.label }}</h3>
          <span class="badge" :data-tone="card.tone">{{ card.statusLabel }}</span>
          <dl v-if="card.counts && card.tone !== 'unimplemented'">
            <template v-for="row in countRows" :key="row.key">
              <dt>{{ row.label }}</dt>
              <dd>{{ formatNumber(card.counts[row.key]) }}</dd>
            </template>
          </dl>
        </button>
      </div>

      <h3>Actions</h3>
      <form class="filters" @submit.prevent="applySearch">
        <label>Recherche <input v-model="draftQ" type="search" @input="onSearch" /></label>
        <label>Tranche <input :value="state.slice" @change="set({ slice: $event.target.value.trim(), page: 1 })" /></label>
        <label>Verdict
          <select :value="state.verdict" @change="set({ verdict: $event.target.value, page: 1 })">
            <option value="">tous</option>
            <option v-for="verdict in verdicts" :key="verdict" :value="verdict">{{ verdictLabel(verdict) }}</option>
          </select>
        </label>
        <label>Planned
          <select :value="state.planned" @change="set({ planned: $event.target.value, page: 1 })">
            <option value="">tous</option><option value="true">yes</option><option value="false">no</option>
          </select>
        </label>
        <label>Executed
          <select :value="state.executed" @change="set({ executed: $event.target.value, page: 1 })">
            <option value="">tous</option><option value="true">yes</option><option value="false">no</option>
          </select>
        </label>
        <label>Proved
          <select :value="state.proved" @change="set({ proved: $event.target.value, page: 1 })">
            <option value="">tous</option><option value="true">yes</option><option value="false">no</option>
          </select>
        </label>
        <label>Catégorie <input :value="state.category" @change="set({ category: $event.target.value.trim(), page: 1 })" /></label>
        <label>Race group <input :value="state.raceGroup" @change="set({ raceGroup: $event.target.value.trim(), page: 1 })" /></label>
        <label>Taille
          <select :value="state.pageSize" @change="set({ pageSize: Number($event.target.value), page: 1 })">
            <option :value="10">10</option><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option>
          </select>
        </label>
        <label>Tri
          <select :value="state.sort" @change="set({ sort: $event.target.value, page: 1 })">
            <option value="actionId">action</option>
            <option value="slice">slice</option>
            <option value="verdict">verdict</option>
            <option value="label">label</option>
          </select>
        </label>
        <label>Ordre
          <select :value="state.order" @change="set({ order: $event.target.value, page: 1 })">
            <option value="asc">ascendant</option>
            <option value="desc">descendant</option>
          </select>
        </label>
      </form>
      <ErrorPanel v-if="actionError" :error="actionError" @retry="loadActions" />
      <p v-else-if="actions && actions.total === 0" class="note">Aucune action pour ces filtres.</p>
      <div v-if="actions" class="table-wrap">
        <table>
          <caption>{{ actions.total }} actions, page {{ actions.page }}</caption>
          <thead>
            <tr>
              <th scope="col">slice</th>
              <th scope="col">action / scénario</th>
              <th scope="col">catégorie</th>
              <th scope="col">planned</th>
              <th scope="col">executed</th>
              <th scope="col">proved</th>
              <th scope="col">HTTP attendu</th>
              <th scope="col">HTTP observé</th>
              <th scope="col">état</th>
              <th scope="col">verdict</th>
              <th scope="col">message</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="action in actions.actions" :key="action.slice + action.actionId + action.ordinal">
              <td>{{ action.slice }}</td>
              <td>
                <router-link :to="actionDetailPath(run.runId, action)">{{ action.actionId }}</router-link>
                <div>{{ action.scenarioId || 'unknown' }}</div>
              </td>
              <td>{{ action.category || 'unknown' }}</td>
              <td><span class="yn" :data-value="yesNo(action.planned)">{{ yesNo(action.planned) }}</span></td>
              <td><span class="yn" :data-value="yesNo(action.executed)">{{ yesNo(action.executed) }}</span></td>
              <td><span class="yn" :data-value="yesNo(action.proved)">{{ yesNo(action.proved) }}</span></td>
              <td>{{ formatHttp(action.expectedHttp) }}</td>
              <td>{{ formatHttp(action.observedHttp) }}</td>
              <td>{{ action.state || 'unknown' }}</td>
              <td><span class="badge" :data-verdict="action.verdict">{{ verdictLabel(action.verdict) }}</span></td>
              <td class="message" :title="action.message || ''">{{ action.message || 'unknown' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="actions" class="pager">
        <button type="button" :disabled="state.page <= 1" @click="set({ page: state.page - 1 })">Page précédente</button>
        <button type="button" :disabled="state.page >= actionPages" @click="set({ page: state.page + 1 })">Page suivante</button>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ErrorPanel from '../components/ErrorPanel.vue';
import JsonBlock from '../components/JsonBlock.vue';
import { createClient } from '../model/api.mjs';
import { createSearchDelay } from '../model/debounce.mjs';
import { formatBytes, formatDate, formatHttp, formatNumber, yesNo } from '../model/format.mjs';
import { POLL_MS, shouldPoll } from '../model/polling.mjs';
import { actionDetailPath, actionListPath, parseActionQuery } from '../model/queries.mjs';
import { reproductionCommand } from '../model/reproduce.mjs';
import { badgeLabel, sliceCards, statusTone, verdictLabel } from '../model/status.mjs';

const props = defineProps({ refreshToken: { type: Number, default: 0 } });
const emit = defineEmits(['health']);
const route = useRoute();
const router = useRouter();
const client = createClient();
const run = ref(null);
const slicePayload = ref(null);
const actions = ref(null);
const error = ref(null);
const sliceError = ref(null);
const actionError = ref(null);
const loading = ref(false);
const autoPoll = ref(false);
const pollStarted = ref(false);
const polling = ref(false);
const draftQ = ref('');
let timer = null;
const verdicts = ['pass', 'finding', 'harness_error', 'blocked', 'unhandled', 'contract_decision', 'not_applicable', 'not_executed', 'not_proved'];
const countRows = [
  ['planned', 'planned'], ['executed', 'executed'], ['proved', 'proved'], ['pass', 'pass'],
  ['finding', 'finding'], ['harness_error', 'harness error'], ['blocked', 'blocked'], ['unhandled', 'unhandled'],
  ['contract_decision', 'contract decision'], ['not_applicable', 'not applicable'], ['not_executed', 'not executed'], ['not_proved', 'not proved'],
].map(([key, label]) => ({ key, label }));
const quick = [
  { verdict: 'finding', key: 'finding', label: 'Findings', hot: true },
  { verdict: 'harness_error', key: 'harness_error', label: 'Harness errors', hot: true },
  { verdict: 'unhandled', key: 'unhandled', label: 'Unhandled' },
  { verdict: 'blocked', key: 'blocked', label: 'Blocked' },
  { verdict: 'not_proved', key: 'not_proved', label: 'Not proved', warm: true },
  { verdict: 'contract_decision', key: 'contract_decision', label: 'Contract decisions' },
];

const state = computed(() => parseActionQuery(route.query));
const cards = computed(() => sliceCards(slicePayload.value?.slices));
const command = computed(() => reproductionCommand(run.value || {}));
const verdictText = computed(() => {
  if (run.value?.fatal === true) return 'fatal';
  if (run.value?.verdict === true) return 'pass';
  if (run.value?.verdict === false) return 'fail';
  return 'unknown';
});
const actionPages = computed(() => Math.max(1, Math.ceil((actions.value?.total || 0) / state.value.pageSize)));

function count(key) {
  const bag = run.value?.aggregates?.byVerdict;
  if (!bag) {
    if (key === 'not_proved') return run.value?.notProved ?? null;
    if (key === 'finding') return run.value?.findings ?? null;
    if (key === 'harness_error') return run.value?.harnessErrors ?? null;
    if (key === 'blocked') return run.value?.blocked ?? null;
    if (key === 'unhandled') return run.value?.unhandled ?? null;
    if (key === 'contract_decision') return run.value?.contractDecisions ?? null;
    return null;
  }
  return Number.isFinite(bag[key]) ? bag[key] : 0;
}

function set(partial) {
  const next = { ...state.value, ...partial };
  const query = {};
  for (const key of ['slice', 'verdict', 'planned', 'executed', 'proved', 'category', 'raceGroup', 'q']) {
    if (next[key]) query[key] = next[key];
  }
  if (next.page > 1) query.page = String(next.page);
  if (next.pageSize !== 25) query.pageSize = String(next.pageSize);
  if (next.sort !== 'actionId') query.sort = next.sort;
  if (next.order !== 'asc') query.order = next.order;
  router.push({ path: '/runs/' + route.params.runId, query });
}

const search = createSearchDelay((value) => set({ q: value.trim(), page: 1 }));
function onSearch() { search.push(draftQ.value); }
function applySearch() { search.cancel(); set({ q: draftQ.value.trim(), page: 1 }); }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* le texte reste visible */ }
}

async function loadActions() {
  actionError.value = null;
  try {
    actions.value = await client.get(actionListPath(route.params.runId, state.value));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    actions.value = null;
    actionError.value = err;
  }
}
async function loadSlices() {
  sliceError.value = null;
  try {
    slicePayload.value = await client.get('/api/runs/' + encodeURIComponent(route.params.runId) + '/slices');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    slicePayload.value = null;
    sliceError.value = err;
  }
}
async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [health, detail] = await Promise.all([
      client.get('/api/health'),
      client.get('/api/runs/' + encodeURIComponent(route.params.runId)),
    ]);
    emit('health', health);
    run.value = detail;
    if (detail.status !== 'incomplete') autoPoll.value = false;
    else if (!pollStarted.value) {
      pollStarted.value = true;
      autoPoll.value = true;
    }
    await Promise.all([loadSlices(), loadActions()]);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    run.value = null;
    error.value = err;
  } finally {
    loading.value = false;
  }
}

function armPoll() {
  if (timer) clearInterval(timer);
  timer = null;
  polling.value = shouldPoll(run.value?.status, autoPoll.value);
  if (polling.value) timer = setInterval(load, POLL_MS);
}

watch(() => route.params.runId, () => {
  pollStarted.value = false;
  autoPoll.value = false;
});
watch(() => [route.params.runId, route.query], () => {
  draftQ.value = state.value.q;
  load();
}, { immediate: true });
watch(() => props.refreshToken, load);
watch([() => run.value?.status, autoPoll], armPoll);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  search.cancel();
});
</script>

<template>
  <section>
    <p v-if="loading" role="status">Chargement des runs…</p>
    <ErrorPanel v-if="error" :error="error" @retry="load" />
    <form class="filters" @submit.prevent="applyNow">
      <label>Recherche
        <input v-model="draftQ" type="search" @input="onSearch" />
      </label>
      <label>Verdict
        <select :value="state.verdict" @change="set({ verdict: $event.target.value, page: 1 })">
          <option value="">tous</option>
          <option value="pass">pass</option>
          <option value="fail">fail</option>
          <option value="fatal">fatal</option>
          <option value="unknown">unknown</option>
        </select>
      </label>
      <label>Seed
        <input :value="state.seed" @change="set({ seed: $event.target.value.trim(), page: 1 })" />
      </label>
      <label>Findings
        <select :value="state.hasFindings" @change="set({ hasFindings: $event.target.value, page: 1 })">
          <option value="">tous</option>
          <option value="true">oui</option>
          <option value="false">non</option>
        </select>
      </label>
      <label>Harness errors
        <select :value="state.hasHarnessErrors" @change="set({ hasHarnessErrors: $event.target.value, page: 1 })">
          <option value="">tous</option>
          <option value="true">oui</option>
          <option value="false">non</option>
        </select>
      </label>
      <label>Statut
        <select :value="state.status" @change="set({ status: $event.target.value, page: 1 })">
          <option value="">tous</option>
          <option value="complete">complete</option>
          <option value="failed">FAILED</option>
          <option value="fatal">FATAL</option>
          <option value="incomplete">INCOMPLETE</option>
          <option value="coverage_missing">COVERAGE MISSING</option>
          <option value="coverage_invalid">COVERAGE INVALID</option>
        </select>
      </label>
      <label>Taille
        <select :value="state.pageSize" @change="set({ pageSize: Number($event.target.value), page: 1 })">
          <option :value="10">10</option>
          <option :value="25">25</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
        </select>
      </label>
      <label>Tri
        <select :value="state.sort" @change="set({ sort: $event.target.value, page: 1 })">
          <option value="runId">run-id</option>
          <option value="seed">seed</option>
          <option value="finishedAt">date</option>
          <option value="status">statut</option>
        </select>
      </label>
      <label>Ordre
        <select :value="state.order" @change="set({ order: $event.target.value, page: 1 })">
          <option value="asc">ascendant</option>
          <option value="desc">descendant</option>
        </select>
      </label>
    </form>
    <p v-if="payload && payload.runs.length === 0" class="note">Aucun run pour ces filtres.</p>
    <div v-if="payload" class="table-wrap">
      <table>
        <caption>Runs locaux, page {{ payload.page }} sur {{ pages }}</caption>
        <thead>
          <tr>
            <th scope="col">run-id</th>
            <th scope="col">seed</th>
            <th scope="col">date</th>
            <th scope="col">statut</th>
            <th scope="col">verdict</th>
            <th scope="col">planned</th>
            <th scope="col">executed</th>
            <th scope="col">proved</th>
            <th scope="col">not proved</th>
            <th scope="col">findings</th>
            <th scope="col">harness errors</th>
            <th scope="col">blocked</th>
            <th scope="col">unhandled</th>
            <th scope="col">contrats</th>
            <th scope="col">commit BE</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in payload.runs" :key="run.runId">
            <td><router-link :to="'/runs/' + run.runId">{{ run.runId }}</router-link></td>
            <td>{{ run.seed ?? 'unknown' }}</td>
            <td>{{ formatDate(run.finishedAt) }}</td>
            <td><span class="badge" :data-tone="statusTone(run)">{{ badgeLabel(run) }}</span></td>
            <td>{{ verdictText(run) }}</td>
            <td>{{ formatNumber(run.planned) }}</td>
            <td>{{ formatNumber(run.executed) }}</td>
            <td>{{ formatNumber(run.proved) }}</td>
            <td><span class="badge" data-verdict="not_proved">{{ formatNumber(run.notProved) }}</span></td>
            <td>{{ formatNumber(run.findings) }}</td>
            <td>{{ formatNumber(run.harnessErrors) }}</td>
            <td>{{ formatNumber(run.blocked) }}</td>
            <td>{{ formatNumber(run.unhandled) }}</td>
            <td>{{ formatNumber(run.contractDecisions) }}</td>
            <td class="hash">{{ shortHash(backendCommit(run.commits)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="payload" class="pager">
      <button type="button" :disabled="state.page <= 1" @click="set({ page: state.page - 1 })">Page précédente</button>
      <span>{{ payload.total }} runs</span>
      <button type="button" :disabled="state.page >= pages" @click="set({ page: state.page + 1 })">Page suivante</button>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ErrorPanel from '../components/ErrorPanel.vue';
import { createClient } from '../model/api.mjs';
import { createSearchDelay } from '../model/debounce.mjs';
import { backendCommit, formatDate, formatNumber, shortHash } from '../model/format.mjs';
import { parseRunQuery, runListPath } from '../model/queries.mjs';
import { badgeLabel, statusTone } from '../model/status.mjs';

const props = defineProps({ refreshToken: { type: Number, default: 0 } });
const emit = defineEmits(['health']);
const route = useRoute();
const router = useRouter();
const client = createClient();
const payload = ref(null);
const error = ref(null);
const loading = ref(false);
const draftQ = ref('');
const state = computed(() => parseRunQuery(route.query));
const pages = computed(() => Math.max(1, Math.ceil((payload.value?.total || 0) / state.value.pageSize)));

function verdictText(run) {
  if (run.fatal === true) return 'fatal';
  if (run.verdict === true) return 'pass';
  if (run.verdict === false) return 'fail';
  return 'unknown';
}

function set(partial) {
  const next = { ...state.value, ...partial };
  const query = {};
  if (next.q) query.q = next.q;
  if (next.verdict) query.verdict = next.verdict;
  if (next.seed) query.seed = next.seed;
  if (next.hasFindings) query.hasFindings = next.hasFindings;
  if (next.hasHarnessErrors) query.hasHarnessErrors = next.hasHarnessErrors;
  if (next.status) query.status = next.status;
  if (next.page > 1) query.page = String(next.page);
  if (next.pageSize !== 25) query.pageSize = String(next.pageSize);
  if (next.sort !== 'runId') query.sort = next.sort;
  if (next.order !== 'asc') query.order = next.order;
  router.push({ path: '/', query });
}

const search = createSearchDelay((value) => set({ q: value.trim(), page: 1 }));
function onSearch() { search.push(draftQ.value); }
function applyNow() { search.cancel(); set({ q: draftQ.value.trim(), page: 1 }); }

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [health, runs] = await Promise.all([
      client.get('/api/health'),
      client.get(runListPath(state.value)),
    ]);
    emit('health', health);
    payload.value = runs;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    error.value = err;
  } finally {
    loading.value = false;
  }
}

watch(() => route.query, () => {
  draftQ.value = state.value.q;
  load();
}, { immediate: true });
watch(() => props.refreshToken, load);
onBeforeUnmount(() => search.cancel());
</script>

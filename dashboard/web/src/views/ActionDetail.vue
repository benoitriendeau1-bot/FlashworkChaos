<template>
  <section>
    <p>
      <button type="button" @click="back">Retour au run</button>
    </p>
    <p v-if="loading" role="status">Chargement de l’action…</p>
    <ErrorPanel v-if="error && !ambiguous" :error="error" @retry="load" />
    <div v-if="ambiguous" class="note">
      <h2>Plusieurs actions portent cet identifiant</h2>
      <p>Choisissez une correspondance. Aucune n’est ouverte par défaut.</p>
      <ul>
        <li v-for="match in ambiguous" :key="match.slice + match.ordinal">
          <router-link :to="link(match)">{{ match.slice }} · {{ match.scenarioId || 'unknown' }} · ordinal {{ match.ordinal }}</router-link>
        </li>
      </ul>
    </div>
    <template v-if="action">
      <h2>{{ action.actionId }}</h2>
      <p class="meta">
        <span>{{ action.slice }}</span>
        <span>{{ action.scenarioId || 'unknown' }}</span>
        <span>{{ action.label || 'unknown' }}</span>
        <span class="badge" :data-verdict="action.verdict">{{ verdictLabel(action.verdict) }}</span>
      </p>
      <div class="stats">
        <article class="stat"><span>catégorie</span><strong>{{ action.category || 'unknown' }}</strong></article>
        <article class="stat"><span>planned</span><strong>{{ yesNo(action.planned) }}</strong></article>
        <article class="stat"><span>executed</span><strong>{{ yesNo(action.executed) }}</strong></article>
        <article class="stat"><span>proved</span><strong>{{ yesNo(action.proved) }}</strong></article>
        <article class="stat"><span>race group</span><strong>{{ action.raceGroup || 'none' }}</strong></article>
      </div>
      <p class="note">{{ action.message || 'Aucun message.' }}</p>
      <p v-if="action.reproduction" class="note">Reproduction enregistrée : {{ typeof action.reproduction === 'string' ? action.reproduction : formatJson(action.reproduction) }}</p>
      <JsonBlock title="Requête nettoyée" :value="action.request" />
      <JsonBlock title="Expected" :value="action.expected" />
      <JsonBlock title="Observed" :value="action.observed" />
      <JsonBlock title="stateBefore" :value="action.stateBefore" />
      <JsonBlock title="stateAfter" :value="action.stateAfter" />
      <JsonBlock title="auditBefore" :value="action.auditBefore" />
      <JsonBlock title="auditAfter" :value="action.auditAfter" />
      <JsonBlock title="Invariants" :value="action.invariants" />
      <h3>Événements sources</h3>
      <p v-if="!action.sourceEventSeqs?.length" class="note">Aucune séquence source.</p>
      <ul v-else>
        <li v-for="seq in action.sourceEventSeqs" :key="seq">
          <button type="button" @click="loadEvent(seq)">Lire l’événement {{ seq }}</button>
          <div v-if="events[seq]" class="note">
            <p>Mode {{ events[seq].mode }}<span v-if="events[seq].slow"> · parcours lent, borné</span> · seq {{ events[seq].seq }}</p>
            <p>Phase {{ events[seq].event?.phase || 'unknown' }} · {{ events[seq].event?.label || 'unknown' }} · HTTP {{ events[seq].event?.status ?? 'none' }}</p>
            <JsonBlock title="Contenu nettoyé" :value="events[seq].event" />
          </div>
          <ErrorPanel v-if="eventErrors[seq]" :error="eventErrors[seq]" @retry="loadEvent(seq)" />
        </li>
      </ul>
    </template>
  </section>
</template>

<script setup>
import { reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ErrorPanel from '../components/ErrorPanel.vue';
import JsonBlock from '../components/JsonBlock.vue';
import { createClient } from '../model/api.mjs';
import { formatJson, yesNo } from '../model/format.mjs';
import { verdictLabel } from '../model/status.mjs';

const props = defineProps({ refreshToken: { type: Number, default: 0 } });
const route = useRoute();
const router = useRouter();
const client = createClient();
const action = ref(null);
const ambiguous = ref(null);
const error = ref(null);
const loading = ref(false);
const events = reactive({});
const eventErrors = reactive({});

function back() {
  if (window.history.state?.back) router.back();
  else router.push('/runs/' + route.params.runId);
}

function link(match) {
  const query = { slice: match.slice, ordinal: String(match.ordinal) };
  return { path: route.path, query };
}

async function load() {
  loading.value = true;
  error.value = null;
  ambiguous.value = null;
  action.value = null;
  const params = new URLSearchParams();
  if (route.query.slice) params.set('slice', String(route.query.slice));
  if (route.query.ordinal) params.set('ordinal', String(route.query.ordinal));
  const suffix = params.toString();
  try {
    action.value = await client.get('/api/runs/' + encodeURIComponent(route.params.runId) + '/actions/' + encodeURIComponent(route.params.actionId) + (suffix ? '?' + suffix : ''));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (err?.code === 'ambiguous_action') ambiguous.value = err.details?.matches || [];
    error.value = err;
  } finally {
    loading.value = false;
  }
}

async function loadEvent(seq) {
  eventErrors[seq] = null;
  try {
    events[seq] = await client.get('/api/runs/' + encodeURIComponent(route.params.runId) + '/events/' + seq);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    eventErrors[seq] = err;
  }
}

watch(() => [route.params.runId, route.params.actionId, route.query.slice, route.query.ordinal, props.refreshToken], load, { immediate: true });
</script>

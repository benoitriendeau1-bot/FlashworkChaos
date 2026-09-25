<template>
  <a class="skip" href="#contenu">Aller au contenu</a>
  <div class="shell">
    <header class="top">
      <div>
        <h1>FlashWorkChaos</h1>
        <p class="meta">
          <span>API {{ health ? health.status : '…' }}</span>
          <span>{{ health ? formatNumber(health.runCount) + ' runs' : 'runs inconnus' }}</span>
          <span>Lecture {{ health ? formatDate(health.readAt) : 'unknown' }}</span>
        </p>
      </div>
      <button type="button" @click="refresh">Rafraîchir</button>
    </header>
    <main id="contenu">
      <router-view :refresh-token="token" @health="health = $event" />
    </main>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { formatDate, formatNumber } from './model/format.mjs';

const health = ref(null);
const token = ref(0);
function refresh() {
  token.value += 1;
}
</script>

<template>
  <section class="error" role="alert">
    <h2>{{ advice.title }}</h2>
    <p>Code : {{ error.code || 'error' }} · HTTP {{ error.status ?? '—' }}</p>
    <p>{{ error.message }}</p>
    <p>{{ advice.action }}</p>
    <button type="button" @click="$emit('retry')">Réessayer</button>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { errorAdvice } from '../model/advice.mjs';

const props = defineProps({ error: { type: Object, required: true } });
defineEmits(['retry']);
const advice = computed(() => errorAdvice(props.error) || { title: 'Erreur', action: 'Réessayez.' });
</script>

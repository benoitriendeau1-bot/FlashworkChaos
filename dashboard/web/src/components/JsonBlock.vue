<template>
  <details>
    <summary>{{ title }}</summary>
    <p>
      <button type="button" @click="copy">Copier</button>
      <span v-if="copied"> copié</span>
    </p>
    <pre>{{ text }}</pre>
  </details>
</template>

<script setup>
import { computed, ref } from 'vue';
import { formatJson } from '../model/format.mjs';

const props = defineProps({ title: { type: String, required: true }, value: { type: null, required: true } });
const text = computed(() => formatJson(props.value));
const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
</script>

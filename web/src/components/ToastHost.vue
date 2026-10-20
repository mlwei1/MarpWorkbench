<script setup lang="ts">
import { toasts } from '../stores/app'
</script>

<template>
  <div class="toast-host">
    <transition-group name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="`toast-${t.type}`">
        <span class="toast-icon">{{ t.type === 'error' ? '⚠️' : t.type === 'success' ? '✅' : 'ℹ️' }}</span>
        <span class="toast-text">{{ t.text }}</span>
      </div>
    </transition-group>
  </div>
</template>

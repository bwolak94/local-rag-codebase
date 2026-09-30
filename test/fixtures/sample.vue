<template>
  <div>{{ message }}</div>
</template>

<script lang="ts">
export interface Props {
  message: string
}

export function formatMessage(msg: string): string {
  return msg.trim()
}
</script>

<style>
div { color: red; }
</style>

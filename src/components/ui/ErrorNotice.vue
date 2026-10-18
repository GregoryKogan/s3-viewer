<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
import AppButton from "./AppButton.vue";

/**
 * One failure, with everything the backend knows about it.
 *
 * `ApiError` carries fix-it hints, a service code and an S3 request id; showing
 * only `message` threw the useful half away (DLG-3). Hints stay visible, the
 * identifiers sit in a quiet monospace line so they can be copied into a bug
 * report without dominating the message.
 */
const props = withDefaults(
  defineProps<{
    title?: string;
    message: string;
    hints?: string[];
    code?: string | null;
    requestId?: string | null;
    /** Render a retry button that repeats the failed operation. */
    retry?: () => void;
    retryLabel?: string;
    /** Kept on the button so existing selectors keep working. */
    retryTestId?: string;
  }>(),
  { hints: () => [], retryLabel: "Try again" },
);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <p v-if="props.title" class="text-xs font-medium text-content">{{ props.title }}</p>
    <p class="text-[0.6875rem] leading-relaxed break-words text-muted" data-testid="error-message">
      {{ props.message }}
    </p>
    <ul
      v-if="props.hints.length"
      class="list-disc space-y-1 pl-4 text-[0.6875rem] leading-relaxed break-words text-muted"
      data-testid="error-hints"
    >
      <li v-for="(hint, index) in props.hints" :key="index">{{ hint }}</li>
    </ul>
    <p
      v-if="props.code || props.requestId"
      class="font-mono text-[0.625rem] leading-relaxed break-all text-subtle"
      data-testid="error-details"
    >
      <span v-if="props.code">Code {{ props.code }}</span>
      <span v-if="props.code && props.requestId"> · </span>
      <span v-if="props.requestId">Request ID {{ props.requestId }}</span>
    </p>
    <div v-if="props.retry">
      <AppButton size="sm" :icon="RefreshCw" :data-testid="props.retryTestId" @click="props.retry?.()">
        {{ props.retryLabel }}
      </AppButton>
    </div>
  </div>
</template>

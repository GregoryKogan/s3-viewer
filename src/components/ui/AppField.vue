<script setup lang="ts">
import { onMounted, ref, useId, watch } from "vue";

/**
 * Label + control + hint. The unit every settings and connection field uses.
 *
 * The hint and the error sit outside the `<label>`: anything inside it becomes
 * part of the control's accessible name, which used to read
 * "Region Usually dictated by the provider" (VIS-8). The control stays inside
 * the label so clicking the text still focuses it, and the hint/error is
 * explicitly associated through `aria-describedby` instead of being folded into
 * the name.
 */
const props = defineProps<{
  label?: string;
  hint?: string;
  error?: string | null;
  wide?: boolean;
  /** Draw the required marker next to the label. */
  required?: boolean;
}>();

const labelElement = ref<HTMLLabelElement | null>(null);
/** Unique per field instance; several fields are on screen at once. */
const baseId = useId();
const descriptionId = `${baseId}-description`;
const fallbackControlId = `${baseId}-control`;
let control: HTMLElement | null = null;
/**
 * Whether AppField put `aria-invalid` on the control itself. A call site may
 * bind the attribute independently (ConnectionDialog does); that value is left
 * alone and only the attribute this component owns is removed again.
 */
let ownsAriaInvalid = false;

function syncInvalid(element: HTMLElement) {
  if (props.error) {
    // The field's error wins while it exists, but an attribute the call site
    // manages is never taken over.
    if (ownsAriaInvalid) {
      element.setAttribute("aria-invalid", "true");
    } else if (!element.hasAttribute("aria-invalid")) {
      element.setAttribute("aria-invalid", "true");
      ownsAriaInvalid = true;
    }
  } else if (ownsAriaInvalid) {
    element.removeAttribute("aria-invalid");
    ownsAriaInvalid = false;
  }
}

/**
 * Point the label and the description at the slot's control.
 *
 * A ref-based attach keeps every call site unchanged: the slot controls are
 * plain inputs/selects/textareas, and the first one is the field's control. An
 * id that already exists is preserved, and an existing `aria-describedby` is
 * extended rather than replaced.
 */
function syncControl() {
  const element = control;
  if (!element) return;
  if (!element.id) element.id = fallbackControlId;
  if (labelElement.value) labelElement.value.htmlFor = element.id;

  const ids = new Set(
    (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean),
  );
  if (props.error || props.hint) ids.add(descriptionId);
  else ids.delete(descriptionId);
  if (ids.size) element.setAttribute("aria-describedby", [...ids].join(" "));
  else element.removeAttribute("aria-describedby");

  syncInvalid(element);
}

onMounted(() => {
  control = labelElement.value?.querySelector<HTMLElement>("input, select, textarea") ?? null;
  syncControl();
});

// Validation messages appear and disappear after mount; keep the description
// association in step with what is actually rendered.
watch(
  () => [props.error, props.hint],
  () => syncControl(),
  { flush: "post" },
);
</script>

<template>
  <div :class="['flex min-w-0 flex-col gap-1', props.wide ? 'col-span-full' : '']">
    <label ref="labelElement" class="flex min-w-0 flex-col gap-1">
      <span v-if="props.label" class="text-meta font-medium text-muted">
        {{ props.label }}<span v-if="props.required" class="ml-0.5 text-danger" aria-hidden="true">*</span>
      </span>
      <slot />
    </label>
    <span
      v-if="props.error"
      :id="descriptionId"
      class="text-meta leading-snug text-danger"
      role="alert"
    >
      {{ props.error }}
    </span>
    <span
      v-else-if="props.hint"
      :id="descriptionId"
      class="text-meta leading-snug text-subtle"
    >
      {{ props.hint }}
    </span>
  </div>
</template>

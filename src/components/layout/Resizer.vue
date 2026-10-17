<script setup lang="ts">
import { ref } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    /** Which edge the handle sits on. */
    side: "left" | "right";
    /** Which way a drag grows the panel. Defaults to the opposite edge. */
    grow?: "left" | "right";
    min: number;
    max: number | (() => number);
    /** Highlight while dragging and show a resize cursor. */
    label?: string;
  }>(),
  { label: "Resize panel" },
);

const emit = defineEmits<{ "update:modelValue": [value: number]; commit: []; reset: [] }>();

const dragging = ref(false);
let startX = 0;
let startValue = 0;

const growDirection = () => props.grow ?? (props.side === "left" ? "right" : "left");
const sign = () => (growDirection() === "right" ? 1 : -1);

function maxWidth(): number {
  return typeof props.max === "function" ? props.max() : props.max;
}

function clamp(value: number) {
  return Math.min(Math.max(props.min, value), maxWidth());
}

function onPointerMove(event: PointerEvent) {
  emit("update:modelValue", clamp(startValue + (event.clientX - startX) * sign()));
}

function onPointerUp() {
  dragging.value = false;
  document.body.style.cursor = "";
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  emit("commit");
}

function onPointerDown(event: PointerEvent) {
  event.preventDefault();
  dragging.value = true;
  startX = event.clientX;
  startValue = props.modelValue;
  document.body.style.cursor = "col-resize";
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = (event.shiftKey ? 40 : 10) * (event.key === "ArrowRight" ? 1 : -1) * sign();
  emit("update:modelValue", clamp(props.modelValue + step));
  emit("commit");
}

function onDoubleClick() {
  emit("reset");
}
</script>

<template>
  <div
    class="group absolute inset-y-0 z-30 w-1.5 cursor-col-resize"
    :class="side === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'"
    role="separator"
    aria-orientation="vertical"
    :aria-label="props.label"
    tabindex="0"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
    @dblclick="onDoubleClick"
  >
    <div
      class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors"
      :class="dragging ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent'"
    />
  </div>
</template>

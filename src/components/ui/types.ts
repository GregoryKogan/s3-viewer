import type { Component } from "vue";

export type ModalSize = "normal" | "narrow" | "wide";

export interface ModalProps {
  title: string;
  size?: ModalSize;
  icon?: Component;
}

/** Shared sizing for the modal shell, used by the stack and the frame. */
export const MODAL_WIDTH: Record<ModalSize, string> = {
  narrow: "max-w-md",
  normal: "max-w-2xl",
  wide: "max-w-4xl",
};

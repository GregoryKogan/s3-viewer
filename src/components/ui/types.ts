/** Shared modal geometry. Values only — prop shapes live in their components. */

export type ModalSize = "normal" | "narrow" | "wide";

export const MODAL_WIDTH: Record<ModalSize, string> = {
  narrow: "max-w-md",
  normal: "max-w-2xl",
  wide: "max-w-4xl",
};

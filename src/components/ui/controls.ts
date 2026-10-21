/** Shared Tailwind recipes, so a control looks the same everywhere. */

export const inputClass =
  "w-full rounded-control border border-line bg-inset px-2 py-1.5 text-xs text-content " +
  "placeholder:text-subtle focus:border-accent focus:outline-none";

export const selectClass = `${inputClass} cursor-pointer pr-6`;

export const textareaClass = `${inputClass} resize-y font-mono leading-relaxed`;

export const checkboxClass = "size-3.5 shrink-0 cursor-pointer accent-accent";

export const codeClass =
  "overflow-x-auto rounded-control border border-line bg-inset p-2.5 font-mono " +
  "text-meta leading-relaxed text-content/90 whitespace-pre";

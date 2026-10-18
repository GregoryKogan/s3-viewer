/** Shared Tailwind recipes, so a control looks the same everywhere. */

export const inputClass =
  "w-full rounded-control border border-line bg-inset px-2 py-1.5 text-xs text-content " +
  "placeholder:text-subtle focus:border-accent focus:outline-none";

export const selectClass = `${inputClass} cursor-pointer pr-6`;

export const textareaClass = `${inputClass} resize-y font-mono leading-relaxed`;

export const checkboxClass =
  "size-3.5 shrink-0 cursor-pointer appearance-none rounded-[3px] border border-line-strong " +
  "bg-inset checked:border-accent checked:bg-accent " +
  "checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22white%22 stroke-width=%223%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M20 6 9 17l-5-5%22/></svg>')] " +
  "checked:bg-[length:10px] checked:bg-center checked:bg-no-repeat";

export const codeClass =
  "overflow-x-auto rounded-control border border-line bg-inset p-2.5 font-mono " +
  "text-meta leading-relaxed text-content/90 whitespace-pre";

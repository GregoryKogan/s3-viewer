import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

interface VirtualListOptions<T> {
  items: Ref<T[]>;
  rowHeight: number;
  /** Rows drawn beyond the viewport on each side, to smooth fast scrolling. */
  overscan?: number;
  /** Field used as the `v-for` key. */
  keyField: keyof T;
}

/**
 * Windowed rendering for long lists.
 *
 * Only the rows inside the viewport (plus a small overscan) are rendered, so a
 * folder with tens of thousands of objects paints like a folder with thirty. The
 * window is derived from the scroll offset, and the container is given the full
 * height so the native scrollbar still behaves.
 */
export function useVirtualList<T>(options: VirtualListOptions<T>) {
  const { items, rowHeight, keyField, overscan = 8 } = options;

  const scroller = ref<HTMLElement | null>(null);
  const scrollTop = ref(0);
  const viewportHeight = ref(600);

  const totalHeight = computed(() => items.value.length * rowHeight);

  const range = computed(() => {
    const first = Math.max(0, Math.floor(scrollTop.value / rowHeight) - overscan);
    const visible = Math.ceil(viewportHeight.value / rowHeight) + overscan * 2;
    const last = Math.min(items.value.length, first + visible);
    return { first, last };
  });

  const visible = computed(() => {
    const { first, last } = range.value;
    return items.value.slice(first, last).map((item, offset) => ({
      item,
      key: String(item[keyField]),
      index: first + offset,
    }));
  });

  function onScroll() {
    scrollTop.value = scroller.value?.scrollTop ?? 0;
  }

  /** Bring one row into view, used by keyboard navigation and the e2e suite. */
  function scrollToIndex(index: number) {
    const element = scroller.value;
    if (!element || index < 0) return;
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
    scrollTop.value = element.scrollTop;
  }

  function resetScroll() {
    if (scroller.value) scroller.value.scrollTop = 0;
    scrollTop.value = 0;
  }

  let observer: ResizeObserver | undefined;

  onMounted(() => {
    const element = scroller.value;
    if (!element) return;
    viewportHeight.value = element.clientHeight || 600;
    observer = new ResizeObserver(() => {
      viewportHeight.value = element.clientHeight || 600;
    });
    observer.observe(element);
  });

  onBeforeUnmount(() => observer?.disconnect());

  // A new folder (or a new filter) starts at the top.
  watch(
    () => items.value.length,
    () => {
      const element = scroller.value;
      if (element && element.scrollTop > totalHeight.value) {
        element.scrollTop = Math.min(element.scrollTop, Math.max(0, totalHeight.value - rowHeight));
        scrollTop.value = element.scrollTop;
      }
    },
  );

  return {
    scroller,
    visible,
    totalHeight,
    range,
    onScroll,
    scrollToIndex,
    resetScroll,
  };
}

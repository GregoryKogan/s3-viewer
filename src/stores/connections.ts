import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/lib/ipc";
import { useObjectsStore } from "@/stores/objects";
import type {
  Capabilities,
  CapabilityLevel,
  Connection,
  ConnectionDraft,
  ConnectionProbeDraft,
  ConnectionView,
  ProbeOutcome,
} from "@/types";

export interface CapabilitySummary {
  level: CapabilityLevel;
  summary: string;
  badge: string;
  badgeClass: string;
}

/** Turn the probe result into the label the sidebar shows. */
export function describeCapabilities(capabilities?: Capabilities | null): CapabilitySummary {
  if (!capabilities?.probed) {
    return { level: "none", summary: "not probed", badge: "not probed", badgeClass: "warn" };
  }
  if (!capabilities.canList) {
    return { level: "none", summary: "cannot list", badge: "no access", badgeClass: "danger" };
  }
  if (capabilities.canWrite && capabilities.canDelete) {
    return { level: "rw", summary: "read & write", badge: "read-write", badgeClass: "ok" };
  }
  if (capabilities.canWrite) {
    return { level: "rw", summary: "write, delete denied", badge: "write only", badgeClass: "warn" };
  }
  return { level: "ro", summary: "read-only", badge: "read-only", badgeClass: "warn" };
}

/** Saved connections, their credentials, and their probed rights. */
export const useConnectionsStore = defineStore("connections", () => {
  const views = ref<ConnectionView[]>([]);
  const activeId = ref<string | null>(null);
  /** Connections already probed during this session, to avoid repeating it. */
  const probedThisSession = ref(new Set<string>());

  const all = computed(() => views.value.map((view) => view.connection));

  const active = computed<Connection | null>(
    () => views.value.find((view) => view.connection.id === activeId.value)?.connection ?? null,
  );

  const activeCapabilities = computed<Capabilities | undefined>(
    () => views.value.find((view) => view.connection.id === activeId.value)?.capabilities,
  );

  const activeSummary = computed(() => describeCapabilities(activeCapabilities.value));

  const canWriteActive = computed(() => {
    if (!active.value) return false;
    if (active.value.security.readOnlyMode) return false;
    return activeSummary.value.level !== "ro";
  });

  async function load() {
    views.value = await api.listConnections();
  }

  function find(id: string): ConnectionView | undefined {
    return views.value.find((view) => view.connection.id === id);
  }

  function capabilitiesOf(id: string): Capabilities | undefined {
    return find(id)?.capabilities;
  }

  async function save(draft: ConnectionDraft): Promise<Connection> {
    const saved = await api.saveConnection(draft);
    await load();
    return saved;
  }

  async function remove(id: string) {
    await api.deleteConnection(id);
    if (activeId.value === id) {
      activeId.value = null;
      useObjectsStore().close();
    }
    await load();
  }

  async function duplicate(id: string) {
    const copy = await api.duplicateConnection(id);
    await load();
    return copy;
  }

  /** Run the capability probe and remember the outcome. */
  async function detect(id: string): Promise<Capabilities> {
    const capabilities = await api.detectCapabilities(id);
    const view = find(id);
    if (view) view.capabilities = capabilities;
    probedThisSession.value.add(id);
    return capabilities;
  }

  async function probeDraft(
    draft: ConnectionProbeDraft,
    detectWrite: boolean,
    savedId?: string | null,
  ): Promise<ProbeOutcome> {
    return api.testConnection({ id: savedId ?? null, connection: draft, detectWrite });
  }

  /** Probe once per connection per session, on first open. */
  async function probeOnConnect(id: string) {
    const view = find(id);
    if (!view) return;
    const { security } = view.connection;
    if (!security.detectPermissions || !security.autoProbeOnConnect) return;
    if (view.capabilities?.probed || probedThisSession.value.has(id)) return;
    probedThisSession.value.add(id);
    try {
      await detect(id);
    } catch {
      /* a failed probe is reported by the capability badge itself */
    }
  }

  function setActive(id: string | null) {
    activeId.value = id;
  }

  return {
    views,
    activeId,
    all,
    active,
    activeCapabilities,
    activeSummary,
    canWriteActive,
    load,
    find,
    capabilitiesOf,
    save,
    remove,
    duplicate,
    detect,
    probeDraft,
    probeOnConnect,
    setActive,
  };
});

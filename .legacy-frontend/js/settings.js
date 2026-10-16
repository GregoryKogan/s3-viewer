// App settings + a read-only security summary of where secrets live.

import { el } from "./dom.js";
import { openModal } from "./modal.js";
import { toastError, toastOk } from "./toast.js";
import { api } from "./api.js";
import { humanSize } from "./format.js";

const PREVIEW_PRESETS = [
  [2 * 1024 * 1024, "2 MB — safest"],
  [10 * 1024 * 1024, "10 MB"],
  [25 * 1024 * 1024, "25 MB — default"],
  [100 * 1024 * 1024, "100 MB"],
  [1024 * 1024 * 1024, "1 GB — can be slow"],
];

export function openSettingsDialog({ onSaved }) {
  const settingsPromise = api.getSettings();
  const securityPromise = api.securityStatus().catch(() => null);

  const container = el("div", { style: { display: "flex", flexDirection: "column", gap: "16px" } });

  const modal = openModal({
    title: "Settings",
    body: [container],
    footer: [
      el("button", { class: "btn", text: "Close", onClick: () => modal.close() }),
      el("button", {
        class: "btn btn--primary",
        text: "Save",
        "data-testid": "settings-save",
        onClick: () => save(),
      }),
    ],
  });

  let previewSelect = null;
  let listLimitInput = null;
  let themeSelect = null;
  let downloadInput = null;
  let systemToggle = null;
  let settings = null;

  function buildForm() {
    container.replaceChildren();

    previewSelect = el(
      "select",
      { "data-testid": "settings-preview-limit" },
      PREVIEW_PRESETS.map(([bytes, label]) =>
        el("option", { value: String(bytes), text: label, selected: settings.previewMaxBytes === bytes }),
      ),
    );
    if (!PREVIEW_PRESETS.some(([bytes]) => bytes === settings.previewMaxBytes)) {
      previewSelect.append(
        el("option", {
          value: String(settings.previewMaxBytes),
          text: `${humanSize(settings.previewMaxBytes)} — custom`,
          selected: true,
        }),
      );
    }

    listLimitInput = el("input", {
      type: "number",
      min: "200",
      max: "100000",
      value: String(settings.listPageLimit),
      "data-testid": "settings-list-limit",
    });
    themeSelect = el(
      "select",
      { "data-testid": "settings-theme" },
      [
        ["dark", "Dark"],
        ["light", "Light"],
        ["system", "Follow the system"],
      ].map(([value, label]) => el("option", { value, text: label, selected: settings.theme === value })),
    );
    downloadInput = el("input", {
      type: "text",
      value: settings.downloadDir ?? "",
      placeholder: "(default: your Downloads folder)",
      "data-testid": "settings-download-dir",
    });
    systemToggle = el("input", {
      type: "checkbox",
      checked: settings.showSystemObjects,
      "data-testid": "settings-show-system",
    });

    container.append(
      el("fieldset", { class: "fieldset" }, [
        el("legend", { text: "Preview" }),
        el("div", { class: "field field--wide" }, [
          el("label", { text: "Maximum file size to preview" }),
          previewSelect,
          el("div", {
            class: "field__hint",
            text: "Files above this size are listed and downloadable, but the preview panel explains that it is too large instead of loading it.",
          }),
        ]),
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { text: "Browsing" }),
        el("div", { class: "field" }, [
          el("label", { text: "Objects loaded per folder" }),
          listLimitInput,
          el("div", { class: "field__hint", text: "A safety cap for very large prefixes." }),
        ]),
        el("div", { class: "field" }, [
          el("label", { text: "Theme" }),
          themeSelect,
        ]),
        el("label", { class: "check" }, [
          systemToggle,
          el("span", {}, [
            "Show system objects",
            el("small", { text: "_SUCCESS, _temporary, .DS_Store and *.crc are hidden by default." }),
          ]),
        ]),
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { text: "Downloads" }),
        el("div", { class: "field field--wide" }, [
          el("label", { text: "Download folder" }),
          downloadInput,
          el("div", { class: "field__hint", text: "Leave empty to use your operating system's Downloads folder." }),
        ]),
      ]),
    );
  }

  function buildSecurity(status) {
    if (!status) return;
    const keychainBadge = status.masterKeyInKeychain
      ? el("span", { class: "badge badge--rw", text: "OS keychain" })
      : el("span", { class: "badge badge--ro", text: "local key file (0600)" });
    container.append(
      el("fieldset", { class: "fieldset", "data-testid": "security-summary" }, [
        el("legend", { text: "Security" }),
        el("div", { class: "field field--wide" }, [
          el("label", { text: "Master key storage" }),
          el("div", { class: "badge-list" }, [keychainBadge]),
          el("div", {
            class: "field__hint",
            text: status.masterKeyInKeychain
              ? "Secret access keys are sealed with XChaCha20-Poly1305; the master key lives in the operating system keychain, not on disk."
              : "The operating system keychain was unavailable, so the master key is stored in a file readable only by your user (mode 0600). Secrets are still encrypted at rest.",
          }),
        ]),
        el("div", { class: "field field--wide" }, [
          el("label", { text: "Configuration file" }),
          el("div", { class: "field__hint", text: `${status.configPath} (mode 0600, version ${status.configVersion})` }),
          el("div", { class: "field__hint", text: `${status.connectionCount} connection(s) stored.` }),
        ]),
        el("div", { class: "field field--wide" }, [
          el("label", { text: "Default download folder" }),
          el("div", { class: "field__hint", text: status.homeDownloadDir }),
        ]),
      ]),
    );
  }

  async function save() {
    try {
      const next = {
        ...settings,
        previewMaxBytes: Number(previewSelect.value),
        listPageLimit: Number(listLimitInput.value) || settings.listPageLimit,
        theme: themeSelect.value,
        downloadDir: downloadInput.value.trim() || null,
        showSystemObjects: systemToggle.checked,
      };
      const saved = await api.updateSettings(next);
      settings = saved;
      toastOk("Settings saved.");
      modal.close();
      onSaved?.(saved);
    } catch (error) {
      toastError(error.message, "Cannot save settings");
    }
  }

  Promise.all([settingsPromise, securityPromise])
    .then(([loaded, status]) => {
      settings = loaded;
      buildForm();
      buildSecurity(status);
    })
    .catch((error) => {
      container.replaceChildren(el("p", { text: `Cannot load settings: ${error.message}` }));
    });

  return modal;
}

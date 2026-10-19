//! Built-in end-to-end harness (headless-testable core).
//!
//! WebDriver is not an option on macOS: WKWebView has no WebDriver
//! implementation, so `tauri-driver` refuses to start, and driving the screen
//! with synthetic clicks would not test the app anyway. Instead the app hosts the
//! test itself. When `S3VIEWER_E2E=1` is set, the real window boots, a scripted
//! scenario runs inside the actual webview against the real Rust backend and the
//! real S3 bucket, and the outcome is written to `S3VIEWER_E2E_OUT` as JSON.
//!
//! This covers what unit tests cannot: IPC round-trips, the `s3stream://` media
//! protocol, DOM rendering, sanitisation, and every command the UI calls.
//!
//! Safety: the scenario only ever touches the bucket and prefix the runner
//! passes in, and none of this is reachable unless the environment variable is
//! set explicitly. The desktop-only glue lives in [`desktop`].

pub mod desktop;

use crate::error::AppResult;
use std::time::Duration;

pub const ENV_RUN: &str = "S3VIEWER_E2E";
pub const ENV_OUT: &str = "S3VIEWER_E2E_OUT";
pub const ENV_BUCKET: &str = "S3VIEWER_E2E_BUCKET";
pub const ENV_PREFIX: &str = "S3VIEWER_E2E_PREFIX";
pub const ENV_ENDPOINT: &str = "S3VIEWER_E2E_ENDPOINT";
pub const ENV_REGION: &str = "S3VIEWER_E2E_REGION";
pub const ENV_ACCESS: &str = "S3VIEWER_E2E_ACCESS_KEY";
pub const ENV_SECRET: &str = "S3VIEWER_E2E_SECRET_KEY";
pub const ENV_DOWNLOAD_DIR: &str = "S3VIEWER_E2E_DOWNLOAD_DIR";
const ENV_IMPORT_FILE: &str = "S3VIEWER_E2E_IMPORT_FILE";

/// Name of the connection the harness creates for the run.
pub const CONNECTION_NAME: &str = "E2E dev bucket";

/// Preview ceiling used during e2e runs. Deliberately small: the suite ships a
/// 1 MB+ fixture instead of a multi-gigabyte one.
pub const E2E_PREVIEW_LIMIT: u64 = 1024 * 1024;

/// Everything the scenario needs, read from the environment.
#[derive(Debug, Clone)]
pub struct TestPlan {
    pub bucket: String,
    pub prefix: String,
    pub endpoint: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    pub output: String,
    pub download_dir: Option<String>,
    /// A credentials file the scenario reads through the backend.
    pub import_file: Option<String>,
    /// The isolated config directory the runner set; the scenario proves it is
    /// the one actually in use and that the keychain was never touched.
    pub config_dir: Option<String>,
}

impl TestPlan {
    pub fn from_env() -> Option<TestPlan> {
        if std::env::var(ENV_RUN).ok().as_deref() != Some("1") {
            return None;
        }
        let need = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
        Some(TestPlan {
            bucket: need(ENV_BUCKET)?,
            prefix: need(ENV_PREFIX).unwrap_or_else(|| "_s3viewer-e2e/".to_string()),
            endpoint: need(ENV_ENDPOINT)?,
            region: need(ENV_REGION).unwrap_or_else(|| "us-east-1".to_string()),
            access_key: need(ENV_ACCESS)?,
            secret_key: need(ENV_SECRET)?,
            output: need(ENV_OUT).unwrap_or_else(|| "e2e-report.json".to_string()),
            download_dir: need(ENV_DOWNLOAD_DIR),
            import_file: need(ENV_IMPORT_FILE),
            config_dir: need("S3VIEWER_CONFIG_DIR"),
        })
    }
}

/// The one thing the scenario needs from the host: run a string in the webview.
pub trait ScriptHost {
    fn eval_str(&self, script: &str) -> AppResult<()>;
}

/// Injects the scenario into the webview.
///
/// The page reports back by calling the `e2e_report` command (see
/// [`crate::e2e::desktop`]), which avoids depending on eval return values —
/// `WebviewWindow::eval` is fire-and-forget.
pub fn start<H: ScriptHost>(host: &H, plan: &TestPlan) -> AppResult<()> {
    host.eval_str(&scenario_script(plan))
}

/// How long the whole scenario may take before the harness gives up.
pub const SCENARIO_TIMEOUT: Duration = Duration::from_secs(600);

/// Strictly parse the report the page produced.
pub fn parse_report(text: &str) -> AppResult<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| crate::error::AppError::msg(format!("report is not valid JSON: {e}")))?;
    if value.get("checks").and_then(|c| c.as_array()).is_none() {
        return Err(crate::error::AppError::msg("report has no checks array"));
    }
    Ok(value)
}

pub fn report_passed(report: &serde_json::Value) -> bool {
    report.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn write_report(path: &str, report: &serde_json::Value) {
    let text = serde_json::to_string_pretty(report).unwrap_or_else(|_| "{}".to_string());
    if let Err(err) = std::fs::write(path, text) {
        eprintln!("s3viewer e2e: cannot write {path}: {err}");
    }
}

/// The script that drives the UI. One readable string, so a selector change has
/// exactly one place to be fixed.
pub fn scenario_script(plan: &TestPlan) -> String {
    let json = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    SCENARIO
        .replace("__CONNECTION_NAME__", &json(CONNECTION_NAME))
        .replace("__ENDPOINT__", &json(&plan.endpoint))
        .replace("__REGION__", &json(&plan.region))
        .replace("__ACCESS__", &json(&plan.access_key))
        .replace("__SECRET__", &json(&plan.secret_key))
        .replace("__BUCKET__", &json(&plan.bucket))
        .replace("__PREFIX__", &json(&plan.prefix))
        .replace(
            "__IMPORT_FILE__",
            &json(plan.import_file.as_deref().unwrap_or("")),
        )
        .replace(
            "__CONFIG_DIR__",
            &json(plan.config_dir.as_deref().unwrap_or("")),
        )
}

const SCENARIO: &str = r#"(async () => {
  // Injecting twice must not run the suite twice: the second run would race the
  // first and its final report could overwrite a failing one with a pass.
  if (window.__S3VIEWER_E2E_STARTED) return;
  window.__S3VIEWER_E2E_STARTED = true;

  // The harness may inject before the page has finished loading. Wait for the
  // Tauri bridge (injected as a global) and for the app shell to exist, so a slow
  // start is a wait rather than a crash.
  {
    const deadline = Date.now() + 60000;
    while (!(window.__TAURI__ && window.__TAURI__.core && window.__s3viewer)) {
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const REPORT = [];
  const connectionName = __CONNECTION_NAME__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const invoke = window.__TAURI__.core.invoke;

  /**
   * Yield to the event loop so a framework can apply pending updates.
   *
   * Deliberately a timer rather than `requestAnimationFrame`: macOS throttles
   * animation frames when the window is occluded, and a harness that waits on
   * them hangs for as long as the window is behind another one.
   */
  const frame = () => new Promise((resolve) => setTimeout(resolve, 0));

  const wait = async (what, fn, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    let last = null;
    await frame();
    for (;;) {
      try {
        last = await fn();
        if (last) return last;
      } catch (error) {
        last = error;
      }
      if (Date.now() > deadline) {
        throw new Error('timeout waiting for ' + what + (last ? ' — ' + last : ''));
      }
      await sleep(120);
      await frame();
    }
  };

  // Heartbeat: while a check is running, the partial report says which one, so a
  // stall is attributable without any value ever being read back from the page.
  let ACTIVE = null;
  setInterval(() => {
    if (!window.__TAURI__ || !ACTIVE) return;
    invoke('e2e_report', {
      report: JSON.stringify({
        ok: false,
        final: false,
        active: ACTIVE,
        checks: REPORT.slice(),
        updatedAt: new Date().toISOString(),
      }),
    }).catch(() => {});
  }, 3000);

  const withLimit = (promise, seconds, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out after ' + seconds + 's: ' + label)), seconds * 1000),
      ),
    ]);

  const check = async (name, fn) => {
    const started = Date.now();
    ACTIVE = name;
    try {
      const detail = await withLimit(fn(), 90, name);
      REPORT.push({ name, ok: true, detail: detail ? String(detail) : '', ms: Date.now() - started });
    } catch (error) {
      REPORT.push({
        name,
        ok: false,
        detail: String((error && error.message) || error),
        stack: String((error && error.stack) || '').split('\n').slice(0, 10),
        ms: Date.now() - started,
      });
    }
    ACTIVE = null;
    publish(false);
  };

  // Partial reports are sent as the run progresses: if a later check hangs, the
  // last reported check names the culprit instead of a bare timeout.
  const publish = (final) => {
    const report = {
      ok: final && REPORT.every((entry) => entry.ok),
      final: Boolean(final),
      checks: REPORT.slice(),
      updatedAt: new Date().toISOString(),
    };
    window.__S3VIEWER_E2E_REPORT = report;
    try {
      invoke('e2e_report', { report: JSON.stringify(report) });
    } catch (error) {
      console.error('e2e: could not publish the report', error);
    }
  };

  const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
  const setInput = (selector, value) => {
    const node = $(selector);
    node.focus();
    node.value = value;
    fire(node, 'input');
    fire(node, 'change');
  };
  /** A real key press as the app's window listener sees it. */
  const press = (target, key, init = {}) =>
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }));
  const rowNames = () => $$('.object-row .row-label').map((n) => n.textContent);
  /** Right-click a row and hand back the menu. Both steps are real user input. */
  const rowMenu = async (label) => {
    const index = window.__s3viewer.state.visible.findIndex((e) => e.name === label);
    if (index >= 0) window.__s3viewer.scrollToRow(index);
    await frame();
    const row = $$('.object-row').find((r) => r.querySelector('.row-label').textContent === label);
    if (!row) throw new Error('row not found for the menu: ' + label + ' :: ' + rowNames().join(','));
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(box.left + 40),
      clientY: Math.round(box.top + 8),
    }));
    return wait('the context menu', () => $('[data-testid=context-menu]'), 8000);
  };

  /** Put the address bar into editing mode, whichever state it is in. */
  const openAddress = async () => {
    const existing = $('[data-testid=address-input]');
    if (existing) return existing;
    $('[data-testid=address-edit]').click();
    return wait('the address input', () => $('[data-testid=address-input]'), 5000);
  };

  /** Leave editing mode without navigating. */
  const closeAddress = () => {
    const input = $('[data-testid=address-input]');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  };

  /** Click one item of an open context menu by its label. */
  const menuClick = (menu, label) => {
    const items = Array.from(menu.querySelectorAll('button'));
    const item = items.find((button) =>
      (button.textContent || '').trim().toLowerCase().startsWith(label.toLowerCase()));
    if (!item) {
      throw new Error('menu item "' + label + '" not found in: '
        + items.map((b) => b.textContent.trim()).join(' | '));
    }
    item.click();
  };
  const clickRow = (label) => {
    // Preview-only checks do not care about the selection, and a leftover
    // multi-selection from an earlier check must not leak into them. A plain
    // click then selects exactly the row it hits, as a file manager does.
    window.__s3viewer.state.objects.clearSelection();
    // The list is virtualised: only the rows near the viewport exist in the DOM,
    // so scroll the target into the painted window before looking for it.
    const index = window.__s3viewer.state.visible.findIndex((e) => e.name === label);
    if (index >= 0) window.__s3viewer.scrollToRow(index);
    const row = $$('.object-row').find((r) => r.querySelector('.row-label').textContent === label);
    if (!row) {
      throw new Error(
        'row not found: ' + label
        + ' :: drawn=[' + rowNames().join(',') + ']'
        + ' visible=' + window.__s3viewer.state.visible.length
        + ' pool=' + window.__s3viewer.state.rowPool.length
        + ' entries=' + (window.__s3viewer.state.session ? window.__s3viewer.state.session.entries.length : -1)
        + ' loading=' + Boolean(window.__s3viewer.state.session && window.__s3viewer.state.session.loading)
        + ' scrollerHeight=' + (($('#object-list') || {}).clientHeight)
        + ' rowsLayer=' + Boolean($('#object-rows'))
        + ' empty=' + (($('[data-testid=empty-folder]') || {}).textContent || '')
        + ' loadingEl=' + Boolean($('[data-testid=loading-state]'))
        + ' prefix=' + JSON.stringify(window.__s3viewer.state.objects.prefix)
        + ' awaiting=' + window.__s3viewer.state.objects.awaitingFirstPage
        + ' listingLog=' + window.__s3viewer.logs.listing.slice(-10).join(' | ')
        + ' errors=' + JSON.stringify(window.__s3viewerErrors.slice(-2)),
      );
    }
    row.click();
    return row;
  };
  /**
   * Click a row only once the listing is settled and actually contains it.
   *
   * A background reload (from a just-finished delete or copy) clears `visible`
   * and sets `loading` without any user action, so a bare clickRow can race it
   * even when the caller checked a moment earlier.
   */
  const clickRowWhenReady = async (label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const objects = window.__s3viewer.state.objects;
      if (!objects.loading && !objects.awaitingFirstPage && rowNames().includes(label)) {
        return clickRow(label);
      }
      if (Date.now() > deadline) {
        throw new Error('the listing never settled on ' + label
          + ' :: loading=' + objects.loading
          + ' awaiting=' + objects.awaitingFirstPage
          + ' rows=' + rowNames().join(',')
          + ' prefix=' + JSON.stringify(objects.prefix));
      }
      await sleep(200);
    }
  };
  const closeModal = async () => {
    const button = $('[data-testid=modal-close]');
    if (button) button.click();
    await wait('the modal to close', async () => !$('[data-testid=modal]'), 5000);
  };

  window.__S3VIEWER_E2E_ERRORS = [];
  window.addEventListener('error', (event) => {
    window.__S3VIEWER_E2E_ERRORS.push('error: ' + (event.message || '') + ' @ ' + (event.filename || ''));
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__S3VIEWER_E2E_ERRORS.push('rejection: ' + String((event.reason && event.reason.message) || event.reason));
  });

  const domDigest = () => {
    const rowCount = $$('.object-row').length;
    return 'rows=' + rowCount
      + ' session=' + Boolean(window.__s3viewer.state.session)
      + ' connections=' + window.__s3viewer.state.connections.length
      + ' objectList=' + Boolean($('#object-list'))
      + ' newFolderBtn=' + Boolean($('[data-testid=new-folder]'))
      + ' errors=[' + window.__S3VIEWER_E2E_ERRORS.join(' | ') + ']'
      + ' empty=' + (($('[data-testid=empty-folder]') || {}).textContent || '')
      + ' noConn=' + (($('[data-testid=no-connection-state]') || {}).textContent || '').slice(0, 40)
      + ' loading=' + Boolean($('[data-testid=loading-state]'))
      + ' describe=' + JSON.stringify(window.__s3viewer.describe());
  };

  try {
    await check('boot: the app shell rendered', async () => {
      await wait('the connection list', () => $('#connection-list'));
      return document.title + ' · ' + domDigest();
    });

    await check('boot: the IPC bridge answers', async () => {
      const pong = await invoke('ping');
      if (pong !== 'pong') throw new Error('unexpected ping reply: ' + pong);
      return 'pong';
    });

    const connectionId = await invoke('e2e_setup');
    await window.__s3viewer.refreshConnections();

    await check('ui: the connection form produces a working boto3 snippet', async () => {
      $('#new-connection').click();
      await wait('the connection form', () => $('[data-testid=conn-name]'));
      setInput('[data-testid=conn-name]', 'snippet probe');
      setInput('[data-testid=conn-endpoint]', __ENDPOINT__);
      setInput('[data-testid=conn-region]', __REGION__);
      setInput('[data-testid=conn-access-key]', __ACCESS__);
      setInput('[data-testid=conn-bucket]', __BUCKET__);
      const snippet = await wait('the snippet to follow the form', async () => {
        const text = $('[data-testid=boto3-snippet]').textContent;
        return text.includes(__ACCESS__) ? text : null;
      });
      const expected = [
        'endpoint_url="' + __ENDPOINT__ + '"',
        'region_name="' + __REGION__ + '"',
        'aws_access_key_id="' + __ACCESS__ + '"',
        'signature_version="s3v4"',
        '"addressing_style": "virtual"',
      ];
      for (const line of expected) {
        if (!snippet.includes(line)) throw new Error('snippet is missing: ' + line);
      }
      if (snippet.includes(__SECRET__)) throw new Error('the secret key was rendered into the snippet');
      await closeModal();
      return 'snippet mirrors the form';
    });

    await check('import: a credentials file is read from disk', async () => {
      if (!__IMPORT_FILE__) throw new Error('no import fixture was provided');
      const contents = await invoke('read_text_file', { path: __IMPORT_FILE__ });
      if (!contents.includes('import-fixture-bucket')) {
        throw new Error('the file contents came back wrong: ' + contents.slice(0, 80));
      }
      // The same parser the dialog uses must find a connection in it.
      const found = window.__s3viewerParseImport(contents);
      if (!found.length) throw new Error('the file parsed to nothing');
      const first = found[0];
      if (first.bucket !== 'import-fixture-bucket') {
        throw new Error('unexpected bucket: ' + first.bucket);
      }
      if (first.endpointUrl !== 'https://s3.import-fixture.test') {
        throw new Error('unexpected endpoint: ' + first.endpointUrl);
      }
      return found.length + ' connection(s) parsed from ' + contents.length + ' bytes';
    });

    await check('import: a missing file reports something readable', async () => {
      let message = '';
      try {
        await invoke('read_text_file', { path: __IMPORT_FILE__ + '.gone' });
      } catch (error) {
        message = error.message || String(error);
      }
      if (!message) throw new Error('reading a missing file did not fail');
      if (/^\[object Object\]$/.test(message)) throw new Error('unreadable error: ' + message);
      if (!/cannot open/i.test(message)) throw new Error('unhelpful message: ' + message);
      return message.slice(0, 70);
    });

    await check('ui: importing is available from the start', async () => {
      const trigger = $('[data-testid=import-connections]');
      if (!trigger) throw new Error('the import action is missing');
      trigger.click();
      const area = await wait('the import dialog', () => $('[data-testid=import-textarea]'), 10000);
      const title = $('[data-testid=modal-title]').textContent;
      if (!/import/i.test(title)) throw new Error('unexpected dialog: ' + title);
      await closeModal();
      return area.tagName.toLowerCase() + ' in "' + title.trim() + '"';
    });

    await check('ui: the sidebar lists the connection with probed rights', async () => {
      const cards = await wait('a connection card', () => {
        const found = $$('#connection-list button[data-testid^="connection-"]');
        return found.length ? found : null;
      });
      if (window.__S3VIEWER_E2E_ERRORS.length) {
        throw new Error('page errors before opening: ' + window.__S3VIEWER_E2E_ERRORS.join(' | '));
      }
      const card = cards.find((c) => c.textContent.includes(connectionName));
      if (!card) throw new Error('card for ' + connectionName + ' not found');
      const text = card.textContent;
      if (/not probed/.test(text)) throw new Error('capabilities were not probed: ' + text);
      if (!/read-write/.test(text)) throw new Error('expected a read-write badge, got: ' + text);
      // The dot is health, not permissions: a probed connection that answers is
      // green, and its tooltip talks about reachability rather than rights.
      const dot = $('[data-testid=connection-health-' + connectionId + ']');
      if (!dot) throw new Error('the health dot is missing');
      if (!/(^|\s)bg-ok(\s|$)/.test(dot.className)) {
        throw new Error('the working connection has a health dot with class "' + dot.className + '"');
      }
      if (!/reachable/i.test(dot.title)) throw new Error('unhelpful health tooltip: ' + dot.title);
      return text.replace(/\s+/g, ' ').trim() + ' · health green';
    });

    await check('ui: opening the connection lists every fixture', async () => {
      const card = await wait('the connection card', () => {
        const found = $$('#connection-list button[data-testid^="connection-"]')
          .find((c) => c.textContent.includes(connectionName));
        return found || null;
      });
      card.click();
      try {
        await wait('object rows', async () => ($$('.object-row').length >= 12 ? true : null), 30000);
      } catch (error) {
        throw new Error(error.message + ' :: ' + domDigest());
      }
      const names = rowNames();
      const expected = ['image.png', 'tone.wav', 'clip.mp4', 'document.pdf', 'vector.svg', 'blob.bin',
                        'readme.md', 'notes.txt', 'sample.json', 'sample.py', 'table.csv', 'too-big.txt'];
      const missing = expected.filter((name) => !names.includes(name));
      if (missing.length) throw new Error('missing rows: ' + missing.join(', '));
      const rootCrumb = $('[data-testid=crumb-root]').textContent;
      if (rootCrumb !== connectionName) throw new Error('unexpected root crumb: ' + rootCrumb);
      // The listing must be scoped to the connection prefix, not the bucket root.
      const scoped = await invoke('list_objects', { input: { connectionId, prefix: null } });
      if (scoped.prefix !== __PREFIX__) {
        throw new Error('the listing is not scoped to the prefix: ' + scoped.prefix);
      }
      return names.length + ' rows · ' + $('[data-testid=folder-status]').textContent;
    });

    await check('ui: the list is a listbox and the keyboard owns it', async () => {
      window.__s3viewer.state.objects.clearSelection();
      const list = $('[data-testid=object-list]');
      if (!list) throw new Error('the object list is missing');
      if (list.getAttribute('role') !== 'listbox') {
        throw new Error('the list is not a listbox: ' + list.getAttribute('role'));
      }
      if (list.getAttribute('aria-multiselectable') !== 'true') {
        throw new Error('the list does not advertise multiple selection');
      }
      list.focus();
      press(list, 'ArrowDown');
      await wait('aria-activedescendant', async () => {
        const id = list.getAttribute('aria-activedescendant');
        return id && $('#' + id) ? id : null;
      });
      const rows = window.__s3viewer.state.visible;
      const active = () => Number((list.getAttribute('aria-activedescendant') || '').replace('row-', ''));
      if (active() !== 0) throw new Error('ArrowDown did not land on the first row: ' + active());
      if (window.__s3viewer.state.objects.focusedKey !== rows[0].key) {
        throw new Error('focus and aria-activedescendant disagree');
      }
      await wait('the preview to follow the focus', async () => {
        const key = window.__s3viewer.state.objects.previewKey;
        return key === rows[0].key ? true : null;
      });
      press(list, 'End');
      await wait('End', async () => (active() === rows.length - 1 ? true : null));
      press(list, 'Home');
      await wait('Home', async () => (active() === 0 ? true : null));
      press(list, 'PageDown');
      await wait('PageDown', async () => (active() > 0 ? true : null));
      // A viewport-sized page can reach the last row; start the two-row probe
      // from the top so the second Down is not clamped at the bottom.
      press(list, 'Home');
      await wait('Home after PageDown', async () => (active() === 0 ? true : null));
      const selectedBefore = window.__s3viewer.state.objects.selected.size;
      press(list, 'ArrowDown');
      await frame();
      if (window.__s3viewer.state.objects.selected.size !== selectedBefore) {
        throw new Error('a plain arrow changed the selection');
      }
      press(list, 'Escape');
      await frame();
      press(list, 'ArrowDown');
      press(list, 'ArrowDown', { shiftKey: true });
      await frame();
      const extended = window.__s3viewer.state.objects.selected.size;
      if (extended !== 2) throw new Error('Shift+ArrowDown selected ' + extended + ' row(s)');
      press(list, 'Escape');
      await frame();
      press(list, 'a', { metaKey: true });
      await frame();
      const all = window.__s3viewer.state.objects.selected.size;
      if (all !== rows.length) {
        throw new Error('select all covered ' + all + ' of ' + rows.length + ' rows');
      }
      const countLabel = $('[data-testid=selection-count]').textContent.trim();
      press(list, 'Escape');
      await frame();
      return 'Home/End/PageDown, Shift+Arrow and ⌘A (' + all + ' rows, "' + countLabel + '")';
    });

    await check('ui: type-ahead focuses the matching row and restarts', async () => {
      const list = $('[data-testid=object-list]');
      // Typing into a listing that is still streaming matches nothing, and a
      // stale buffer (its reset timer fires late on a loaded machine) poisons
      // the first letter. Both are timing, not behaviour: settle, then retry.
      await wait('the listing to settle', async () => {
        const objects = window.__s3viewer.state.objects;
        return !objects.loading && !objects.awaitingFirstPage && objects.visibleEntries.length
          ? true
          : null;
      }, 20000);
      list.focus();
      const match = async (name) => {
        const key = window.__s3viewer.state.objects.focusedKey;
        return key && key.endsWith('/' + name) ? key : null;
      };
      press(list, 's');
      try {
        await wait('sample.json by type-ahead', () => match('sample.json'), 8000);
      } catch {
        await sleep(1200);
        press(list, 's');
        await wait('sample.json by type-ahead, second try', () => match('sample.json'));
      }
      press(list, 'a');
      await frame();
      const together = window.__s3viewer.state.objects.focusedKey;
      if (!/sample\.(json|py)$/.test(together)) {
        throw new Error('the second letter restarted the search: ' + together);
      }
      await sleep(1200);
      press(list, 'n');
      const isNotes = async () => {
        const key = window.__s3viewer.state.objects.focusedKey;
        return key && key.endsWith('/notes.txt') ? key : null;
      };
      let notes;
      try {
        notes = await wait('notes.txt after the timeout', isNotes, 4000);
      } catch {
        // The reset timer can fire late under load; a second "n" after another
        // timeout starts a fresh search instead of extending "sa".
        await sleep(900);
        press(list, 'n');
        notes = await wait('notes.txt on the second try', isNotes, 4000);
      }
      return notes.split('/').pop() + ' after "sa" → "n"';
    });

    await check('ui: Cmd/Ctrl-click toggles one row', async () => {
      window.__s3viewer.state.objects.clearSelection();
      const rows = $$('.object-row');
      if (rows.length < 3) throw new Error('not enough rows');
      const click = (row, init = {}) =>
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window, ...init }));
      click(rows[0]);
      click(rows[2], { metaKey: true });
      await frame();
      if (window.__s3viewer.state.objects.selected.size !== 2) {
        throw new Error('⌘-click did not add: ' + window.__s3viewer.state.objects.selected.size);
      }
      click(rows[2], { metaKey: true });
      await frame();
      const left = window.__s3viewer.state.objects.selected.size;
      if (left !== 1) throw new Error('a second ⌘-click did not remove: ' + left);
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      return 'added then removed one row';
    });

    await check('ui: the context menu acts on the pointed row only', async () => {
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      const list = $('[data-testid=object-list]');
      const rows = $$('.object-row');
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
      rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true, view: window }));
      await frame();
      if (window.__s3viewer.state.objects.selected.size !== 3) {
        throw new Error('the range setup selected ' + window.__s3viewer.state.objects.selected.size);
      }
      const inside = rowNames()[1];
      const menu = await rowMenu(inside);
      const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent.trim());
      if (!labels.some((label) => label.startsWith('Delete 3 items'))) {
        throw new Error('the menu lost the selection count: ' + labels.join(' | '));
      }
      if (window.__s3viewer.state.objects.selected.size !== 3) {
        throw new Error('right-click inside the selection changed it');
      }
      // The menu must start on a runnable item and give focus back to the list.
      if (!document.activeElement || document.activeElement.getAttribute('role') !== 'menuitem') {
        throw new Error('the menu did not take focus');
      }
      press(menu, 'Escape');
      await wait('the menu to close', async () => ($('[data-testid=context-menu]') ? null : true));
      if (document.activeElement !== list) {
        throw new Error('focus did not return to the list: ' + (document.activeElement || {}).tagName);
      }
      // Right-clicking an unselected row collapses the set to that row.
      const outside = rowNames()[5];
      const second = await rowMenu(outside);
      const secondLabels = Array.from(second.querySelectorAll('button')).map((b) => b.textContent.trim());
      if (window.__s3viewer.state.objects.selected.size !== 1) {
        throw new Error('right-click outside the selection did not select one row');
      }
      if (secondLabels.some((label) => /^Delete \d+ items/.test(label))) {
        throw new Error('the menu still counts a stale selection: ' + secondLabels.join(' | '));
      }
      press(second, 'Escape');
      await wait('the second menu to close', async () => ($('[data-testid=context-menu]') ? null : true));
      return '3 selected inside, 1 when pointed outside, focus restored';
    });

    await check('ui: the toolbar reports one selection and acts on a set', async () => {
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      await clickRowWhenReady('sample.json');
      await frame();
      if (!$('[data-testid=selection-count]')) throw new Error('the selection count is missing');
      for (const id of ['download', 'copy', 'move', 'delete', 'copy-uri']) {
        if ($('[data-testid=' + id + ']')) {
          throw new Error('the toolbar repeats the single-row action "' + id + '"');
        }
      }

      const rows = $$('.object-row');
      const other = rows.find((row) => row.querySelector('.row-label').textContent !== 'sample.json');
      if (!other) throw new Error('no second row to extend the selection');
      other.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, view: window }));
      await frame();
      for (const id of ['download', 'copy', 'move', 'delete']) {
        if (!$('[data-testid=' + id + ']')) {
          throw new Error('the bulk toolbar is missing "' + id + '"');
        }
      }
      press($('[data-testid=object-list]'), 'Escape');
      await frame();
      if ($('[data-testid=selection-count]')) throw new Error('Escape did not clear the selection');
      return 'one row: count only; two rows: bulk actions; Escape clears';
    });

    await check('ui: the address bar edits in place and explains bad addresses', async () => {
      const row = $('[data-testid=breadcrumb]').firstElementChild;
      row.click();
      const input = await wait('the address input', () => $('[data-testid=address-input]'));
      if (document.activeElement !== input) throw new Error('the address input did not take focus');
      if (!input.value.startsWith('s3://' + __BUCKET__ + '/')) {
        throw new Error('unexpected draft: ' + input.value);
      }
      // A bare key is a key, not a bucket.
      input.value = 'sample.json';
      fire(input, 'input');
      press(input, 'Enter');
      const name = await wait('the preview from a bare address', () => {
        const node = $('[data-testid=preview-name]');
        return node && node.textContent.trim() === 'sample.json' ? node.textContent.trim() : null;
      });
      if ($('[data-testid=address-error]')) throw new Error('a valid bare address reported an error');
      // A foreign bucket gets its own explanation, not "nothing found".
      const again = await openAddress();
      again.value = 's3://not-this-bucket/x';
      fire(again, 'input');
      press(again, 'Enter');
      const error = await wait('the foreign-bucket message', () => $('[data-testid=address-error]'));
      if (!/can only open/i.test(error.textContent)) {
        throw new Error('unhelpful foreign-bucket message: ' + error.textContent);
      }
      closeAddress();
      await frame();
      return 'bare key opened, foreign bucket explained';
    });

    await check('ui: an address opens an object in another folder', async () => {
      const key = __PREFIX__ + 'nested/deep.txt';
      await invoke('create_file', {
        input: { connectionId, prefix: __PREFIX__ + 'nested/', name: 'deep.txt', content: 'nested probe' },
      });
      $('[data-testid=refresh]').click();
      await wait('the nested folder', async () => {
        const objects = window.__s3viewer.state.objects;
        return !objects.loading && rowNames().includes('nested') ? true : null;
      }, 20000);
      const input = await openAddress();
      input.value = 's3://' + __BUCKET__ + '/' + key;
      fire(input, 'input');
      press(input, 'Enter');
      const name = await wait('the nested preview', () => {
        const node = $('[data-testid=preview-name]');
        return node && node.textContent.trim() === 'deep.txt' ? node.textContent.trim() : null;
      }, 20000);
      if ($('[data-testid=address-error]')) {
        throw new Error('opening an object one folder away reported: ' + $('[data-testid=address-error]').textContent);
      }
      const selected = window.__s3viewer.state.objects.selected.size;
      if (selected !== 1) throw new Error('the opened object is not selected: ' + selected);
      $('[data-testid=crumb-root]').click();
      await wait('the root listing', async () => {
        const objects = window.__s3viewer.state.objects;
        return !objects.loading && rowNames().includes('nested') ? true : null;
      });
      // Remove the object and, if the provider kept one, the folder marker. A
      // refresh clears the rows first, so waiting for absence must also wait for
      // the new listing to settle or the check passes on the empty loading list.
      await invoke('delete_objects', {
        input: { connectionId, keys: [key, __PREFIX__ + 'nested/'] },
      });
      // The command starts a transfer and returns; confirm against the backend
      // that the keys are gone before asking the UI to reload.
      await wait('S3 to forget the nested key', async () => {
        const listing = await invoke('list_objects', {
          input: { connectionId, prefix: __PREFIX__ },
        });
        return listing.entries.some((entry) => entry.key.indexOf(__PREFIX__ + 'nested') === 0)
          ? null
          : true;
      }, 30000);
      $('[data-testid=refresh]').click();
      await wait('the cleanup listing', async () => {
        const objects = window.__s3viewer.state.objects;
        if (objects.loading || objects.awaitingFirstPage) return null;
        return rowNames().includes('nested') ? null : true;
      }, 20000);
      return name + ' selected, root restored';
    });

    await check('ops: New file takes content, validates the name and Delete works', async () => {
      window.__s3viewer.state.objects.clearSelection();
      $('[data-testid=new-file]').click();
      const nameInput = await wait('the new file dialog', () => $('[data-testid=new-file-name]'));
      $('[data-testid=new-file-create]').click();
      // The error is rendered on a microtask; reading synchronously would see
      // the pre-click attributes.
      await wait('the name error', async () =>
        (nameInput.getAttribute('aria-invalid') === 'true' ? true : null), 5000);
      const described = nameInput.getAttribute('aria-describedby') || '';
      const errorNode = described.split(/\s+/).map((id) => document.getElementById(id)).find(Boolean);
      if (nameInput.getAttribute('aria-invalid') !== 'true') {
        throw new Error('the invalid name is not marked aria-invalid');
      }
      if (!errorNode || !/file name is required/i.test(errorNode.textContent)) {
        throw new Error('the name error is not associated: ' + described);
      }
      if (errorNode.getAttribute('role') !== 'alert') {
        throw new Error('the validation message is not a live region');
      }
      if (document.activeElement !== nameInput) {
        throw new Error('validation did not return focus to the field');
      }

      const name = 'keyboard-probe-' + Date.now() + '.txt';
      setInput('[data-testid=new-file-name]', name);
      setInput('[data-testid=new-file-content]', 'delete me\n');
      $('[data-testid=new-file-create]').click();
      await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 10000);
      await wait('the new row', async () => (rowNames().includes(name) ? true : null), 20000);
      const preview = await wait('the new file preview', () => {
        const node = $('[data-testid=preview-code]');
        return node && node.textContent.includes('delete me') ? node : null;
      }, 20000);
      const shown = $('[data-testid=preview-name]').textContent.trim();
      if (shown !== name) throw new Error('the preview did not follow the new file: ' + shown);

      // The destructive key asks first; Cancel must leave the object alone.
      const list = $('[data-testid=object-list]');
      clickRow(name);
      await frame();
      press(list, 'Delete');
      const cancel = await wait('the delete confirmation', () => $('[data-testid=confirm-cancel]'), 8000);
      if (document.activeElement !== cancel) {
        throw new Error('Cancel is not the default on a destructive confirmation');
      }
      $('[data-testid=modal]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await frame();
      if (!$('[data-testid=confirm-ok]')) throw new Error('Enter confirmed a destructive dialog');
      cancel.click();
      await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 8000);
      if (!rowNames().includes(name)) throw new Error('Cancel still deleted the file');

      press(list, 'Backspace', { metaKey: true });
      const ok = await wait('the second confirmation', () => $('[data-testid=confirm-ok]'), 8000);
      ok.click();
      await wait('the file to disappear', async () => (rowNames().includes(name) ? null : true), 20000);
      return 'content previewed; Cancel kept it; ⌘⌫ removed it (' + preview.textContent.length + ' chars)';
    });

    await check('navigation: folder rows are sorted before files', async () => {
      const toolbarProbe = 'toolbar=' + Boolean($('#toolbar'))
        + ' buttons=' + (($('#toolbar') || {}).querySelectorAll ? $('#toolbar').querySelectorAll('button').length : -1)
        + ' testids=[' + $$('#toolbar button').map((b) => b.dataset.testid).join(',') + ']'
        + ' allBtnIds=[' + $$('button').map((b) => b.id || b.dataset.testid || b.className.split(' ')[0]).slice(0, 24).join(',') + ']';
      if (!$('[data-testid=new-folder]')) {
        throw new Error('the toolbar lost its buttons: ' + toolbarProbe + ' :: ' + domDigest());
      }
      $('[data-testid=new-folder]').click();
      await wait('the folder prompt', () => $('[data-testid=prompt-input]'));
      // "zzz" sorts after every fixture alphabetically, so the folder can only
      // be first when folders are grouped before files.
      const folder = 'zzz-sort-probe-' + Date.now();
      setInput('[data-testid=prompt-input]', folder);
      $('[data-testid=prompt-ok]').click();
      await wait('the new folder', async () => (rowNames().includes(folder) ? true : null));
      const ordered = rowNames();
      if (ordered[0] !== folder) {
        throw new Error('folders are not listed first: ' + ordered.slice(0, 3).join(', '));
      }
      if (ordered.indexOf('blob.bin') < ordered.indexOf(folder)) {
        throw new Error('the file sort leaked above the folder: ' + ordered.slice(0, 3).join(', '));
      }
      const folderMenu = await rowMenu(folder);
      const deleteState = 'selected=' + window.__s3viewer.state.selected.size
        + ' rows=' + rowNames().join(',');
      menuClick(folderMenu, 'Delete');
      const confirm = await wait('the confirmation', () => $('[data-testid=confirm-ok]'), 8000)
        .catch(() => null);
      if (!confirm) throw new Error('no confirmation appeared after delete: ' + deleteState);
      confirm.click();
      try {
        await wait('the folder to disappear', async () => (rowNames().includes(folder) ? null : true), 60000);
      } catch (error) {
        const progress = await invoke('transfer_progress');
        throw new Error(error.message + ' :: rows=' + rowNames().join(',')
          + ' transfers=' + JSON.stringify(progress).slice(0, 300));
      }
      return 'folders sort first';
    });

    await check('navigation: Up, the folder card and empty-folder actions', async () => {
      const folder = 'nav-probe-' + Date.now();
      $('[data-testid=new-folder]').click();
      await wait('the folder prompt', () => $('[data-testid=prompt-input]'));
      setInput('[data-testid=prompt-input]', folder);
      $('[data-testid=prompt-ok]').click();
      await wait('the new folder row', async () => (rowNames().includes(folder) ? true : null));

      clickRow(folder);
      const card = await wait('the folder preview card', () => $('[data-testid=preview-folder]'), 10000);
      if (!$('[data-testid=preview-folder-open]')) throw new Error('the folder card has no Open button');
      if ($('[data-testid=preview-download]')) throw new Error('a folder offered Download');
      if ($('[data-testid=preview-expand]')) throw new Error('a folder offered Expand');
      $('[data-testid=preview-folder-open]').click();
      await wait('the breadcrumb to follow the folder', async () =>
        ($('[data-testid=breadcrumb]').textContent.includes(folder) ? true : null));

      const empty = await wait('the empty-folder state', () => $('[data-testid=empty-folder]'), 10000);
      if (!/this folder is empty/i.test(empty.textContent)) {
        throw new Error('unexpected empty state: ' + empty.textContent.slice(0, 80));
      }
      for (const id of ['empty-upload', 'empty-upload-folder', 'empty-new-folder']) {
        if (!$('[data-testid=' + id + ']')) throw new Error('the empty state is missing ' + id);
      }
      const up = $('[data-testid=navigate-up]');
      if (up.disabled) throw new Error('Up is disabled inside a folder');
      $('[data-testid=empty-new-folder]').click();
      await wait('the nested-folder prompt', () => $('[data-testid=prompt-input]'));
      const nested = 'nested-' + Date.now();
      setInput('[data-testid=prompt-input]', nested);
      $('[data-testid=prompt-ok]').click();
      await wait('the nested folder row', async () => (rowNames().includes(nested) ? true : null));

      $('[data-testid=navigate-up]').click();
      await wait('the root listing', async () => (rowNames().includes(folder) ? true : null), 15000);
      if (!$('[data-testid=navigate-up]').disabled) throw new Error('Up is enabled at the scope root');

      const menu = await rowMenu(folder);
      const chosen = Array.from(window.__s3viewer.state.objects.selected);
      if (chosen.length !== 1 || chosen[0] !== __PREFIX__ + folder + '/') {
        throw new Error('the delete would target ' + JSON.stringify(chosen) + ', not the folder');
      }
      menuClick(menu, 'Delete');
      const confirm = await wait('the recursive-delete confirmation', () => $('[data-testid=confirm-ok]'), 8000);
      const details = ($('[data-testid=confirm-details]') || {}).textContent || '';
      if (!/recursively/i.test(details)) throw new Error('the delete did not warn about recursion: ' + details);
      confirm.click();
      // Wait for S3 itself to forget the folder marker. The delete command
      // starts a background transfer and returns, so a transfer list (or a row)
      // can be stale by the time it is read.
      await wait('S3 to forget the folder', async () => {
        const listing = await invoke('list_objects', {
          input: { connectionId, prefix: __PREFIX__ },
        });
        const marker = __PREFIX__ + folder + '/';
        return listing.entries.some((entry) => entry.key === marker) ? null : true;
      }, 60000).catch(async (error) => {
        const items = await invoke('transfer_progress');
        const under = await invoke('list_objects', {
          input: { connectionId, prefix: __PREFIX__ + folder + '/' },
        }).catch((e) => ({ entries: [], error: String(e) }));
        const root = await invoke('list_objects', {
          input: { connectionId, prefix: __PREFIX__ },
        }).catch((e) => ({ entries: [], error: String(e) }));
        throw new Error(error.message + ' :: deletes='
          + JSON.stringify(items.filter((item) => /Deleting/i.test(item.label)).slice(-2))
          + ' under=' + JSON.stringify(under.entries.map((entry) => entry.key))
          + ' root=' + JSON.stringify(root.entries.map((entry) => entry.key)));
      });
      $('[data-testid=refresh]').click();
      await wait('the folder and its child to disappear', async () => {
        const objects = window.__s3viewer.state.objects;
        if (objects.loading || objects.awaitingFirstPage) return null;
        return rowNames().includes(folder) ? null : true;
      }, 30000);
      return card.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) + ' → nested → Up → deleted';
    });

    await check('preview: image decodes through the s3stream protocol', async () => {
      clickRow('image.png');
      const image = await wait('the image element', () => $('[data-testid=preview-image]'));
      const width = await wait('the image to decode', async () => (image.naturalWidth > 0 ? image.naturalWidth : null));
      if (!image.src.startsWith('s3stream:')) throw new Error('unexpected src: ' + image.src);
      return width + 'x' + image.naturalHeight;
    });

    await check('preview: audio metadata loads through ranged reads', async () => {
      clickRow('tone.wav');
      const audio = await wait('the audio element', () => $('[data-testid=preview-audio]'));
      const duration = await wait('audio duration', async () => {
        const value = audio.duration;
        return Number.isFinite(value) && value > 0 ? value : null;
      }, 30000);
      if (!(duration > 0.5)) throw new Error('suspicious duration: ' + duration);
      return duration.toFixed(2) + 's';
    });

    await check('preview: video is wired to the ranged stream', async () => {
      clickRow('clip.mp4');
      const video = await wait('the video element', () => $('[data-testid=preview-video]'));
      if (!video.src.startsWith('s3stream:')) throw new Error('unexpected src: ' + video.src);
      if (!video.controls) throw new Error('the video has no controls');
      // A metadata request proves the range plumbing; the fixture itself is not
      // decodable on purpose, so no readyState assertion is made here.
      await sleep(500);
      return 'video element bound to ' + video.src.slice(0, 48);
    });

    await check('preview: PDF is rendered from the stream', async () => {
      clickRow('document.pdf');
      const canvas = await wait('the rendered PDF page', async () => {
        const node = $('[data-testid=preview-pdf]');
        return node && node.width > 0 ? node : null;
      }, 30000);
      const page = $('[data-testid=pdf-page]');
      if (!page || !/1 \//.test(page.textContent)) {
        throw new Error('no page indicator: ' + (page ? page.textContent : 'missing'));
      }
      return canvas.width + 'x' + canvas.height + ' px, ' + page.textContent.trim();
    });

    await check('preview: SVG renders as an image', async () => {
      clickRow('vector.svg');
      const image = await wait('the SVG preview', () => $('[data-testid=preview-image]'));
      const width = await wait('the SVG to decode', async () => (image.naturalWidth > 0 ? image.naturalWidth : null));
      // A stale image.png element would satisfy a bare naturalWidth check.
      const name = $('[data-testid=preview-name]').textContent.trim();
      if (name !== 'vector.svg') throw new Error('the preview did not follow the row: ' + name);
      if (width !== 120) throw new Error('unexpected SVG width: ' + width);
      return name + ' at ' + width + 'px';
    });

    await check('preview: Markdown renders structure and toggles to raw', async () => {
      clickRow('readme.md');
      const rendered = await wait('the rendered markdown', () => $('[data-testid=preview-markdown]'));
      const html = rendered.innerHTML;
      for (const tag of ['<h1', '<table', '<strong>', '<code']) {
        if (!html.includes(tag)) throw new Error('missing ' + tag + ' in the rendered output');
      }
      const rawButton = await wait('the raw toggle', () => $('[data-testid=md-view-raw]'), 10000);
      rawButton.click();
      const raw = await wait('the raw view', () => $('[data-testid=preview-code]'), 10000).catch((error) => {
        throw new Error(error.message + ' :: view=' + window.__s3viewer.state.preview.view
          + ' codeEl=' + Boolean($('[data-testid=preview-code]'))
          + ' mdEl=' + Boolean($('[data-testid=preview-markdown]'))
          + ' firstChildClass=' + (($('#preview-body').firstElementChild || {}).className)
          + ' innerClasses=[' + $$('#preview-body div, #preview-body pre').map((n) => n.className).join(' | ') + ']');
      });
      if (!raw.textContent.includes('# Preview test document')) {
        throw new Error('the raw view is not the source text');
      }
      // Switching views re-renders the panel, so the button must be re-queried.
      const back = await wait('the rendered toggle', () => $('[data-testid=md-view-rendered]'), 10000);
      back.click();
      await wait('the rendered view again', () => $('[data-testid=preview-markdown]'), 10000);
      return html.length + ' bytes of rendered markup';
    });

    await check('preview: Markdown output is sanitised', async () => {
      const result = window.__s3viewerSanitizeProbe();
      if (result.executed.script || result.executed.handler) throw new Error('injected code executed');
      if (/<script/i.test(result.html)) throw new Error('script tag survived');
      if (/onerror/i.test(result.html)) throw new Error('event handler survived');
      if (/\\b(?:href|src)\\s*=\\s*["']?\\s*javascript:/i.test(result.html)) {
        throw new Error('javascript: URL survived in an attribute: ' + result.html.slice(0, 200));
      }
      if (!result.html.includes('<h1')) throw new Error('legitimate markup was stripped');
      return 'script, onerror and javascript: all removed';
    });

    await check('preview: JSON is highlighted and pretty-printed', async () => {
      clickRow('sample.json');
      const code = await wait('the code preview', () => $('[data-testid=preview-code]'), 30000)
        .catch((error) => {
          const state = window.__s3viewer.state;
          throw new Error(error.message
            + ' :: previewKey=' + state.preview?.key
            + ' loading=' + state.preview?.loading
            + ' err=' + (state.preview?.error?.message || 'none')
            + ' reason=' + (state.preview?.data?.unavailableReason || 'none')
            + ' kind=' + (state.preview?.data?.kind || 'none')
            + ' panelHidden=' + $('#preview').hidden
            + ' bodyClasses=[' + $$('#preview-body *').slice(0, 6).map((n) => n.className || n.tagName).join(' | ') + ']'
            + ' trace=' + window.__s3viewer.describe().previewTrace);
        });
      const html = code.innerHTML;
      if (!/hljs-(attr|string)/.test(html)) throw new Error('no highlighting: ' + html.slice(0, 160));
      if (!html.includes('preview-fixture')) throw new Error('content missing');
      if (!/\n\s{2}"/.test(code.textContent)) throw new Error('JSON was not pretty-printed');
      return 'highlighted, ' + html.length + ' bytes';
    });

    await check('preview: Python is highlighted', async () => {
      clickRow('sample.py');
      const code = await wait('the code preview', () => $('[data-testid=preview-code]'), 20000)
        .catch((error) => {
          throw new Error(error.message
            + ' :: previewKey=' + window.__s3viewer.state.objects.previewKey
            + ' kind=' + (window.__s3viewer.state.objects.preview?.kind || 'none')
            + ' body=[' + $$('#preview-body *').slice(0, 5).map((n) => n.className || n.tagName).join(' | ') + ']');
        });
      const html = code.innerHTML;
      if (!html.includes('hljs-keyword')) throw new Error('no keywords: ' + html.slice(0, 160));
      if (!html.includes('Greeter')) {
        throw new Error('content missing; previewKey=' + window.__s3viewer.state.objects.previewKey
          + ' dataKey=' + (window.__s3viewer.state.objects.preview || {}).key
          + ' previewLog=' + window.__s3viewer.logs.preview.slice(-8).join(' | ')
          + ' errors=' + JSON.stringify(window.__s3viewerErrors.slice(-2))
          + ' markup=' + html.slice(0, 120));
      }
      return 'highlighted, ' + html.length + ' bytes';
    });

    await check('preview: CSV becomes a table with quoted fields intact', async () => {
      clickRow('table.csv');
      const table = await wait('the table', () => $('[data-testid=preview-table] table'));
      const rows = table.querySelectorAll('tbody tr').length;
      if (rows !== 3) throw new Error('expected 3 data rows, found ' + rows);
      if (!table.textContent.includes('quoted, value')) throw new Error('quoted field was mangled');
      return rows + ' data rows';
    });

    await check('preview: unicode text is preserved', async () => {
      clickRow('notes.txt');
      const code = await wait('the text preview', () => $('[data-testid=preview-code]'));
      if (!code.textContent.includes('привет мир — 你好 — 🎉')) throw new Error('unicode was mangled');
      return code.textContent.length + ' chars';
    });

    await check('preview: binary content is refused with a reason', async () => {
      clickRow('blob.bin');
      const node = await wait('the refusal message', () => $('[data-testid=preview-unavailable]'));
      const text = node.textContent;
      if (!/preview/i.test(text)) throw new Error('unhelpful message: ' + text);
      if (!/download/i.test(text)) throw new Error('no download hint: ' + text);
      return text.replace(/\s+/g, ' ').trim().slice(0, 90);
    });

    await check('preview: an oversized file is refused with its size and limit', async () => {
      clickRow('too-big.txt');
      const node = await wait('the size refusal', () => $('[data-testid=preview-unavailable]'), 60000)
        .catch((error) => {
          throw new Error(error.message
            + ' :: previewKey=' + window.__s3viewer.state.objects.previewKey
            + ' reason=' + (window.__s3viewer.state.objects.previewUnavailable || 'none')
            + ' previewLog=' + window.__s3viewer.logs.preview.slice(-8).join(' | ')
            + ' errors=' + JSON.stringify(window.__s3viewerErrors.slice(-2)));
        });
      const text = node.textContent;
      if (!/exceeds the preview limit/i.test(text)) throw new Error('wrong message: ' + text);
      if (!/MB/.test(text)) throw new Error('the message does not name the sizes: ' + text);
      return text.replace(/\s+/g, ' ').trim().slice(0, 120);
    });

    await check('preview: Parquet renders as a table', async () => {
      // Seeded by the runner before the app started; refresh so the listing
      // includes anything uploaded since the window opened.
      $('[data-testid=refresh]').click();
      await wait('the listing to settle', async () => {
        const objects = window.__s3viewer.state.objects;
        if (objects.loading || objects.awaitingFirstPage) return null;
        return rowNames().includes('table.parquet') ? true : null;
      }, 30000).catch((error) => {
        throw new Error(error.message + ' :: rows=' + rowNames().join(','));
      });
      clickRow('table.parquet');
      const table = await wait('the parquet table', () => $('[data-testid=preview-table] table'), 30000);
      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
      if (headers.join(',') !== 'name,count,score') {
        throw new Error('unexpected parquet columns: ' + headers.join(','));
      }
      const body = table.querySelectorAll('tbody tr');
      if (body.length !== 3) throw new Error('expected 3 parquet rows, found ' + body.length);
      if (!table.textContent.includes('alpha')) throw new Error('parquet values are missing');
      if (!table.textContent.includes('2.75')) throw new Error('numeric parquet values are missing');
      return headers.join(',') + ' · ' + body.length + ' rows';
    });

    await check('preview: YAML is syntax highlighted', async () => {
      await wait('the yaml row', async () => (rowNames().includes('config.yaml') ? true : null), 30000);
      clickRow('config.yaml');
      const code = await wait('the code preview', () => $('[data-testid=preview-code]'), 20000);
      const html = code.innerHTML;
      if (!/hljs-/.test(html)) throw new Error('no highlighting for YAML: ' + html.slice(0, 200));
      if (!html.includes('replicas')) throw new Error('content missing from the YAML preview');
      return 'highlighted, ' + html.length + ' bytes';
    });

    await check('ui: at minimum width the sidebar label never covers the New button', async () => {
      const ui = window.__s3viewer.state.ui;
      const before = ui.layout.sidebar;
      ui.setSidebarWidth(190);
      await frame();
      const label = $('#sidebar .sidebar-label');
      const button = $('#new-connection');
      if (!button) throw new Error('the New button disappeared');
      if (!/\bNew\b/.test(button.textContent || '')) {
        throw new Error('the New button lost its label at minimum width: "' + button.textContent.trim() + '"');
      }
      if (label && label.offsetParent !== null) {
        const l = label.getBoundingClientRect();
        const b = button.getBoundingClientRect();
        const overlap = Math.min(l.right, b.right) - Math.max(l.left, b.left);
        if (overlap > 1) {
          throw new Error('the label overlaps the button by ' + Math.round(overlap) + 'px');
        }
      }
      ui.setSidebarWidth(before);
      await frame();
      return 'no overlap at 190px';
    });

    await check('ui: the layout can be collapsed and resized', async () => {
      const sidebar = $('#sidebar');
      const before = sidebar.getBoundingClientRect().width;
      $('[data-testid=collapse-sidebar]').click();
      const collapsed = sidebar.getBoundingClientRect().width;
      if (!(collapsed < before)) {
        throw new Error('the sidebar did not collapse (' + before + ' -> ' + collapsed
          + ') collapsedFlag=' + window.__s3viewer.state.ui.layout.collapsed
          + ' styleWidth=' + sidebar.style.width);
      }
      // The rail is a column of targets: each avatar must sit on the sidebar's
      // centre line, not against its left edge.
      const rail = $$('#connection-list button[data-testid^="connection-"]')[0];
      if (!rail) throw new Error('the collapsed rail has no connection target');
      const railBox = rail.getBoundingClientRect();
      const sideBox = sidebar.getBoundingClientRect();
      const offset = Math.abs(
        railBox.left + railBox.width / 2 - (sideBox.left + sideBox.width / 2),
      );
      if (offset > 1.5) {
        throw new Error('the collapsed rail avatar is off-centre by ' + offset.toFixed(1) + 'px');
      }
      $('[data-testid=collapse-sidebar]').click();
      const restored = sidebar.getBoundingClientRect().width;
      if (Math.abs(restored - before) > 2) {
        throw new Error('the sidebar did not expand again (' + collapsed + ' -> ' + restored + ')');
      }

      // Dragging the handle must change the width, and a double click reset it.
      const handle = $('[data-testid=resizer-sidebar]');
      const startX = handle.getBoundingClientRect().left + 2;
      handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: startX + 80, bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointerup', { clientX: startX + 80, bubbles: true }));
      const widened = sidebar.getBoundingClientRect().width;
      if (!(widened > restored + 20)) {
        throw new Error('dragging the handle did not resize the sidebar (' + restored + ' -> ' + widened + ')');
      }
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const reset = sidebar.getBoundingClientRect().width;
      if (Math.abs(reset - restored) > 2) throw new Error('double click did not reset the width: ' + reset);
      return before + 'px collapsed to ' + collapsed + 'px, dragged to ' + widened + 'px, reset';
    });

    await check('ui: an object S3 URI can be copied', async () => {
      const menu = await rowMenu('image.png');
      menuClick(menu, 'Copy S3 URI');
      await wait('the confirmation toast', () => $$('[data-testid^=toast-]').find((t) => /s3:\/\//.test(t.textContent)), 10000);
      const toast = $$('[data-testid^=toast-]').find((t) => /s3:\/\//.test(t.textContent));
      const expected = 's3://' + __BUCKET__ + '/';
      if (!toast.textContent.includes(expected)) {
        throw new Error('unexpected URI in the toast: ' + toast.textContent);
      }
      return toast.textContent.replace(/\s+/g, ' ').slice(0, 80);
    });

    await check('ui: a single click selects exactly one row and opens its preview', async () => {
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      const row = clickRow('sample.json');
      await frame();
      const selected = Array.from(window.__s3viewer.state.objects.selected);
      if (selected.length !== 1) {
        throw new Error('a plain click selected ' + selected.length + ' row(s)');
      }
      if (!selected[0].endsWith('sample.json')) {
        throw new Error('the click selected the wrong row: ' + selected.join(', '));
      }
      const previewKey = window.__s3viewer.state.objects.previewKey;
      if (!previewKey || !previewKey.includes('sample.json')) {
        throw new Error('the click did not open the preview: ' + previewKey);
      }
      if (row.getAttribute('aria-selected') !== 'true') {
        throw new Error('the selected row is not marked aria-selected');
      }

      // A second plain click must replace the selection, not add to it.
      const secondIndex = window.__s3viewer.state.visible.findIndex((e) => e.name === 'notes.txt');
      if (secondIndex < 0) throw new Error('the second row for the click probe is missing');
      window.__s3viewer.scrollToRow(secondIndex);
      await frame();
      const second = $$('.object-row')
        .find((r) => r.querySelector('.row-label').textContent === 'notes.txt');
      if (!second) throw new Error('the second row is not rendered');
      second.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
      await frame();
      const replaced = Array.from(window.__s3viewer.state.objects.selected);
      if (replaced.length !== 1 || !replaced[0].endsWith('notes.txt')) {
        throw new Error('a second plain click did not replace the selection: '
          + replaced.length + ' row(s): ' + replaced.join(', '));
      }
      const ariaSelected = $$('.object-row')
        .filter((r) => r.getAttribute('aria-selected') === 'true');
      if (ariaSelected.length !== 1 || ariaSelected[0] !== second) {
        throw new Error('expected only the second row to be aria-selected, got ' + ariaSelected.length);
      }
      return 'one row, then the selection followed a second plain click';
    });

    await check('ui: checkboxes appear with the first selected row, never at rest', async () => {
      window.__s3viewer.state.objects.clearSelection();
      window.__s3viewer.state.objects.focus(null);
      await frame();
      // At rest the column does not exist at all: no gutter, no header box.
      if ($$('[data-testid^=row-check-]').length) {
        throw new Error('the checkbox column is rendered with nothing selected');
      }
      if ($('[data-testid=select-all]')) throw new Error('the select-all box is rendered at rest');

      const rows = $$('.object-row');
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
      await frame();
      const selected = window.__s3viewer.state.objects.selected.size;
      if (selected !== 1) {
        throw new Error('clicking a row selected ' + selected + ' row(s) instead of one');
      }
      // One selected row is already a selection: it shows a checked box, the
      // select-all box and the cursor. That is what tells the user a click
      // registered instead of leaving the list looking unchanged.
      const boxes = $$('[data-testid^=row-check-]');
      if (boxes.length !== rows.length) {
        throw new Error('one selected row rendered ' + boxes.length + ' checkbox(es) for '
          + rows.length + ' rows');
      }
      if (boxes.filter((box) => box.checked && box.offsetParent !== null).length !== 1) {
        throw new Error('the selected row does not show exactly one checked box');
      }
      if (!$('[data-testid=select-all]')) throw new Error('one row did not turn on select-all');

      // A selected set is a flat tint, so the cursor needs a marker of its own.
      if (rows[0].dataset.focused !== 'true') {
        throw new Error('the clicked row is not marked as the cursor');
      }
      if (getComputedStyle(rows[0]).boxShadow === 'none') {
        throw new Error('the cursor row has no visible marker inside the selection');
      }

      // A second row may widen the selection, but never produces a second cursor.
      rows[1].dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        metaKey: true,
        view: window,
      }));
      await frame();
      const pair = window.__s3viewer.state.objects.selected.size;
      if (pair !== 2) throw new Error('⌘-click produced ' + pair + ' selected rows');
      if ($$('[data-testid^=row-check-]').filter((box) => box.checked).length !== 2) {
        throw new Error('a two-row selection does not show two checked boxes');
      }
      const cursors = $$('.object-row').filter((row) => row.dataset.focused === 'true');
      if (cursors.length !== 1 || cursors[0] !== rows[1]) {
        throw new Error('the set has ' + cursors.length + ' cursor row(s) instead of one');
      }

      press($('[data-testid=object-list]'), 'Escape');
      await frame();
      if ($$('[data-testid^=row-check-]').length) {
        throw new Error('clearing the set left the checkbox column behind');
      }

      // Select-all is the flattest state the list can be in: every row ticked,
      // and the cursor still has to land on one of them.
      window.__s3viewer.state.objects.focus(null);
      await frame();
      press($('[data-testid=object-list]'), 'a', { metaKey: true });
      await frame();
      const everything = window.__s3viewer.state.objects.visibleEntries.length;
      if (window.__s3viewer.state.objects.selected.size !== everything) {
        throw new Error('⌘A selected ' + window.__s3viewer.state.objects.selected.size
          + ' of ' + everything + ' rows');
      }
      const marks = $$('.object-row').filter((row) => row.dataset.focused === 'true');
      if (marks.length !== 1) throw new Error('⌘A left ' + marks.length + ' cursor row(s)');
      const firstKey = window.__s3viewer.state.objects.visibleEntries[0].key;
      if (window.__s3viewer.state.objects.focusedKey !== firstKey) {
        throw new Error('⌘A put the cursor on ' + window.__s3viewer.state.objects.focusedKey);
      }
      press($('[data-testid=object-list]'), 'Escape');
      await frame();
      return 'none at rest, full column for one row, one cursor inside the set; ⌘A keeps a cursor';
    });

    await check('ui: shift-click selects a contiguous range', async () => {
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      const rows = $$('.object-row');
      if (rows.length < 3) throw new Error('not enough rows: ' + rows.length);
      const names = rows.slice(0, 3).map((r) => r.querySelector('.row-label').textContent);

      const click = (row, init = {}) =>
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window, ...init }));
      click(rows[0]);
      click(rows[2], { shiftKey: true });
      await frame();

      const selected = Array.from(window.__s3viewer.state.objects.selected);
      if (selected.length !== 3) {
        throw new Error('expected 3 rows, got ' + selected.length + ' (' + selected.join(', ') + ')');
      }
      const ariaSelected = $$('.object-row')
        .filter((row) => row.getAttribute('aria-selected') === 'true').length;
      if (ariaSelected !== 3) {
        throw new Error('expected 3 aria-selected rows, got ' + ariaSelected);
      }
      return names.join(' → ');
    });

    await check('ui: the row context menu offers the row actions', async () => {
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      const menu = await rowMenu('image.png');
      const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent.trim());
      for (const wanted of ['Preview', 'Download', 'Copy S3 URI', 'Delete']) {
        if (!labels.some((label) => label.startsWith(wanted))) {
          throw new Error('missing "' + wanted + '" in: ' + labels.join(' | '));
        }
      }
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait('the menu to close', async () => ($('[data-testid=context-menu]') ? null : true), 4000);
      return labels.length + ' items';
    });

    await check('ui: the address bar opens an s3:// URI', async () => {
      const target = __PREFIX__ + 'sample.json';
      const input = await openAddress();
      input.value = 's3://' + window.__s3viewer.state.connections.active.bucket + '/' + target;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const previewKey = await wait('the preview to follow the address', async () => {
        const key = window.__s3viewer.state.objects.previewKey;
        return key && key.endsWith('sample.json') ? key : null;
      }, 20000);
      return previewKey.split('/').pop();
    });

    await check('ui: an address that does not exist says so', async () => {
      const input = await openAddress();
      input.value = 's3://' + window.__s3viewer.state.connections.active.bucket + '/' + __PREFIX__ + 'no-such-object-' + Date.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const error = await wait('the address error', () => $('[data-testid=address-error]'), 20000);
      const text = error.textContent.trim();
      if (!/nothing found/i.test(text)) throw new Error('unhelpful message: ' + text);
      // The message belongs to the address field, so it starts at the field's
      // edge — under the database icon it read as a separate label.
      const fieldLeft = input.getBoundingClientRect().left;
      const errorLeft = error.getBoundingClientRect().left;
      if (Math.abs(errorLeft - fieldLeft) > 1) {
        throw new Error('the error starts at ' + Math.round(errorLeft)
          + ', the address field at ' + Math.round(fieldLeft));
      }
      closeAddress();
      await frame();
      return text.slice(0, 60);
    });

    await check('preview: an empty file explains itself', async () => {
      clickRow('empty.txt');
      const node = await wait('the empty-file message', () => $('[data-testid=preview-unavailable]'), 20000);
      const text = node.textContent;
      if (/InvalidRange|not satisfiable/i.test(text)) {
        throw new Error('a protocol error leaked through: ' + text);
      }
      if (!/empty/i.test(text)) throw new Error('unhelpful message: ' + text);
      return text.trim().slice(0, 60);
    });

    await check('preview: a file with no extension is previewed as text', async () => {
      clickRow('LICENSE');
      const code = await wait('the text preview', () => $('[data-testid=preview-code]'), 20000);
      if (!code.textContent.includes('MIT License')) {
        throw new Error('LICENSE was not previewed: ' + code.textContent.slice(0, 80));
      }
      return 'no extension, still readable';
    });

    await check('preview: a .pub key is previewed as text', async () => {
      clickRow('deploy.pub');
      const code = await wait('the key preview', () => $('[data-testid=preview-code]'), 20000);
      if (!code.textContent.includes('ssh-ed25519')) {
        throw new Error('.pub was not previewed as text: ' + code.textContent.slice(0, 80));
      }
      return 'best-effort text for .pub';
    });

    await check('preview: PDF zoom changes the rendered page size', async () => {
      clickRow('document.pdf');
      const canvas = await wait('the rendered page', async () => {
        const node = $('[data-testid=preview-pdf]');
        return node && node.width > 0 ? node : null;
      }, 30000);
      const before = canvas.width;
      $('[data-testid=pdf-zoom-in]').click();
      const grew = await wait('the page to zoom in', async () => {
        const node = $('[data-testid=preview-pdf]');
        return node && node.width > before ? node.width : null;
      }, 10000);
      $('[data-testid=pdf-zoom-out]').click();
      const shrank = await wait('the page to zoom out', async () => {
        const node = $('[data-testid=preview-pdf]');
        return node && node.width < grew ? node.width : null;
      }, 10000);
      return before + ' → ' + grew + ' → ' + shrank + ' px';
    });

    await check('preview: Expand, Escape and Close give the list back', async () => {
      clickRow('readme.md');
      await wait('the rendered markdown', () => $('[data-testid=preview-markdown]'));
      const list = $('[data-testid=object-list]');
      const expand = () => $('[data-testid=preview-expand]');
      expand().click();
      await wait('the expanded preview', async () =>
        (expand().getAttribute('aria-pressed') === 'true' && list.offsetParent === null ? true : null));
      press(document.body, 'Escape');
      await wait('Escape to collapse it', async () =>
        (list.offsetParent !== null && expand().getAttribute('aria-pressed') === 'false' ? true : null));
      expand().click();
      await wait('the expanded preview again', async () =>
        (list.offsetParent === null ? true : null));
      $('[data-testid=preview-close]').click();
      await wait('Close to hide the panel', async () =>
        ($('#preview').hidden && $('[data-testid=toggle-preview]').getAttribute('aria-pressed') === 'false'
          ? true : null));
      $('[data-testid=toggle-preview]').click();
      await wait('the panel to come back', async () => (!$('#preview').hidden ? true : null));
      return 'expanded, Escape collapsed, Close hid the panel';
    });

    await check('preview: the header downloads without repeating the URI action', async () => {
      clickRow('sample.json');
      await wait('the JSON preview', () => $('[data-testid=preview-code]'));
      if ($('[data-testid=preview-copy-uri]')) {
        throw new Error('the Copy S3 URI button is back in the preview header');
      }
      $('[data-testid=preview-download]').click();
      const done = await wait('the panel download', async () => {
        const items = await invoke('transfer_progress');
        const finished = items.filter((item) =>
          item.state === 'done' && /Downloading/i.test(item.label) && /sample\.json/.test(item.label));
        return finished.length ? finished[finished.length - 1] : null;
      }, 60000);
      if (!done.resultPath) throw new Error('the panel download reported no destination');
      return String(done.resultPath).split('/').pop();
    });

    await check('preview: the panel can be hidden and shown again', async () => {
      $('[data-testid=toggle-preview]').click();
      if (!$('#preview') || !$('#preview').hidden && $('#preview')) {
        throw new Error('the panel did not hide; previewHidden=' + window.__s3viewer.state.ui.previewHidden
          + ' element=' + Boolean($('#preview')));
      }
      $('[data-testid=toggle-preview]').click();
      if ($('#preview').hidden) throw new Error('the panel did not come back');
      return 'toggled';
    });

    await check('preview: an auto-hidden panel fetches on reveal', async () => {
      clickRow('notes.txt');
      await wait('the text preview', () => $('[data-testid=preview-code]'), 20000);
      const ui = window.__s3viewer.state.ui;
      // Showing the panel by hand pauses the automatic rule until a wide-window
      // check clears it; the toggle in the previous check left that pause set.
      ui.clampLayoutToWindow();
      ui.setPreviewWidth(window.innerWidth);
      ui.clampLayoutToWindow();
      await wait('the automatic hide', async () => (ui.previewHidden ? true : null), 5000);

      // Pointing at an object while the panel is hidden must keep the key and
      // skip the fetch, not leave a stale preview behind.
      clickRow('sample.json');
      await frame();
      const objects = window.__s3viewer.state.objects;
      if (!objects.previewKey || !objects.previewKey.endsWith('sample.json')) {
        throw new Error('the hidden panel forgot the clicked key: ' + objects.previewKey);
      }
      if (objects.preview !== null) throw new Error('the hidden panel fetched anyway');

      ui.setPreviewWidth(420);
      ui.clampLayoutToWindow();
      await wait('the reveal', async () => (ui.previewHidden ? null : true), 5000);
      await wait('the deferred fetch', () => $('[data-testid=preview-code]'), 15000);
      const name = $('[data-testid=preview-name]').textContent.trim();
      if (name !== 'sample.json') throw new Error('the revealed panel shows ' + name);
      return 'deferred while hidden, fetched on reveal';
    });

    const folderName = 'e2e-folder-' + Date.now();
    await check('ops: create a folder, enter it, then delete it', async () => {
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      $('[data-testid=new-folder]').click();
      await wait('the folder prompt', () => $('[data-testid=prompt-input]'));
      setInput('[data-testid=prompt-input]', folderName);
      $('[data-testid=prompt-ok]').click();
      await wait('the new folder row', async () => (rowNames().includes(folderName) ? true : null));
      const row = clickRow(folderName);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await wait('the breadcrumb to follow', async () =>
        $('[data-testid=breadcrumb]').textContent.includes(folderName) ? true : null);
      $('[data-testid=crumb-root]').click();
      await wait('the root listing again', async () => (rowNames().includes(folderName) ? true : null));

      // A folder found by name opens from the keyboard too: ⌘F, type, Enter.
      // This is the find-and-open gesture that used to need the mouse.
      press(document.body, 'f', { metaKey: true });
      await frame();
      setInput('[data-testid=filter-input]', folderName);
      press($('[data-testid=filter-input]'), 'Enter');
      await wait('the folder to open from the filter', async () =>
        $('[data-testid=breadcrumb]').textContent.includes(folderName) ? true : null);
      if (document.activeElement !== $('[data-testid=object-list]')) {
        throw new Error('Enter left the keyboard in the filter field');
      }
      if ($('[data-testid=filter-input]').value !== '') {
        throw new Error('the filter stayed behind after opening the folder');
      }
      $('[data-testid=crumb-root]').click();
      await wait('the root listing again', async () => (rowNames().includes(folderName) ? true : null));

      // An edited address follows a navigation started somewhere else, and a
      // stale error goes with it (NAV-7). This is the frozen-editor case: the
      // error kept the editor open while the folder changed underneath it.
      press(document.body, 'l', { metaKey: true });
      const address = await wait('the address editor', () => $('[data-testid=address-input]'), 5000);
      address.value = 's3://' + window.__s3viewer.state.connections.active.bucket + '/'
        + __PREFIX__ + 'does-not-exist-' + Date.now();
      fire(address, 'input');
      press(address, 'Enter');
      await wait('the address error', () => $('[data-testid=address-error]'), 20000);
      const staleRow = clickRow(folderName);
      staleRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const expectedPrefix = __PREFIX__ + folderName + '/';
      // The breadcrumb is hidden while the editor is open, so the store is the
      // fact to wait on.
      await wait('the folder to open behind the editor', async () =>
        window.__s3viewer.state.objects.prefix === expectedPrefix ? true : null);
      const expected = 's3://' + window.__s3viewer.state.connections.active.bucket + '/'
        + __PREFIX__ + folderName + '/';
      if ($('[data-testid=address-input]').value !== expected) {
        throw new Error('the edited address froze at ' + $('[data-testid=address-input]').value
          + ' instead of ' + expected);
      }
      if ($('[data-testid=address-error]')) {
        throw new Error('the stale address error survived the navigation');
      }
      press($('[data-testid=address-input]'), 'Escape');
      await frame();
      $('[data-testid=crumb-root]').click();
      await wait('the root listing again', async () => (rowNames().includes(folderName) ? true : null));

      const opsMenu = await rowMenu(folderName);
      menuClick(opsMenu, 'Delete');
      const confirm = await wait('the confirmation', () => $('[data-testid=confirm-ok]'), 8000).catch(() => null);
      if (!confirm) {
        throw new Error('no confirmation appeared; selected=' + window.__s3viewer.state.selected.size);
      }
      confirm.click();
      try {
        // Keep the sum of this check's waits under the 90 s watchdog.
        await wait('the folder to disappear', async () => (rowNames().includes(folderName) ? null : true), 20000);
      } catch (error) {
        const progress = await invoke('transfer_progress');
        throw new Error(error.message + ' :: rows=' + rowNames().join(',')
          + ' transfers=' + JSON.stringify(progress).slice(0, 400));
      }
      return folderName + ' created and removed';
    });

    await check('ops: the filter narrows the listing', async () => {
      setInput('[data-testid=filter-input]', 'sample');
      // The input is debounced, so poll rather than assume the render happened.
      await wait('the filtered list', async () => ($$('.object-row').length === 2 ? true : null), 10000)
        .catch((error) => {
          throw new Error(error.message + ' :: rows=[' + rowNames().join(',')
            + '] filterValue=' + $('[data-testid=filter-input]').value
            + ' describe=' + JSON.stringify(window.__s3viewer.describe()).replace(/\s+/g, ''));
        });
      const names = rowNames();
      if (names.length !== 2) throw new Error('expected 2 rows, got ' + names.length + ': ' + names);
      if (!names.every((name) => name.includes('sample'))) {
        throw new Error('the filter leaked unrelated rows: ' + names.join(', '));
      }
      const totalFiles = window.__s3viewer.state.entries.filter((entry) => !entry.isFolder).length;
      const status = $('[data-testid=folder-status]').textContent;
      if (!new RegExp('0 folders · 2 of ' + totalFiles + ' files').test(status)) {
        throw new Error('the status does not report the filter: ' + status + ' (expected 2 of ' + totalFiles + ')');
      }

      // A filter with no matches must offer a way out, and that way must clear
      // the input as well as the store.
      setInput('[data-testid=filter-input]', 'zzz-no-match');
      await wait('the no-match state', () => $('[data-testid=clear-filter]'), 10000);
      const emptyText = $('[data-testid=empty-folder]').textContent;
      if (!/nothing matches the filter/i.test(emptyText)) {
        throw new Error('the no-match state reads: ' + emptyText.slice(0, 80));
      }
      $('[data-testid=clear-filter]').click();
      await wait('the cleared filter', async () => {
        const input = $('[data-testid=filter-input]');
        return input.value === '' && $$('.object-row').length >= 12 ? true : null;
      }, 10000);
      const clearedStatus = $('[data-testid=folder-status]').textContent;
      if (!new RegExp('0 folders · ' + totalFiles + ' files').test(clearedStatus)) {
        throw new Error('the cleared status reads: ' + clearedStatus);
      }
      return names.join(', ') + ' · ' + status;
    });

    await check('keyboard: the filter hands the keyboard to the matches', async () => {
      window.__s3viewer.state.objects.clearSelection();
      window.__s3viewer.state.objects.focus(null);
      await frame();
      press(document.body, 'f', { metaKey: true });
      await frame();
      const field = $('[data-testid=filter-input]');
      if (document.activeElement !== field) throw new Error('⌘F did not focus the filter field');

      // Type and commit in one gesture: the 120 ms debounce must not hand the
      // list the previous query, which would open the wrong row (KEY-4).
      setInput('[data-testid=filter-input]', 'notes');
      press(field, 'ArrowDown');
      await wait('the cursor to reach the match', async () => {
        const objects = window.__s3viewer.state.objects;
        return objects.focusedKey && objects.focusedKey.endsWith('notes.txt')
          && String(objects.previewKey).includes('notes.txt') ? true : null;
      }, 10000);
      const list = $('[data-testid=object-list]');
      if (document.activeElement !== list) {
        throw new Error('↓ left the keyboard in the filter field');
      }
      const active = list.getAttribute('aria-activedescendant');
      const cursor = $$('.object-row').find((row) => row.dataset.focused === 'true');
      if (!active || !cursor || active !== cursor.id) {
        throw new Error('the list has no active option after ↓: ' + active + ' / ' + (cursor && cursor.id));
      }

      // Escape backs out of the filter without leaving the text behind.
      press(document.body, 'f', { metaKey: true });
      await frame();
      press($('[data-testid=filter-input]'), 'Escape');
      await wait('the filter to clear', async () => {
        const input = $('[data-testid=filter-input]');
        return input.value === '' && window.__s3viewer.state.objects.filter === '' ? true : null;
      }, 5000);
      if (document.activeElement !== $('[data-testid=object-list]')) {
        throw new Error('Escape left the keyboard in the filter field');
      }
      if ($$('.object-row').length < 12) throw new Error('the filter did not come back off');
      return '↓ landed on ' + cursor.querySelector('.row-label').textContent
        + ' and previewed it; Escape cleared the filter';
    });

    await check('keyboard: a filtered-out cursor is inert', async () => {
      const objects = window.__s3viewer.state.objects;
      const list = $('[data-testid=object-list]');
      objects.clearSelection();
      const target = objects.visibleEntries.find((entry) => entry.name === 'notes.txt');
      if (!target) throw new Error('notes.txt is not in the listing');
      objects.focus(target.key);
      list.focus();
      setInput('[data-testid=filter-input]', 'sample');
      await wait('the filtered list', async () => ($$('.object-row').length === 2 ? true : null), 10000);
      press(list, ' ');
      await frame();
      if (objects.selected.size) {
        throw new Error('Space selected a row the filter hides');
      }
      if (list.getAttribute('aria-activedescendant')) {
        throw new Error('the hidden cursor still advertises an active descendant');
      }
      if (objects.deleteTargets.length) {
        throw new Error('Delete would act on a hidden row');
      }
      // The row menu must not offer row actions for a row that is not on screen.
      press(list, 'F10', { shiftKey: true });
      await frame();
      const menu = $('[data-testid=context-menu]');
      if (menu) {
        const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent.trim());
        if (labels.some((label) => label.startsWith('Copy S3 URI'))) {
          throw new Error('the keyboard menu offered row actions for a hidden row: ' + labels.join(' | '));
        }
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait('the menu to close', async () => ($('[data-testid=context-menu]') ? null : true), 4000);
      }
      setInput('[data-testid=filter-input]', '');
      await wait('the unfiltered list', async () => ($$('.object-row').length >= 12 ? true : null), 10000);
      objects.clearSelection();
      objects.focus(null);
      await frame();
      return 'Space, Delete and the menu ignored the hidden cursor';
    });

    await check('keyboard: Left and Right move between the columns', async () => {
      const list = $('[data-testid=object-list]');
      const activeId = window.__s3viewer.state.connections.activeId;
      list.focus();
      press(list, 'ArrowLeft');
      await frame();
      const card = $('[data-testid=connection-' + activeId + ']');
      if (!card) throw new Error('the active connection card is missing');
      if (document.activeElement !== card) {
        throw new Error('Left did not reach the connection column: '
          + (document.activeElement && document.activeElement.outerHTML || '').slice(0, 90));
      }

      // Right goes back to the main column.
      press(card, 'ArrowRight');
      await frame();
      if (document.activeElement !== list) {
        throw new Error('Right did not come back to the list');
      }

      // The list's cursor is its focus indicator; the stray pane ring is gone.
      press(list, 'ArrowDown');
      await frame();
      if (getComputedStyle(list).outlineStyle !== 'none') {
        throw new Error('the list still draws a focus ring: ' + getComputedStyle(list).outline);
      }
      // With no cursor there is nothing else to show focus with, so the list
      // draws its own inset ring instead of leaving the pane invisible.
      window.__s3viewer.state.objects.focus(null);
      await frame();
      if (getComputedStyle(list).outlineStyle === 'none') {
        throw new Error('the list has no focus indicator when the cursor is cleared');
      }

      // The visible Actions button opens the same menu as a right-click; it is
      // the reliable path where F10 is a media key.
      window.__s3viewer.state.objects.focus(window.__s3viewer.state.visible[0].key);
      await frame();
      const actions = $('[data-testid=row-actions]');
      if (!actions) throw new Error('the Actions button is missing while a cursor exists');
      actions.click();
      const actionsMenu = await wait('the Actions menu', () => $('[data-testid=context-menu]'), 5000);
      actionsMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait('the Actions menu to close', async () => ($('[data-testid=context-menu]') ? null : true), 4000);
      list.focus();
      await frame();

      // A checkbox is a control, not a text field: Space on select-all must not
      // reach the list and toggle the cursor row behind it.
      clickRow('notes.txt');
      await frame();
      const selectAll = $('[data-testid=select-all]');
      if (!selectAll) throw new Error('select-all is missing after selecting a row');
      const cursorBefore = window.__s3viewer.state.objects.focusedKey;
      selectAll.focus();
      press(selectAll, ' ');
      await frame();
      if (window.__s3viewer.state.objects.selected.size !== 1) {
        throw new Error('Space on select-all changed the row selection');
      }
      if (window.__s3viewer.state.objects.focusedKey !== cursorBefore) {
        throw new Error('Space on select-all moved the cursor');
      }
      // Clearing the last row unmounts the box that had focus; the keyboard
      // must land on the list, not on <body>.
      selectAll.focus();
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      await frame();
      if (document.activeElement !== list) {
        throw new Error('clearing the selection dropped focus off the list');
      }

      // Right again: the preview is a column of its own and can take the keyboard.
      if (window.__s3viewer.state.ui.previewHidden) {
        $('[data-testid=toggle-preview]').click();
        await frame();
      }
      press(list, 'ArrowRight');
      await frame();
      const body = $('[data-testid=preview-body]');
      if (!body) throw new Error('the preview body is missing while the panel is visible');
      // The column focuses the renderer's own scroller when there is one, so
      // "the preview has the keyboard" means inside it, not the body itself.
      if (!body.contains(document.activeElement)) {
        throw new Error('Right did not reach the preview column');
      }
      press(document.activeElement, 'ArrowLeft');
      await frame();
      if (document.activeElement !== list) {
        throw new Error('Left did not come back from the preview');
      }

      // Shift+F10 is the keyboard's right-click: the row menu opens on the cursor.
      const target = window.__s3viewer.state.visible[0];
      if (!target) throw new Error('the list is empty, so the keyboard menu cannot be probed');
      window.__s3viewer.state.objects.focus(target.key);
      list.focus();
      await frame();
      press(list, 'F10', { shiftKey: true });
      const menu = await wait('the keyboard row menu', () => $('[data-testid=context-menu]'), 5000);
      const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent.trim());
      for (const wanted of ['Preview', 'Download', 'Copy S3 URI', 'Delete']) {
        if (!labels.some((label) => label.startsWith(wanted))) {
          throw new Error('the keyboard menu is missing "' + wanted + '": ' + labels.join(' | '));
        }
      }
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait('the menu to close', async () => ($('[data-testid=context-menu]') ? null : true), 4000);
      if (document.activeElement !== list) {
        throw new Error('closing the menu did not restore the list');
      }
      return 'list ↔ connections ↔ preview, Shift+F10 menu, no pane ring';
    });

    await check('keyboard: range edges and viewport pages', async () => {
      const objects = window.__s3viewer.state.objects;
      const list = $('[data-testid=object-list]');
      objects.clearSelection();
      objects.focus(null);
      list.focus();
      const rows = objects.visibleEntries.length;
      press(list, 'End');
      await frame();
      if (objects.focusedKey !== objects.visibleEntries[rows - 1].key) {
        throw new Error('End did not land on the last row');
      }
      press(list, 'Home', { shiftKey: true });
      await frame();
      if (objects.selected.size !== rows) {
        throw new Error('Shift+Home from the last row selected ' + objects.selected.size
          + ' of ' + rows + ' rows');
      }

      // PageDown jumps by what is actually on screen, not by a fixed ten rows.
      objects.clearSelection();
      objects.focus(null);
      press(list, 'Home');
      await frame();
      press(list, 'PageDown');
      await frame();
      const landed = objects.visibleEntries.findIndex((entry) => entry.key === objects.focusedKey);
      const page = Math.max(1, Math.floor($('[data-testid=object-list]').clientHeight / 30) - 1);
      const expected = Math.min(rows - 1, page);
      if (landed !== expected) {
        throw new Error('PageDown landed on row ' + landed + ', expected ' + expected
          + ' (page size ' + page + ')');
      }
      objects.clearSelection();
      objects.focus(null);
      press(list, 'Escape');
      await frame();
      return 'Shift+Home covered ' + rows + ' rows, PageDown moved ' + page;
    });

    await check('keyboard: the copy and download shortcuts use the cursor row', async () => {
      const objects = window.__s3viewer.state.objects;
      objects.clearSelection();
      const target = objects.visibleEntries.find((entry) => entry.name === 'notes.txt');
      if (!target) throw new Error('notes.txt is not in the listing');
      objects.focus(target.key);
      const list = $('[data-testid=object-list]');
      list.focus();
      await frame();

      press(list, 'c', { shiftKey: true, metaKey: true });
      const toast = await wait('the URI toast', () =>
        $$('[data-testid^=toast-]').find((node) => /s3:\/\/.*notes\.txt/.test(node.textContent)), 8000);
      if (!toast) throw new Error('⌘⇧C did not copy the cursor row');
      if ($$('[data-testid^=toast-]').some((node) => /nothing to/i.test(node.textContent))) {
        throw new Error('⌘⇧C reported nothing to copy with a cursor row');
      }

      press(list, 'd', { metaKey: true });
      const download = await wait('the cursor-row download', async () => {
        const items = await invoke('transfer_progress');
        return items.find((item) => /Downloading.*notes\.txt/i.test(item.label)) ?? null;
      }, 15000);
      objects.clearSelection();
      await frame();
      return 'copied and downloaded ' + target.name + ' with no selection';
    });

    await check('ops: the boto3 snippet copies to the clipboard', async () => {
      $('#new-connection').click();
      await wait('the form', () => $('[data-testid=boto3-snippet]'));
      const copied = await window.__s3viewer.copySnippet();
      await closeModal();
      if (!copied) throw new Error('clipboard write failed');
      return 'copied';
    });

    await check('transfer: download writes the exact object bytes', async () => {
      const outcome = await invoke('e2e_transfer_check');
      if (!outcome.match) {
        throw new Error('bytes differ (local ' + outcome.localSize + ', remote ' + outcome.remoteSize + ')');
      }
      return outcome.localSize + ' bytes identical';
    });

    await check('transfer: upload and delete round-trip through the UI commands', async () => {
      const outcome = await invoke('e2e_roundtrip_check');
      if (!outcome.uploaded) throw new Error('the upload did not produce the object');
      if (!outcome.deleted) throw new Error('the delete did not remove the object');
      return 'uploaded and removed ' + outcome.size + ' bytes';
    });

    await check('transfer: the Download button queues a download', async () => {
      const downloadMenu = await rowMenu('image.png');
      menuClick(downloadMenu, 'Download');
      const settled = await wait('the download to finish', async () => {
        const items = await invoke('transfer_progress');
        const done = items.filter((item) => item.state === 'done' && /Downloading/i.test(item.label));
        return done.length ? done[0] : null;
      }, 60000);
      if (!settled.resultPath) throw new Error('no destination reported');
      return String(settled.resultPath).split('/').pop();
    });

    // Immediately after a download the panel must exist, so this is not the
    // vacuous "no panel left open" pass it used to be.
    await check('transfer: a finished download hides itself', async () => {
      await wait('the transfer panel', () => $('[data-testid=transfers]'), 8000);
      await wait('the finished transfer to disappear', async () =>
        ($('[data-testid=transfer-done]') ? null : true), 20000);
      return 'cleared without pressing Clear';
    });

    await check('transfer: multi-object delete removes markers and children', async () => {
      const outcome = await invoke('e2e_delete_many_check');
      if (outcome.remaining.length) {
        throw new Error('left behind ' + JSON.stringify(outcome.remaining)
          + ' after deleting ' + JSON.stringify(outcome.keys));
      }
      if (outcome.parentExists) throw new Error('the folder marker survived the batch delete');
      if (outcome.childExists) throw new Error('the nested folder marker survived the batch delete');
      if (outcome.keys.length < 2) {
        throw new Error('the expansion did not include the nested marker: ' + JSON.stringify(outcome.keys));
      }
      return outcome.keys.length + ' keys deleted, none left';
    });

    await check('transfer: copy duplicates an object inside the bucket', async () => {
      const copyMenu = await rowMenu('notes.txt');
      menuClick(copyMenu, 'Copy to');
      const prefixInput = await wait('the copy dialog', () => $('[data-testid=transfer-prefix]'), 10000);
      const destination = __PREFIX__ + 'copies/';
      prefixInput.value = destination;
      prefixInput.dispatchEvent(new Event('input', { bubbles: true }));
      $('[data-testid=transfer-confirm]').click();
      const outcome = await wait('the transfer to settle', async () => {
        const items = await invoke('transfer_progress');
        const done = items.filter((item) => item.state !== 'running' && /Copying|Moving/i.test(item.label));
        return done.length ? done[0] : null;
      }, 60000);
      if (outcome.state !== 'done') throw new Error('copy failed: ' + outcome.error);
      // Verify through the API that the object exists, then remove it again.
      const listing = await invoke('list_objects', { input: { connectionId, prefix: destination } });
      const copied = listing.entries.find((entry) => (entry.name || '').indexOf('notes') === 0);
      if (!copied) throw new Error('the copy is not on S3: ' + JSON.stringify(listing.entries.map((e) => e.name)));
      await invoke('delete_objects', { input: { connectionId, keys: [copied.key] } });
      return 'copied and cleaned up ' + copied.name;
    });

    await check('transfer: Copy refuses the current folder and Move leaves no source', async () => {
      // The previous copy reloads the listing in the background; queue nothing
      // against a list that is still painting.
      await wait('the listing to settle', async () => {
        const objects = window.__s3viewer.state.objects;
        if (objects.loading || objects.awaitingFirstPage) return null;
        return rowNames().length >= 12 ? true : null;
      }, 20000);
      if ($('[data-testid=modal]')) await closeModal();
      await clickRowWhenReady('sample.py');
      // A single row's actions live in its context menu, not in the toolbar.
      const copyMenu = await rowMenu('sample.py');
      menuClick(copyMenu, 'Copy to');
      const input = await wait('the copy dialog', () => $('[data-testid=transfer-prefix]'), 10000);
      if ($('[data-testid=transfer-confirm]').disabled) throw new Error('Copy starts disabled');
      input.value = __PREFIX__;
      fire(input, 'input');
      await wait('the same-folder guard', async () =>
        ($('[data-testid=transfer-confirm]').disabled ? true : null), 5000);
      if (!/current folder/i.test($('[data-testid=modal]').textContent)) {
        throw new Error('the guard does not explain itself: ' + $('[data-testid=modal]').textContent.slice(0, 100));
      }
      await closeModal();

      await clickRowWhenReady('sample.py');
      const moveMenu = await rowMenu('sample.py');
      menuClick(moveMenu, 'Move to');
      const dest = await wait('the move dialog', () => $('[data-testid=transfer-prefix]'), 10000);
      dest.value = __PREFIX__ + 'moved/';
      fire(dest, 'input');
      $('[data-testid=transfer-confirm]').click();
      const outcome = await wait('the move to finish', async () => {
        const items = await invoke('transfer_progress');
        const done = items.filter((item) => item.state !== 'running' && /Moving/i.test(item.label));
        return done.length ? done[done.length - 1] : null;
      }, 60000);
      if (outcome.state !== 'done') throw new Error('move failed: ' + outcome.error);
      await wait('the moved key on S3', async () => {
        const listing = await invoke('list_objects', {
          input: { connectionId, prefix: __PREFIX__ + 'moved/' },
        });
        return listing.entries.some((entry) => entry.key === __PREFIX__ + 'moved/sample.py')
          ? true
          : null;
      }, 30000);
      $('[data-testid=refresh]').click();
      await wait('the source row to leave', async () => {
        const objects = window.__s3viewer.state.objects;
        if (objects.loading || objects.awaitingFirstPage) return null;
        return rowNames().includes('sample.py') ? null : true;
      }, 20000);
      await invoke('delete_objects', {
        input: { connectionId, keys: [__PREFIX__ + 'moved/sample.py', __PREFIX__ + 'moved/'] },
      });
      $('[data-testid=refresh]').click();
      await wait('the cleanup listing to settle', async () =>
        (window.__s3viewer.state.objects.loading ? null : true), 20000);
      return 'guard blocked the current folder; Move left no source';
    });

    await check('transfer: progress reporting is wired', async () => {
      const items = await invoke('transfer_progress');
      if (!Array.isArray(items)) throw new Error('transfer_progress did not return a list');
      const download = items.find((item) =>
        item.state === 'done' && /Downloading/i.test(item.label) && item.resultPath);
      if (!download) {
        throw new Error('the finished download is not tracked with a destination: '
          + JSON.stringify(items.slice(-3)));
      }
      return items.length + ' tracked transfer(s), last at ' + download.resultPath.split('/').pop();
    });

    await check('transfer: upload conflicts offer Skip, Replace and Cancel', async () => {
      const key = __PREFIX__ + 's3-creds.json';
      await invoke('save_text_object', {
        input: { connectionId, key, content: 'ORIGINAL', contentType: 'application/json' },
      });
      const read = async () => {
        const preview = await invoke('get_preview', { input: { connectionId, key } });
        return preview.text || '';
      };

      // Uploading the fixture file collides with the object created above.
      void window.__s3viewer.queueUploads([__IMPORT_FILE__]);
      const modal = await wait('the conflict dialog', () => $('[data-testid=upload-conflict-skip]'), 15000);
      const text = $('[data-testid=modal]').textContent;
      if (!/already exist/i.test(text) || !/s3-creds\.json/.test(text)) {
        throw new Error('the conflict dialog does not name the collision: ' + text.slice(0, 120));
      }
      $('[data-testid=upload-conflict-skip]').click();
      await wait('the dialog to close', async () => ($('[data-testid=upload-conflict-skip]') ? null : true), 10000);
      // Skipped files do not necessarily get a progress entry; the content is
      // the observable that matters.
      await sleep(800);
      if ((await read()) !== 'ORIGINAL') throw new Error('Skip overwrote the object');

      window.__s3viewerE2EUpload = 'pending';
      void window.__s3viewer.queueUploads([__IMPORT_FILE__]).then(
        () => { window.__s3viewerE2EUpload = 'resolved'; },
        (error) => { window.__s3viewerE2EUpload = 'rejected: ' + (error.message || error); },
      );
      await wait('the second conflict', () => $('[data-testid=upload-conflict-replace]'), 15000);
      $('[data-testid=upload-conflict-replace]').click();
      await wait('the replacement to land', async () => {
        const body = await read();
        return body.includes('import-fixture-bucket') ? true : null;
      }, 30000).catch(async (error) => {
        const items = await invoke('transfer_progress');
        const listing = await invoke('list_objects', {
          input: { connectionId, prefix: __PREFIX__ },
        });
        let body = 'unreadable';
        try { body = (await read()).slice(0, 60); } catch (readError) { body = String(readError.message); }
        throw new Error(error.message
          + ' :: uploads=' + JSON.stringify(items.filter((item) => /Uploading|Skipped/.test(item.label)).slice(-4))
          + ' promise=' + window.__s3viewerE2EUpload
          + ' toasts=' + JSON.stringify($$('[data-testid^=toast-]').map((node) => node.textContent).slice(-3))
          + ' errors=' + JSON.stringify((window.__s3viewerErrors || []).slice(-3))
          + ' keys=' + listing.entries.map((entry) => entry.key).filter((key) => key.includes('s3-creds')).join('|')
          + ' body=' + body);
      });
      const replaced = await read();

      void window.__s3viewer.queueUploads([__IMPORT_FILE__]);
      await wait('the third conflict', () => $('[data-testid=upload-conflict-cancel]'), 15000);
      $('[data-testid=upload-conflict-cancel]').click();
      await wait('the dialog to close', async () => ($('[data-testid=upload-conflict-cancel]') ? null : true), 10000);
      await sleep(500);
      if ((await read()) !== replaced) throw new Error('Cancel changed the object');

      await invoke('delete_objects', { input: { connectionId, keys: [key] } });
      $('[data-testid=refresh]').click();
      await wait('the listing after the conflict probe', async () =>
        (window.__s3viewer.state.objects.loading ? null : true), 20000);
      return 'Skip kept, Replace wrote, Cancel left ' + replaced.length + ' bytes';
    });

    await check('security: secrets are sealed on disk, never in the clear', async () => {
      const status = await invoke('e2e_config_audit');
      if (!status.sealed) throw new Error('the stored secret is not sealed');
      if (status.containsSecret) throw new Error('THE SECRET LEAKED INTO config.json');
      // The access key id is not a secret and is stored in the clear by design.
      if (status.mode !== '600') throw new Error('config.json mode is ' + status.mode + ', expected 600');
      if (status.dirMode !== '700') throw new Error('the config dir mode is ' + status.dirMode + ', expected 700');
      return 'sealed, file ' + status.mode + ', dir ' + status.dirMode;
    });

    await check('security: read-only mode blocks an upload', async () => {
      const outcome = await invoke('e2e_readonly_check');
      if (!outcome.blocked) throw new Error('read-only mode did not block the upload');
      if (!/read-only/i.test(outcome.message)) throw new Error('unexpected error: ' + outcome.message);
      return outcome.message;
    });

    await check('security: the permission probe reports read-write', async () => {
      const caps = await invoke('detect_capabilities', { id: connectionId });
      if (!caps.canList || !caps.canRead) throw new Error('listing or reading is denied: ' + JSON.stringify(caps));
      if (!caps.canWrite || !caps.canDelete) throw new Error('write or delete is denied: ' + JSON.stringify(caps));
      return 'list/read/write/delete all granted';
    });

    await check('connection: one button tests the connection and its permissions', async () => {
      $('#new-connection').click();
      await wait('the connection dialog', () => $('[data-testid=conn-test]'), 10000);
      if ($('[data-testid=conn-detect]')) {
        throw new Error('the separate Detect permissions button is back');
      }
      const dialog = $('[data-testid=modal]');
      const text = dialog.textContent;
      // Labels describe the setting; they do not point at another tool's API.
      if (/boto3:/i.test(text)) {
        throw new Error('a field still refers to boto3: ' + text.match(/[^.]*boto3:[^.]*/i)[0].slice(0, 80));
      }
      const testButtons = Array.from(dialog.querySelectorAll('button'))
        .filter((button) => /test connection/i.test(button.textContent));
      if (testButtons.length !== 1) {
        throw new Error('expected exactly one Test connection button, found ' + testButtons.length);
      }

      // A button count is not a test. Fill the form and press it.
      setInput('[data-testid=conn-name]', 'probe probe');
      setInput('[data-testid=conn-endpoint]', __ENDPOINT__);
      setInput('[data-testid=conn-region]', __REGION__);
      setInput('[data-testid=conn-access-key]', __ACCESS__);
      setInput('[data-testid=conn-bucket]', __BUCKET__);
      setInput('[data-testid=conn-secret-key]', __SECRET__);
      $('[data-testid=conn-test]').click();
      const output = await wait('the probe result', () => $('[data-testid=probe-output]'), 45000)
        .catch((error) => {
          throw new Error(error.message + ' :: error='
            + (($('[data-testid=probe-error]') || {}).textContent || 'none'));
        });
      const rights = Array.from(output.querySelectorAll('.text-ok')).map((chip) => chip.textContent.trim());
      for (const wanted of ['list', 'read', 'write', 'delete']) {
        if (!rights.some((label) => label.includes(wanted))) {
          throw new Error('the probe did not grant ' + wanted + ': ' + rights.join(', '));
        }
      }

      // A wrong secret must produce a readable denial, not a stuck spinner or
      // "[object Object]".
      setInput('[data-testid=conn-secret-key]', 'definitely-not-the-secret');
      $('[data-testid=conn-test]').click();
      const failure = await wait('the denied probe', () => $('[data-testid=probe-error]'), 45000);
      const message = failure.textContent.trim();
      if (!message || /\[object Object\]/.test(message)) {
        throw new Error('unreadable probe failure: ' + message.slice(0, 120));
      }
      if ($('[data-testid=probe-output]')) throw new Error('the old probe result survived a failure');
      await closeModal();
      return 'four rights, then a readable denial (' + message.replace(/\s+/g, ' ').slice(0, 60) + ')';
    });

    await check('connection: copying the snippet confirms on the button', async () => {
      // Open a fresh dialog: depending on the probe dialog left open by the
      // previous check made one failure poison every later check.
      $('#new-connection').click();
      await wait('the connection dialog', () => $('[data-testid=copy-snippet]'), 10000);
      const copy = $('[data-testid=copy-snippet]');
      copy.click();
      const confirmed = await wait('the button to confirm', async () => {
        const button = $('[data-testid=copy-snippet]');
        return button && /copied/i.test(button.textContent) ? button.textContent.trim() : null;
      }, 8000).catch(async (error) => {
        const toasts = $$('[data-testid^=toast-]').map((node) => node.textContent).join(' | ');
        throw new Error(error.message + ' :: toasts=' + toasts);
      });
      await closeModal();
      return 'button said "' + confirmed + '"';
    });

    await check('connection: the card menu duplicates and removes without opening', async () => {
      const connections = window.__s3viewer.state.connections;
      const original = connections.activeId;
      $('[data-testid=connection-menu-' + original + ']').click();
      let menu = await wait('the connection menu', () => $('[data-testid=context-menu]'), 8000);
      const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent.trim());
      for (const wanted of ['Open', 'Edit connection', 'Duplicate', 'Copy bucket URI', 'Remove connection']) {
        if (!labels.some((label) => label.startsWith(wanted))) {
          throw new Error('the connection menu is missing "' + wanted + '": ' + labels.join(' | '));
        }
      }
      menuClick(menu, 'Duplicate');
      const copy = await wait('the duplicated card', () =>
        connections.all.find((connection) => connection.name.endsWith('(copy)')), 10000);
      if (connections.activeId !== original) throw new Error('Duplicate activated the copy');

      // Right-click opens the menu; it must not open the connection.
      const card = await wait('the copied card', () =>
        $('[data-testid=connection-' + copy.id + ']'), 8000);

      // Shift+F10 is the keyboard's right-click on a card too (the collapsed
      // rail has no visible ⋯ at all).
      card.focus();
      press(card, 'F10', { shiftKey: true });
      const cardMenu = await wait('the connection menu from the keyboard',
        () => $('[data-testid=context-menu]'), 5000);
      const cardLabels = Array.from(cardMenu.querySelectorAll('button'))
        .map((button) => button.textContent.trim());
      if (!cardLabels.some((label) => label.startsWith('Open'))) {
        throw new Error('Shift+F10 opened the wrong menu: ' + cardLabels.join(' | '));
      }
      cardMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait('the menu to close', async () => ($('[data-testid=context-menu]') ? null : true), 4000);

      // The connection column is a keyboard list: Down/Up walk the cards, Enter
      // (the click a focused button receives natively) opens one, Right hands
      // the keyboard back to the object list.
      const originalCard = $('[data-testid=connection-' + original + ']');
      originalCard.focus();
      press(originalCard, 'ArrowDown');
      await frame();
      if (document.activeElement !== card) {
        throw new Error('Down did not move to the next connection');
      }
      press(card, 'ArrowUp');
      await frame();
      if (document.activeElement !== originalCard) {
        throw new Error('Up did not move back to the first connection');
      }
      card.focus();
      card.click();
      await wait('the copy to become active', async () =>
        (connections.activeId === copy.id ? true : null), 15000);
      press(card, 'ArrowRight');
      await frame();
      if (document.activeElement !== $('[data-testid=object-list]')) {
        throw new Error('Right did not leave the connection column');
      }
      // Back to the original before the removal assertions below.
      originalCard.focus();
      originalCard.click();
      await wait('the original connection again', async () =>
        (connections.activeId === original ? true : null), 15000);
      const box = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(box.left + 20),
        clientY: Math.round(box.top + 20),
      }));
      menu = await wait('the copy menu', () => $('[data-testid=context-menu]'), 8000);
      if (connections.activeId !== original) throw new Error('right-click activated the copy');

      menuClick(menu, 'Remove connection');
      const confirm = await wait('the removal confirmation', () => $('[data-testid=confirm-ok]'), 8000);
      const wording = $('[data-testid=confirm-message]').textContent;
      if (!/unaffected/i.test(wording)) throw new Error('removal wording lost the bucket note: ' + wording);
      confirm.click();
      await wait('the copy card to disappear', async () =>
        (connections.all.some((connection) => connection.id === copy.id) ? null : true), 10000);
      if (connections.activeId !== original) throw new Error('removing the copy changed the active connection');
      return 'menu items, duplicate, right-click inert, removed';
    });

    await check('dialogs: focus is trapped, the shell is inert and shortcuts stay out', async () => {
      // A real click focuses the trigger first; JS .click() alone does not, and
      // then the focus-restore assertion would test the harness, not the app.
      const trigger = $('[data-testid=open-settings]');
      trigger.focus();
      trigger.click();
      const modal = await wait('the settings dialog', () => $('[data-testid=modal]'), 10000);
      const title = $('[data-testid=modal-title]').textContent.trim();
      if (title !== 'Settings') throw new Error('unexpected dialog: ' + title);
      const shell = $('[data-app-shell]');
      if (!shell || !shell.hasAttribute('inert')) {
        throw new Error('the shell behind the modal is not inert');
      }
      if ($('[data-testid=modal-root]').parentElement !== document.body) {
        throw new Error('the modal is rendered inside the inert shell');
      }
      const limit = await wait('the autofocused field', () => $('[data-testid=settings-preview-limit]'), 5000);
      if (document.activeElement !== limit) {
        throw new Error('the dialog did not focus its first control');
      }

      // A global shortcut must not stack another dialog or act on the shell.
      press(document.activeElement, 'n', { metaKey: true });
      await frame();
      const open = $$('[data-testid=modal]').filter((node) => node.offsetParent !== null);
      if (open.length !== 1) throw new Error('⌘N opened a dialog behind the modal: ' + open.length);
      if ($('[data-testid=modal-title]').textContent.trim() !== title) {
        throw new Error('⌘N replaced the dialog');
      }
      press(document.activeElement, 'r', { metaKey: true });
      await frame();
      if ($$('[data-testid=modal]').filter((node) => node.offsetParent !== null).length !== 1) {
        throw new Error('⌘R acted behind the modal');
      }

      // Tab from the last control wraps inside the dialog; Shift+Tab wraps back.
      $('[data-testid=settings-save]').focus();
      press(document.activeElement, 'Tab');
      await frame();
      if (!modal.contains(document.activeElement)) {
        throw new Error('Tab escaped the dialog to ' + document.activeElement.tagName);
      }
      $('[data-testid=modal-close]').focus();
      press(document.activeElement, 'Tab', { shiftKey: true });
      await frame();
      if (!modal.contains(document.activeElement)) {
        throw new Error('Shift+Tab escaped the dialog');
      }

      $('[data-testid=modal-close]').click();
      await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 8000);
      if (shell.hasAttribute('inert')) throw new Error('the shell stayed inert after closing');
      await wait('focus to return', async () =>
        (document.activeElement === $('[data-testid=open-settings]') ? true : null), 5000);
      return 'inert shell, focus trap both ways, ⌘N/⌘R blocked, focus restored';
    });

    await check('ui: toasts are announced and keep line breaks', async () => {
      window.__s3viewer.toasts.error('first line\nsecond line', 'E2E toast');
      const toast = await wait('the error toast', () => $('[data-testid=toast-error]'), 8000);
      if (toast.getAttribute('role') !== 'alert') {
        throw new Error('an error toast is not role=alert: ' + toast.getAttribute('role'));
      }
      const stack = $('[data-testid=toasts]');
      if (!stack || stack.getAttribute('aria-live') !== 'polite') {
        throw new Error('the toast stack has no aria-live region');
      }
      const message = Array.from(toast.querySelectorAll('p'))
        .find((node) => node.textContent.includes('first line'));
      if (!message || !/first line\nsecond line/.test(message.textContent)) {
        throw new Error('the newline was lost: ' + (message || {}).textContent);
      }
      if (getComputedStyle(message).whiteSpace !== 'pre-line') {
        throw new Error('the message does not preserve line breaks visually');
      }
      return 'role=alert, aria-live=polite, pre-line';
    });

    await check('settings: the theme follows the system and persists', async () => {
      const setTheme = async (value) => {
        $('[data-testid=open-settings]').click();
        const select = await wait('the settings dialog', () => $('[data-testid=settings-theme]'), 10000);
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        $('[data-testid=settings-save]').click();
        await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 10000);
      };
      await setTheme('system');
      const expected = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (document.documentElement.dataset.theme !== expected) {
        throw new Error('system theme resolved to ' + document.documentElement.dataset.theme
          + ', expected ' + expected);
      }
      if (localStorage.getItem('s3viewer.theme') !== 'system') {
        throw new Error('the pre-paint theme mirror was not updated: ' + localStorage.getItem('s3viewer.theme'));
      }
      await setTheme('light');
      if (document.documentElement.dataset.theme !== 'light') throw new Error('light did not apply');
      await setTheme('dark');
      if (document.documentElement.dataset.theme !== 'dark') throw new Error('dark did not apply');
      return 'system → ' + expected + ', light and dark applied, mirrored for pre-paint';
    });

    await check('settings: downloads can ask for a destination every time', async () => {
      $('[data-testid=open-settings]').click();
      const toggle = await wait('the ask-location setting', () => $('[data-testid=settings-ask-location]'), 10000);
      // The folder picker is an icon: a label next to the path field did not fit.
      const choose = $('[data-testid=settings-choose-dir]');
      if (!choose) throw new Error('the folder picker is missing');
      if ((choose.textContent || '').trim()) {
        throw new Error('the folder picker still has a label: "' + choose.textContent.trim() + '"');
      }
      if (!choose.querySelector('svg')) throw new Error('the folder picker has no icon');
      const before = toggle.checked;
      toggle.click();
      await frame();
      $('[data-testid=settings-save]').click();
      await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 10000);

      $('[data-testid=open-settings]').click();
      const reopened = await wait('the setting to persist', () => $('[data-testid=settings-ask-location]'), 10000);
      if (reopened.checked === before) throw new Error('the setting did not persist');
      // Put it back the way it was.
      reopened.click();
      await frame();
      $('[data-testid=settings-save]').click();
      await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 10000);
      return 'toggled and persisted';
    });

    await check('settings: the dialog saves a new preview limit', async () => {
      $('[data-testid=open-settings]').click();
      const select = await wait('the settings dialog', () => $('[data-testid=settings-preview-limit]'), 15000);
      const chosen = Array.from(select.options)
        .map((option) => option.value)
        .find((value) => value !== select.value);
      if (!chosen) throw new Error('no alternative preview limit to choose');
      select.value = chosen;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      $('[data-testid=settings-save]').click();
      await wait('the dialog to close', async () => !$('[data-testid=modal]'), 15000).catch((error) => {
        throw new Error(error.message
          + ' :: toasts=[' + $$('[data-testid^=toast-]').map((n) => n.textContent).join(' | ') + ']'
          + ' modalTitle=' + (($('[data-testid=modal-title]') || {}).textContent || 'none'));
      });
      const stored = await invoke('get_settings');
      if (String(stored.previewMaxBytes) !== String(chosen)) {
        throw new Error('the limit was not saved: wanted ' + chosen + ', stored ' + stored.previewMaxBytes);
      }
      // Put it back so later checks see the documented default.
      const settings = await invoke('get_settings');
      settings.previewMaxBytes = 1048576;
      await invoke('update_settings', { settings });
      return 'saved and restored ' + chosen + ' B';
    });

    await check('settings: the list limit truncates the listing and says so', async () => {
      // A failure below must not leave the 3-file limit in place for every
      // later check, which is exactly what happened once.
      try {
        $('[data-testid=open-settings]').click();
        await wait('the settings dialog', () => $('[data-testid=settings-list-limit]'), 10000);
        setInput('[data-testid=settings-list-limit]', '3');
        $('[data-testid=settings-save]').click();
        await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 10000);

        $('[data-testid=refresh]').click();
        const fileCount = () =>
          window.__s3viewer.state.objects.visibleEntries.filter((entry) => !entry.isFolder).length;
        await wait('the truncated listing', async () => {
          const objects = window.__s3viewer.state.objects;
          if (objects.loading || objects.awaitingFirstPage) return null;
          return objects.truncated && fileCount() === 3 ? true : null;
        }, 30000).catch((error) => {
          throw new Error(error.message + ' :: rows=' + rowNames().join(',')
            + ' files=' + fileCount()
            + ' truncated=' + window.__s3viewer.state.objects.truncated);
        });
        const banner = $('[data-testid=truncation-banner]');
        if (!banner) throw new Error('no truncation banner');
        if (!/truncated at 3/i.test(banner.textContent)) {
          throw new Error('the banner does not name the limit: ' + banner.textContent);
        }
        if (!/truncated/.test($('[data-testid=folder-status]').textContent)) {
          throw new Error('the status line hides the truncation');
        }

        // Retry keeps the same limit and the same three files.
        $('[data-testid=truncation-retry]').click();
        await wait('the retried listing', async () => {
          const objects = window.__s3viewer.state.objects;
          return !objects.loading && !objects.awaitingFirstPage && fileCount() === 3 ? true : null;
        }, 30000);

        $('[data-testid=truncation-settings]').click();
        await wait('the settings dialog from the banner', () => $('[data-testid=settings-list-limit]'), 10000);
        setInput('[data-testid=settings-list-limit]', '20000');
        $('[data-testid=settings-save]').click();
        await wait('the dialog to close', async () => ($('[data-testid=modal]') ? null : true), 10000);
        $('[data-testid=refresh]').click();
        await wait('the restored listing', async () => {
          const objects = window.__s3viewer.state.objects;
          return !objects.loading && !objects.truncated && fileCount() >= 12 ? true : null;
        }, 30000);
        if ($('[data-testid=truncation-banner]')) throw new Error('the banner survived the restore');
      } finally {
        const settings = await invoke('get_settings');
        if (settings.listPageLimit !== 20000) {
          settings.listPageLimit = 20000;
          await invoke('update_settings', { settings });
        }
        if ($('[data-testid=modal]')) {
          await closeModal().catch(() => {});
        }
        $('[data-testid=refresh]')?.click();
        await sleep(500);
      }
      return '3 files + banner, Retry stable, restored 17';
    });

    await check('settings: the preview limit is exposed and configurable', async () => {
      const settings = await invoke('get_settings');
      if (typeof settings.previewMaxBytes !== 'number' || settings.previewMaxBytes <= 0) {
        throw new Error('no preview limit in settings');
      }
      const security = await invoke('security_status');
      if (!security.configPath) throw new Error('no config path reported');
      // The run must stay in its throwaway directory and must never unlock the
      // developer's login keychain.
      if (__CONFIG_DIR__ && !security.configPath.startsWith(__CONFIG_DIR__)) {
        throw new Error('the run is using ' + security.configPath + ', not the isolated config dir');
      }
      if (security.masterKeyInKeychain) {
        throw new Error('the run read the master key from the login keychain');
      }
      return 'limit ' + settings.previewMaxBytes + ' B, isolated config';
    });

    await check('import: the dialog imports, opens and removes a connection', async () => {
      if ($('[data-testid=modal]')) await closeModal();
      $('[data-testid=import-connections]').click();
      const area = await wait('the import dialog', () => $('[data-testid=import-textarea]'), 10000);
      if (!$('[data-testid=import-confirm]').disabled) {
        throw new Error('Import is enabled with nothing pasted');
      }
      const payload = {};
      payload['E2E imported'] = {
        access_key: __ACCESS__,
        secret_key: __SECRET__,
        endpoint: __ENDPOINT__,
        region: __REGION__,
        bucket: __BUCKET__,
        prefix: __PREFIX__,
      };
      area.value = JSON.stringify(payload, null, 2);
      fire(area, 'input');
      await wait('the parsed preview', () => {
        const preview = $('[data-testid=import-preview]');
        return preview && /E2E imported/.test(preview.textContent) ? true : null;
      }, 10000);
      const confirm = $('[data-testid=import-confirm]');
      if (confirm.disabled) throw new Error('Import stayed disabled after a valid paste');
      confirm.click();
      await wait('the dialog to close', async () =>
        ($('[data-testid=import-textarea]') ? null : true), 15000);
      await wait('the imported session', async () => {
        const crumb = $('[data-testid=crumb-root]');
        return crumb && crumb.textContent.includes('E2E imported') ? true : null;
      }, 30000).catch((error) => {
        throw new Error(error.message + ' :: cards=['
          + $$('#connection-list button[data-testid^="connection-"]').map((c) => c.textContent.trim()).join(' | ') + ']');
      });
      const imported = window.__s3viewer.state.connections.all.find((c) => c.name === 'E2E imported');
      if (!imported) throw new Error('the imported connection is not in the sidebar');
      const menuButton = $('[data-testid=connection-menu-' + imported.id + ']');
      if (!menuButton) throw new Error('the imported card has no menu');
      menuButton.click();
      const menu = await wait('the connection menu', () => $('[data-testid=context-menu]'), 8000);
      menuClick(menu, 'Remove connection');
      const confirmRemove = await wait('the removal confirmation', () => $('[data-testid=confirm-ok]'), 8000);
      const wording = $('[data-testid=confirm-message]').textContent;
      if (!/unaffected/i.test(wording)) {
        throw new Error('the removal does not say the bucket is untouched: ' + wording);
      }
      confirmRemove.click();
      await wait('the card to disappear', async () => {
        const cards = $$('#connection-list button[data-testid^="connection-"]')
          .filter((c) => c.textContent.includes('E2E imported'));
        return cards.length ? null : true;
      }, 10000);
      const original = window.__s3viewer.state.connections.all.find((c) => c.name === connectionName);
      const card = await wait('the original card', () =>
        $('[data-testid=connection-' + original.id + ']'), 8000);
      card.click();
      await wait('the original session', async () => (rowNames().length >= 12 ? true : null), 30000)
        .catch((error) => {
          const state = window.__s3viewer.state;
          throw new Error(error.message + ' :: active=' + state.connections.activeId
            + ' prefix=' + JSON.stringify(state.objects.prefix)
            + ' loading=' + state.objects.loading
            + ' error=' + (state.objects.error || 'none')
            + ' limit=' + (window.__s3viewer.state.ui.settings || {}).listPageLimit
            + ' rows=' + rowNames().join(','));
        });
      return 'pasted, imported, opened, removed; original restored';
    });
  } catch (error) {
    REPORT.push({
      name: 'scenario crashed',
      ok: false,
      detail: String((error && error.message) || error),
      stack: String((error && error.stack) || '').split('\n').slice(0, 6),
      ms: 0,
    });
  }

  publish(true);
})();

// Safety net: flush the partial report every 10s even if a check hangs.
setInterval(() => {
  if (window.__S3VIEWER_E2E_REPORT && !window.__S3VIEWER_E2E_REPORT.final) {
    window.__TAURI__ && window.__TAURI__.core.invoke('e2e_report', {
      report: JSON.stringify(window.__S3VIEWER_E2E_REPORT),
    });
  }
}, 10000);"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> TestPlan {
        TestPlan {
            bucket: "dev-bucket".into(),
            prefix: "_s3viewer-e2e/".into(),
            endpoint: "https://s3.example.com".into(),
            region: "us-east-1".into(),
            access_key: "AKIATEST".into(),
            secret_key: "SECRETTEST".into(),
            output: "/tmp/report.json".into(),
            download_dir: None,
            import_file: None,
            config_dir: None,
        }
    }

    #[test]
    fn scenario_substitutes_every_placeholder() {
        let script = scenario_script(&plan());
        for placeholder in [
            "__CONNECTION_NAME__",
            "__ENDPOINT__",
            "__REGION__",
            "__ACCESS__",
            "__SECRET__",
            "__BUCKET__",
            "__PREFIX__",
            "__IMPORT_FILE__",
            "__CONFIG_DIR__",
        ] {
            assert!(
                !script.contains(placeholder),
                "{placeholder} was not substituted"
            );
        }
        assert!(script.contains("https://s3.example.com"));
        // The prefix reaches the page as a JSON literal.
        assert!(script.contains("_s3viewer-e2e/"));
        assert!(script.contains("\"E2E dev bucket\""));
    }

    #[test]
    fn scenario_values_are_json_escaped() {
        let mut plan = plan();
        plan.bucket = "weird\"bucket\\name".into();
        let script = scenario_script(&plan);
        assert!(script.contains(r#""weird\"bucket\\name""#));
    }

    #[test]
    fn report_parsing_is_strict() {
        let good = r#"{"ok": true, "checks": []}"#;
        assert!(parse_report(good).is_ok());
        assert!(report_passed(&parse_report(good).unwrap()));

        assert!(parse_report("not json").is_err());
        assert!(parse_report(r#"{"ok": true}"#).is_err());
    }

    #[test]
    fn failed_report_is_not_passing() {
        let report = parse_report(r#"{"ok": false, "checks": [{"name":"x","ok":false}]}"#).unwrap();
        assert!(!report_passed(&report));
    }

    #[test]
    fn plan_requires_the_run_flag() {
        std::env::remove_var(ENV_RUN);
        assert!(TestPlan::from_env().is_none());
    }

    #[test]
    fn write_report_creates_readable_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.json");
        write_report(
            path.to_str().unwrap(),
            &serde_json::json!({"ok": true, "checks": []}),
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"ok\": true"));
    }

    #[test]
    fn start_injects_the_scenario_into_the_host() {
        use std::sync::Mutex;
        struct Host {
            seen: Mutex<Vec<String>>,
        }
        impl ScriptHost for Host {
            fn eval_str(&self, script: &str) -> AppResult<()> {
                self.seen.lock().unwrap().push(script.to_string());
                Ok(())
            }
        }
        let host = Host {
            seen: Mutex::new(Vec::new()),
        };
        start(&host, &plan()).unwrap();
        let seen = host.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].contains("__S3VIEWER_E2E_REPORT"));
        assert!(
            seen[0].contains("e2e_report"),
            "the page must report back via IPC"
        );
    }

    #[test]
    fn start_propagates_host_failures() {
        struct Failing;
        impl ScriptHost for Failing {
            fn eval_str(&self, _script: &str) -> AppResult<()> {
                Err(crate::error::AppError::msg("eval unavailable"))
            }
        }
        assert!(start(&Failing, &plan()).is_err());
    }
}

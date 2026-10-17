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
}

const SCENARIO: &str = r#"(async () => {
  // The harness may inject before the page has finished loading. Wait for the
  // Tauri bridge (injected as a global) and for the app shell to exist, so a slow
  // start is a wait rather than a crash.
  {
    const deadline = Date.now() + 60000;
    while (!(window.__TAURI__ && window.__TAURI__.core && window.__s3viewer)) {
      if (Date.now() > deadline) {
        window.__S3VIEWER_E2E_STARTED = true;
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  window.__S3VIEWER_E2E_STARTED = true;
  const REPORT = [];
  const connectionName = __CONNECTION_NAME__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const invoke = window.__TAURI__.core.invoke;

  /** One animation frame: enough for a framework to apply pending updates. */
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

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
      return text.replace(/\s+/g, ' ').trim();
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
      if (rootCrumb !== __BUCKET__) throw new Error('unexpected root crumb: ' + rootCrumb);
      // The listing must be scoped to the connection prefix, not the bucket root.
      const scoped = await invoke('list_objects', { input: { connectionId, prefix: null } });
      if (scoped.prefix !== __PREFIX__) {
        throw new Error('the listing is not scoped to the prefix: ' + scoped.prefix);
      }
      return names.length + ' rows · ' + $('[data-testid=folder-status]').textContent;
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
      const folder = 'aaa-sort-probe-' + Date.now();
      setInput('[data-testid=prompt-input]', folder);
      $('[data-testid=prompt-ok]').click();
      await wait('the new folder', async () => (rowNames().includes(folder) ? true : null));
      const first = rowNames()[0];
      if (first !== folder) throw new Error('folders are not listed first: ' + first);
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
      return width + 'px wide';
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

    await check('ui: a single click focuses a row without ticking its checkbox', async () => {
      window.__s3viewer.state.objects.clearSelection();
      await frame();
      clickRow('sample.json');
      await frame();
      const selected = window.__s3viewer.state.objects.selected.size;
      if (selected !== 0) throw new Error('a plain click selected ' + selected + ' row(s)');
      const previewKey = window.__s3viewer.state.objects.previewKey;
      if (!previewKey || !previewKey.includes('sample.json')) {
        throw new Error('the click did not open the preview: ' + previewKey);
      }
      return 'focused without selecting';
    });

    await check('ui: checkboxes are hidden until something is selected', async () => {
      window.__s3viewer.state.objects.clearSelection();
      // Hover is real state, so reset it: a row the pointer passed over earlier
      // legitimately still shows its checkbox.
      for (const row of $$('.object-row')) {
        row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      }
      await frame();
      const boxes = $$('[data-testid^=row-check-]');
      if (!boxes.length) throw new Error('no checkbox elements at all');
      const visible = boxes.filter((box) => box.offsetParent !== null);
      if (visible.length) {
        throw new Error(
          visible.length + ' checkbox(es) visible at rest: '
          + visible.map((box) => box.dataset.testid).join(', ')
          + ' | selected=' + window.__s3viewer.state.objects.selected.size,
        );
      }

      const row = $$('.object-row')[0];
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const check = row.querySelector('input[type=checkbox]');
      check.click();
      await frame();
      const after = $$('[data-testid^=row-check-]').filter((box) => box.offsetParent !== null);
      if (!after.length) throw new Error('checkboxes stayed hidden after selecting');
      return 'hidden at rest, ' + after.length + ' visible in selection mode';
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
      const opsMenu = await rowMenu(folderName);
      menuClick(opsMenu, 'Delete');
      const confirm = await wait('the confirmation', () => $('[data-testid=confirm-ok]'), 8000).catch(() => null);
      if (!confirm) {
        throw new Error('no confirmation appeared; selected=' + window.__s3viewer.state.selected.size);
      }
      confirm.click();
      try {
        await wait('the folder to disappear', async () => (rowNames().includes(folderName) ? null : true), 40000);
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
      setInput('[data-testid=filter-input]', '');
      await wait('the full list', async () => ($$('.object-row').length >= 12 ? true : null), 10000);
      return names.join(', ');
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

    await check('transfer: progress reporting is wired', async () => {
      const items = await invoke('transfer_progress');
      if (!Array.isArray(items)) throw new Error('transfer_progress did not return a list');
      return items.length + ' tracked transfer(s)';
    });

    await check('security: secrets are sealed on disk, never in the clear', async () => {
      const status = await invoke('e2e_config_audit');
      if (!status.sealed) throw new Error('the stored secret is not sealed');
      if (status.containsSecret) throw new Error('THE SECRET LEAKED INTO config.json');
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
      return 'one button, no boto3 references';
    });

    await check('connection: copying the snippet confirms on the button', async () => {
      const copy = $('[data-testid=copy-snippet]');
      if (!copy) throw new Error('the copy button is missing');
      copy.click();
      const confirmed = await wait('the button to confirm', async () => {
        const button = $('[data-testid=copy-snippet]');
        return button && /copied/i.test(button.textContent) ? button.textContent.trim() : null;
      }, 8000);
      await closeModal();
      return 'button said "' + confirmed + '"';
    });

    await check('settings: downloads can ask for a destination every time', async () => {
      $('[data-testid=open-settings]').click();
      const toggle = await wait('the ask-location setting', () => $('[data-testid=settings-ask-location]'), 10000);
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

    await check('transfers: a finished download hides itself', async () => {
      const panel = $('[data-testid=transfers]');
      if (!panel) return 'no transfer panel left open';
      await wait('the finished transfer to disappear', async () =>
        ($('[data-testid=transfer-done]') ? null : true), 20000);
      return 'cleared without pressing Clear';
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

    await check('settings: the preview limit is exposed and configurable', async () => {
      const settings = await invoke('get_settings');
      if (typeof settings.previewMaxBytes !== 'number' || settings.previewMaxBytes <= 0) {
        throw new Error('no preview limit in settings');
      }
      const security = await invoke('security_status');
      if (!security.configPath) throw new Error('no config path reported');
      return 'limit ' + settings.previewMaxBytes + ' B';
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
            endpoint: "https://obs.example.ru".into(),
            region: "us-east-1".into(),
            access_key: "AKIATEST".into(),
            secret_key: "SECRETTEST".into(),
            output: "/tmp/report.json".into(),
            download_dir: None,
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
        ] {
            assert!(
                !script.contains(placeholder),
                "{placeholder} was not substituted"
            );
        }
        assert!(script.contains("https://obs.example.ru"));
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

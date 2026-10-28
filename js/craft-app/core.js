/**
 * The one implementation of "how a page embeds a Craft app's web build and talks to it".
 *
 * Three faces share this module with no logic written twice:
 * - `mountCraftApp` here (vanilla),
 * - `<craft-app>` in `element.js` (a web component around this),
 * - `CraftApp` in `react.js` (a React wrapper around the element).
 *
 * The framed app exposes `window.<app>` with a `request(method, params)` function and, where its
 * control channel has them, `execute`, `commands`, `docInspect` and `screenshot` — the shape the
 * Rust crate `craft-web-api` installs. The handle calls those functions, so the app's own method
 * names (its `Methods` table) decide what is sent.
 *
 * No build step, no dependencies, any realm: every value that comes from the frame is awaited with
 * `Promise.resolve(...)` and never `instanceof`-checked, because a page in a parent frame passes
 * objects from another realm and `instanceof` fails for them.
 */

/**
 * @typedef {Object} MountOptions
 * @property {string} app The global name the app installs (`"vectorcraft"` → `window.vectorcraft`).
 * @property {string} src The app's URL for the iframe.
 * @property {Object|null} [storage] The page's `craftStorage`, handed to the frame.
 * @property {number} [timeout=180000] Milliseconds to wait for the app to appear in the frame.
 * @property {Document} [document] The document to create the iframe in (tests inject a fake).
 */

/**
 * @typedef {Object} CraftAppHandle
 * @property {string} app
 * @property {HTMLIFrameElement} frame
 * @property {(method: string, params?: Object) => Promise<Object>} request
 * @property {(command: string, params?: Object) => Promise<Object>} execute
 * @property {() => Promise<Object>} commands
 * @property {(params?: Object) => Promise<Object>} inspect
 * @property {(params?: Object) => Promise<Object>} screenshot
 * @property {(event: string, fn: (detail: Object) => void) => () => void} on Subscribe; returns `off`.
 * @property {() => void} destroy
 */

const APP_POLL_MS = 100;

/**
 * Mount a Craft app's web build in a same-origin iframe and return its command API.
 *
 * @param {HTMLElement} container Where the iframe is appended.
 * @param {MountOptions} options
 * @returns {Promise<CraftAppHandle>} Resolves with the handle once the app answered; rejects
 *   through the `failed` event path when the app does not appear within `timeout`.
 */
export async function mountCraftApp(container, { app, src, storage = null, timeout = 180000, document: doc = globalThis.document }) {
  const frame = doc.createElement('iframe');
  frame.src = src;
  frame.title = app;
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.border = 'none';
  container.appendChild(frame);

  const listeners = new Map();
  let destroyed = false;
  /** @type {Array<() => void>} Unsubscribers of the frame's forwarded events, for `destroy`. */
  const offs = [];
  const emit = (event, detail) => {
    for (const fn of listeners.get(event) ?? []) {
      try { fn(detail); } catch { /* a listener must not break the others */ }
    }
  };

  const call = (name, ...args) => {
    if (destroyed) return Promise.reject(new Error(`${app} handle was destroyed`));
    const fn = frame.contentWindow?.[app]?.[name];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`${app} has no ${name} (yet)`));
    }
    // Any realm: never assume the frame's promise is ours.
    return Promise.resolve(fn.apply(frame.contentWindow[app], args));
  };

  const handle = /** @type {CraftAppHandle} */ ({
    app,
    frame,
    // Every call goes to the frame's `window.<app>` function of the same purpose and is awaited
    // with `Promise.resolve(...)` so a foreign realm's thenable is awaited too.
    request: (method, params) => call('request', method, params ?? {}),
    execute: (command, params) => call('execute', command, params ?? {}),
    commands: () => call('commands'),
    inspect: (params) => call('docInspect', params ?? {}),
    screenshot: (params) => call('screenshot', params ?? {}),
    on: (event, fn) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const i = current.indexOf(fn);
        if (i >= 0) current.splice(i, 1);
      };
    },
    destroy: () => {
      destroyed = true;
      for (const off of offs) off();
      listeners.clear();
      frame.remove();
    },
  });

  // Forward the app's dirty/save signals to this handle's listeners. `save` is the app handing a
  // file over; `saved` is reserved for a host-confirmed save and is not forwarded (not emitted yet).
  const forwards = [];
  for (const [event, name] of [['dirty', `${app}:dirty`], ['save', `${app}:save`]]) {
    const forward = (e) => emit(event, /** @type {CustomEvent} */ (e).detail);
    forwards.push([frame.contentWindow, name, forward]);
    forwards.push([frame.contentWindow?.document ?? null, name, forward]);
  }
  const attachForwards = () => {
    for (const [target, name, fn] of forwards) {
      if (typeof target?.addEventListener === 'function') target.addEventListener(name, fn);
      offs.push(() => {
        if (typeof target?.removeEventListener === 'function') target.removeEventListener(name, fn);
      });
    }
  };

  // Wait until the app's global exists with a `request` function.
  const deadline = Date.now() + timeout;
  let window_app = null;
  while (Date.now() < deadline) {
    window_app = frame.contentWindow?.[app] ?? null;
    if (window_app && typeof window_app.request === 'function') break;
    await new Promise((resolve) => setTimeout(resolve, APP_POLL_MS));
    window_app = null;
  }
  if (!window_app || typeof window_app.request !== 'function') {
    const error = `${app} did not appear in the frame within ${Math.round(timeout / 1000)} s`;
    emit('failed', { error });
    throw new Error(error);
  }

  // Hand the page's storage to the frame before anything else can run.
  if (storage) frame.contentWindow.craftStorage = storage;

  attachForwards();

  emit('ready', {});
  return handle;
}

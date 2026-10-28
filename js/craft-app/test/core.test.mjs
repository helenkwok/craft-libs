/**
 * Tests for the vanilla face (`core.js`) under the built-in `node --test` runner — no dependencies,
 * no build step, no browser. A fake container and a fake iframe stand in for the DOM; the fake
 * frame's `window.<app>` answers canned replies through a `request` function, and its `execute`,
 * `commands`, `docInspect` and `screenshot` send their default methods through it, the way the
 * Rust crate installs them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mountCraftApp } from '../core.js';

/** A minimal fake document whose `createElement` returns a configurable fake iframe. */
function fakeDocument({ appWindow }) {
  const created = [];
  // The fake window: the app's globals (when given) plus the event surface the app's
  // dirty/saved signals are forwarded from.
  const win = appWindow ?? {};
  const winListeners = new Map();
  win.addEventListener = (name, fn) => {
    const list = winListeners.get(name) ?? [];
    list.push(fn);
    winListeners.set(name, list);
  };
  win.removeEventListener = (name, fn) => {
    const list = winListeners.get(name) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  win.dispatch = (name, detail) => {
    for (const fn of winListeners.get(name) ?? []) fn({ detail });
  };
  const doc = {
    createElement() {
      const listeners = new Map();
      const frame = {
        src: '',
        title: '',
        style: {},
        // Same-origin: the frame's `contentWindow` is the app's window (test 1 replaces it later
        // to simulate the app appearing late).
        contentWindow: doc.appWindow,
        addEventListener(name, fn) {
          const list = listeners.get(name) ?? [];
          list.push(fn);
          listeners.set(name, list);
        },
        removeEventListener(name, fn) {
          const list = listeners.get(name) ?? [];
          const i = list.indexOf(fn);
          if (i >= 0) list.splice(i, 1);
        },
        removed: 0,
        remove() { this.removed += 1; },
        dispatch(name, detail) {
          for (const fn of listeners.get(name) ?? []) fn({ detail });
        },
        listeners,
      };
      created.push(frame);
      return frame;
    },
  };
  doc.created = created;
  doc.appWindow = win;
  doc.appendChild = (node) => {
    node.contentWindow = doc.appWindow;
  };
  return doc;
}

/** A fake container that records what is appended. */
function fakeContainer() {
  const appended = [];
  return {
    appended,
    appendChild(node) {
      appended.push(node);
    },
  };
}

/** A fake `window.<app>`: a request function answering `canned`, recording its calls, and the
 * named functions sending their default methods through it. */
function fakeApp({ canned, delay = 0 } = {}) {
  const calls = [];
  const api = {
    calls,
    request(method, params) {
      calls.push({ method, params });
      const reply = canned?.({ method, params }) ?? { ok: true, result: { method, params } };
      return delay
        ? new Promise((resolve) => setTimeout(() => resolve(reply), delay))
        : Promise.resolve(reply);
    },
    execute(command, params) { return api.request('engine.execute', { command, params }); },
    commands() { return api.request('engine.commands', {}); },
    docInspect(params) { return api.request('document.inspect', params); },
    screenshot(params) { return api.request('ui.screenshot', { data: true, ...params }); },
  };
  return api;
}

test('mountCraftApp waits for the app, then wires the frame', async () => {
  const api = fakeApp();
  const doc = fakeDocument({ appWindow: null });
  const container = fakeContainer();
  // The app only appears after a delay: the poll loop must wait for it. The frame's window is
  // given the app global; the app's events are forwarded from the window, so the fake window
  // carries the same add/remove/dispatch surface the core listens on.
  setTimeout(() => {
    const frame = container.appended[0];
    const listeners = new Map();
    frame.contentWindow = {
      vectorcraft: api,
      addEventListener(name, fn) {
        const list = listeners.get(name) ?? [];
        list.push(fn);
        listeners.set(name, list);
      },
      removeEventListener(name, fn) {
        const list = listeners.get(name) ?? [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      },
      dispatch(name, detail) {
        for (const fn of listeners.get(name) ?? []) fn({ detail });
      },
    };
  }, 250);

  const handle = await mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });

  assert.equal(container.appended.length, 1, 'the iframe is appended');
  assert.equal(container.appended[0].title, 'vectorcraft', 'the iframe title is the app name');
  assert.equal(container.appended[0].style.border, 'none');
  const out = await handle.execute('object.rectangle', { width: 100 });
  assert.equal(out.ok, true, 'execute resolves');
  assert.deepEqual(api.calls[0], {
    method: 'engine.execute',
    params: { command: 'object.rectangle', params: { width: 100 } },
  });
  handle.destroy();
});

test('execute, commands, inspect and screenshot call the frame\'s own functions', async () => {
  const api = fakeApp();
  const doc = fakeDocument({ appWindow: { vectorcraft: api } });
  const handle = await mountCraftApp(fakeContainer(), { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });

  await handle.execute('a.b', { x: 1 });
  await handle.commands();
  await handle.inspect({ depth: 2 });
  await handle.screenshot();
  await handle.request('custom.method', { x: 1 });

  assert.deepEqual(api.calls, [
    { method: 'engine.execute', params: { command: 'a.b', params: { x: 1 } } },
    { method: 'engine.commands', params: {} },
    { method: 'document.inspect', params: { depth: 2 } },
    { method: 'ui.screenshot', params: { data: true } },
    { method: 'custom.method', params: { x: 1 } },
  ]);
  handle.destroy();
});

test('storage is set on the frame window', async () => {
  const api = fakeApp();
  const doc = fakeDocument({ appWindow: { vectorcraft: api } });
  const storage = { get: () => 1 };
  const container = fakeContainer();
  await mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, storage, timeout: 5000 });

  const frameWindow = container.appended[0].contentWindow;
  assert.equal(frameWindow.craftStorage, storage, 'craftStorage handed to the frame');
  handle_destroy(container.appended[0]);
});

test('a thenable from a "foreign realm" is awaited', async () => {
  // The app answers with a plain object with a `then` function — not a Promise. `instanceof`
  // would reject it; the host must await it through Promise.resolve.
  const api = {
    calls: [],
    request(_method, _params) {
      this.calls.push({ method: _method, params: _params });
      const answer = { ok: true, result: { thenable: true } };
      return {
        then(resolve) {
          setTimeout(() => resolve(answer), 10);
        },
      };
    },
    execute(command, params) { return this.request('engine.execute', { command, params }); },
  };
  const doc = fakeDocument({ appWindow: { vectorcraft: api } });
  const handle = await mountCraftApp(fakeContainer(), { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });

  const out = await handle.execute('a.b');
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { thenable: true }, 'the foreign thenable was awaited');
  handle.destroy();
});

test('a missing app times out and fires failed', async () => {
  const doc = fakeDocument({ appWindow: null }); // the app never appears
  const container = fakeContainer();
  const failures = [];
  await assert.rejects(
    (async () => {
      const handlePromise = mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 300 });
      // `failed` fires on the handle, which only exists after success — so the rejection itself is
      // the signal; record nothing here.
      return handlePromise;
    })(),
    (error) => {
      failures.push(error);
      return /did not appear in the frame within/.test(error.message);
    },
    'the timeout rejects with the failed message',
  );
  assert.equal(failures.length, 1);
});

test('dirty and save events are forwarded from the frame', async () => {
  const api = fakeApp();
  const doc = fakeDocument({ appWindow: { vectorcraft: api } });
  const container = fakeContainer();
  const handle = await mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });

  const seen = [];
  const off = handle.on('dirty', (detail) => seen.push(['dirty', detail]));
  const frame = container.appended[0];
  frame.contentWindow.dispatch('vectorcraft:dirty', { pages: 2 });
  off();
  frame.contentWindow.dispatch('vectorcraft:dirty', { pages: 3 });
  assert.deepEqual(seen, [['dirty', { pages: 2 }]], 'dirty forwards the detail; off stops it');

  const saved = [];
  handle.on('save', (detail) => saved.push(detail));
  frame.contentWindow.dispatch('vectorcraft:save', { at: 1 });
  assert.deepEqual(saved, [{ at: 1 }]);
  handle.destroy();
});

test('the app save hand-over reaches on("save"); on("saved") stays silent (reserved)', async () => {
  const api = fakeApp();
  const doc = fakeDocument({ appWindow: { vectorcraft: api } });
  const container = fakeContainer();
  const handle = await mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });

  const save = [];
  const saved = [];
  handle.on('save', (detail) => save.push(detail));
  handle.on('saved', (detail) => saved.push(detail));
  const frame = container.appended[0];
  frame.contentWindow.dispatch('vectorcraft:save', { name: 'doc.cv', bytes: 42 });
  assert.deepEqual(save, [{ name: 'doc.cv', bytes: 42 }], 'the app hand-over reaches on("save")');
  assert.deepEqual(saved, [], 'nothing reaches on("saved"): reserved for a host-confirmed save');
  handle.destroy();
});

test('destroy removes the frame and stops the listeners', async () => {
  const api = fakeApp();
  const doc = fakeDocument({ appWindow: { vectorcraft: api } });
  const container = fakeContainer();
  const handle = await mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });
  let removed = 0;
  container.appended[0].remove = () => { removed += 1; };
  handle.destroy();
  assert.equal(removed, 1, 'destroy removes the frame');
  await assert.rejects(() => handle.execute('a.b'), /destroyed/, 'a destroyed handle rejects');
});

/** A no-op helper naming the frame whose window the seams were checked on. */
function handle_destroy(frame) {
  frame.contentWindow = null;
}

test('a mount that times out removes its frame', async () => {
  const doc = fakeDocument({ appWindow: null }); // the app never appears
  const container = fakeContainer();
  const mounting = mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 300 });
  let removed = 0;
  container.appended[0].remove = () => { removed += 1; };
  await assert.rejects(mounting, /did not appear in the frame within/);
  assert.equal(removed, 1, 'the caller gets no handle, so the core removes the frame');
});

test('events on the app\'s own document are forwarded, not the blank one the frame starts with', async () => {
  const api = fakeApp();
  const doc = fakeDocument({ appWindow: {} });
  const container = fakeContainer();
  const mounting = mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });
  // The app loads: its document replaces the frame's first one, and its global appears.
  const listeners = new Map();
  const appDocument = {
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn)); },
    dispatch(name, detail) { for (const fn of listeners.get(name) ?? []) fn({ detail }); },
  };
  setTimeout(() => {
    doc.appWindow.document = appDocument;
    doc.appWindow.vectorcraft = api;
  }, 150);
  const handle = await mounting;
  const seen = [];
  handle.on('dirty', (detail) => seen.push(detail));
  appDocument.dispatch('vectorcraft:dirty', { dirty: true });
  assert.deepEqual(seen, [{ dirty: true }], 'the listener is on the document the app dispatches on');
  handle.destroy();
  appDocument.dispatch('vectorcraft:dirty', { dirty: false });
  assert.deepEqual(seen, [{ dirty: true }], 'destroy removes it again');
});

test('a mount whose frame throws while loading removes its frame', async () => {
  const doc = fakeDocument({ appWindow: { get vectorcraft() { throw new Error('the frame is not readable'); } } });
  const container = fakeContainer();
  const mounting = mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000 });
  await assert.rejects(mounting, /the frame is not readable/);
  assert.equal(container.appended[0].removed, 1);
});

test('aborting a mount while the app loads removes the frame at once and rejects', async () => {
  const doc = fakeDocument({ appWindow: null }); // still loading
  const container = fakeContainer();
  const abort = new AbortController();
  const mounting = mountCraftApp(container, { app: 'vectorcraft', src: '/v/', document: doc, timeout: 5000, signal: abort.signal });
  let removed = 0;
  container.appended[0].remove = () => { removed += 1; };
  const started = Date.now();
  abort.abort(new Error('replaced'));
  assert.ok(removed >= 1, 'the frame goes as soon as the signal aborts');
  await assert.rejects(mounting, /replaced/);
  assert.ok(Date.now() - started < 1000, 'no waiting for the timeout');
});

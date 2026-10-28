/**
 * Tests for the web-component face (`element.js`) under `node --test`, with no browser: a small
 * fake `HTMLElement` and `document` stand in for the DOM. Each frame's window is chosen by its
 * `src`, and can appear late to simulate an app that is still loading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** src -> the window the frame gets once the app has loaded (absent: still loading). */
const windows = new Map();
/** Every iframe created, in order. */
const frames = [];

class FakeElement extends EventTarget {
  #attrs = new Map();
  attachShadow() {
    this.shadowRoot = { append() {} };
    return this.shadowRoot;
  }
  getAttribute(name) {
    return this.#attrs.get(name) ?? null;
  }
  setAttribute(name, value) {
    const old = this.getAttribute(name);
    this.#attrs.set(name, value);
    if (this.constructor.observedAttributes.includes(name)) this.attributeChangedCallback(name, old, value);
  }
}

globalThis.HTMLElement = FakeElement;
globalThis.document = {
  createElement(tag) {
    if (tag === 'iframe') {
      const frame = {
        style: {},
        removed: 0,
        remove() { this.removed += 1; },
        get contentWindow() { return windows.get(this.src) ?? {}; },
      };
      frames.push(frame);
      return frame;
    }
    return { style: {}, appendChild() {} };
  },
};

const { CraftAppElement } = await import('../element.js');

/** A fake `window.<app>` answering every request with the frame's src. */
function appWindow(src) {
  return { vectorcraft: { request: (method) => Promise.resolve({ ok: true, src, method }) } };
}

/** Resolve once `name` fires on `el`. */
function next(el, name) {
  return new Promise((resolve) => el.addEventListener(name, (e) => resolve(e.detail), { once: true }));
}

function element(src) {
  const el = new CraftAppElement();
  el.setAttribute('app', 'vectorcraft');
  el.setAttribute('src', src);
  el.connectedCallback();
  return el;
}

test('a mount replaced by a newer one never comes back', async () => {
  const el = element('/a/'); // still loading
  const frameA = frames.at(-1);
  windows.set('/b/', appWindow('/b/'));
  const ready = next(el, 'craft-ready');
  el.setAttribute('src', '/b/');
  await ready;
  windows.set('/a/', appWindow('/a/')); // the first app finishes loading after all
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(frameA.removed, 1, 'the superseded frame is removed');
  assert.equal((await el.request('x')).src, '/b/', 'calls go to the current app');
  el.destroy();
});

test('storage set while the app is loading reaches its frame', async () => {
  const el = element('/c/');
  const storage = { chooseOpen() {} };
  el.storage = storage;
  const ready = next(el, 'craft-ready');
  const win = appWindow('/c/');
  windows.set('/c/', win);
  await ready;
  assert.equal(win.craftStorage, storage);
  el.destroy();
});

test('a mount that fails fires craft-failed, and mount() can try again', async () => {
  windows.set('/d/', { get vectorcraft() { throw new Error('the frame is not readable'); } });
  const el = new CraftAppElement();
  const failed = next(el, 'craft-failed');
  el.setAttribute('app', 'vectorcraft');
  el.setAttribute('src', '/d/');
  el.connectedCallback();
  assert.deepEqual(await failed, { error: 'the frame is not readable' });
  windows.set('/d/', appWindow('/d/'));
  const ready = next(el, 'craft-ready');
  el.mount();
  await ready;
  assert.equal(el.ready, true);
  el.destroy();
});

test('mount() after destroy() brings the app back (React StrictMode runs effects twice)', async () => {
  windows.set('/e/', appWindow('/e/'));
  const el = element('/e/');
  await next(el, 'craft-ready');
  const first = frames.at(-1);
  el.destroy();
  assert.equal(first.removed, 1);
  assert.equal(el.ready, false);
  const ready = next(el, 'craft-ready');
  el.mount();
  el.mount(); // safe to repeat
  await ready;
  assert.equal(el.ready, true);
  assert.notEqual(frames.at(-1), first, 'a fresh frame');
  el.destroy();
});

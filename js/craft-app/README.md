# @craft/app

How a page embeds a Craft app's web build and talks to it: one implementation, three faces — a
vanilla `mountCraftApp`, a `<craft-app>` web component and a React `<CraftApp>` wrapper.

Plain ES modules, no build step, no dependencies (React is an optional peer for the React face).

## The three faces

### Vanilla (`mountCraftApp`)

```js
import { mountCraftApp } from '@craft/app';

const app = await mountCraftApp(document.getElementById('host'), {
  app: 'vectorcraft', src: '/apps/vectorcraft/',
  storage: myStorage,
});
await app.execute('object.rectangle', { width: 100 });
app.on('dirty', () => setUnsaved(true));
```

### Web component (`<craft-app>`)

```js
import { defineCraftApp } from '@craft/app/element';
defineCraftApp();
```

```html
<craft-app app="vectorcraft" src="/apps/vectorcraft/"></craft-app>
```

```js
const el = document.querySelector('craft-app');
el.storage = myStorage; // property, not attribute
el.addEventListener('craft-ready', () => el.execute('object.rectangle', { width: 100 }));
```

### React (`<CraftApp>`)

```jsx
import { CraftApp } from '@craft/app/react';

<CraftApp app="vectorcraft" src="/apps/vectorcraft/"
  storage={myStorage}
  onReady={() => setReady(true)} onDirty={() => setUnsaved(true)} />;
```

`storage` is set as an element property (objects never go through attributes),
and the events are subscribed with `addEventListener` in an effect — JSX event props on custom
elements are unreliable after hydration.

## Events

`dirty` and `save` on the handle (`mountCraftApp` itself resolves once the app is ready and
rejects with the error when it is not); `craft-ready`, `craft-failed` (`{error}`), `craft-dirty`
and `craft-save` (bubbled, composed) on the element. `dirty`/`save` forward the
app's `<app>:dirty` / `<app>:save` `CustomEvent`s with their `detail` — `save` is the app handing
a file over, not a confirmation that anything was stored. `saved` is reserved for a
host-confirmed save; it is not emitted yet.

## Lifecycle: destroy, not disconnect

When you are done with the app, call `element.destroy()` on `<craft-app>` (or `handle.destroy()` on the vanilla handle) — it unsubscribes the listeners, destroys the handle and removes the frame; calling it twice is safe, and after it, connecting the element again or calling `element.mount()` mounts a fresh app (`mount()` does nothing while an app is mounted or mounting). Leaving the DOM alone never tears the app down: a move can take longer than a microtask, and tearing down on disconnect would kill a running editor with unsaved work, so `disconnectedCallback` only records that the element is disconnected and the same mounted app survives a move. React's `<CraftApp>` calls `mount()` in an effect and `destroy()` in its cleanup, so unmounting the component frees the app, and StrictMode's second run of the effect brings it back.

## Relation to the Rust crate

The framed app exposes `window.<app>` — `request(method, params)` and, where its control channel
has them, `execute`, `commands`, `docInspect` and `screenshot` — the shape the Rust crate
`craft-web-api` installs (`crates/web-api/`). The handle calls those functions, so the app's own
method table decides which control method each one sends. Each resolves with the method's
`result` and rejects with an `Error` carrying the app's `error`.

## Tests

`node --test 'js/craft-app/test/**/*.test.mjs'` — no dependencies, no build step, no browser.

/**
 * The Craft app host: embed a Craft app's web build in a page and talk to it.
 * Hand-written types for `core.js`, the root entry (plain ES modules, no build step).
 * `element.d.ts` and `react.d.ts` cover the `./element` and `./react` entries.
 */
export as namespace CraftAppHost;

/** What a call resolves with: the method's `result`. A failed call rejects with an `Error` carrying the app's `error`. */
export type AppResult = unknown;

export interface MountOptions {
  /** The global name the app installs (`"vectorcraft"` → `window.vectorcraft`). */
  app: string;
  /** The app's URL for the iframe. */
  src: string;
  /** The page's `craftStorage`, handed to the frame. */
  storage?: unknown | null;
  /** Milliseconds to wait for the app to appear in the frame. Default 180000. */
  timeout?: number;
  /** The document to create the iframe in (tests inject a fake). */
  document?: Document;
  /** Aborting it while the app is still loading removes the frame and rejects the mount. */
  signal?: AbortSignal;
}

export interface CraftAppHandle {
  readonly app: string;
  readonly frame: HTMLIFrameElement;
  request(method: string, params?: object): Promise<AppResult>;
  execute(command: string, params?: object): Promise<AppResult>;
  commands(): Promise<AppResult>;
  inspect(params?: object): Promise<AppResult>;
  screenshot(params?: object): Promise<AppResult>;
  /** Subscribe to `dirty` or `save`; returns the unsubscribe function. (`ready` and `failed` fire
   * before the handle exists: await `mountCraftApp` instead.)
   * `save` forwards the app's `<app>:save` (the app handing a file over). `saved` is reserved for
   * a host-confirmed save and is not emitted yet. */
  on(event: 'dirty' | 'save', fn: (detail: Record<string, unknown>) => void): () => void;
  /** Remove the frame and every listener. */
  destroy(): void;
}

/** Vanilla face: mount a Craft app's web build and get its command API. */
export function mountCraftApp(container: HTMLElement, options: MountOptions): Promise<CraftAppHandle>;

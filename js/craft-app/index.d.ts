/**
 * The Craft app host: embed a Craft app's web build in a page and talk to it.
 * Hand-written types for `core.js`, `element.js` and `react.js` (plain ES modules, no build step).
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
}

export interface CraftAppHandle {
  readonly app: string;
  readonly frame: HTMLIFrameElement;
  request(method: string, params?: object): Promise<AppResult>;
  execute(command: string, params?: object): Promise<AppResult>;
  commands(): Promise<AppResult>;
  inspect(params?: object): Promise<AppResult>;
  screenshot(params?: object): Promise<AppResult>;
  /** Subscribe to `ready`, `failed`, `dirty` or `save`; returns the unsubscribe function.
   * `save` forwards the app's `<app>:save` (the app handing a file over). `saved` is reserved for
   * a host-confirmed save and is not emitted yet. */
  on(event: 'ready' | 'failed' | 'dirty' | 'save', fn: (detail: Record<string, unknown>) => void): () => void;
  /** Remove the frame and every listener. */
  destroy(): void;
}

/** Vanilla face: mount a Craft app's web build and get its command API. */
export function mountCraftApp(container: HTMLElement, options: MountOptions): Promise<CraftAppHandle>;

/** The web-component face. Defined by `defineCraftApp(tag)`; never define it at import time. */
export class CraftAppElement extends HTMLElement {
  static observedAttributes: string[];
  /** The page's `craftStorage` (a property, never an attribute). */
  storage: unknown | null;
  /** True once the app is mounted and answering. */
  readonly ready: boolean;
  request(method: string, params?: object): Promise<AppResult>;
  execute(command: string, params?: object): Promise<AppResult>;
  commands(): Promise<AppResult>;
  inspect(params?: object): Promise<AppResult>;
  screenshot(params?: object): Promise<AppResult>;
  /** Tear the mounted app down and empty the element: the element's listeners are unsubscribed
   * and the handle destroyed, which removes the frame. Safe to call twice; after it, connecting
   * the element again mounts a fresh app. */
  destroy(): void;
}

/**
 * Define `<craft-app>` (or another tag). Idempotent; no side effect on import.
 * Events on the element, `bubbles: true, composed: true`:
 * `craft-ready`, `craft-failed` (`{error}`), `craft-dirty`, `craft-save` (`craft-saved` is
 * reserved for a host-confirmed save and is not emitted yet).
 */
export function defineCraftApp(tag?: string): typeof CraftAppElement;

/** The React face (React >= 18 as a peer, no JSX, no build step). */
export const CraftApp: import('react').ForwardRefExoticComponent<
  import('react').PropsWithoutRef<{
    app: string;
    src: string;
    storage?: unknown | null;
    onReady?: (detail: Record<string, unknown>) => void;
    onFailed?: (detail: Record<string, unknown>) => void;
    onDirty?: (detail: Record<string, unknown>) => void;
    onSave?: (detail: Record<string, unknown>) => void;
    style?: import('react').CSSProperties;
    className?: string;
  }> &
  import('react').RefAttributes<HTMLElement>
>;

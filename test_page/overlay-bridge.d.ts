// Type declarations for overlay-bridge.js (loaded from the CDN as a global script).
// Copy this file into a TypeScript project (e.g. src/types/overlay-bridge.d.ts).

export {};

declare global {
  type OverlayBridgeEnvironment = 'steam-overlay' | 'webview2' | 'none';

  /** Native -> web message. Same shape as WebView2's message event (`e.data`). */
  interface OverlayBridgeMessageEvent {
    readonly type: 'message';
    readonly data: unknown;
  }

  interface OverlayBridgeCloseEvent {
    readonly type: 'close';
  }

  interface OverlayBridgeEventMap {
    message: OverlayBridgeMessageEvent;
    /** The game is closing this popup (Steam overlay). The popup closes itself right after. */
    close: OverlayBridgeCloseEvent;
  }

  interface OverlayBridgeApi {
    readonly version: string;
    /** Which host opened the page. 'none' = no native connection (postMessage() resolves false). */
    getEnvironment(): OverlayBridgeEnvironment;
    /** True while connected to the game. */
    isAvailable(): boolean;
    /** This popup's id assigned by the game (Steam overlay). null elsewhere or before connecting. */
    getPopupId(): number | null;
    /**
     * Closes this popup and tells the game it was closed by the page (PAGE_REQUEST) with `reason`.
     * In the Steam overlay, a plain window.close() is reported the same way (reason 'window.close').
     */
    closePopup(reason?: string): void;
    /**
     * Opens `url` (http/https) as a new popup that the game tracks and can close (Steam overlay).
     * Resolves to the new popup's id, or null if the game refused it / outside the Steam overlay
     * (there it is a plain window.open). In the Steam overlay, target="_blank" links and
     * window.open() are routed here automatically; window.open() then returns null.
     */
    openPopup(url: string): Promise<number | null>;
    /**
     * False where new popups cannot be opened: in the Steam overlay when the game says so (Steam Deck:
     * the overlay shows one page at a time) or before the page has connected. openPopup(), window.open()
     * and target="_blank" links then open nothing (null). True elsewhere (a plain window.open).
     */
    canOpenPopup(): boolean;
    /** Web -> native. Same as window.chrome.webview.postMessage; `message` must be JSON-serializable. */
    postMessage(message: unknown): Promise<boolean>;
    addEventListener<K extends keyof OverlayBridgeEventMap>(type: K, listener: (event: OverlayBridgeEventMap[K]) => void): void;
    removeEventListener<K extends keyof OverlayBridgeEventMap>(type: K, listener: (event: OverlayBridgeEventMap[K]) => void): void;
  }

  interface Window {
    /** Undefined until overlay-bridge.js has loaded (and always undefined during SSR). */
    OverlayBridge?: OverlayBridgeApi;
  }

  interface WindowEventMap {
    'overlaybridge:ready': CustomEvent<{ environment: OverlayBridgeEnvironment }>;
  }
}

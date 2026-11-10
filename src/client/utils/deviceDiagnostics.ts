/**
 * deviceDiagnostics — opt-in client instrumentation for touch / small-screen /
 * console-browser debugging.
 *
 * Activation: open any page with `?diag=1` (persisted in sessionStorage for the
 * tab; `?diag=0` turns it off). When disabled, every exported function is a
 * cheap no-op, so call sites need no guards.
 *
 * Entries are batched to POST /api/diag/client, which writes each one to
 * stdout as a `[client-diag] {json}` line (Railway deploy logs). A small
 * on-screen badge shows the session id so testers can report it.
 *
 * Privacy: never records input values, chat text, or typed characters.
 */

import { authenticatedFetch } from '../services/authenticatedFetch';
import { config } from '../config/apiConfig';

/** A single diagnostic entry, as sent to the server. */
export interface DiagEntry {
  t: number;
  seq: number;
  cat: string;
  ev: string;
  data?: Record<string, unknown>;
}

/** Plain rect used for logging bounds. */
export interface DiagRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type GameLike = {
  scale?: { width: number; height: number };
  renderer?: { type: number };
  canvas?: HTMLCanvasElement;
  input?: any;
  scene?: { getScenes: (isActive?: boolean, inReverse?: boolean) => any[] };
};

const STORAGE_KEY = 'eurorails.diag';
const SESSION_KEY = 'eurorails.diag.session';
const TOKEN_KEY = 'eurorails.jwt';
export const MAX_QUEUE = 2000;
export const FLUSH_BATCH = 100;
const MAX_BATCH_JSON_BYTES = 56 * 1024; // keepalive bodies are capped at 64KB
const FLUSH_INTERVAL_MS = 5000;
const MOVE_SUMMARY_MS = 500;
const RECENT_LIMIT = 200;
const MAX_STRING = 300;
const MAX_ARRAY = 20;
const MAX_DEPTH = 6;

let enabled = false;
let initialized = false;
let sessionId = '';
let startMs = 0;
let seq = 0;
let dropped = 0;
let queue: DiagEntry[] = [];
let recent: DiagEntry[] = [];
let inFlight = false;
let backoffUntil = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let moveTimer: ReturnType<typeof setInterval> | null = null;
let lastFlushStatus = 'idle';
let gameRef: GameLike | null = null;
let insideConsoleHook = false;
let overlayEl: HTMLDivElement | null = null;
let overlayListEl: HTMLPreElement | null = null;
let overlayBadgeEl: HTMLButtonElement | null = null;
let overlayExpanded = false;
let probeListener: (() => void) | null = null;

const moveStats = {
  pointerMoves: 0,
  pointerMovesWithButtons: 0,
  touchMoves: 0,
  maxTouches: 0,
  pointerTypes: new Set<string>(),
};

function safeStorageGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode etc.) — diagnostics still work for this page.
  }
}

function makeUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Make arbitrary data JSON-safe and bounded in size. */
export function sanitize(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? round(value) : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…+${value.length - MAX_ARRAY}`);
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'function') continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Short descriptor for a DOM event target: tag#id.class[data-chat-input]. */
export function describeTarget(target: EventTarget | null): string {
  if (!target || !(target as Element).tagName) return String(target && (target as any).constructor?.name);
  const el = target as Element;
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  if (cls) s += `.${cls}`;
  if (el.hasAttribute && el.hasAttribute('data-chat-input')) s += '[chat-input]';
  return s.slice(0, 80);
}

function rectOf(el: Element | null | undefined): DiagRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) };
}

/** Bounds of a Phaser game object (world/scene coordinates), or null. */
export function boundsOf(obj: any): DiagRect | null {
  try {
    if (!obj || typeof obj.getBounds !== 'function') return null;
    const b = obj.getBounds();
    return { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height) };
  } catch {
    return null;
  }
}

/** Whether a rect is fully inside a w×h viewport. */
export function isRectOnScreen(rect: DiagRect | null, width: number, height: number): boolean | null {
  if (!rect) return null;
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height;
}

function currentGameId(): string | undefined {
  const m = window.location.pathname.match(/\/game\/([0-9a-f-]{36})/i);
  return m ? m[1] : undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function isEnabled(): boolean {
  return enabled;
}

export function getSessionId(): string {
  return sessionId;
}

/** Record a diagnostic event. No-op unless diagnostics are enabled. */
export function log(cat: string, ev: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const entry: DiagEntry = {
    t: Math.round(performance.now() - startMs),
    seq: seq++,
    cat,
    ev,
  };
  if (data) entry.data = sanitize(data) as Record<string, unknown>;
  queue.push(entry);
  if (queue.length > MAX_QUEUE) {
    const over = queue.length - MAX_QUEUE;
    queue.splice(0, over);
    dropped += over;
  }
  recent.push(entry);
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  if (queue.length >= FLUSH_BATCH) void flush();
  renderOverlay();
}

/** Record a full environment / layout snapshot. */
export function snapshot(reason: string): void {
  if (!enabled) return;
  const vv = window.visualViewport;
  const mq = (q: string): boolean | null => {
    try {
      return window.matchMedia ? window.matchMedia(q).matches : null;
    } catch {
      return null;
    }
  };
  const nav = navigator as any;
  const canvas = gameRef?.canvas ?? document.querySelector('#game-container canvas');
  const input = gameRef?.input;
  log('env', 'snapshot', {
    reason,
    ua: navigator.userAgent,
    uaData: nav.userAgentData ? { mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform } : null,
    maxTouchPoints: navigator.maxTouchPoints,
    media: {
      pointerCoarse: mq('(pointer: coarse)'),
      pointerFine: mq('(pointer: fine)'),
      hoverNone: mq('(hover: none)'),
      anyPointerFine: mq('(any-pointer: fine)'),
      anyHover: mq('(any-hover: hover)'),
    },
    dpr: window.devicePixelRatio,
    inner: { w: window.innerWidth, h: window.innerHeight },
    docEl: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
    screen: { w: window.screen?.width, h: window.screen?.height, orientation: window.screen?.orientation?.type },
    visualViewport: vv
      ? { w: vv.width, h: vv.height, scale: vv.scale, offsetTop: vv.offsetTop, offsetLeft: vv.offsetLeft }
      : null,
    heights: measureViewportUnits(),
    rects: {
      root: rectOf(document.getElementById('root')),
      gameContainer: rectOf(document.getElementById('game-container')),
      canvas: rectOf(canvas as Element | null),
    },
    phaser: gameRef
      ? {
          scale: gameRef.scale ? { w: gameRef.scale.width, h: gameRef.scale.height } : null,
          renderer: gameRef.renderer?.type,
          pointers: input?.pointers?.length,
          pointersTotal: input?.pointersTotal,
          touchEnabled: input?.touch?.enabled,
          mouseEnabled: input?.mouse?.enabled,
          touchCapture: input?.touch?.capture,
          globalTopOnly: input?.globalTopOnly,
        }
      : null,
    chatInputs: document.querySelectorAll('input[data-chat-input]').length,
    dropped,
  });
}

/** Compare 100vh / 100dvh / 100svh against innerHeight (H3). */
function measureViewportUnits(): Record<string, number | null> {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-10px;top:0;width:1px;visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);
  const measure = (h: string): number | null => {
    probe.style.height = '';
    probe.style.height = h;
    return probe.style.height ? round(probe.getBoundingClientRect().height) : null;
  };
  const out = { vh100: measure('100vh'), dvh100: measure('100dvh'), svh100: measure('100svh'), inner: window.innerHeight };
  probe.remove();
  return out;
}

/** Send queued entries to the server. Exported for the overlay and tests. */
export async function flush(): Promise<void> {
  if (!enabled || inFlight || queue.length === 0) return;
  if (Date.now() < backoffUntil) return;
  let hasToken = false;
  try {
    hasToken = !!window.localStorage.getItem(TOKEN_KEY);
  } catch {
    hasToken = false;
  }
  if (!hasToken) {
    lastFlushStatus = `waiting-auth (${queue.length})`;
    renderOverlay();
    return;
  }

  let batch = queue.slice(0, FLUSH_BATCH);
  while (batch.length > 1 && JSON.stringify(batch).length > MAX_BATCH_JSON_BYTES) {
    batch = batch.slice(0, Math.ceil(batch.length / 2));
  }
  inFlight = true;
  try {
    const response = await authenticatedFetch(`${config.apiBaseUrl}/api/diag/client`, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({ sessionId, gameId: currentGameId(), entries: batch }),
    });
    if (response.ok || response.status === 400) {
      // 400 = malformed batch; drop it rather than retrying forever.
      queue.splice(0, batch.length);
      lastFlushStatus = response.ok ? `sent ${batch.length}` : 'rejected 400';
    } else if (response.status === 429) {
      backoffUntil = Date.now() + 15000;
      lastFlushStatus = 'rate-limited';
    } else {
      lastFlushStatus = `error ${response.status}`;
    }
  } catch {
    lastFlushStatus = 'network-error';
  } finally {
    inFlight = false;
    renderOverlay();
  }
}

/** Read diagnostics state for tests. */
export function _getStateForTests(): { queue: DiagEntry[]; dropped: number; sessionId: string } {
  return { queue, dropped, sessionId };
}

/** Reset all module state (tests only). */
export function _resetForTests(): void {
  enabled = false;
  initialized = false;
  sessionId = '';
  seq = 0;
  dropped = 0;
  queue = [];
  recent = [];
  inFlight = false;
  backoffUntil = 0;
  if (flushTimer) clearInterval(flushTimer);
  if (moveTimer) clearInterval(moveTimer);
  flushTimer = null;
  moveTimer = null;
  gameRef = null;
  if (probeListener) window.removeEventListener('pointerdown', probeListener, true);
  probeListener = null;
  overlayEl?.remove();
  overlayEl = null;
  overlayListEl = null;
  overlayBadgeEl = null;
}

/**
 * Initialize diagnostics. Reads `?diag=1|0`, persists the choice for the tab,
 * and (if enabled) attaches DOM listeners, the flush loop, and the overlay.
 * Safe to call multiple times.
 */
export function initDeviceDiagnostics(options: { attachListeners?: boolean; showOverlay?: boolean } = {}): void {
  if (initialized) return;
  initialized = true;

  const param = new URLSearchParams(window.location.search).get('diag');
  if (param === '1') safeStorageSet(STORAGE_KEY, '1');
  if (param === '0') {
    safeStorageSet(STORAGE_KEY, null);
    safeStorageSet(SESSION_KEY, null);
  }
  enabled = safeStorageGet(STORAGE_KEY) === '1';
  if (!enabled) return;

  sessionId = safeStorageGet(SESSION_KEY) || makeUuid();
  safeStorageSet(SESSION_KEY, sessionId);
  startMs = performance.now();

  log('diag', 'init', { path: window.location.pathname });

  if (options.attachListeners !== false) {
    attachDomListeners();
    flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    moveTimer = setInterval(emitMoveSummary, MOVE_SUMMARY_MS);
  }
  if (options.showOverlay !== false) createOverlay();
  snapshot('init');
}

// ─── DOM listeners ──────────────────────────────────────────────────────────

function emitMoveSummary(): void {
  if (moveStats.pointerMoves === 0 && moveStats.touchMoves === 0) return;
  log('dom', 'moveSummary', {
    pointerMoves: moveStats.pointerMoves,
    pointerMovesWithButtons: moveStats.pointerMovesWithButtons,
    touchMoves: moveStats.touchMoves,
    maxTouches: moveStats.maxTouches,
    pointerTypes: Array.from(moveStats.pointerTypes),
  });
  moveStats.pointerMoves = 0;
  moveStats.pointerMovesWithButtons = 0;
  moveStats.touchMoves = 0;
  moveStats.maxTouches = 0;
  moveStats.pointerTypes.clear();
}

/** Log after dispatch so `defaultPrevented` reflects Phaser's handlers. */
function logAfterDispatch(ev: string, e: Event, data: Record<string, unknown>): void {
  setTimeout(() => log('dom', ev, { ...data, defaultPrevented: e.defaultPrevented }), 0);
}

function attachDomListeners(): void {
  const capture = { capture: true, passive: true };

  const onPointer = (e: PointerEvent): void => {
    logAfterDispatch(e.type, e, {
      pointerType: e.pointerType,
      pointerId: e.pointerId,
      isPrimary: e.isPrimary,
      button: e.button,
      buttons: e.buttons,
      x: e.clientX,
      y: e.clientY,
      target: describeTarget(e.target),
    });
  };
  ['pointerdown', 'pointerup', 'pointercancel'].forEach((t) =>
    window.addEventListener(t, onPointer as EventListener, capture));

  window.addEventListener('pointermove', ((e: PointerEvent) => {
    moveStats.pointerMoves++;
    if (e.buttons) moveStats.pointerMovesWithButtons++;
    moveStats.pointerTypes.add(e.pointerType);
  }) as EventListener, capture);

  const onTouch = (e: TouchEvent): void => {
    moveStats.maxTouches = Math.max(moveStats.maxTouches, e.touches.length);
    logAfterDispatch(e.type, e, {
      touches: e.touches.length,
      changed: e.changedTouches.length,
      target: describeTarget(e.target),
    });
  };
  ['touchstart', 'touchend', 'touchcancel'].forEach((t) =>
    window.addEventListener(t, onTouch as EventListener, capture));
  window.addEventListener('touchmove', ((e: TouchEvent) => {
    moveStats.touchMoves++;
    moveStats.maxTouches = Math.max(moveStats.maxTouches, e.touches.length);
  }) as EventListener, capture);

  // iOS Safari pinch gestures
  ['gesturestart', 'gestureend'].forEach((t) =>
    window.addEventListener(t, ((e: any) => log('dom', t, { scale: e.scale, target: describeTarget(e.target) })) as EventListener, capture));

  window.addEventListener('wheel', ((e: WheelEvent) => {
    log('dom', 'wheel', { deltaMode: e.deltaMode, dir: Math.sign(e.deltaY), ctrl: e.ctrlKey, target: describeTarget(e.target) });
  }) as EventListener, capture);

  window.addEventListener('contextmenu', (e) => log('dom', 'contextmenu', { target: describeTarget(e.target) }), capture);

  window.addEventListener('keydown', ((e: KeyboardEvent) => {
    const tag = (e.target as Element | null)?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA';
    log('dom', 'keydown', inField
      ? { inField: true, isEnter: e.key === 'Enter', keyLen: e.key?.length ?? 0, target: describeTarget(e.target) }
      : { inField: false, code: e.code, target: describeTarget(e.target) });
  }) as EventListener, capture);

  const onFocus = (e: FocusEvent): void => {
    const el = e.target as HTMLElement | null;
    const isChatInput = !!el?.hasAttribute?.('data-chat-input');
    log('dom', e.type, {
      target: describeTarget(e.target),
      rect: el instanceof Element ? rectOf(el) : null,
      fontSize: isChatInput ? window.getComputedStyle(el as Element).fontSize : undefined,
      vv: window.visualViewport
        ? { h: window.visualViewport.height, top: window.visualViewport.offsetTop, scale: window.visualViewport.scale }
        : null,
    });
  };
  window.addEventListener('focusin', onFocus as EventListener, true);
  window.addEventListener('focusout', onFocus as EventListener, true);

  window.addEventListener('resize', () => snapshot('resize'));
  window.addEventListener('orientationchange', () => snapshot('orientationchange'));
  if (window.visualViewport) {
    let vvTimer: ReturnType<typeof setTimeout> | null = null;
    const onVv = (type: string): void => {
      if (vvTimer) clearTimeout(vvTimer);
      vvTimer = setTimeout(() => snapshot(`visualViewport.${type}`), 150);
    };
    window.visualViewport.addEventListener('resize', () => onVv('resize'));
    window.visualViewport.addEventListener('scroll', () => onVv('scroll'));
  }

  window.addEventListener('error', (e) => log('error', 'window.error', { message: e.message, src: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => log('error', 'unhandledrejection', { reason: String(e.reason) }));

  document.addEventListener('visibilitychange', () => {
    log('dom', 'visibilitychange', { state: document.visibilityState });
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('pagehide', () => void flush());

  hookConsole('error');
  hookConsole('warn');
}

function hookConsole(level: 'error' | 'warn'): void {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    original(...args);
    if (insideConsoleHook) return;
    insideConsoleHook = true;
    try {
      const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ');
      log('console', level, { text: text.slice(0, MAX_STRING) });
    } finally {
      insideConsoleHook = false;
    }
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ─── Phaser probe ───────────────────────────────────────────────────────────

function describeGameObject(obj: any): Record<string, unknown> {
  return {
    type: obj?.type,
    name: obj?.name || undefined,
    depth: obj?.depth,
    x: obj?.x,
    y: obj?.y,
    w: obj?.displayWidth ?? obj?.width,
    h: obj?.displayHeight ?? obj?.height,
    parent: obj?.parentContainer ? obj.parentContainer.name || obj.parentContainer.type : undefined,
  };
}

/**
 * Attach the Phaser game: enables Phaser fields in snapshots, and on every DOM
 * pointerdown logs what each active scene hit-tests under the pointer (H1).
 */
export function attachPhaserProbe(game: GameLike): void {
  if (!enabled) return;
  gameRef = game;
  const probe = (): void => {
    try {
      const input = game.input;
      const pointer = input?.activePointer;
      if (!pointer || !game.scene) return;
      const scenes = game.scene.getScenes(true, true); // top-most first
      const hits = scenes.map((s: any) => {
        let objs: any[] = [];
        try {
          objs = s.input && s.input.enabled !== false ? s.input.hitTestPointer(pointer) : [];
        } catch {
          objs = [];
        }
        return {
          scene: s.sys?.settings?.key,
          inputEnabled: s.input?.enabled,
          count: objs.length,
          top: objs.slice(0, 3).map(describeGameObject),
        };
      });
      log('phaser', 'hitTest', {
        x: pointer.x,
        y: pointer.y,
        wasTouch: pointer.wasTouch,
        buttons: pointer.buttons,
        leftButtonDown: typeof pointer.leftButtonDown === 'function' ? pointer.leftButtonDown() : null,
        pointer1Down: input?.pointer1?.isDown ?? null,
        pointer2Down: input?.pointer2?.isDown ?? null,
        scale: game.scale ? { w: game.scale.width, h: game.scale.height } : null,
        scenes: hits,
      });
    } catch (err) {
      log('phaser', 'hitTestError', { message: String(err) });
    }
  };
  // Replace any listener from a previous game instance (StandaloneGame remounts).
  if (probeListener) window.removeEventListener('pointerdown', probeListener, true);
  probeListener = (): void => {
    setTimeout(probe, 0);
  };
  window.addEventListener('pointerdown', probeListener, { capture: true, passive: true });
  snapshot('phaserAttached');
}

// ─── Overlay ────────────────────────────────────────────────────────────────

function createOverlay(): void {
  if (overlayEl || !document.body) return;
  const el = document.createElement('div');
  el.id = 'diag-overlay';
  el.style.cssText = [
    'position:fixed', 'top:4px', 'left:4px', 'z-index:2147483000',
    'font:11px/1.3 monospace', 'color:#0f0', 'max-width:min(92vw,520px)',
  ].join(';');

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.style.cssText = 'background:rgba(0,0,0,.75);color:#0f0;border:1px solid #0f0;border-radius:4px;padding:4px 8px;font:inherit;';
  badge.addEventListener('click', () => {
    overlayExpanded = !overlayExpanded;
    renderOverlay();
  });

  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;background:rgba(0,0,0,.85);border:1px solid #0f0;border-radius:4px;margin-top:4px;padding:6px;';
  const buttons = document.createElement('div');
  const mkBtn = (label: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'margin:0 6px 6px 0;padding:6px 10px;font:inherit;background:#033;color:#0f0;border:1px solid #0f0;border-radius:3px;';
    b.addEventListener('click', fn);
    buttons.appendChild(b);
  };
  mkBtn('Send now', () => void flush());
  mkBtn('Snapshot', () => snapshot('manual'));
  mkBtn('Copy', () => {
    const text = JSON.stringify({ sessionId, entries: recent });
    navigator.clipboard?.writeText(text).then(
      () => log('diag', 'copied', { count: recent.length }),
      () => log('diag', 'copyFailed'),
    );
  });
  mkBtn('Hide', () => {
    overlayExpanded = false;
    renderOverlay();
  });
  const list = document.createElement('pre');
  list.style.cssText = 'margin:0;max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-all;';
  panel.appendChild(buttons);
  panel.appendChild(list);

  el.appendChild(badge);
  el.appendChild(panel);
  document.body.appendChild(el);
  overlayEl = el;
  overlayBadgeEl = badge;
  overlayListEl = list;
  renderOverlay();
}

function renderOverlay(): void {
  if (!overlayEl || !overlayBadgeEl || !overlayListEl) return;
  overlayBadgeEl.textContent = `DIAG ● ${sessionId.slice(0, 8)} · ${lastFlushStatus} · q${queue.length}`;
  const panel = overlayListEl.parentElement as HTMLElement;
  panel.style.display = overlayExpanded ? 'block' : 'none';
  if (overlayExpanded) {
    overlayListEl.textContent = [`session ${sessionId}`]
      .concat(recent.slice(-20).map((e) => `${e.t} ${e.cat}.${e.ev} ${e.data ? safeJson(e.data).slice(0, 160) : ''}`))
      .join('\n');
  }
}

/** Convenience namespace for call sites: `diag.log(...)`. */
export const diag = {
  log,
  snapshot,
  isEnabled,
  boundsOf,
  isRectOnScreen,
};

/**
 * Test-only: make servers that listen on an OS-assigned port bind to
 * 127.0.0.1 instead of the wildcard address.
 *
 * supertest's `request(app)` runs `app.listen(0)` — a wildcard bind — and then
 * sends the request to 127.0.0.1:<port>. On macOS the kernel may assign a port
 * that another process already holds on 127.0.0.1 specifically (editors, API
 * clients, local model servers), and that more specific listener receives the
 * request. The test then sees a response from a stranger, typically a 404.
 * With thousands of requests per run, that produced a couple of random
 * failures in most full runs.
 *
 * Binding 127.0.0.1 makes ours the most specific listener for loopback
 * traffic, and the kernel will not assign a port already held on 127.0.0.1.
 * Calls that name a host, a non-zero port, a pipe or a handle are untouched.
 *
 * The bind must stay synchronous: supertest reads `server.address().port`
 * straight after `listen(0)`. Node's public `listen(port, host)` resolves the
 * host asynchronously, so this uses the long-standing internal
 * `Server.prototype._listen2(address, port, addressType, backlog)`, the same
 * call a host-less `listen()` makes with a null address. If a future Node
 * drops it, listen() falls back to its normal behaviour and
 * setupLoopbackListen.test.ts fails to flag it.
 */

import net from 'net';

const LOOPBACK_HOST = '127.0.0.1';
const IPV4 = 4;
const DEFAULT_BACKLOG = 511;
const PATCHED = Symbol.for('eurorails.test.loopbackListen');

type ListenCallback = () => void;
type ListenFn = (this: net.Server, ...args: unknown[]) => net.Server;
type SyncListenFn = (this: net.Server, address: string, port: number, addressType: number, backlog: number) => void;
type PatchableServerPrototype = { listen: ListenFn; _listen2?: SyncListenFn; [PATCHED]?: boolean };

/**
 * If `args` are a host-less listen on an OS-assigned port — listen(),
 * listen(cb), listen(0), listen(0, cb) — return its callback (or null when
 * there is none). Any other call shape returns undefined and is left alone.
 */
export function ephemeralListenCallback(args: unknown[]): ListenCallback | null | undefined {
  const rest = args[0] === 0 ? args.slice(1) : args;
  if (rest.length === 0) {
    return null;
  }
  if (rest.length === 1 && typeof rest[0] === 'function') {
    return rest[0] as ListenCallback;
  }
  return undefined;
}

const serverPrototype = net.Server.prototype as unknown as PatchableServerPrototype;

// setupFiles run once per test file against the same core module; patch once.
if (!serverPrototype[PATCHED]) {
  const originalListen = serverPrototype.listen;
  serverPrototype.listen = function listenOnLoopback(this: net.Server, ...args: unknown[]): net.Server {
    const callback = ephemeralListenCallback(args);
    const listenSync = serverPrototype._listen2;
    if (callback === undefined || typeof listenSync !== 'function' || this.listening) {
      return originalListen.apply(this, args);
    }
    if (callback) {
      this.once('listening', callback);
    }
    listenSync.call(this, LOOPBACK_HOST, 0, IPV4, DEFAULT_BACKLOG);
    return this;
  };
  serverPrototype[PATCHED] = true;
}

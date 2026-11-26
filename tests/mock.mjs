// Runs the real Worker (worker.js) in Node with stand-ins for Cloudflare's storage and its sleeping WebSockets, for tests.
// It exercises the Worker's own rules; what it cannot check is Cloudflare itself (deploying, a real connection).
import worker, { Space } from '../worker.js';
const spaces = new Map();
function storage() {
  const m = new Map(), copy = v => (v === undefined ? undefined : structuredClone(v));
  return {
    get: async k => copy(m.get(k)),
    put: async (k, v) => { m.set(k, copy(v)); },
    delete: async k => { for (const x of [].concat(k)) m.delete(x); },
    deleteAll: async () => { m.clear(); },
    list: async ({ prefix = '' } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, copy(v)])),
    keys: () => [...m.keys()].sort()   // not Cloudflare's: for a test to see what a space keeps
  };
}
/* One end of a socket. What it sends, the other end hears a moment later, as on a real line. The Worker's end is handed
   to acceptWebSocket, which sets `hears` and `ended`; the page's end has onmessage and onclose, like a browser's. */
class End {
  constructor() { this.peer = null; this.closed = null; this.tags = []; this.kept = null; }
  serializeAttachment(v) { this.kept = structuredClone(v); }
  deserializeAttachment() { return this.kept; }
  send(message) {
    if (this.closed) throw new Error('this socket is closed');
    const to = this.peer;
    queueMicrotask(() => { if (to.closed) return; if (to.hears) to.hears(message); else if (to.onmessage) to.onmessage({ data: message }); });
  }
  close(code = 1005, reason = '') {
    if (this.closed) return;
    const to = this.peer; this.closed = { code, reason };
    if (to.closed) return;
    to.closed = { code, reason };
    if (to.ended) to.ended(code); else if (to.onclose) to.onclose({ code, reason });
  }
}
/* Node has neither of these, and refuses to make a Response with status 101, which is how a Worker hands a socket back */
globalThis.WebSocketPair = class { constructor() { this[0] = new End(); this[1] = new End(); this[0].peer = this[1]; this[1].peer = this[0]; } };
globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { this.request = request; this.response = response; } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, init) {
    if (!init || init.status !== 101) { super(body, init); return; }
    super(null, { status: 200, headers: init.headers });
    Object.defineProperty(this, 'status', { value: 101 }); this.webSocket = init.webSocket;
  }
};
/* what Cloudflare gives a Durable Object: its storage, and the sockets it accepted, which outlive its sleep */
function context() {
  const held = [];
  const ctx = {
    storage: storage(), space: null, auto: null,
    acceptWebSocket(ws, tags = []) {
      ws.tags = tags; held.push(ws);
      ws.hears = message => { if (ctx.auto && message === ctx.auto.request) ws.send(ctx.auto.response); else ctx.space.webSocketMessage(ws, message); };
      ws.ended = code => ctx.space.webSocketClose(ws, code);
    },
    getWebSockets(tag) { return held.filter(ws => !ws.closed && (tag === undefined || ws.tags.includes(tag))); },
    setWebSocketAutoResponse(pair) { ctx.auto = pair; }
  };
  return ctx;
}
export const env = {
  SPACES: {
    idFromName: name => name,
    get: name => { if (!spaces.has(name)) { const ctx = context(); ctx.space = new Space(ctx, env); spaces.set(name, ctx.space); } return spaces.get(name); }
  }
};
export default function mockFetch(url, init = {}) { return worker.fetch(new Request(url, init), env); }
/* the storage keys a space holds (its name, plus a line break and the read key for a keyed one) */
export const stored = name => (spaces.has(name) ? spaces.get(name).store.keys() : []);
/* A WebSocket as a page has one, connected to the mock: pass it to the client as its `WebSocket`. `refused` is the
   status the store answered with when it would not open one. */
export class Socket {
  constructor(url, headers) {
    this.end = null; this.refused = null; this.done = false;
    mockFetch(String(url).replace(/^ws/, 'http'), { headers: Object.assign({ Upgrade: 'websocket' }, headers) }).then(r => {
      if (r.status !== 101) { this.refused = r.status; this.done = true; if (this.onclose) this.onclose({ code: 1006 }); return; }
      this.end = r.webSocket;
      if (this.done) { this.end.close(1000); return; }
      this.end.onmessage = e => { if (this.onmessage) this.onmessage(e); };
      this.end.onclose = e => { this.done = true; if (this.onclose) this.onclose(e); };
      if (this.onopen) this.onopen();
    });
  }
  send(message) { this.end.send(message); }
  close() {
    if (this.done) return;
    this.done = true; if (this.end) this.end.close(1000);
    queueMicrotask(() => { if (this.onclose) this.onclose({ code: 1000 }); });
  }
}
/* open a listener and wait until it is open or refused; `heard` collects what arrives, `closed` how it ended */
export function listen(url, headers) {
  return new Promise(done => {
    const s = new Socket(url, headers); s.heard = []; s.closed = null;
    s.onmessage = e => s.heard.push(e.data); s.onopen = () => done(s); s.onclose = e => { s.closed = e; done(s); };
  });
}

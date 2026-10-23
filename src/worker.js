// Cloudflare entry point. Static files come from public/ (Workers assets); the worker only handles
// "/" (to inject the Google client id) and "/ws", which goes to one global Durable Object running the game.
import { DurableObject } from 'cloudflare:workers';
import { createCore } from './core.js';
import { verifyGoogleIdToken } from './google.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      // shortcut: one Durable Object holds every player and match; shard by region or rating band if it ever saturates.
      return env.GAME.get(env.GAME.idFromName('global')).fetch(req);
    }
    const res = await env.ASSETS.fetch(req);
    if (url.pathname !== '/' || !res.headers.get('content-type')?.startsWith('text/html')) return res;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('cache-control', 'no-cache');
    return new Response((await res.text()).replace('%GOOGLE_CLIENT_ID%', env.GOOGLE_CLIENT_ID || ''), { status: res.status, headers });
  },
};

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.conns = new WeakMap(); // WebSocket -> conn
    const clientId = env.GOOGLE_CLIENT_ID || '';
    this.core = createCore({ sql: ctx.storage.sql, clientId, verifyGoogle: token => verifyGoogleIdToken(token, clientId) });
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.core.restore(ctx.getWebSockets().map(ws => this.conn(ws)));
  }

  conn(ws) {
    let c = this.conns.get(ws);
    if (!c) {
      c = {
        data: { id: ws.deserializeAttachment()?.id ?? null },
        send: obj => { try { ws.send(JSON.stringify(obj)); } catch {} },
        close: () => { try { ws.close(4000, 'kicked'); } catch {} },
        // The player id must survive hibernation; match state never does (a live match keeps timers running).
        persist: () => ws.serializeAttachment({ id: c.data.id }),
      };
      this.conns.set(ws, c);
    }
    return c;
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) { await this.core.message(this.conn(ws), msg); }
  webSocketClose(ws) { this.core.close(this.conn(ws)); }
  webSocketError(ws) { this.core.close(this.conn(ws)); }
}

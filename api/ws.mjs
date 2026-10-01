import { createServer } from "http";
import { WebSocketServer } from "ws";

// In-memory state. Lives only as long as this function instance does.
const sockets = new Map(); // userId -> ws
const queues = new Map();  // userId -> [{ id, from, text, ts }]

const TTL_MS = 24 * 60 * 60 * 1000; // drop undelivered messages after 24h
const MAX_QUEUE = 200;              // max undelivered messages per user
const MAX_TEXT = 2000;
const MAX_IMG = 450_000;              // one image (data URL length), client shrinks to under 400k
const MAX_QUEUE_BYTES = 8_000_000;    // total waiting data per user
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const sizeOf = (m) => m.text.length + (m.image ? m.image.length : 0);

const server = createServer((req, res) => {
  res.statusCode = 426;
  res.end("Use a WebSocket connection");
});
const wss = new WebSocketServer({ server, maxPayload: 1_000_000 });

function put(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function prune(userId) {
  const q = queues.get(userId);
  if (!q) return [];
  const fresh = q.filter((m) => Date.now() - m.ts < TTL_MS);
  queues.set(userId, fresh);
  return fresh;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const me = (url.searchParams.get("user") || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,20}$/.test(me)) {
    put(ws, { type: "error", reason: "Use 2 to 20 letters, numbers, - or _" });
    return ws.close();
  }

  // One tab per user for this simple version: newest connection wins.
  const old = sockets.get(me);
  if (old && old !== ws) old.close();
  sockets.set(me, ws);

  put(ws, { type: "ready", me });

  // Flush everything still waiting for this user.
  for (const m of prune(me)) put(ws, { type: "msg", ...m });

  ws.on("message", (raw) => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }

    if (d.type === "ping") return put(ws, { type: "pong" });

    if (d.type === "send") {
      const to = String(d.to || "").trim().toLowerCase();
      const text = String(d.text || "").slice(0, MAX_TEXT);
      const id = String(d.id || "");
      const image = typeof d.image === "string" && d.image.length <= MAX_IMG && IMG_RE.test(d.image) ? d.image : undefined;
      if (!id || !to || (!text && !image)) return;

      const q = prune(to);
      // Duplicate resend from the sender: just confirm again.
      if (!q.some((m) => m.id === id)) {
        if (q.length >= MAX_QUEUE) q.shift();
        const msg = { id, from: me, text, ts: Date.now(), image };
        q.push(msg);
        while (q.length > 1 && q.reduce((n, m) => n + sizeOf(m), 0) > MAX_QUEUE_BYTES) q.shift();
        queues.set(to, q);
        put(sockets.get(to), { type: "msg", ...msg });
      }
      return put(ws, { type: "sent", id });
    }

    // Receiver confirms it got the message: remove from queue, tell sender.
    if (d.type === "ack") {
      const id = String(d.id || "");
      const q = queues.get(me) || [];
      const msg = q.find((m) => m.id === id);
      if (!msg) return;
      queues.set(me, q.filter((m) => m.id !== id));
      put(sockets.get(msg.from), { type: "delivered", id });
    }
  });

  ws.on("close", () => {
    if (sockets.get(me) === ws) sockets.delete(me);
  });
});

export default server;

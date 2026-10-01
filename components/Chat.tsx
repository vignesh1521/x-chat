"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "./chat.css";

type Status = "sending" | "sent" | "delivered" | "received";
type Msg = { id: string; from: string; to: string; text: string; ts: number; status: Status; image?: string; hadImage?: boolean };

const NAME_RE = /^[a-z0-9_-]{2,20}$/;
const RANK: Record<Status, number> = { sending: 0, sent: 1, delivered: 2, received: 3 };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const MAX_IMG = 400_000; // max size of one image, in characters of its data URL
const IMG_OK = /^data:image\/(jpeg|png|webp|gif);base64,/;

// localStorage is small (about 5 MB). If it fills up, drop old images first so text history survives.
function saveHistory(key: string, list: Msg[]) {
  let items = list.slice(-500);
  const attempt = () => {
    try {
      localStorage.setItem(key, JSON.stringify(items));
      return true;
    } catch {
      return false;
    }
  };
  if (attempt()) return;
  for (const keep of [8, 3, 0]) {
    let kept = 0;
    items = [...items]
      .reverse()
      .map((m) => {
        if (!m.image) return m;
        if (kept < keep) {
          kept++;
          return m;
        }
        return { ...m, image: undefined, hadImage: true };
      })
      .reverse();
    if (attempt()) return;
  }
}

// Shrink any image to a JPEG under MAX_IMG so it is cheap to send and store.
async function toJpeg(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  let max = 1280;
  let q = 0.8;
  for (let i = 0; i < 6; i++) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const out = c.toDataURL("image/jpeg", q);
    if (out.length <= MAX_IMG) {
      bmp.close();
      return out;
    }
    max = Math.round(max * 0.75);
    q = Math.max(0.5, q - 0.1);
  }
  bmp.close();
  throw new Error("too big");
}

// crypto.randomUUID only exists on https or localhost, so fall back when it is missing.
function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function Ticks({ status }: { status: Status }) {
  if (status === "sending") {
    return (
      <svg className="xc-ticks" viewBox="0 0 16 16" width="13" height="13" role="img" aria-label="Sending">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.6V8l2.3 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const done = status === "delivered";
  return (
    <svg className={"xc-ticks" + (done ? " done" : "")} viewBox="0 0 17 11" width="17" height="11" role="img" aria-label={done ? "Delivered" : "Sent"}>
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1.5 5.9 4.5 8.9 10.2 1.9" />
        {done && <path d="M6 8.3 6.6 8.9 12.3 1.9" />}
      </g>
    </svg>
  );
}

function clock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function listTime(ts: number) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? clock(ts)
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export default function Chat({ me }: { me: string }) {
  const valid = NAME_RE.test(me);
  const [online, setOnline] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [reads, setReads] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newErr, setNewErr] = useState("");
  const [draftImg, setDraftImg] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const seen = useRef(new Set<string>());
  const logRef = useRef<HTMLDivElement>(null);

  function commit(next: Msg[]) {
    msgsRef.current = next;
    setMsgs(next);
    saveHistory("chat:history:" + me, next);
  }

  function advance(id: string, status: Status) {
    const m = msgsRef.current.find((x) => x.id === id);
    if (!m || RANK[status] <= RANK[m.status]) return; // never move backwards
    commit(msgsRef.current.map((x) => (x.id === id ? { ...x, status } : x)));
  }

  useEffect(() => {
    if (!valid) return;
    const history = load<Msg[]>("chat:history:" + me, []);
    msgsRef.current = history;
    setMsgs(history);
    setReads(load("chat:read:" + me, {}));
    seen.current = new Set(history.map((m) => m.id));

    let closed = false;
    let retry = 0;
    let ping: ReturnType<typeof setInterval>;
    let timer: ReturnType<typeof setTimeout>;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const isLocal = location.hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname);
    const base = isLocal ? `${proto}://${location.hostname}:3001` : `${proto}://${location.host}/api/ws`;

    const connect = () => {
      const ws = new WebSocket(`${base}?user=${encodeURIComponent(me)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setOnline(true);
        // Resend anything the server never confirmed (covers restarts and deploys).
        msgsRef.current
          .filter((m) => m.from === me && m.status === "sending")
          .forEach((m) => ws.send(JSON.stringify({ type: "send", id: m.id, to: m.to, text: m.text, image: m.image })));
        ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25000);
      };

      ws.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.type === "msg") {
          ws.send(JSON.stringify({ type: "ack", id: d.id })); // always ack, even duplicates
          if (!seen.current.has(d.id)) {
            seen.current.add(d.id);
            commit([...msgsRef.current, { id: d.id, from: d.from, to: me, text: d.text, ts: d.ts, status: "received", image: d.image }]);
          }
        }
        if (d.type === "sent") advance(d.id, "sent");
        if (d.type === "delivered") advance(d.id, "delivered");
      };

      ws.onclose = () => {
        clearInterval(ping);
        setOnline(false);
        if (!closed) timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
    };

    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [me, valid]);

  // Chat list: one row per person, newest conversation first.
  const convos = useMemo(() => {
    const map = new Map<string, { peer: string; last: Msg; unread: number }>();
    for (const m of msgs) {
      const peer = m.from === me ? m.to : m.from;
      const unread = m.from !== me && m.ts > (reads[peer] ?? 0) ? 1 : 0;
      const prev = map.get(peer);
      map.set(peer, { peer, last: m, unread: (prev?.unread ?? 0) + unread });
    }
    return [...map.values()].sort((a, b) => b.last.ts - a.last.ts);
  }, [msgs, reads, me]);

  const rows = active ? msgs.filter((m) => m.from === active || m.to === active) : [];

  // Opening a chat (or getting a message in the open chat) marks it as read.
  useEffect(() => {
    if (!active) return;
    const latest = Math.max(0, ...msgs.filter((m) => m.from === active).map((m) => m.ts));
    if (latest > (reads[active] ?? 0)) {
      const next = { ...reads, [active]: latest };
      setReads(next);
      save("chat:read:" + me, next);
    }
  }, [active, msgs, reads, me]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [rows.length, active]);

  // Esc closes the full-size image.
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  function startChat(e: React.FormEvent) {
    e.preventDefault();
    const n = newName.trim().toLowerCase();
    if (!NAME_RE.test(n)) return setNewErr("Use 2 to 20 letters, numbers, - or _");
    if (n === me) return setNewErr("That is your own name");
    setNewErr("");
    setNewName("");
    setAdding(false);
    setActive(n);
  }

  async function addFile(file?: File) {
    if (!file || !file.type.startsWith("image/")) return;
    setImgErr("");
    try {
      setDraftImg(await toJpeg(file));
    } catch {
      setImgErr("Could not use that image. Try a smaller one.");
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/"));
    if (f) {
      e.preventDefault();
      addFile(f);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if ((!body && !draftImg) || !active) return;
    const m: Msg = { id: newId(), from: me, to: active, text: body, ts: Date.now(), status: "sending", image: draftImg ?? undefined };
    seen.current.add(m.id);
    commit([...msgsRef.current, m]);
    setText("");
    setDraftImg(null);
    setImgErr("");
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "send", id: m.id, to: m.to, text: m.text, image: m.image }));
  }

  if (!valid) {
    return (
      <div className="xc-root xc-center">
        <div className="xc-login">
          <h1>That name will not work</h1>
          <p>Use 2 to 20 letters, numbers, - or _ in the address, for example /vicky.</p>
          <a className="xc-btn" href="/">Go back</a>
        </div>
      </div>
    );
  }

  return (
    <div className={"xc-root" + (active ? " chat-open" : "")}>
      <aside className="xc-side">
        <div className="xc-bar">
          <div className="xc-avatar">{me[0]}</div>
          <div className="xc-bar-name">
            <strong>{me}</strong>
            <span className="xc-status">
              <span className={"xc-dot" + (online ? " on" : "")} />
              {online ? "Online" : "Connecting"}
            </span>
          </div>
          <button className="xc-icon" onClick={() => setAdding((v) => !v)} aria-label="New chat" title="New chat">+</button>
        </div>

        {adding && (
          <form className="xc-new" onSubmit={startChat}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Username to chat with" maxLength={20} autoComplete="off" autoFocus />
            <button>Start</button>
            {newErr && <div className="xc-err">{newErr}</div>}
          </form>
        )}

        <div className="xc-list">
          {!convos.length && <div className="xc-empty">No chats yet. Press + and enter a username to start one.</div>}
          {convos.map((c) => (
            <button key={c.peer} className={"xc-row" + (active === c.peer ? " sel" : "")} onClick={() => setActive(c.peer)}>
              <div className="xc-avatar">{c.peer[0]}</div>
              <div className="xc-row-body">
                <div className="xc-row-top">
                  <span className="xc-row-name">{c.peer}</span>
                  <span className={"xc-row-time" + (c.unread && active !== c.peer ? " new" : "")}>{listTime(c.last.ts)}</span>
                </div>
                <div className="xc-row-bottom">
                  <span className="xc-row-last">
                    {c.last.from === me && <Ticks status={c.last.status} />}
                    {c.last.image || c.last.hadImage ? `📷 ${c.last.text || "Photo"}` : c.last.text}
                  </span>
                  {c.unread > 0 && active !== c.peer && <span className="xc-badge">{c.unread}</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main
        className="xc-main"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (active) addFile(e.dataTransfer.files[0]);
        }}
      >
        {!active ? (
          <div className="xc-empty big">Pick a chat from the list to start messaging.</div>
        ) : (
          <>
            <div className="xc-bar">
              <button className="xc-icon xc-back" onClick={() => setActive(null)} aria-label="Back to chats">‹</button>
              <div className="xc-avatar">{active[0]}</div>
              <div className="xc-bar-name"><strong>{active}</strong></div>
            </div>
            <div className="xc-log" ref={logRef}>
              {!rows.length && <div className="xc-empty">No messages with {active} yet. Say hi.</div>}
              {rows.map((m) => {
                const mine = m.from === me;
                const src = m.image && IMG_OK.test(m.image) ? m.image : null;
                return (
                  <div key={m.id} className={"xc-m" + (mine ? " me" : "") + (src ? " has-pic" : "")}>
                    {src && <img className="xc-pic" src={src} alt="Sent image" onClick={() => setZoom(src)} />}
                    {!src && m.hadImage && <div className="xc-gone">Image no longer stored on this device</div>}
                    {m.text && <div className="xc-text">{m.text}</div>}
                    <span className="xc-meta">
                      {clock(m.ts)}
                      {mine && <Ticks status={m.status} />}
                    </span>
                  </div>
                );
              })}
            </div>
            <form className="xc-send" onSubmit={send}>
              {draftImg && (
                <div className="xc-draft">
                  <img src={draftImg} alt="Image to send" />
                  <button type="button" className="xc-x" onClick={() => setDraftImg(null)} aria-label="Remove image">×</button>
                </div>
              )}
              {imgErr && <div className="xc-err">{imgErr}</div>}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  addFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <button type="button" className="xc-icon xc-attach" onClick={() => fileRef.current?.click()} aria-label="Attach image" title="Attach image">📎</button>
              <input value={text} onChange={(e) => setText(e.target.value)} onPaste={onPaste} placeholder="Type a message or paste an image" autoComplete="off" maxLength={2000} />
              <button>Send</button>
            </form>
          </>
        )}
      </main>
      {zoom && (
        <div className="xc-zoom" onClick={() => setZoom(null)}>
          <button className="xc-zoom-x" onClick={() => setZoom(null)} aria-label="Close image">×</button>
          <img src={zoom} alt="Full size" />
        </div>
      )}
    </div>
  );
}
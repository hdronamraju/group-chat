// Group chat prototype: humans + one LLM in a shared room.
// One file, no framework: plain node:http, Server-Sent Events for realtime,
// rooms kept in memory and snapshotted to data/rooms.json.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.MODEL || "claude-opus-5-5";
const DATA_FILE = path.join(here, "data", "rooms.json");
const AUTO_TURNS = Number(process.env.AUTO_TURNS || 6); // AI-to-AI turns per burst

const DEFAULT_PROMPT =
  "You are a helpful assistant participating in a group chat. Be concise and conversational.";

const client = new Anthropic();

// ---- Room state ---------------------------------------------------------

/** @type {Map<string, {id:string, systemPrompt:string, ais:{name:string, persona:string}[], autoChat:boolean, messages:any[], createdAt:number}>} */
const rooms = new Map();
/** room id -> Set of SSE responses */
const listeners = new Map();
/** room id -> { busy, pending } so the AI answers one turn at a time */
const aiState = new Map();

try {
  for (const r of JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))) {
    r.ais ??= [{ name: "Claude", persona: "" }]; // rooms saved before multi-AI support
    r.autoChat ??= false;
    rooms.set(r.id, r);
  }
} catch {}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...rooms.values()]));
  }, 200);
}

function broadcast(roomId, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners.get(roomId) ?? []) res.write(payload);
}

function addMessage(room, msg) {
  const full = { id: crypto.randomUUID(), at: Date.now(), ...msg };
  room.messages.push(full);
  broadcast(room.id, "message", full);
  save();
  return full;
}

function presence(roomId) {
  const names = [...(listeners.get(roomId) ?? [])].map((r) => r.userName);
  broadcast(roomId, "presence", [...new Set(names)]);
}

// ---- LLM ----------------------------------------------------------------

// The Messages API wants alternating user/assistant turns, so consecutive
// human messages (from either person) are folded into one user turn, each
// line tagged with who said it.
// Other AIs' messages are "user" turns too, tagged with their name.
function toApiMessages(room, ai) {
  const out = [];
  for (const m of room.messages) {
    if (m.kind === "system-note" || m.error) continue;
    const role = m.kind === "ai" && m.author === ai.name ? "assistant" : "user";
    const text = role === "user" ? `[${m.author}]: ${m.text}` : m.text;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += "\n" + text;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function systemPrompt(room, ai) {
  const others = room.ais.filter((a) => a.name !== ai.name).map((a) => a.name);
  return (
    `${room.systemPrompt}\n\n` +
    (ai.persona ? `Your persona: ${ai.persona}\n\n` : "") +
    `You are "${ai.name}" in a shared chat room with more than one human. ` +
    (others.length
      ? `Another AI, ${others.join(", ")}, is also in the room; you may talk with it directly. `
      : "") +
    `Each other participant's message is prefixed with the sender's name in brackets, like "[Name]: ...". ` +
    `Address people by name when it helps. Do not prefix your own replies with a name.`
  );
}

// Humans get an answer from every AI in turn. With auto-chat on, the AIs then
// keep replying to each other for up to AUTO_TURNS turns (or until stopped).
async function runAi(room, { banterOnly = false } = {}) {
  const state = aiState.get(room.id) ?? { busy: false, pending: false };
  aiState.set(room.id, state);
  if (state.busy) {
    if (!banterOnly) state.pending = true; // answer again once the current reply finishes
    return;
  }
  state.busy = true;
  try {
    let skipHumans = banterOnly;
    do {
      state.pending = false;
      let last = null;
      if (!skipHumans) {
        for (const ai of [...room.ais]) {
          await respond(room, ai);
          last = ai;
          if (state.pending) break;
        }
      }
      skipHumans = false;
      if (state.pending) continue;
      last ??= [...room.messages].reverse().find((m) => m.kind === "ai");
      for (let i = 0; room.autoChat && room.ais.length > 1 && i < AUTO_TURNS && !state.pending; i++) {
        const idx = room.ais.findIndex((a) => a.name === last?.name || a.name === last?.author);
        const next = room.ais[(idx + 1) % room.ais.length];
        await respond(room, next);
        last = next;
      }
    } while (state.pending);
  } finally {
    state.busy = false;
    broadcast(room.id, "ai-idle", {});
  }
}

async function respond(room, ai) {
  if (!toApiMessages(room, ai).length) return; // nothing to answer yet
  const id = crypto.randomUUID();
  broadcast(room.id, "ai-start", { id, author: ai.name });
  let text = "";
  let error = false;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: systemPrompt(room, ai),
      messages: toApiMessages(room, ai),
      output_config: { effort: "low" },
      // If a safety classifier declines, the API retries on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    stream.on("text", (delta) => {
      text += delta;
      broadcast(room.id, "ai-delta", { id, delta });
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      text ||= "(I can't help with that one.)";
    }
  } catch (err) {
    console.error("LLM error:", err);
    text = `(Error talking to the model: ${err.message})`;
    error = true;
  }
  const msg = { id, at: Date.now(), kind: "ai", author: ai.name, text: text.trim(), ...(error && { error }) };
  room.messages.push(msg);
  broadcast(room.id, "ai-done", msg);
  save();
}

// ---- HTTP ---------------------------------------------------------------

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const clean = (s, max) => String(s ?? "").trim().slice(0, max);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  // Pages: "/" (create) and "/r/:id" (room) both serve the single-page app.
  if (req.method === "GET" && (parts.length === 0 || parts[0] === "r")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(here, "public", "index.html")).pipe(res);
  }

  if (parts[0] !== "api") return json(res, 404, { error: "not found" });

  // POST /api/rooms -> create a room
  if (req.method === "POST" && parts[1] === "rooms" && parts.length === 2) {
    const room = {
      id: crypto.randomBytes(6).toString("base64url"),
      systemPrompt: DEFAULT_PROMPT,
      ais: [{ name: "Claude", persona: "" }],
      autoChat: false,
      messages: [],
      createdAt: Date.now(),
    };
    rooms.set(room.id, room);
    save();
    return json(res, 201, { id: room.id });
  }

  const room = rooms.get(parts[2]);
  if (parts[1] !== "rooms" || !room) return json(res, 404, { error: "room not found" });
  const action = parts[3];

  // GET /api/rooms/:id -> snapshot
  if (req.method === "GET" && !action) {
    return json(res, 200, {
      id: room.id, systemPrompt: room.systemPrompt, ais: room.ais, autoChat: room.autoChat,
      messages: room.messages,
    });
  }

  // GET /api/rooms/:id/events?name=... -> SSE stream
  if (req.method === "GET" && action === "events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.userName = clean(url.searchParams.get("name"), 40) || "Someone";
    res.write(": connected\n\n");
    if (!listeners.has(room.id)) listeners.set(room.id, new Set());
    listeners.get(room.id).add(res);
    presence(room.id);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      listeners.get(room.id)?.delete(res);
      presence(room.id);
    });
    return;
  }

  // POST /api/rooms/:id/messages {author, text}
  if (req.method === "POST" && action === "messages") {
    const body = await readBody(req);
    const text = clean(body.text, 8000);
    const author = clean(body.author, 40);
    if (!text || !author) return json(res, 400, { error: "author and text required" });
    addMessage(room, { kind: "human", author, text });
    json(res, 202, { ok: true });
    runAi(room);
    return;
  }

  // PUT /api/rooms/:id/system-prompt {author, systemPrompt}
  if (req.method === "PUT" && action === "system-prompt") {
    const body = await readBody(req);
    const prompt = clean(body.systemPrompt, 8000);
    const author = clean(body.author, 40) || "Someone";
    if (!prompt) return json(res, 400, { error: "systemPrompt required" });
    room.systemPrompt = prompt;
    broadcast(room.id, "system-prompt", { systemPrompt: prompt });
    addMessage(room, { kind: "system-note", author, text: `${author} updated the system prompt` });
    return json(res, 200, { ok: true });
  }

  // PUT /api/rooms/:id/ais {author, ais:[{name, persona}], autoChat}
  if (req.method === "PUT" && action === "ais") {
    const body = await readBody(req);
    const author = clean(body.author, 40) || "Someone";
    const ais = (Array.isArray(body.ais) ? body.ais : []).slice(0, 2).map((a) => ({
      name: clean(a?.name, 30), persona: clean(a?.persona, 2000),
    }));
    const names = new Set(ais.map((a) => a.name.toLowerCase()));
    if (!ais.length || names.size !== ais.length || names.has("")) {
      return json(res, 400, { error: "each AI needs a unique name" });
    }
    const was = room.ais.length;
    room.ais = ais;
    room.autoChat = Boolean(body.autoChat) && ais.length > 1;
    broadcast(room.id, "settings", { ais: room.ais, autoChat: room.autoChat });
    addMessage(room, {
      kind: "system-note", author,
      text: `${author} updated the AIs (${ais.map((a) => a.name).join(" + ")}${room.autoChat ? ", auto-chat on" : ""})`,
    });
    json(res, 200, { ok: true });
    if (ais.length > was) runAi(room, { banterOnly: true });
    return;
  }

  // POST /api/rooms/:id/auto {on, author} -> toggle auto-chat; turning it on runs a burst
  if (req.method === "POST" && action === "auto") {
    const body = await readBody(req);
    room.autoChat = Boolean(body.on) && room.ais.length > 1;
    broadcast(room.id, "settings", { ais: room.ais, autoChat: room.autoChat });
    json(res, 200, { ok: true });
    if (room.autoChat) runAi(room, { banterOnly: true });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Group chat running at http://localhost:${PORT}  (model: ${MODEL})`);
});

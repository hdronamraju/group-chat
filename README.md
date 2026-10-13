# Group Chat

A pared-down prototype: two humans and Claude in one shared conversation.

- Human A opens `/`, enters a name, and creates a chat. They can start talking to Claude right away.
- **Copy invite link** copies the room's URL (`/r/<id>`). Human B opens it, enters a name, and joins — they see the full history.
- Everyone sees messages and Claude's replies stream in live. Claude sees every human message tagged with the sender's name.
- Anyone can open **System prompt** to change Claude's instructions. A note in the chat records who changed it.

## Run

```bash
npm install
cp .env.example .env   # then paste your ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

To let someone on another machine join, expose the port, e.g. `ngrok http 3000`, and share the ngrok URL.

## How it works

- `server.js` — plain `node:http`. Rooms live in memory and are snapshotted to `data/rooms.json`. Clients get updates over Server-Sent Events.
- `public/index.html` — the whole UI, no build step.
- Claude replies to every human message. If messages arrive while it's still replying, it answers them together in one follow-up.
- Model defaults to `claude-opus-5-5` at low effort (set `MODEL` to change). Server-side refusal fallbacks are enabled.
- No auth: anyone with the link can join. Names are self-declared.

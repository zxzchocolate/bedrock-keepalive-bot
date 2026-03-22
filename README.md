# ⛏ Bedrock Keep-Alive Bot

A Minecraft Bedrock Edition keep-alive bot that maintains a persistent connection to prevent your server from sleeping. Includes a local web dashboard at `http://localhost:3000`.

---

## Features

- 🚀 **Setup wizard** — prompts for your server address, port, and version on first run (no hardcoded defaults)
- 🌐 **Web dashboard** — setup screen + live stats, log feed, and command buttons at `localhost:3000`
- 🔄 Auto-reconnects with exponential backoff
- 💓 Keep-alive packets to prevent server timeout
- 📋 Session stats (attempts, disconnects, errors, keep-alives sent)
- 📡 Ping tracker with history
- 📝 Rotating log file (`bot.log`, max 5 MB)

---

## Requirements

- [Node.js](https://nodejs.org) v18 or higher
- A Minecraft Bedrock server

---

## Setup

```bash
# 1. Clone the repo
git clone https://https://github.com/zxzchocolate/bedrock-keepalive-bot.git
cd bedrock-keepalive-bot

# 2. Install dependencies
npm install

# 3. Start the bot
npm start
```

On first run you will be prompted in the terminal:

```
  ╔══════════════════════════════════════════╗
  ║   ⛏  Bedrock Keep-Alive Bot              ║
  ║      Web dashboard → localhost:3000      ║
  ╚══════════════════════════════════════════╝

  Server address : play.yourserver.com
  Server port [19132] : 25565
  Bedrock version [1.21.0] : 1.26.0
```

Then open **http://localhost:3000** — the dashboard also has its own setup screen so you can configure and launch the connection from the browser if you prefer.

---

## Configuration via Environment Variables

You can skip the prompts entirely by setting these before running:

| Variable | Description | Example |
|---|---|---|
| `BOT_HOST` | Server hostname | `play.yourserver.com` |
| `BOT_PORT` | Server port | `19132` |
| `BOT_VERSION` | Bedrock protocol version | `1.26.0` |

Copy `.env.example` to `.env` and fill it in, then run `npm start`.

---

## Terminal Commands

| Command | Description |
|---|---|
| `status` | Show connection stats |
| `reconnect` | Force reconnect immediately |
| `settings` | View current config |
| `setname <n>` | Fix the bot's username |
| `setname random` | Go back to random names |
| `setdelay <ms>` | Change reconnect delay (500–300000) |
| `ping` | Send a ping and show RTT |
| `history` | Show ping history bar chart |
| `silent` | Toggle keep-alive log spam on/off |
| `clearlog` | Wipe the log file |
| `uptime` | Show how long the bot has been running |
| `pause` | Pause auto-reconnect |
| `resume` | Resume auto-reconnect |
| `rename` | Pick a new random name and reconnect |
| `stop` | Shut down the bot |
| `help` | List all commands |

All commands are also available as buttons in the web dashboard.

---

## Notes

- Runs in **offline mode** — no Microsoft account required
- The dashboard is bound to `127.0.0.1` — it is **not** accessible from outside your machine
- Log file rotates automatically at 5 MB
- To find your server's Bedrock version, connect with the Minecraft client and check the version shown in the server list

---

## License

MIT

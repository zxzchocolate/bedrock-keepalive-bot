const { createClient } = require('bedrock-protocol');
const readline = require('readline');
const http = require('http');
const fs = require('fs');

// ─── Configuration (no defaults for host/port — user must enter them) ─────────

const CONFIG = {
  host: process.env.BOT_HOST || null,
  port: process.env.BOT_PORT ? parseInt(process.env.BOT_PORT) : null,
  version: process.env.BOT_VERSION || '1.21.0',
  reconnectDelay: 3000,
  errorRetryDelay: 15000,
  keepAliveInterval: 15000,
  logToFile: true,
  logFile: 'bot.log',
  maxLogSizeMB: 5,
};

// ─── Log Levels ───────────────────────────────────────────────────────────────

const LOG_LEVELS = {
  INFO: '📋', SUCCESS: '✅', WARN: '⚠️ ',
  ERROR: '❌', GAME: '🎮', NET: '🔄', PULSE: '💓', STOP: '🛑',
};

// ─── Log Buffer (for dashboard) ───────────────────────────────────────────────

const logBuffer = [];
const MAX_LOG_BUFFER = 200;

function log(level, message) {
  const icon = LOG_LEVELS[level] || '•';
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${icon}  ${message}`;
  console.log(line);
  logBuffer.push({ timestamp, level, icon, message });
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
  if (CONFIG.logToFile) {
    try {
      if (fs.existsSync(CONFIG.logFile)) {
        const s = fs.statSync(CONFIG.logFile);
        if (s.size > CONFIG.maxLogSizeMB * 1024 * 1024)
          fs.renameSync(CONFIG.logFile, CONFIG.logFile + '.old');
      }
      fs.appendFileSync(CONFIG.logFile, line + '\n');
    } catch {}
  }
}

function logMaybe(level, message) {
  if (silentMode && level === 'PULSE') return;
  log(level, message);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

const stats = {
  connectAttempts: 0, successfulConnects: 0,
  disconnects: 0, errors: 0, keepAlivesSent: 0,
  startTime: Date.now(),
  summary() {
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    return `\n┌─ Session Stats ──────────────────────┐\n` +
      `│  Uptime        : ${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s\n` +
      `│  Connect tries : ${this.connectAttempts}\n` +
      `│  Successful    : ${this.successfulConnects}\n` +
      `│  Disconnects   : ${this.disconnects}\n` +
      `│  Errors        : ${this.errors}\n` +
      `│  Keep-alives   : ${this.keepAlivesSent}\n` +
      `└──────────────────────────────────────┘`;
  }
};

// ─── Username Generator ───────────────────────────────────────────────────────

const ADJECTIVES = ['Fast','Quiet','Lucky','Brave','Sharp','Cool','Wild','Dark','Blue','Red'];
const NOUNS      = ['Wolf','Fox','Hawk','Bear','Lion','Frog','Owl','Deer','Pike','Lynx'];

function randomUsername() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}${Math.floor(Math.random() * 9999)}`;
}

// ─── Bot State ────────────────────────────────────────────────────────────────

let client         = null;
let keepAlive      = null;
let running        = true;
let currentUsername = '';
let fixedUsername  = null;
let silentMode     = false;
let pausedRecon    = false;
const pingHistory  = [];
let backoffMs      = CONFIG.reconnectDelay;
const MAX_BACKOFF  = 60000;

function cleanup() {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  if (client) { try { client.disconnect(); } catch {} client = null; }
}

function resetBackoff()    { backoffMs = CONFIG.reconnectDelay; }
function increaseBackoff() { backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF); }

function scheduleReconnect(delayMs) {
  if (pausedRecon) { log('INFO', 'Auto-reconnect paused — type "resume" to rejoin.'); return; }
  log('NET', `Reconnecting in ${(delayMs / 1000).toFixed(1)}s...`);
  setTimeout(connect, delayMs);
}

// ─── Core Connect ─────────────────────────────────────────────────────────────

function connect() {
  if (!running) return;
  cleanup();
  stats.connectAttempts++;
  currentUsername = fixedUsername || randomUsername();
  log('NET', `Connecting as "${currentUsername}" → ${CONFIG.host}:${CONFIG.port} (attempt #${stats.connectAttempts})`);

  try {
    client = createClient({
      host: CONFIG.host, port: CONFIG.port,
      offline: true, version: CONFIG.version,
      username: currentUsername,
    });
  } catch (err) {
    log('ERROR', `Failed to create client: ${err.message}`);
    stats.errors++;
    scheduleReconnect(CONFIG.errorRetryDelay);
    return;
  }

  client.on('connect', () => {
    stats.successfulConnects++;
    resetBackoff();
    log('SUCCESS', `Connected as "${currentUsername}"`);
  });

  client.on('spawn', () => {
    log('GAME', 'Spawned in world — server keep-alive active.');
    keepAlive = setInterval(() => {
      try {
        if (client && client._client) {
          client.write('tick_sync', {
            request_time: BigInt(Date.now()),
            response_time: BigInt(Date.now()),
          });
          stats.keepAlivesSent++;
          logMaybe('PULSE', `Keep-alive #${stats.keepAlivesSent} sent`);
        }
      } catch (e) { log('WARN', `Keep-alive failed: ${e.message}`); }
    }, CONFIG.keepAliveInterval);
  });

  client.on('disconnect', (packet) => {
    stats.disconnects++;
    log('WARN', `Disconnected: ${packet?.reason || 'unknown'}`);
    cleanup();
    if (running) { increaseBackoff(); scheduleReconnect(backoffMs); }
  });

  client.on('error', (err) => {
    stats.errors++;
    log('ERROR', err.message);
    cleanup();
    if (running) { increaseBackoff(); scheduleReconnect(backoffMs); }
  });
}

// ─── CLI Commands ─────────────────────────────────────────────────────────────

const COMMANDS = {
  stop() {
    log('STOP', 'Stopping bot...');
    console.log(stats.summary());
    running = false;
    cleanup();
    if (server) server.close();
    rl.close();
    process.exit(0);
  },
  status() {
    console.log(stats.summary());
    log('INFO', `Target         : ${CONFIG.host}:${CONFIG.port}`);
    log('INFO', `Current user   : ${currentUsername || '—'}`);
    log('INFO', `Fixed name     : ${fixedUsername || 'none (random)'}`);
    log('INFO', `Silent mode    : ${silentMode}`);
    log('INFO', `Auto-reconnect : ${pausedRecon ? 'PAUSED' : 'active'}`);
  },
  reconnect() { log('INFO', 'Manual reconnect.'); cleanup(); connect(); },
  settings() {
    console.log('\n┌─ Settings ─────────────────────────────────┐');
    console.log(`│  host      : ${CONFIG.host}`);
    console.log(`│  port      : ${CONFIG.port}`);
    console.log(`│  version   : ${CONFIG.version}`);
    console.log(`│  bot name  : ${fixedUsername || '(random)'}`);
    console.log(`│  dashboard : http://localhost:3000`);
    console.log('└────────────────────────────────────────────┘\n');
  },
  ping() {
    if (!client || !client._client) { log('WARN', 'Not connected.'); return; }
    const sent = Date.now();
    try {
      client.write('tick_sync', { request_time: BigInt(sent), response_time: BigInt(sent) });
      const rtt = Date.now() - sent;
      pingHistory.push(rtt);
      if (pingHistory.length > 10) pingHistory.shift();
      const avg = Math.round(pingHistory.reduce((a, b) => a + b, 0) / pingHistory.length);
      log('INFO', `Ping RTT: ~${rtt}ms  |  avg: ${avg}ms`);
    } catch (e) { log('ERROR', `Ping failed: ${e.message}`); }
  },
  silent()  { silentMode = !silentMode; log('INFO', `Silent mode ${silentMode ? 'ON' : 'OFF'}`); },
  clearlog() {
    try { fs.writeFileSync(CONFIG.logFile, ''); log('INFO', 'Log file cleared.'); }
    catch (e) { log('ERROR', `Could not clear log: ${e.message}`); }
  },
  uptime() {
    const s = Math.floor((Date.now() - stats.startTime) / 1000);
    log('INFO', `Running for ${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`);
  },
  pause()  {
    if (pausedRecon) { log('WARN', 'Already paused.'); return; }
    pausedRecon = true; log('INFO', 'Auto-reconnect PAUSED.');
  },
  resume() {
    if (!pausedRecon) { log('WARN', 'Not paused.'); return; }
    pausedRecon = false; log('INFO', 'Auto-reconnect RESUMED.');
    if (!client) connect();
  },
  history() {
    if (!pingHistory.length) { log('INFO', 'No ping history yet.'); return; }
    const avg = Math.round(pingHistory.reduce((a,b)=>a+b,0)/pingHistory.length);
    console.log('\n┌─ Ping History ──────────────────────────┐');
    pingHistory.forEach((ms, i) => {
      console.log(`│  #${String(i+1).padStart(2)}  ${String(ms).padStart(4)}ms  ${'█'.repeat(Math.min(Math.round(ms/5),30))}`);
    });
    console.log(`│  avg: ${avg}ms  min: ${Math.min(...pingHistory)}ms  max: ${Math.max(...pingHistory)}ms`);
    console.log('└─────────────────────────────────────────┘\n');
  },
  rename() {
    fixedUsername = randomUsername();
    log('INFO', `Renamed to "${fixedUsername}" — reconnecting.`);
    cleanup(); connect();
  },
  help() {
    console.log('\nCommands:');
    console.log('  stop / status / reconnect / settings / help');
    console.log('  setname <n> / setname random / setdelay <ms> / rename');
    console.log('  ping / history / silent / clearlog / uptime / pause / resume');
    console.log('  Dashboard → http://localhost:3000\n');
  },
};

// ─── Readline (after setup completes) ────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.toLowerCase().startsWith('setname ')) {
    const v = trimmed.slice(8).trim();
    if (v.toLowerCase() === 'random') { fixedUsername = null; log('INFO', 'Name set to random.'); }
    else if (v.length < 3 || v.length > 16) log('WARN', 'Name must be 3–16 chars.');
    else { fixedUsername = v; log('INFO', `Name fixed to "${v}".`); }
    return;
  }
  if (trimmed.toLowerCase().startsWith('setdelay ')) {
    const ms = parseInt(trimmed.slice(9).trim());
    if (isNaN(ms) || ms < 500 || ms > 300000) log('WARN', 'Delay must be 500–300000ms.');
    else { CONFIG.reconnectDelay = ms; backoffMs = ms; log('INFO', `Reconnect delay: ${ms}ms`); }
    return;
  }
  const cmd = trimmed.toLowerCase();
  if (COMMANDS[cmd]) COMMANDS[cmd]();
  else log('WARN', `Unknown command "${trimmed}". Type "help".`);
});

process.on('SIGINT',  () => COMMANDS.stop());
process.on('SIGTERM', () => COMMANDS.stop());

// ─── Web Dashboard HTML ───────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bot Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap');
  :root {
    --bg:#0a0c0f; --panel:#0f1318; --border:#1a2a1a;
    --green:#00ff88; --green-dim:#00aa55; --green-dark:#003322;
    --red:#ff3355; --yellow:#ffcc00; --text:#c8ffdc; --muted:#4a7a5a;
    --font-mono:'Share Tech Mono',monospace; --font-head:'Orbitron',monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--text);font-family:var(--font-mono);min-height:100vh;
    background-image:radial-gradient(ellipse at 20% 0%,#001a0a 0%,transparent 60%),
    radial-gradient(ellipse at 80% 100%,#001a10 0%,transparent 60%);}
  header{border-bottom:1px solid var(--border);padding:18px 32px;display:flex;align-items:center;gap:16px;
    background:linear-gradient(90deg,#0a1a0f 0%,transparent 100%);}
  .logo{font-family:var(--font-head);font-size:1.3rem;font-weight:900;color:var(--green);
    letter-spacing:4px;text-shadow:0 0 20px var(--green);}
  .status-dot{width:10px;height:10px;border-radius:50%;background:var(--red);
    box-shadow:0 0 8px var(--red);animation:pulse-dot 2s infinite;margin-left:auto;}
  .status-dot.online{background:var(--green);box-shadow:0 0 8px var(--green);}
  @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}
  .status-label{font-size:.75rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;}
  .host-label{font-size:.75rem;color:var(--green-dim);margin-left:16px;}
  .grid{display:grid;grid-template-columns:320px 1fr;grid-template-rows:auto 1fr;
    gap:1px;background:var(--border);height:calc(100vh - 61px);}
  .panel{background:var(--panel);padding:24px;overflow-y:auto;}
  .panel-title{font-family:var(--font-head);font-size:.65rem;letter-spacing:3px;color:var(--green-dim);
    text-transform:uppercase;margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid var(--border);}
  .stat-row{display:flex;justify-content:space-between;align-items:center;
    padding:8px 0;border-bottom:1px solid #111a14;font-size:.82rem;}
  .stat-key{color:var(--muted);}
  .stat-val{color:var(--green);font-weight:bold;}
  .stat-val.warn{color:var(--yellow);}
  .stat-val.bad{color:var(--red);}
  .commands{grid-row:1/3;display:flex;flex-direction:column;}
  .cmd-btn{background:transparent;border:none;border-bottom:1px solid var(--border);
    color:var(--text);font-family:var(--font-mono);font-size:.85rem;padding:13px 24px;
    text-align:left;cursor:pointer;display:flex;align-items:center;gap:10px;
    transition:background .15s,color .15s;letter-spacing:1px;}
  .cmd-btn:hover{background:var(--green-dark);color:var(--green);}
  .cmd-btn .icon{font-size:1rem;width:20px;text-align:center;}
  .cmd-btn.danger:hover{background:#1a0008;color:var(--red);}
  .cmd-btn.warn-btn:hover{background:#1a1400;color:var(--yellow);}
  .log-panel{grid-column:2;display:flex;flex-direction:column;}
  #log-output{flex:1;overflow-y:auto;padding:16px 24px;font-size:.78rem;line-height:1.7;background:#080b0a;}
  #log-output::-webkit-scrollbar{width:4px;}
  #log-output::-webkit-scrollbar-thumb{background:var(--green-dark);}
  .log-line{display:flex;gap:10px;}
  .log-ts{color:#2a4a35;min-width:90px;}
  .log-msg{color:var(--text);}
  .log-msg.WARN{color:var(--yellow);}
  .log-msg.ERROR{color:var(--red);}
  .log-msg.SUCCESS{color:var(--green);}
  .log-msg.PULSE{color:#2a6a45;}
  .log-msg.STOP{color:var(--red);}
  .log-msg.GAME{color:#88ffcc;}
  .toast{position:fixed;bottom:24px;right:24px;background:var(--green-dark);
    border:1px solid var(--green-dim);color:var(--green);padding:10px 20px;
    font-size:.8rem;letter-spacing:1px;opacity:0;transform:translateY(10px);
    transition:all .3s;pointer-events:none;}
  .toast.show{opacity:1;transform:translateY(0);}
  .input-row{display:flex;gap:0;margin-top:12px;}
  .input-row input{flex:1;background:#080b0a;border:1px solid var(--border);border-right:none;
    color:var(--green);font-family:var(--font-mono);font-size:.8rem;padding:8px 12px;outline:none;}
  .input-row input::placeholder{color:var(--muted);}
  .input-row input:focus{border-color:var(--green-dim);}
  .input-row button{background:var(--green-dark);border:1px solid var(--border);
    color:var(--green);font-family:var(--font-mono);font-size:.8rem;padding:8px 14px;
    cursor:pointer;letter-spacing:1px;white-space:nowrap;}
  .input-row button:hover{background:#004422;}
  .section-gap{height:16px;}

  /* Setup overlay */
  #setup-overlay{position:fixed;inset:0;background:var(--bg);z-index:100;
    display:flex;align-items:center;justify-content:center;
    background-image:radial-gradient(ellipse at 50% 50%,#001a0a 0%,transparent 70%);}
  .setup-box{border:1px solid var(--green-dim);padding:40px 48px;max-width:480px;width:100%;}
  .setup-title{font-family:var(--font-head);font-size:1.1rem;color:var(--green);
    letter-spacing:4px;text-shadow:0 0 16px var(--green);margin-bottom:8px;}
  .setup-sub{font-size:.8rem;color:var(--muted);margin-bottom:32px;letter-spacing:1px;}
  .setup-field{margin-bottom:20px;}
  .setup-label{font-size:.7rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px;}
  .setup-input{width:100%;background:#080b0a;border:1px solid var(--border);
    color:var(--text);font-family:var(--font-mono);font-size:.9rem;padding:10px 14px;outline:none;}
  .setup-input:focus{border-color:var(--green-dim);}
  .setup-btn{width:100%;background:var(--green-dark);border:1px solid var(--green-dim);
    color:var(--green);font-family:var(--font-head);font-size:.85rem;letter-spacing:3px;
    padding:14px;cursor:pointer;margin-top:8px;text-transform:uppercase;}
  .setup-btn:hover{background:#004422;}
  .setup-error{color:var(--red);font-size:.78rem;margin-top:12px;min-height:20px;}
</style>
</head>
<body>

<!-- Setup Overlay -->
<div id="setup-overlay">
  <div class="setup-box">
    <div class="setup-title">BOTDASH</div>
    <div class="setup-sub">Configure your server connection</div>
    <div class="setup-field">
      <div class="setup-label">Server Address</div>
      <input class="setup-input" id="in-host" placeholder="play.yourserver.com" autocomplete="off"/>
    </div>
    <div class="setup-field">
      <div class="setup-label">Port</div>
      <input class="setup-input" id="in-port" placeholder="19132" type="number"/>
    </div>
    <div class="setup-field">
      <div class="setup-label">Bedrock Version</div>
      <input class="setup-input" id="in-ver" placeholder="1.21.0"/>
    </div>
    <button class="setup-btn" onclick="submitSetup()">Connect →</button>
    <div class="setup-error" id="setup-err"></div>
  </div>
</div>

<!-- Main Dashboard -->
<header>
  <div class="logo">BOTDASH</div>
  <span class="status-label" id="conn-label">OFFLINE</span>
  <span class="host-label" id="host-label"></span>
  <div class="status-dot" id="conn-dot"></div>
</header>
<div class="grid">
  <div class="panel commands">
    <div class="panel-title">Commands</div>
    <button class="cmd-btn" onclick="cmd('reconnect')"><span class="icon">🔄</span> reconnect</button>
    <button class="cmd-btn" onclick="cmd('ping')"><span class="icon">📡</span> ping</button>
    <button class="cmd-btn" onclick="cmd('status')"><span class="icon">📊</span> status</button>
    <button class="cmd-btn" onclick="cmd('uptime')"><span class="icon">⏱️</span> uptime</button>
    <button class="cmd-btn" onclick="cmd('history')"><span class="icon">📈</span> ping history</button>
    <button class="cmd-btn" onclick="cmd('silent')"><span class="icon">🔇</span> toggle silent</button>
    <button class="cmd-btn" onclick="cmd('pause')"><span class="icon">⏸️</span> pause reconnect</button>
    <button class="cmd-btn" onclick="cmd('resume')"><span class="icon">▶️</span> resume reconnect</button>
    <button class="cmd-btn" onclick="cmd('rename')"><span class="icon">🎲</span> random rename</button>
    <button class="cmd-btn warn-btn" onclick="cmd('clearlog')"><span class="icon">🗑️</span> clear log</button>
    <button class="cmd-btn danger" onclick="cmd('stop')"><span class="icon">🛑</span> stop bot</button>
    <div class="section-gap"></div>
    <div class="panel-title">Set Name</div>
    <div class="input-row">
      <input id="nameInput" placeholder="BotName123" maxlength="16"/>
      <button onclick="setname()">SET</button>
    </div>
  </div>

  <div class="panel" id="stats-panel">
    <div class="panel-title">Live Stats</div>
    <div id="stats-content">Waiting for data...</div>
  </div>

  <div class="panel log-panel">
    <div class="panel-title" style="padding:16px 24px 10px;margin:0;border-bottom:1px solid var(--border)">Terminal Log</div>
    <div id="log-output"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
  let lastLogLen = 0;
  let configured = false;

  async function submitSetup() {
    const host = document.getElementById('in-host').value.trim();
    const port = parseInt(document.getElementById('in-port').value.trim()) || 19132;
    const ver  = document.getElementById('in-ver').value.trim() || '1.21.0';
    const err  = document.getElementById('setup-err');
    if (!host) { err.textContent = 'Server address is required.'; return; }
    err.textContent = 'Connecting...';
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ host, port, version: ver })
      });
      const d = await res.json();
      if (d.ok) {
        document.getElementById('setup-overlay').style.display = 'none';
        document.getElementById('host-label').textContent = host + ':' + port;
        configured = true;
        startPolling();
      } else {
        err.textContent = d.error || 'Failed to connect.';
      }
    } catch(e) { err.textContent = 'Could not reach bot server.'; }
  }

  document.getElementById('in-host').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('in-port').focus(); });
  document.getElementById('in-port').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('in-ver').focus(); });
  document.getElementById('in-ver').addEventListener('keydown',  e => { if(e.key==='Enter') submitSetup(); });

  // Check if already configured
  fetch('/api/stats').then(r=>r.json()).then(d => {
    if (d.configured) {
      document.getElementById('setup-overlay').style.display = 'none';
      document.getElementById('host-label').textContent = d.host + ':' + d.port;
      configured = true;
      startPolling();
    }
  }).catch(()=>{});

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  }

  async function cmd(name) {
    const res = await fetch('/cmd/' + name, { method: 'POST' });
    const data = await res.json();
    showToast(data.ok ? '✓ ' + name : '✗ ' + (data.error||'error'));
  }

  async function setname() {
    const val = document.getElementById('nameInput').value.trim();
    if (!val) return;
    const res = await fetch('/cmd/setname/' + encodeURIComponent(val), { method: 'POST' });
    const data = await res.json();
    showToast(data.ok ? '✓ name → ' + val : '✗ ' + (data.error||'error'));
  }

  async function fetchStats() {
    try {
      const d = await fetch('/api/stats').then(r=>r.json());
      const dot   = document.getElementById('conn-dot');
      const label = document.getElementById('conn-label');
      dot.className   = 'status-dot' + (d.connected ? ' online' : '');
      label.textContent = d.connected ? 'ONLINE' : 'OFFLINE';
      document.getElementById('stats-content').innerHTML = [
        ['Host',            d.host + ':' + d.port],
        ['Version',         d.version],
        ['Current user',    d.username   || '—'],
        ['Fixed name',      d.fixedName  || '(random)'],
        ['Connected',       d.connected  ? 'YES' : 'NO',  d.connected ? '' : 'bad'],
        ['Silent mode',     d.silent     ? 'ON'  : 'OFF', d.silent    ? 'warn' : ''],
        ['Auto-reconnect',  d.paused     ? 'PAUSED' : 'ACTIVE', d.paused ? 'warn' : ''],
        ['Connect attempts',d.attempts],
        ['Successful',      d.successes],
        ['Disconnects',     d.disconnects, d.disconnects > 0 ? 'warn' : ''],
        ['Errors',          d.errors,      d.errors > 0 ? 'bad' : ''],
        ['Keep-alives sent',d.keepAlives],
        ['Uptime',          d.uptime],
        ['Last ping',       d.lastPing != null ? d.lastPing + 'ms' : '—'],
      ].map(([k,v,cls]) =>
        '<div class="stat-row"><span class="stat-key">'+k+'</span>' +
        '<span class="stat-val '+(cls||'")>'+v+'</span></div>'
      ).join('');
    } catch {}
  }

  async function fetchLogs() {
    try {
      const d = await fetch('/api/logs?since=' + lastLogLen).then(r=>r.json());
      if (!d.lines.length) return;
      lastLogLen = d.total;
      const out = document.getElementById('log-output');
      const atBottom = out.scrollHeight - out.scrollTop <= out.clientHeight + 40;
      d.lines.forEach(l => {
        const div = document.createElement('div');
        div.className = 'log-line';
        div.innerHTML = '<span class="log-ts">'+l.timestamp.slice(11,19)+'</span>' +
                        '<span class="log-msg '+l.level+'">'+l.icon+'  '+
                        l.message.replace(/</g,'&lt;')+'</span>';
        out.appendChild(div);
      });
      if (atBottom) out.scrollTop = out.scrollHeight;
    } catch {}
  }

  function startPolling() {
    fetchStats(); fetchLogs();
    setInterval(fetchStats, 1500);
    setInterval(fetchLogs, 800);
  }
</script>
</body>
</html>`;

// ─── HTTP Server ──────────────────────────────────────────────────────────────

let server = null;

function startServer() {
  server = http.createServer((req, res) => {
    const url = req.url;

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (url === '/api/stats') {
      const s = Math.floor((Date.now() - stats.startTime) / 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured:  !!(CONFIG.host && CONFIG.port),
        connected:   !!(client && client._client),
        host:        CONFIG.host  || '',
        port:        CONFIG.port  || '',
        version:     CONFIG.version,
        username:    currentUsername,
        fixedName:   fixedUsername,
        silent:      silentMode,
        paused:      pausedRecon,
        attempts:    stats.connectAttempts,
        successes:   stats.successfulConnects,
        disconnects: stats.disconnects,
        errors:      stats.errors,
        keepAlives:  stats.keepAlivesSent,
        uptime:      `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`,
        lastPing:    pingHistory.length ? pingHistory[pingHistory.length - 1] : null,
      }));
      return;
    }

    if (url.startsWith('/api/logs')) {
      const since = parseInt(new URL('http://x' + url).searchParams.get('since') || '0');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: logBuffer.slice(since), total: logBuffer.length }));
      return;
    }

    if (url === '/api/setup' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { host, port, version } = JSON.parse(body);
          if (!host) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Host required'})); return; }
          CONFIG.host    = host;
          CONFIG.port    = port || 19132;
          CONFIG.version = version || '1.21.0';
          log('INFO', `[dashboard] Server set to ${CONFIG.host}:${CONFIG.port} (v${CONFIG.version})`);
          connect();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (url.startsWith('/cmd/') && req.method === 'POST') {
      const parts    = url.split('/');
      const cmdName  = parts[2];
      if (cmdName === 'setname' && parts[3]) {
        const v = decodeURIComponent(parts[3]);
        if (v.length < 3 || v.length > 16) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: false, error: 'Name must be 3-16 chars' }));
          return;
        }
        fixedUsername = v;
        log('INFO', `[dashboard] Bot name set to "${v}"`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (COMMANDS[cmdName]) {
        try { COMMANDS[cmdName](); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); }
        catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
        return;
      }
      res.writeHead(404,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'Unknown command'}));
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(3000, '127.0.0.1', () => {
    log('INFO', '🌐 Dashboard running at http://localhost:3000');
  });
}

// ─── Startup ──────────────────────────────────────────────────────────────────

function ask(prompt) {
  return new Promise(resolve => {
    const tmp = readline.createInterface({ input: process.stdin, output: process.stdout });
    tmp.question(prompt, answer => { tmp.close(); resolve(answer.trim()); });
  });
}

async function setup() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   ⛏  Bedrock Keep-Alive Bot              ║');
  console.log('  ║      Web dashboard → localhost:3000      ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  // Skip prompts if env vars are set
  if (!CONFIG.host) {
    const h = await ask('  Server address : ');
    if (!h) { console.log('  Address is required. Exiting.'); process.exit(1); }
    CONFIG.host = h;
  }

  if (!CONFIG.port) {
    const p = await ask('  Server port [19132] : ');
    CONFIG.port = parseInt(p) || 19132;
  }

  const v = await ask(`  Bedrock version [${CONFIG.version}] : `);
  if (v) CONFIG.version = v;

  console.log('');
  log('INFO', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('INFO', `  Target    : ${CONFIG.host}:${CONFIG.port}`);
  log('INFO', `  Version   : ${CONFIG.version}`);
  log('INFO', `  Dashboard : http://localhost:3000`);
  log('INFO', '  Type "help" for commands.');
  log('INFO', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  startServer();
  connect();
}

setup();

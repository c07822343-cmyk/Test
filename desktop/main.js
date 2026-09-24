// ApexWeb OS desktop app: a window onto the dashboard plus a tray icon that
// keeps running in the background. It starts with your computer, starts the
// ApexWeb services (docker compose) if they are down, restarts them if they
// stop responding, and notifies you when something needs your attention.
//
// The API token is read from the repository's .env file and handed to the
// dashboard in the URL fragment (never sent over the network, never logged).
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell, dialog } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ------------------------------------------------------------------ config
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  repoDir: process.env.APEXWEB_HOME || path.resolve(__dirname, '..'),
  coreUrl: 'http://localhost:8080',
  n8nUrl: 'http://localhost:5678',
  manageServices: true,
  startAtLogin: true,
  startHidden: false,
};
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
let config = loadConfig();

function readEnv() {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(config.repoDir, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}
const token = () => readEnv().APEXWEB_API_TOKEN || '';

// ------------------------------------------------------------------ state
let win = null;
let tray = null;
let quitting = false;
let state = { health: 'starting', detail: 'Starting…', driver: null, keys: 0, approvals: 0, running: 0 };
let failures = 0;
let lastComposeUp = 0;
const seenApprovals = new Set();
const projectStatus = new Map();
let firstPoll = true;

const icon = (name) => nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}.png`));

// ------------------------------------------------------------------ services
function compose(args) {
  return new Promise((resolve) => {
    execFile('docker', ['compose', ...args], { cwd: config.repoDir, windowsHide: true, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

async function ensureServices(reason) {
  if (!config.manageServices || Date.now() - lastComposeUp < 120_000) return;
  lastComposeUp = Date.now();
  setState({ health: 'warn', detail: `Starting services (${reason})…` });
  const r = await compose(['up', '-d']);
  if (!r.ok) {
    setState({ health: 'err', detail: /docker/i.test(r.out) && /not (found|recognized)|daemon|pipe|socket/i.test(r.out) ? 'Docker is not running — start Docker Desktop' : 'Could not start services (see Logs)' });
    fs.writeFileSync(path.join(app.getPath('userData'), 'last-compose.log'), r.out.slice(-20_000));
  }
}

async function api(p) {
  const res = await fetch(config.coreUrl + p, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function poll() {
  try {
    const h = await (await fetch(`${config.coreUrl}/healthz`, { signal: AbortSignal.timeout(5_000) })).json();
    failures = 0;
    const [ap, pr, run] = await Promise.all([api('/v1/approvals?status=pending'), api('/v1/projects'), api('/v1/tasks?status=RUNNING')]);
    const pending = ap.approvals || [];
    for (const a of pending) {
      if (!seenApprovals.has(a.id) && !firstPoll) notify('Approval needed', a.title);
      seenApprovals.add(a.id);
    }
    for (const p of pr.projects || []) {
      const prev = projectStatus.get(p.id);
      if (prev && prev !== p.status && !firstPoll) {
        if (p.status === 'COMPLETED' || p.status === 'APPROVED') notify('Project finished', `${p.name} is ready for handoff.`);
        else if (p.status === 'NEEDS_ATTENTION') notify('Project needs your input', p.name);
        else if (p.status === 'AWAITING_APPROVAL') notify('Waiting for approval', p.name);
      }
      projectStatus.set(p.id, p.status);
    }
    firstPoll = false;
    const running = (run.tasks || []).length;
    setState({
      health: h.keys_configured ? 'ok' : 'warn',
      detail: h.keys_configured ? `Running · ${running} task(s) active` : 'Running · no NVIDIA keys configured',
      driver: h.driver, keys: h.keys_configured, approvals: pending.length, running,
    });
    if (win && win.webContents.getURL().startsWith('file:')) loadDashboard();
  } catch (err) {
    failures++;
    setState({ health: failures > 2 ? 'err' : 'warn', detail: String(err.message || err).includes('401') ? 'Token rejected — check APEXWEB_API_TOKEN in .env' : 'ApexWeb core is not responding' });
    if (failures >= 3) await ensureServices('core not responding');
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon('icon-256') });
  n.on('click', () => showWindow());
  n.show();
}

// ------------------------------------------------------------------ UI
function setState(patch) {
  state = { ...state, ...patch };
  if (tray) {
    tray.setImage(icon(`tray-${state.health === 'ok' ? 'ok' : state.health === 'err' ? 'err' : 'warn'}`));
    tray.setToolTip(`ApexWeb OS — ${state.detail}${state.approvals ? ` · ${state.approvals} approval(s) waiting` : ''}`);
    tray.setContextMenu(buildMenu());
  }
  if (process.platform === 'darwin') app.dock?.setBadge(state.approvals ? String(state.approvals) : '');
}

function loadDashboard() {
  win.loadURL(`${config.coreUrl}/#token=${encodeURIComponent(token())}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'ApexWeb OS', backgroundColor: '#0b0e14', icon: icon('icon'), show: !config.startHidden,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Only the dashboard's own origin loads inside the app; everything else
  // (obsidian:// links, n8n, external sites) opens in the system handler.
  const origin = new URL(config.coreUrl).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || new URL(url).origin === origin) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', () => win.loadFile(path.join(__dirname, 'status.html'), { query: { detail: state.detail } }));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.loadFile(path.join(__dirname, 'status.html'), { query: { detail: 'Connecting to ApexWeb OS…' } });
}

function showWindow() {
  if (!win) createWindow();
  if (win.webContents.getURL().startsWith('file:')) loadDashboard();
  win.show();
  win.focus();
}

async function openObsidian() {
  try {
    const ob = await api('/v1/integrations/obsidian');
    if (ob.enabled) return shell.openExternal(`obsidian://open?path=${encodeURIComponent(path.join(ob.folder_host || ob.folder, 'Home.md'))}`);
  } catch {
    /* fall through */
  }
  const vault = readEnv().OBSIDIAN_VAULT_HOST_PATH || readEnv().OBSIDIAN_VAULT_PATH;
  if (vault) shell.openExternal(`obsidian://open?path=${encodeURIComponent(vault)}`);
  else dialog.showMessageBox({ message: 'Obsidian is not connected yet.', detail: 'Run the installer again or set OBSIDIAN_VAULT_PATH in .env.' });
}

function buildMenu() {
  const busy = { enabled: config.manageServices };
  return Menu.buildFromTemplate([
    { label: `ApexWeb OS — ${state.detail}`, enabled: false },
    ...(state.approvals ? [{ label: `${state.approvals} approval(s) waiting — review`, click: showWindow }] : []),
    { type: 'separator' },
    { label: 'Open ApexWeb', click: showWindow },
    { label: 'Open Obsidian vault', click: openObsidian },
    { label: 'Open n8n control plane', click: () => shell.openExternal(config.n8nUrl) },
    { type: 'separator' },
    { label: 'Start services', ...busy, click: async () => { lastComposeUp = 0; await ensureServices('manual'); poll(); } },
    { label: 'Restart services', ...busy, click: async () => { setState({ health: 'warn', detail: 'Restarting services…' }); await compose(['restart']); poll(); } },
    { label: 'Stop services', ...busy, click: async () => {
      const r = await dialog.showMessageBox({ type: 'warning', buttons: ['Stop', 'Cancel'], defaultId: 1, message: 'Stop all ApexWeb services?', detail: 'Running work is saved and resumes when the services start again.' });
      if (r.response === 0) { config.manageServices = false; saveConfig(); await compose(['stop']); setState({ health: 'err', detail: 'Services stopped (automatic restart paused)' }); }
    } },
    { label: 'Keep services running automatically', type: 'checkbox', checked: config.manageServices, click: (i) => { config.manageServices = i.checked; saveConfig(); if (i.checked) { lastComposeUp = 0; ensureServices('enabled'); } } },
    { label: 'Start ApexWeb when I log in', type: 'checkbox', checked: config.startAtLogin, click: (i) => { config.startAtLogin = i.checked; saveConfig(); applyAutostart(); } },
    { type: 'separator' },
    { label: 'Open logs folder', click: () => shell.openPath(app.getPath('userData')) },
    { label: 'Quit ApexWeb window (services keep running)', click: () => { quitting = true; app.quit(); } },
  ]);
}

// ------------------------------------------------------------------ autostart
function applyAutostart() {
  const enable = !!config.startAtLogin;
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
  if (process.platform === 'win32' || (process.platform === 'darwin' && app.isPackaged)) {
    app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: true, path: process.execPath, args });
  } else if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.apexweb.desktop.plist');
    if (!enable) return fs.rmSync(plist, { force: true });
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.apexweb.desktop</string>
<key>ProgramArguments</key><array>${[process.execPath, ...args].map((a) => `<string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
</dict></plist>
`);
  } else {
    const file = path.join(os.homedir(), '.config', 'autostart', 'apexweb-os.desktop');
    if (!enable) return fs.rmSync(file, { force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=ApexWeb OS\nExec=${[process.execPath, ...args].map((a) => `"${a}"`).join(' ')}\nIcon=${path.join(__dirname, 'assets', 'icon.png')}\nX-GNOME-Autostart-enabled=true\n`);
  }
}

// ------------------------------------------------------------------ lifecycle
app.setAppUserModelId?.('com.apexweb.os');
app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
app.on('before-quit', () => { quitting = true; });
// Keep running in the tray when every window is closed.
app.on('window-all-closed', (e) => e.preventDefault?.());

app.whenReady().then(() => {
  if (process.argv.includes('--hidden')) config.startHidden = true;
  if (!fs.existsSync(path.join(config.repoDir, 'docker-compose.yml'))) {
    dialog.showErrorBox('ApexWeb OS', `Could not find the ApexWeb folder at:\n${config.repoDir}\n\nSet "repoDir" in ${CONFIG_FILE} or APEXWEB_HOME.`);
  }
  if (!fs.existsSync(CONFIG_FILE)) saveConfig();
  applyAutostart();
  tray = new Tray(icon('tray-warn'));
  tray.on('click', () => showWindow());
  setState({});
  createWindow();
  poll();
  setInterval(poll, 10_000);
});

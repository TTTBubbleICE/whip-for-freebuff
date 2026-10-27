const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

// ── Whip for Freebuff ────────────────────────────────────────────────────────────
// Umbau von OpenWhip (https://github.com/GitFrog1111/OpenWhip) auf Freebuff.
// Original: Tray-Klick → Peitsche → Ctrl+C + "FASTER" in das Terminal von
// Claude Code. Hier: das Freebuff-Fenster wird gezielt in den Vordergrund
// geholt, danach folgen ein optionaler Interrupt-Tastendruck, ein Nudge-Prompt
// und Enter. Alles wird in freebuffwhip.log protokolliert.

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanA, user32api;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
    user32api = {
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
      BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int nCmdShow)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void* lpString, int nMaxCount)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void* lpdwProcessId)'),
      AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)'),
      GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
    };
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady = false;
let spawnQueued = false;
let freebuffHwnd = 0;
let lastNudge = '';
let audioDeviceList = [];
let audioSinkId = '';
let audioSinkLabel = '';

const CONFIG_FILE = path.join(__dirname, 'freebuffwhip.config.json');

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_ESCAPE  = 0x1B;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;
const SW_RESTORE = 9;

const TARGET_PROCESS = 'Freebuff';
const LOG_FILE = path.join(__dirname, 'freebuffwhip.log');

/**
 * Welche Taste vor dem Nudge gesendet wird.
 *   'ctrlc'  – wie im Original (Interrupt im Terminal-Agent)
 *   'escape' – weicher Stopp-Tastendruck für die Freebuff-Chat-Oberfläche
 *   'off'    – kein Interrupt, nur den Nudge-Text eintippen + Enter
 * Umschaltbar im Tray-Kontextmenü (Rechtsklick auf das Tray-Icon).
 */
let interruptMode = 'ctrlc';
const INTERRUPT_LABELS = { ctrlc: 'Ctrl+C', escape: 'Escape', off: 'aus' };

/**
 * Wie fest man peitschen muss: die Schwelle für die Spitzengeschwindigkeit,
 * ab der der Knall auslöst (Pixel pro Frame). Kleiner = leichter Schwung.
 * Umschaltbar im Tray-Kontextmenü.
 */
const SENSITIVITY = { sanft: 45, mittel: 80, fest: 340 };
let sensitivity = 'mittel';

/** Zielt die Peitsche fest auf das Freebuff-Fenster (statt auf das gerade aktive Fenster). */
let autoFocusTarget = true;

// ── Logging: Konsole + freebuffwhip.log ─────────────────────────────────────
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log('freebuffwhip: ' + msg);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* Log darf nie stören */ }
}

// ── Einstellungen merken (Sound-Ausgabe, Interrupt, Ziel-Fenster) ───────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
      if (cfg.interruptMode in INTERRUPT_LABELS) interruptMode = cfg.interruptMode;
      if (typeof cfg.autoFocusTarget === 'boolean') autoFocusTarget = cfg.autoFocusTarget;
      audioSinkLabel = cfg.audioSinkLabel || '';
      if (cfg.sensitivity in SENSITIVITY) sensitivity = cfg.sensitivity;
    }
  } catch (e) {
    logLine('Konfiguration unlesbar: ' + (e.message || e));
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      interruptMode,
      autoFocusTarget,
      audioSinkLabel,
      sensitivity,
      audioSinkId,
    }, null, 2) + '\n');
  } catch (e) {
    logLine('Konfiguration nicht speicherbar: ' + (e.message || e));
  }
}

/** Gemerktes Ausgabegerät über den Namen wiederfinden (die IDs ändern sich). */
function resolveSavedSink() {
  if (!audioSinkLabel) return;
  const match = audioDeviceList.find(d => d.label === audioSinkLabel);
  if (match) {
    audioSinkId = match.id;
    logLine('Sound-Ausgabe aus Konfiguration: ' + match.label);
    if (overlay && overlayReady) overlay.webContents.send('set-sink', audioSinkId);
  } else {
    audioSinkId = '';
    logLine('Gemerktes Ausgabegeraet "' + audioSinkLabel + '" ist nicht mehr vorhanden – nutze Standard.');
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// ── Fenster-Helfer (Windows) ────────────────────────────────────────────────
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback */ }
  }
}

function windowTitle(hwnd) {
  if (!user32api || !hwnd) return '';
  try {
    const buf = Buffer.alloc(1024);
    const len = user32api.GetWindowTextW(hwnd, buf, 512);
    return buf.toString('utf16le', 0, Math.max(0, len) * 2).trim();
  } catch (e) {
    return '';
  }
}

function foregroundTitle() {
  if (!user32api) return '';
  return windowTitle(user32api.GetForegroundWindow()) || '(unbekannt)';
}

function threadOfWindow(hwnd) {
  try {
    const buf = Buffer.alloc(4);
    return user32api.GetWindowThreadProcessId(hwnd, buf);
  } catch (e) {
    return 0;
  }
}

function tapKey(vk) {
  if (!keybd_event) return;
  keybd_event(vk, 0, 0, 0);
  keybd_event(vk, 0, KEYUP, 0);
}

/** Freebuff-Fenster über PowerShell auflösen (Electron-Prozess, Fensterhandle). */
function findFreebuffHwnd() {
  if (process.platform !== 'win32') return 0;
  const queries = [
    `(Get-Process -Name ${TARGET_PROCESS} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object Id | Select-Object -First 1).MainWindowHandle`,
    `(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${TARGET_PROCESS}*' } | Sort-Object Id | Select-Object -First 1).MainWindowHandle`,
  ];
  for (const q of queries) {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], {
        encoding: 'utf8', windowsHide: true, timeout: 8000,
      });
      const hwnd = parseInt(String(out).trim(), 10);
      if (Number.isFinite(hwnd) && hwnd > 0) return hwnd;
    } catch (e) {
      logLine(`Fenster-Suche fehlgeschlagen: ${e.message || e}`);
    }
  }
  return 0;
}

/** Fenster nach vorn holen – inkl. AttachThreadInput-Trick gegen die Foreground-Sperre. */
function bringToForeground(hwnd) {
  if (!user32api) return;
  if (user32api.IsIconic(hwnd)) user32api.ShowWindow(hwnd, SW_RESTORE);

  // Alt antippen: unser Prozess wird dadurch "letzter Eingabe-Eigentümer",
  // erst dann darf SetForegroundWindow den Fokus wirklich umsetzen.
  tapKey(VK_MENU);

  const fg = user32api.GetForegroundWindow();
  const fgThread = fg ? threadOfWindow(fg) : 0;
  const targetThread = threadOfWindow(hwnd);
  const myThread = user32api.GetCurrentThreadId();

  if (fgThread) user32api.AttachThreadInput(myThread, fgThread, true);
  if (targetThread && targetThread !== fgThread) user32api.AttachThreadInput(myThread, targetThread, true);
  user32api.BringWindowToTop(hwnd);
  user32api.SetForegroundWindow(hwnd);
  if (targetThread && targetThread !== fgThread) user32api.AttachThreadInput(myThread, targetThread, false);
  if (fgThread) user32api.AttachThreadInput(myThread, fgThread, false);
}

/**
 * Ermittelt das Freebuff-Fenster und holt es in den Vordergrund.
 * Gibt { hwnd, foreground } zurück; hwnd = 0, wenn kein Fenster gefunden wurde.
 */
function ensureForegroundTarget() {
  if (!user32api) return { hwnd: 0, foreground: false };
  let hwnd = freebuffHwnd;
  if (!hwnd || !user32api.IsWindow(hwnd)) hwnd = findFreebuffHwnd();
  if (!hwnd) {
    freebuffHwnd = 0;
    return { hwnd: 0, foreground: false };
  }
  freebuffHwnd = hwnd;

  let ok = user32api.GetForegroundWindow() === hwnd;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    bringToForeground(hwnd);
    sleepSync(150);
    ok = user32api.GetForegroundWindow() === hwnd;
  }
  return { hwnd, foreground: ok };
}

/** Nach dem Tray-Klick: Freebuff nach vorn holen (oder wie im Original per Alt+Tab). */
function refocusAfterTrayClick() {
  if (process.platform === 'win32' && autoFocusTarget && user32api) {
    const { hwnd, foreground } = ensureForegroundTarget();
    if (hwnd) {
      logLine(`Peitsche ausgeworfen → Ziel "${windowTitle(hwnd) || TARGET_PROCESS}-Fenster" (Vordergrund: ${foreground ? 'OK' : 'FEHLGESCHLAGEN'})`);
      return;
    }
    logLine('Kein Freebuff-Fenster gefunden – Fokus bleibt, wo er ist.');
    return;
  }
  refocusPreviousApp();
}

/** One Alt+Tab / Cmd+Tab so focus returns to the previously active app after tray click. */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_TAB, 0, 0, 0);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    } else if (process.platform === 'linux') {
      execFile('xdotool', ['key', '--clearmodifiers', 'alt+Tab'], err => {
        if (err) {
          console.warn('refocus previous app (Alt+Tab) failed. Install xdotool:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('freebuffwhip: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

// macOS: createFromPath does not decode .icns (Electron only loads PNG/JPEG there, ICO on Windows).
// Quick Look thumbnails handle .icns; copy to temp if the file is inside ASAR (QL needs a real path).
async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'darwin') {
    const file = path.join(iconDir, 'AppIcon.icns');
    if (fs.existsSync(file)) {
      const fromPath = nativeImage.createFromPath(file);
      if (!fromPath.isEmpty()) return fromPath;
      try {
        const t = await tryIcnsTrayImage(file);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns Quick Look thumbnail failed:', e?.message || e);
      }
      const tmp = path.join(os.tmpdir(), 'freebuffwhip-tray.icns');
      try {
        fs.copyFileSync(file, tmp);
        const t = await tryIcnsTrayImage(tmp);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns temp copy + thumbnail failed:', e?.message || e);
      }
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('console-message', (e, level, message) => {
    // Renderer-Meldungen (u. a. Sound) landen im Log – wichtig zum Nachprüfen.
    logLine('[overlay] ' + message);
  });
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-whip');
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

function toggleOverlay(source = 'Tray-Icon') {
  const dropping = !!(overlay && overlay.isVisible());
  logLine(`Peitsche ${dropping ? 'fallen lassen' : 'auswerfen'} (${source})`);
  if (dropping) {
    overlay.webContents.send('drop-whip');
    return;
  }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    overlay.webContents.send('spawn-whip');
  } else {
    spawnQueued = true;
  }
  refocusAfterTrayClick();
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('whip-crack', () => {
  try {
    sendMacro();
  } catch (err) {
    logLine('sendMacro fehlgeschlagen: ' + (err?.message || err));
  }
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });
ipcMain.on('audio-devices', (event, devices) => {
  audioDeviceList = Array.isArray(devices) ? devices : [];
  resolveSavedSink();
  if (overlay && overlayReady) {
    overlay.webContents.send('set-sensitivity', SENSITIVITY[sensitivity]);
    logLine(`Peitschen-Empfindlichkeit: ${sensitivity} (Knall-Schwelle ${SENSITIVITY[sensitivity]})`);
  }
  const def = audioDeviceList.find(d => d.id === 'default');
  if (def) {
    logLine('Standard-Ausgabegeraet: ' + def.label);
    if (/steam streaming|virtual|oculus/i.test(def.label)) {
      logLine('HINWEIS: Das Standard-Ausgabegeraet ist ein virtuelles Geraet. Im Tray-Menue unter "Sound-Ausgabe" ein echtes Geraet waehlen, sonst bleibt es still.');
    }
  }
  if (tray) tray.setContextMenu(buildTrayMenu());
});

// ── Macro: Interrupt (optional), Nudge-Prompt für Freebuff, Enter ───────────
// Nur ASCII verwenden: die Windows-Variante tippt über VkKeyScanA (ANSI),
// Umlaute hängen von der Tastaturbelegung ab und werden sonst verschluckt.
const NUDGES = [
  'Mach weiter',
  'WEITER',
  'Schneller bitte',
  'Weiter, ohne Pause',
  'Mach schneller',
  'Los, weiter',
  'Weitermachen!',
];

function sendMacro(opts = {}) {
  const pressEnter = opts.pressEnter !== false;
  const chosen = NUDGES[Math.floor(Math.random() * NUDGES.length)];
  lastNudge = chosen;

  if (process.platform === 'win32') {
    let target = { hwnd: 0, foreground: false };
    if (autoFocusTarget && user32api) target = ensureForegroundTarget();

    if (target.hwnd) {
      logLine(`Nudge "${chosen}" → "${windowTitle(target.hwnd)}" [Vordergrund: ${target.foreground ? 'OK' : 'FEHLGESCHLAGEN (aktiv: "' + foregroundTitle() + '")'}]${pressEnter ? '' : ' [ohne Enter]'}`);
    } else {
      logLine(`Nudge "${chosen}" → kein Freebuff-Fenster gefunden, sende an das aktive Fenster "${foregroundTitle()}"${pressEnter ? '' : ' [ohne Enter]'}`);
    }
    setTimeout(() => sendMacroWindows(chosen, pressEnter), target.hwnd ? 120 : 0);
  } else if (process.platform === 'darwin') {
    logLine(`Nudge "${chosen}" (Interrupt: ${INTERRUPT_LABELS[interruptMode]})${pressEnter ? '' : ' [ohne Enter]'}`);
    sendMacroMac(chosen, pressEnter);
  } else if (process.platform === 'linux') {
    logLine(`Nudge "${chosen}" (Interrupt: ${INTERRUPT_LABELS[interruptMode]})${pressEnter ? '' : ' [ohne Enter]'}`);
    sendMacroLinux(chosen, pressEnter);
  }
  if (tray) tray.setToolTip(`Whip for Freebuff - letzter Nudge: "${chosen}"`);
}

function sendInterruptWindows() {
  if (!keybd_event || interruptMode === 'off') return;
  if (interruptMode === 'escape') {
    keybd_event(VK_ESCAPE, 0, 0, 0);
    keybd_event(VK_ESCAPE, 0, KEYUP, 0);
    return;
  }
  keybd_event(VK_CONTROL, 0, 0, 0);
  keybd_event(VK_C, 0, 0, 0);
  keybd_event(VK_C, 0, KEYUP, 0);
  keybd_event(VK_CONTROL, 0, KEYUP, 0);
}

function sendMacroWindows(text, pressEnter) {
  if (!keybd_event || !VkKeyScanA) return;
  const tap = vk => {
    keybd_event(vk, 0, 0, 0);
    keybd_event(vk, 0, KEYUP, 0);
  };
  const tapChar = ch => {
    const packed = VkKeyScanA(ch.charCodeAt(0));
    if (packed === -1) {
      logLine(`Zeichen "${ch}" kann mit dieser Tastaturbelegung nicht getippt werden.`);
      return;
    }
    const vk = packed & 0xff;
    const shiftState = (packed >> 8) & 0xff;
    if (shiftState & 1) keybd_event(0x10, 0, 0, 0); // Shift down
    tap(vk);
    if (shiftState & 1) keybd_event(0x10, 0, KEYUP, 0); // Shift up
  };

  sendInterruptWindows();
  for (const ch of text) tapChar(ch);
  if (pressEnter) {
    keybd_event(VK_RETURN, 0, 0, 0);
    keybd_event(VK_RETURN, 0, KEYUP, 0);
  }
  logLine(`Tastendruecke gesendet: "${text}"${pressEnter ? ' + Enter' : ''}`);
}

function sendMacroMac(text, pressEnter) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = ['tell application "System Events"', `  keystroke "${escaped}"`];
  if (pressEnter) lines.push('  key code 36'); // Enter
  lines.push('end tell');
  const typeScript = lines.join('\n');

  const typeIt = () => execFile('osascript', ['-e', typeScript], err => {
    if (err) {
      logLine('mac macro failed (enable Accessibility for terminal/app): ' + err.message);
    }
  });

  if (interruptMode === 'off') {
    typeIt();
    return;
  }

  const interruptKey = interruptMode === 'escape' ? '  key code 53' : '  key code 8 using {control down}';
  const interruptScript = [
    'tell application "System Events"',
    interruptKey,
    'end tell'
  ].join('\n');

  execFile('osascript', ['-e', interruptScript], err => {
    if (err) {
      logLine('mac macro failed (enable Accessibility for terminal/app): ' + err.message);
      return;
    }
    setTimeout(typeIt, 300);
  });
}

function sendMacroLinux(text, pressEnter) {
  const args = [];
  if (interruptMode !== 'off') {
    args.push('key', '--clearmodifiers', interruptMode === 'escape' ? 'Escape' : 'ctrl+c');
  }
  args.push('type', '--delay', '1', '--clearmodifiers', '--', text);
  if (pressEnter) args.push('key', 'Return');
  execFile('xdotool', args, err => {
    if (err) {
      logLine('linux macro failed. Install xdotool: ' + err.message);
    }
  });
}

// ── Selbsttest: Sound abspielen + Nudge eintippen (ohne Enter) ──────────────
function runSelfTest(opts = {}) {
  const pressEnter = !!opts.pressEnter;
  logLine(`Selbsttest: Sound + Nudge (${pressEnter ? 'mit' : 'ohne'} Enter)`);
  if (overlay && overlayReady) {
    overlay.webContents.send('test-sound');
  } else {
    logLine('Selbsttest: Overlay läuft noch nicht – Tray-Icon einmal anklicken, dann erneut testen.');
  }
  setTimeout(() => sendMacro({ pressEnter }), 600);
}

// ── Tray menu ───────────────────────────────────────────────────────────────
function sensitivityMenuItems() {
  const labels = {
    sanft: 'sanft (leichter Schwung reicht)',
    mittel: 'mittel (Standard)',
    fest: 'fest (wie im Original)',
  };
  return Object.keys(SENSITIVITY).map(key => ({
    label: labels[key],
    type: 'radio',
    checked: sensitivity === key,
    click: () => setSensitivity(key),
  }));
}

function setSensitivity(level) {
  if (!(level in SENSITIVITY)) return;
  sensitivity = level;
  saveConfig();
  const value = SENSITIVITY[level];
  logLine(`Peitschen-Empfindlichkeit = ${level} (Knall-Schwelle ${value})`);
  if (overlay && overlayReady) overlay.webContents.send('set-sensitivity', value);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function soundMenuItems() {
  const items = [
    {
      label: 'Standard (aktuelles Windows-Gerät)',
      type: 'radio',
      checked: !audioSinkId,
      click: () => setAudioSink(''),
    },
  ];
  for (const d of audioDeviceList) {
    if (d.id === 'default' || d.id === 'communications') continue;
    items.push({
      label: d.label.length > 60 ? d.label.slice(0, 57) + '...' : d.label,
      type: 'radio',
      checked: audioSinkId === d.id,
      click: () => setAudioSink(d.id),
    });
  }
  return items;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Peitsche auswerfen / fallen lassen  (Strg+Alt+W)', click: () => toggleOverlay('Tray-Menü') },
    { type: 'separator' },
    { label: 'Interrupt vor dem Nudge', enabled: false },
    {
      label: 'Ctrl+C (wie im Original)',
      type: 'radio',
      checked: interruptMode === 'ctrlc',
      click: () => setInterruptMode('ctrlc'),
    },
    {
      label: 'Escape (weicher Stopp in Freebuff)',
      type: 'radio',
      checked: interruptMode === 'escape',
      click: () => setInterruptMode('escape'),
    },
    {
      label: 'Kein Interrupt, nur Nudge senden',
      type: 'radio',
      checked: interruptMode === 'off',
      click: () => setInterruptMode('off'),
    },
    { type: 'separator' },
    {
      label: `Ziel-Fenster: ${TARGET_PROCESS} automatisch fokussieren`,
      type: 'checkbox',
      checked: autoFocusTarget,
      click: () => {
        autoFocusTarget = !autoFocusTarget;
        logLine('Ziel-Fenster automatisch fokussieren: ' + (autoFocusTarget ? 'an' : 'aus'));
        saveConfig();
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { label: 'Sound-Ausgabe', submenu: soundMenuItems() },
    { label: 'Peitschen-Empfindlichkeit', submenu: sensitivityMenuItems() },
    { type: 'separator' },
    { label: 'Selbsttest: Sound + Nudge eintippen (ohne Enter)', click: () => runSelfTest({ pressEnter: false }) },
    { label: 'Protokoll oeffnen (freebuffwhip.log)', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]);
}

function setInterruptMode(mode) {
  if (!(mode in INTERRUPT_LABELS)) return;
  interruptMode = mode;
  saveConfig();
  logLine('Interrupt = ' + INTERRUPT_LABELS[mode]);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function setAudioSink(id) {
  audioSinkId = id;
  const label = id ? (audioDeviceList.find(d => d.id === id)?.label || id) : 'Standard';
  audioSinkLabel = id ? label : '';
  saveConfig();
  logLine('Sound-Ausgabe = ' + label);
  if (overlay && overlayReady) overlay.webContents.send('set-sink', id);
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip('Whip for Freebuff - Sound: ' + label);
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────────
const SELFTEST = process.argv.includes('--selftest');

app.whenReady().then(async () => {
  loadConfig();
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('Whip for Freebuff - klicken für die Peitsche');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleOverlay('Tray-Icon'));

  // Globaler Hotkey: Windows versteckt neue Tray-Icons gerne im Ueberlauf-Menue,
  // so ist die Peitsche immer nur einen Tastendruck entfernt.
  const HOTKEY = 'Control+Alt+W';
  try {
    const registered = globalShortcut.register(HOTKEY, () => toggleOverlay('Hotkey ' + HOTKEY));
    logLine(registered ? `Hotkey ${HOTKEY} aktiv (Peitsche auswerfen / fallen lassen)` : `Hotkey ${HOTKEY} konnte nicht registriert werden (schon belegt?)`);
  } catch (e) {
    logLine('Hotkey-Fehler: ' + (e.message || e));
  }
  logLine(`gestartet (Plattform ${process.platform}, Electron ${process.versions.electron}, Freebuff-Fenster: ${freebuffHwnd || 'noch nicht gesucht'})`);

  if (SELFTEST) {
    // Nur zum Nachprüfen: Overlay erzeugen (für den Sound), Ziel fokussieren,
    // Selbsttest ausführen und die App danach beenden.
    createOverlay();
    overlay.show();
    setTimeout(() => {
      const { hwnd, foreground } = ensureForegroundTarget();
      logLine(`Selbsttest: Ziel-Fenster "${hwnd ? windowTitle(hwnd) : 'nicht gefunden'}" (Vordergrund: ${foreground ? 'OK' : 'FEHLGESCHLAGEN (aktiv: "' + foregroundTitle() + '")'})`);
      runSelfTest({ pressEnter: process.argv.includes('--selftest-enter') });
      setTimeout(() => {
        logLine('Selbsttest beendet.');
        app.exit(0);
      }, 3000);
    }, 2000);
  }
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray

// Sichtbar machen, wenn die App beendet wird oder abstuerzt – sonst verschwindet
// sie scheinbar grundlos aus dem Tray.
process.on('uncaughtException', err => {
  logLine('UNCAUGHT: ' + (err && err.stack ? err.stack : err));
});
app.on('before-quit', () => logLine('wird beendet (Tray-Menue "Beenden" oder System)'));
app.on('render-process-gone', (event, contents, details) => logLine('Renderer weg: ' + JSON.stringify(details)));

app.on('will-quit', () => globalShortcut.unregisterAll());

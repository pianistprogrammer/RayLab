'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  shell,
  session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { registerHandlers } = require('./src/handlers');

// ─── State ────────────────────────────────────────────────────────────────────

let mainWindow = null;
let tray = null;

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// Register all domain handlers (config, cluster, hardware, discovery, etc.)
registerHandlers(ipcMain);

ipcMain.handle('open_dashboard', async (_event, args) => {
  const url = (args && args.url) ? args.url : 'http://127.0.0.1:8265';
  await shell.openExternal(url);
});

// backend_status reflects the in-process Node.js backend being ready.
ipcMain.handle('backend_status', () => {
  return { running: true, error: null };
});

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const preload = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    title: 'RayLab',
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      // false required so the preload can require('electron').
      sandbox: false,
    },
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "img-src 'self' data:; " +
          "style-src 'self' 'unsafe-inline'; " +
          "script-src 'self'",
        ],
      },
    });
  });

  if (app.isPackaged) {
    const indexPath = path.join(process.resourcesPath, 'frontend', 'dist', 'index.html');
    mainWindow.loadFile(indexPath);
  } else {
    mainWindow.loadURL('http://127.0.0.1:1420');
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow = null;
    app.exit(0);
  });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.icns')
    : path.join(__dirname, 'build-resources', 'icon.png');

  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('RayLab');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show RayLab',
      click() {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: 'Open Dashboard',
      click() {
        shell.openExternal('http://127.0.0.1:8265');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click() {
        app.exit(0);
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS the tray keeps the app alive — don't quit when all windows close.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

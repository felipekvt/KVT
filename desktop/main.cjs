const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let gameServer;
let origin;
let stopping = false;

function createGameWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 960,
    minWidth: 860,
    minHeight: 640,
    title: 'Toca & Trilha',
    backgroundColor: '#f8f4e8',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${origin}/`)) event.preventDefault();
  });
  window.loadURL(origin);
  return window;
}

app.whenReady().then(async () => {
  const { startServer } = await import(pathToFileURL(path.join(app.getAppPath(), 'server.js')).href);
  gameServer = await startServer({ port: 0, host: '127.0.0.1' });
  origin = `http://127.0.0.1:${gameServer.port}`;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Jogo',
      submenu: [
        { label: 'Nova janela para multiplayer', accelerator: 'Ctrl+N', click: createGameWindow },
        { label: 'Recarregar janela', role: 'reload' },
        { type: 'separator' },
        { label: 'Sair', role: 'quit' },
      ],
    },
    { label: 'Visualizar', submenu: [{ role: 'togglefullscreen' }, { role: 'resetzoom' }] },
  ]));
  createGameWindow();
}).catch(error => {
  dialog.showErrorBox('Não foi possível iniciar Toca & Trilha', error.message);
  app.quit();
});

app.on('activate', () => {
  if (origin && BrowserWindow.getAllWindows().length === 0) createGameWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (gameServer && !stopping) {
    event.preventDefault();
    stopping = true;
    gameServer.close().finally(() => app.quit());
  }
});

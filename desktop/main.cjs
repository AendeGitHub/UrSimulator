// UrSim desktop app: the built web game (copied into ./app by tools/prepare-desktop.mjs) in its
// own window. Online rooms and high scores use the public server (src/net/NetSession.ts), so the
// app needs no server of its own.
//
//   npm run desktop        (from the project root: build the game and open the app)
//   npm run desktop:dist   (zip for this computer's OS into desktop/release)

const { app, BrowserWindow, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const GAME_DIR = path.join(__dirname, 'app');

// The game is served as app://ursim/…: a standard, secure scheme gives the page fetch(),
// WebAssembly and localStorage exactly like the website (file:// would block fetch()).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function serveGame() {
  protocol.handle('app', request => {
    // Query strings (?v=build) only bust browser caches; the file is the path.
    const file = path.normalize(path.join(GAME_DIR, decodeURIComponent(new URL(request.url).pathname)));
    if (!file.startsWith(GAME_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    title: 'UrSim',
    backgroundColor: '#090b0f',
    autoHideMenuBar: true,
    icon: path.join(GAME_DIR, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL('app://ursim/index.html');
  // F11 toggles fullscreen, as in most games.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  // Links open in the normal browser, never inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  serveGame();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

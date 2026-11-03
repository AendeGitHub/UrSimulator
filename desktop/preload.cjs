// The game page's one way into the app: signing in through the player's browser (signin.cjs).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ursimDesktop', {
  /** Resolves with a session token, or null */
  signIn: (provider, server) => ipcRenderer.invoke('ursim:sign-in', provider, server),
});

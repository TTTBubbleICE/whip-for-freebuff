const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  audioDevices: (devices) => ipcRenderer.send('audio-devices', devices),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onSetSink: (fn) => ipcRenderer.on('set-sink', (event, id) => fn(id)),
  onTestSound: (fn) => ipcRenderer.on('test-sound', () => fn()),
  onSetSensitivity: (fn) => ipcRenderer.on('set-sensitivity', (event, level) => fn(level)),
});

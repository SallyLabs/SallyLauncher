'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sally', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onEvent: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMax')
  },
  platform: process.platform
});

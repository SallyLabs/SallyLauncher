'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  info: () => ipcRenderer.invoke('setup:info'),
  pickFolder: () => ipcRenderer.invoke('setup:pickFolder'),
  install: (options) => ipcRenderer.invoke('setup:install', options),
  uninstall: (options) => ipcRenderer.invoke('setup:uninstall', options),
  launch: (target) => ipcRenderer.invoke('setup:launch', target),
  openFolder: (target) => ipcRenderer.invoke('setup:openFolder', target),
  close: () => ipcRenderer.send('setup:close'),
  minimize: () => ipcRenderer.send('setup:minimize'),
  onEvent: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('setup:event', listener);
    return () => ipcRenderer.removeListener('setup:event', listener);
  }
});

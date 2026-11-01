// Preload: the only bridge between renderer and main. P1-D owns this folder and
// exposes the typed IPC API from src/shared/ (P0-05) here.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('rcsim', {
  platform: process.platform,
});

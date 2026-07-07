const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  importDocuments: (options) => ipcRenderer.invoke("document:import", options),
  previewSanitize: (payload) => ipcRenderer.invoke("sanitize:preview", payload),
  runSanitize: (payload) => ipcRenderer.invoke("sanitize:run", payload),
  selectOutputDirectory: () => ipcRenderer.invoke("output:select-directory"),
  unlockMapping: (payload) => ipcRenderer.invoke("mapping:unlock", payload),
  runRestore: (payload) => ipcRenderer.invoke("restore:run", payload)
});

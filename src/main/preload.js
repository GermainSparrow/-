const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  importDocuments: (options) => ipcRenderer.invoke("document:import", options),
  previewSanitize: (payload) => ipcRenderer.invoke("sanitize:preview", payload),
  previewSanitizeBatch: (payload) => ipcRenderer.invoke("sanitize:preview-batch", payload),
  runSanitize: (payload) => ipcRenderer.invoke("sanitize:run", payload),
  runSanitizeBatch: (payload) => ipcRenderer.invoke("sanitize:run-batch", payload),
  getLastOutputDirectory: () => ipcRenderer.invoke("output:get-last-directory"),
  selectOutputDirectory: () => ipcRenderer.invoke("output:select-directory"),
  openOutputFile: (payload) => ipcRenderer.invoke("output-file:open", payload),
  previewOutputFile: (payload) => ipcRenderer.invoke("output-file:preview", payload),
  revealOutputFile: (payload) => ipcRenderer.invoke("output-file:reveal", payload),
  deleteOutputFile: (payload) => ipcRenderer.invoke("output-file:delete", payload),
  unlockMapping: (payload) => ipcRenderer.invoke("mapping:unlock", payload),
  runRestore: (payload) => ipcRenderer.invoke("restore:run", payload),
  listEntitySets: () => ipcRenderer.invoke("entity-sets:list"),
  saveEntitySet: (payload) => ipcRenderer.invoke("entity-sets:save", payload),
  deleteEntitySet: (payload) => ipcRenderer.invoke("entity-sets:delete", payload),
  importEntitySet: (payload) => ipcRenderer.invoke("entity-sets:import", payload),
  exportEntitySet: (payload) => ipcRenderer.invoke("entity-sets:export", payload)
});

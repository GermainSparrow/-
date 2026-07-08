const { contextBridge, ipcRenderer, webUtils } = require("electron");

function droppedFilePaths(files) {
  if (!webUtils?.getPathForFile) {
    return [];
  }

  return Array.from(files || [])
    .map((file) => webUtils.getPathForFile(file))
    .filter(Boolean);
}

contextBridge.exposeInMainWorld("desktopApi", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  importDocuments: (options) => ipcRenderer.invoke("document:import", options),
  importDroppedDocuments: (options) => ipcRenderer.invoke("document:import-dropped", {
    purpose: options?.purpose,
    filePaths: droppedFilePaths(options?.files)
  }),
  previewSanitize: (payload) => ipcRenderer.invoke("sanitize:preview", payload),
  runSanitize: (payload) => ipcRenderer.invoke("sanitize:run", payload),
  selectOutputDirectory: () => ipcRenderer.invoke("output:select-directory"),
  unlockMapping: (payload) => ipcRenderer.invoke("mapping:unlock", payload),
  runRestore: (payload) => ipcRenderer.invoke("restore:run", payload)
});

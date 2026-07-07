const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  openDocuments: () => ipcRenderer.invoke("dialog:open-documents")
});

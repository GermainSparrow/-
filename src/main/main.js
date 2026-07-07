const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    title: "文档脱敏还原软件",
    backgroundColor: "#f6f7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("app:get-version", () => app.getVersion());

  ipcMain.handle("dialog:open-documents", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择待处理文档",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Supported Documents", extensions: ["doc", "docx", "pdf", "txt", "md", "xlsx"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });

    if (result.canceled) {
      return [];
    }

    return result.filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      extension: path.extname(filePath).replace(".", "").toUpperCase() || "FILE"
    }));
  });

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

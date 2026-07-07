const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const {
  documentImportSchema,
  parseWithSchema,
  previewSchema,
  restoreRunSchema,
  sanitizeRunSchema,
  unlockMappingSchema
} = require("./services/schemas");
const { runSafely } = require("./services/response");
const { previewSanitization, runRestoration, runSanitization, unlockMapping } = require("./services/sanitizer-service");
const { summarizeFile } = require("./services/document-service");
const {
  assertPreviewPayloadAuthorized,
  assertRestorePayloadAuthorized,
  assertSanitizePayloadAuthorized,
  assertUnlockMappingPayloadAuthorized,
  authorizeFilePaths,
  authorizeOutputDirectory
} = require("./services/path-authorization-service");

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

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl && !app.isPackaged && isLocalRendererUrl(rendererUrl)) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/renderer/index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("app:get-version", () => app.getVersion());

  ipcMain.handle("document:import", async (_event, payload) => runSafely(async () => {
    const options = parseWithSchema(documentImportSchema, payload);
    const result = await dialog.showOpenDialog({
      title: getImportTitle(options.purpose),
      properties: options.multi ? ["openFile", "multiSelections"] : ["openFile"],
      filters: getImportFilters(options.purpose)
    });

    if (result.canceled) {
      return [];
    }

    authorizeFilePaths(result.filePaths, options.purpose);
    return Promise.all(result.filePaths.map((filePath) => summarizeFile(filePath)));
  }));

  ipcMain.handle("output:select-directory", async () => runSafely(async () => {
    const result = await dialog.showOpenDialog({
      title: "选择输出目录",
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    authorizeOutputDirectory(result.filePaths[0]);
    return result.filePaths[0];
  }));

  ipcMain.handle("sanitize:preview", async (_event, payload) => runSafely(async () => {
    const data = parseWithSchema(previewSchema, payload);
    assertPreviewPayloadAuthorized(data);
    return previewSanitization(data.files);
  }));

  ipcMain.handle("sanitize:run", async (_event, payload) => runSafely(async () => {
    const data = parseWithSchema(sanitizeRunSchema, payload);
    assertSanitizePayloadAuthorized(data);
    return runSanitization(data);
  }));

  ipcMain.handle("mapping:unlock", async (_event, payload) => runSafely(async () => {
    const data = parseWithSchema(unlockMappingSchema, payload);
    assertUnlockMappingPayloadAuthorized(data);
    return unlockMapping(data);
  }));

  ipcMain.handle("restore:run", async (_event, payload) => runSafely(async () => {
    const data = parseWithSchema(restoreRunSchema, payload);
    assertRestorePayloadAuthorized(data);
    return runRestoration(data);
  }));

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

function getImportTitle(purpose) {
  const titles = {
    sanitize: "选择待脱敏文档",
    restore: "选择待还原文档",
    mapping: "选择加密映射文件",
    keyFile: "选择密钥文件"
  };
  return titles[purpose] || "选择文件";
}

function getImportFilters(purpose) {
  if (purpose === "mapping") {
    return [
      { name: "Encrypted Mapping", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] }
    ];
  }

  if (purpose === "keyFile") {
    return [
      { name: "Key Files", extensions: ["key", "bin", "txt"] },
      { name: "All Files", extensions: ["*"] }
    ];
  }

  return [
    { name: "Supported Documents", extensions: ["doc", "docx", "pdf", "txt", "md", "xls", "xlsx"] },
    { name: "All Files", extensions: ["*"] }
  ];
}

function isLocalRendererUrl(value) {
  try {
    const rendererUrl = new URL(value);
    return rendererUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(rendererUrl.hostname);
  } catch {
    return false;
  }
}

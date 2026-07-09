const path = require("node:path");
const { AppError } = require("./app-error");

const FILE_PURPOSES = new Set(["sanitize", "restore", "mapping", "keyFile"]);
const authorizedFilePathsByPurpose = new Map(
  Array.from(FILE_PURPOSES, (purpose) => [purpose, new Set()])
);
const authorizedOutputDirectories = new Set();

function normalizePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getAuthorizedFilePaths(purpose) {
  if (!FILE_PURPOSES.has(purpose)) {
    throw new AppError("INVALID_FILE_AUTHORIZATION_PURPOSE", "不支持的文件授权用途", {
      purpose
    });
  }
  return authorizedFilePathsByPurpose.get(purpose);
}

function authorizeFilePaths(filePaths, purpose) {
  const authorizedFilePaths = getAuthorizedFilePaths(purpose);
  for (const filePath of filePaths) {
    authorizedFilePaths.add(normalizePath(filePath));
  }
}

function authorizeOutputDirectory(directoryPath) {
  authorizedOutputDirectories.add(normalizePath(directoryPath));
}

function assertAuthorizedFilePath(filePath, purpose) {
  const authorizedFilePaths = getAuthorizedFilePaths(purpose);
  if (!authorizedFilePaths.has(normalizePath(filePath))) {
    throw new AppError("UNAUTHORIZED_FILE_PATH", "文件路径未通过对应用途的文件选择器授权", {
      path: filePath,
      purpose
    });
  }
}

function assertAuthorizedOutputDirectory(directoryPath) {
  if (!authorizedOutputDirectories.has(normalizePath(directoryPath))) {
    throw new AppError("UNAUTHORIZED_OUTPUT_DIRECTORY", "输出目录未通过目录选择器授权", {
      path: directoryPath
    });
  }
}

function assertCredentialAuthorized(credential) {
  if (credential?.method === "keyFile") {
    assertAuthorizedFilePath(credential.keyFilePath, "keyFile");
  }
}

function assertPreviewPayloadAuthorized(payload) {
  if (payload.source.kind === "word") {
    assertAuthorizedFilePath(payload.source.path, "sanitize");
  }
}

function assertSanitizePayloadAuthorized(payload) {
  if (payload.source.kind === "word") {
    assertAuthorizedFilePath(payload.source.path, "sanitize");
  }
  const outputDirectoryRequired = payload.source.kind === "word" ||
    payload.mode === "reversible" ||
    (payload.textOutputMode || "file") === "file";
  if (outputDirectoryRequired) {
    if (!payload.outputDir) {
      throw new AppError("UNAUTHORIZED_OUTPUT_DIRECTORY", "输出目录未通过目录选择器授权", {
        path: payload.outputDir
      });
    }
    assertAuthorizedOutputDirectory(payload.outputDir);
  }
  assertCredentialAuthorized(payload.credential);
}

function assertUnlockMappingPayloadAuthorized(payload) {
  assertAuthorizedFilePath(payload.mappingPath, "mapping");
  assertCredentialAuthorized(payload.credential);
}

function assertRestorePayloadAuthorized(payload) {
  if (payload.source.kind === "word") {
    assertAuthorizedFilePath(payload.source.path, "restore");
  }
  assertAuthorizedFilePath(payload.mappingPath, "mapping");
  assertAuthorizedOutputDirectory(payload.outputDir);
  assertCredentialAuthorized(payload.credential);
}

function clearAuthorizationsForTest() {
  for (const authorizedFilePaths of authorizedFilePathsByPurpose.values()) {
    authorizedFilePaths.clear();
  }
  authorizedOutputDirectories.clear();
}

module.exports = {
  assertPreviewPayloadAuthorized,
  assertRestorePayloadAuthorized,
  assertSanitizePayloadAuthorized,
  assertUnlockMappingPayloadAuthorized,
  authorizeFilePaths,
  authorizeOutputDirectory,
  clearAuthorizationsForTest
};

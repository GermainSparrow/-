const fs = require("node:fs/promises");
const path = require("node:path");

const STORE_FILE_NAME = "output-preferences.json";
let storeDirectory = null;
let memoryPreferences = {};

function configureOutputDirectoryStore(directory) {
  storeDirectory = directory;
}

function storeFilePath() {
  if (!storeDirectory) return null;
  return path.join(storeDirectory, STORE_FILE_NAME);
}

async function readPreferences() {
  const filePath = storeFilePath();
  if (!filePath) return { ...memoryPreferences };

  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    return {};
  }
}

async function writePreferences(preferences) {
  const filePath = storeFilePath();
  if (!filePath) {
    memoryPreferences = { ...preferences };
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(preferences, null, 2), "utf8");
}

async function isExistingDirectory(directoryPath) {
  if (!directoryPath) return false;
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function getLastOutputDirectory() {
  const preferences = await readPreferences();
  const directoryPath = String(preferences.lastOutputDirectory || "").trim();
  return await isExistingDirectory(directoryPath) ? directoryPath : null;
}

async function saveLastOutputDirectory(directoryPath) {
  if (!await isExistingDirectory(directoryPath)) return null;
  const preferences = await readPreferences();
  const nextPreferences = {
    ...preferences,
    lastOutputDirectory: directoryPath,
    updatedAt: new Date().toISOString()
  };
  await writePreferences(nextPreferences);
  return directoryPath;
}

function clearOutputDirectoryStoreForTest() {
  storeDirectory = null;
  memoryPreferences = {};
}

module.exports = {
  clearOutputDirectoryStoreForTest,
  configureOutputDirectoryStore,
  getLastOutputDirectory,
  saveLastOutputDirectory
};

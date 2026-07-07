const versionNode = document.querySelector("#app-version");
const modeButtons = document.querySelectorAll(".mode-card");
const sanitizeView = document.querySelector("#sanitize-view");
const restoreView = document.querySelector("#restore-view");
const statusPanel = document.querySelector("#status-panel");

const selectFilesButton = document.querySelector("#select-files");
const selectOutputButton = document.querySelector("#select-output");
const sanitizeModeSelect = document.querySelector("#sanitize-mode");
const credentialMethodSelect = document.querySelector("#credential-method");
const passwordInput = document.querySelector("#password-input");
const passwordField = document.querySelector("#password-field");
const keyFileField = document.querySelector("#key-file-field");
const selectKeyFileButton = document.querySelector("#select-key-file");
const credentialFields = document.querySelectorAll(".credential-field");
const fileList = document.querySelector("#file-list");
const previewEntitiesButton = document.querySelector("#preview-entities");
const addEntityButton = document.querySelector("#add-entity");
const entityTableBody = document.querySelector("#entity-table-body");
const runSanitizeButton = document.querySelector("#run-sanitize");

const selectRestoreFileButton = document.querySelector("#select-restore-file");
const selectMappingFileButton = document.querySelector("#select-mapping-file");
const selectRestoreOutputButton = document.querySelector("#select-restore-output");
const restoreCredentialMethodSelect = document.querySelector("#restore-credential-method");
const restorePasswordInput = document.querySelector("#restore-password-input");
const restorePasswordField = document.querySelector("#restore-password-field");
const restoreKeyFileField = document.querySelector("#restore-key-file-field");
const selectRestoreKeyFileButton = document.querySelector("#select-restore-key-file");
const restoreFileList = document.querySelector("#restore-file-list");
const runRestoreButton = document.querySelector("#run-restore");

const TYPE_OPTIONS = [
  ["company", "公司"],
  ["person", "人名"],
  ["phone", "手机号"],
  ["idCard", "身份证"],
  ["address", "地址"],
  ["email", "邮箱"],
  ["account", "账号"]
];

const TYPE_PREFIX = {
  company: "ORG",
  person: "PERSON",
  phone: "PHONE",
  idCard: "ID",
  address: "ADDR",
  email: "EMAIL",
  account: "ACCOUNT"
};

const state = {
  view: "sanitize",
  sanitize: {
    files: [],
    outputDir: "",
    entities: [],
    keyFile: null
  },
  restore: {
    file: null,
    mappingFile: null,
    outputDir: "",
    keyFile: null
  }
};

async function init() {
  if (window.desktopApi?.getVersion) {
    versionNode.textContent = await window.desktopApi.getVersion();
  }

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  selectFilesButton.addEventListener("click", handleSelectFiles);
  selectOutputButton.addEventListener("click", handleSelectOutput);
  sanitizeModeSelect.addEventListener("change", updateSanitizeCredentialFields);
  credentialMethodSelect.addEventListener("change", updateSanitizeCredentialFields);
  selectKeyFileButton.addEventListener("click", handleSelectKeyFile);
  previewEntitiesButton.addEventListener("click", handlePreviewEntities);
  addEntityButton.addEventListener("click", handleAddEntity);
  runSanitizeButton.addEventListener("click", handleRunSanitize);

  selectRestoreFileButton.addEventListener("click", handleSelectRestoreFile);
  selectMappingFileButton.addEventListener("click", handleSelectMappingFile);
  selectRestoreOutputButton.addEventListener("click", handleSelectRestoreOutput);
  restoreCredentialMethodSelect.addEventListener("change", updateRestoreCredentialFields);
  selectRestoreKeyFileButton.addEventListener("click", handleSelectRestoreKeyFile);
  runRestoreButton.addEventListener("click", handleRunRestore);

  updateSanitizeCredentialFields();
  updateRestoreCredentialFields();
}

function switchView(view) {
  state.view = view;
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  sanitizeView.hidden = view !== "sanitize";
  restoreView.hidden = view !== "restore";
  clearStatus();
}

async function callApi(task) {
  const response = await task();
  if (!response.ok) {
    const message = response.error?.message || "操作失败";
    const details = response.error?.details ? `\n${JSON.stringify(response.error.details, null, 2)}` : "";
    throw new Error(`${message}${details}`);
  }
  return response.data;
}

async function handleSelectFiles() {
  try {
    const files = await callApi(() => window.desktopApi.importDocuments({ purpose: "sanitize", multi: false }));
    if (!files.length) return;
    state.sanitize.files = files;
    state.sanitize.entities = [];
    renderFiles();
    renderEntities();
    setStatus("已导入文档，请预览识别出的实体。", "info");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleSelectOutput() {
  try {
    const outputDir = await callApi(() => window.desktopApi.selectOutputDirectory());
    if (!outputDir) return;
    state.sanitize.outputDir = outputDir;
    selectOutputButton.textContent = outputDir;
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleSelectKeyFile() {
  try {
    const files = await callApi(() => window.desktopApi.importDocuments({ purpose: "keyFile", multi: false }));
    if (!files.length) return;
    state.sanitize.keyFile = files[0];
    selectKeyFileButton.textContent = files[0].name;
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handlePreviewEntities() {
  if (!state.sanitize.files.length) {
    setStatus("请先导入待脱敏文档。", "error");
    return;
  }

  try {
    setBusy(previewEntitiesButton, true, "识别中...");
    const result = await callApi(() => window.desktopApi.previewSanitize({
      files: state.sanitize.files.map((file) => ({ path: file.path, docId: file.docId }))
    }));
    state.sanitize.entities = result.entities;
    renderFiles(result);
    renderEntities();
    const blockedText = result.blocked.length ? `，${result.blocked.length} 个文件被阻断` : "";
    setStatus(`已识别 ${result.entities.length} 个实体${blockedText}。`, result.blocked.length ? "warning" : "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(previewEntitiesButton, false, "预览识别");
  }
}

function handleAddEntity() {
  if (!state.sanitize.files.length) {
    setStatus("请先导入文档，再新增实体。", "error");
    return;
  }

  const file = state.sanitize.files[0];
  const type = "company";
  const stableId = nextStableId(type, file.docId);
  state.sanitize.entities.push({
    id: `manual-${Date.now()}`,
    docId: file.docId,
    filePath: file.path,
    type,
    originalValue: "",
    maskedValue: `<${stableId}>`,
    stableId,
    contextHash: "",
    locations: [],
    enabled: true,
    source: "manual"
  });
  renderEntities();
}

async function handleRunSanitize() {
  const mode = sanitizeModeSelect.value;

  if (!state.sanitize.files.length) {
    setStatus("请先导入待脱敏文档。", "error");
    return;
  }
  if (!state.sanitize.outputDir) {
    setStatus("请选择输出目录。", "error");
    return;
  }

  const entities = readEntitiesFromTable();
  if (entities.some((entity) => entity.enabled && (!entity.originalValue || !entity.maskedValue))) {
    setStatus("启用的实体必须填写原文值和脱敏值。", "error");
    return;
  }

  const payload = {
    files: state.sanitize.files.map((file) => ({ path: file.path, docId: file.docId })),
    mode,
    entities,
    outputDir: state.sanitize.outputDir
  };

  if (mode === "reversible") {
    const credential = getSanitizeCredential();
    if (!credential) return;
    payload.credential = credential;
  }

  try {
    setBusy(runSanitizeButton, true, "处理中...");
    const result = await callApi(() => window.desktopApi.runSanitize(payload));
    const lines = result.results.flatMap((item) => [
      `脱敏文件：${item.outputs.sanitizedFile}`,
      item.outputs.mappingFile ? `映射文件：${item.outputs.mappingFile}` : null,
      `报告：${item.outputs.reportFile}`
    ]).filter(Boolean);
    setStatus(lines.join("\n"), "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(runSanitizeButton, false, "执行脱敏");
  }
}

async function handleSelectRestoreFile() {
  try {
    const files = await callApi(() => window.desktopApi.importDocuments({ purpose: "restore", multi: false }));
    if (!files.length) return;
    state.restore.file = files[0];
    renderRestoreFiles();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleSelectMappingFile() {
  try {
    const files = await callApi(() => window.desktopApi.importDocuments({ purpose: "mapping", multi: false }));
    if (!files.length) return;
    state.restore.mappingFile = files[0];
    renderRestoreFiles();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleSelectRestoreOutput() {
  try {
    const outputDir = await callApi(() => window.desktopApi.selectOutputDirectory());
    if (!outputDir) return;
    state.restore.outputDir = outputDir;
    selectRestoreOutputButton.textContent = outputDir;
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleSelectRestoreKeyFile() {
  try {
    const files = await callApi(() => window.desktopApi.importDocuments({ purpose: "keyFile", multi: false }));
    if (!files.length) return;
    state.restore.keyFile = files[0];
    selectRestoreKeyFileButton.textContent = files[0].name;
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleRunRestore() {
  if (!state.restore.file || !state.restore.mappingFile || !state.restore.outputDir) {
    setStatus("请选择脱敏文件、映射文件和输出目录。", "error");
    return;
  }

  const credential = getRestoreCredential();
  if (!credential) return;

  try {
    setBusy(runRestoreButton, true, "还原中...");
    const result = await callApi(() => window.desktopApi.runRestore({
      filePath: state.restore.file.path,
      mappingPath: state.restore.mappingFile.path,
      outputDir: state.restore.outputDir,
      credential
    }));
    setStatus(`还原文件：${result.outputPath}\n报告：${result.reportPath}`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(runRestoreButton, false, "执行还原");
  }
}

function getSanitizeCredential() {
  if (credentialMethodSelect.value === "password") {
    if (!passwordInput.value) {
      setStatus("请输入可恢复映射口令。", "error");
      return null;
    }
    return { method: "password", password: passwordInput.value };
  }

  if (!state.sanitize.keyFile) {
    setStatus("请选择密钥文件。", "error");
    return null;
  }
  return { method: "keyFile", keyFilePath: state.sanitize.keyFile.path };
}

function getRestoreCredential() {
  if (restoreCredentialMethodSelect.value === "password") {
    if (!restorePasswordInput.value) {
      setStatus("请输入映射文件口令。", "error");
      return null;
    }
    return { method: "password", password: restorePasswordInput.value };
  }

  if (!state.restore.keyFile) {
    setStatus("请选择密钥文件。", "error");
    return null;
  }
  return { method: "keyFile", keyFilePath: state.restore.keyFile.path };
}

function updateSanitizeCredentialFields() {
  const reversible = sanitizeModeSelect.value === "reversible";
  credentialFields.forEach((field) => {
    field.hidden = !reversible;
  });
  if (!reversible) return;
  const keyFileMode = credentialMethodSelect.value === "keyFile";
  passwordField.hidden = keyFileMode;
  keyFileField.hidden = !keyFileMode;
}

function updateRestoreCredentialFields() {
  const keyFileMode = restoreCredentialMethodSelect.value === "keyFile";
  restorePasswordField.hidden = keyFileMode;
  restoreKeyFileField.hidden = !keyFileMode;
}

function renderFiles(previewResult = null) {
  if (!state.sanitize.files.length) {
    fileList.innerHTML = "";
    return;
  }

  const blockedByPath = new Map((previewResult?.blocked || []).map((item) => [item.path, item.error]));
  fileList.replaceChildren(...state.sanitize.files.map((file) => {
    const item = document.createElement("article");
    item.className = "file-item";
    const blocked = blockedByPath.get(file.path);
    item.innerHTML = `
      <div class="file-type">${file.extension}</div>
      <div>
        <div class="file-name"></div>
        <div class="file-path"></div>
      </div>
      <span class="status-pill ${blocked ? "danger" : ""}">${blocked ? "已阻断" : "待处理"}</span>
    `;
    item.querySelector(".file-name").textContent = file.name;
    item.querySelector(".file-path").textContent = blocked ? blocked.message : file.path;
    item.querySelector(".file-path").title = blocked ? blocked.message : file.path;
    return item;
  }));
}

function renderRestoreFiles() {
  const files = [
    state.restore.file ? ["脱敏文件", state.restore.file.name, state.restore.file.path] : null,
    state.restore.mappingFile ? ["映射文件", state.restore.mappingFile.name, state.restore.mappingFile.path] : null,
    state.restore.keyFile ? ["密钥文件", state.restore.keyFile.name, state.restore.keyFile.path] : null
  ].filter(Boolean);

  restoreFileList.replaceChildren(...files.map(([type, name, filePath]) => {
    const item = document.createElement("article");
    item.className = "file-item";
    item.innerHTML = `
      <div class="file-type">${type}</div>
      <div>
        <div class="file-name"></div>
        <div class="file-path"></div>
      </div>
      <span class="status-pill">已选择</span>
    `;
    item.querySelector(".file-name").textContent = name;
    item.querySelector(".file-path").textContent = filePath;
    item.querySelector(".file-path").title = filePath;
    return item;
  }));
}

function renderEntities() {
  if (!state.sanitize.entities.length) {
    entityTableBody.innerHTML = '<tr><td colspan="5" class="table-empty">导入文件并预览后显示实体。</td></tr>';
    return;
  }

  entityTableBody.replaceChildren(...state.sanitize.entities.map((entity, index) => {
    const row = document.createElement("tr");
    row.dataset.index = String(index);

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = entity.enabled !== false;
    enabled.addEventListener("change", () => {
      state.sanitize.entities[index].enabled = enabled.checked;
    });

    const type = document.createElement("select");
    for (const [value, label] of TYPE_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = entity.type === value;
      type.append(option);
    }
    type.addEventListener("change", () => {
      const stableId = nextStableId(type.value, entity.docId, index);
      Object.assign(state.sanitize.entities[index], {
        type: type.value,
        stableId,
        maskedValue: `<${stableId}>`
      });
      renderEntities();
    });

    const original = document.createElement("input");
    original.value = entity.originalValue;
    original.addEventListener("input", () => {
      state.sanitize.entities[index].originalValue = original.value;
    });

    const masked = document.createElement("input");
    masked.value = entity.maskedValue;
    masked.addEventListener("input", () => {
      state.sanitize.entities[index].maskedValue = masked.value;
    });

    const stable = document.createElement("code");
    stable.textContent = entity.stableId;

    row.append(td(enabled), td(type), td(original), td(masked), td(stable));
    return row;
  }));
}

function readEntitiesFromTable() {
  return state.sanitize.entities.map((entity) => ({ ...entity }));
}

function nextStableId(type, docId, ignoreIndex = -1) {
  const prefix = TYPE_PREFIX[type] || type.toUpperCase();
  const count = state.sanitize.entities.filter((entity, index) => {
    return index !== ignoreIndex && entity.docId === docId && entity.type === type;
  }).length + 1;
  return `${prefix}_${String(count).padStart(3, "0")}`;
}

function td(child) {
  const cell = document.createElement("td");
  cell.append(child);
  return cell;
}

function setStatus(message, tone = "info") {
  statusPanel.hidden = false;
  statusPanel.className = `status-panel ${tone}`;
  statusPanel.textContent = message;
}

function clearStatus() {
  statusPanel.hidden = true;
  statusPanel.textContent = "";
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

init();

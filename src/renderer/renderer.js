const selectFilesButton = document.querySelector("#select-files");
const emptyState = document.querySelector("#empty-state");
const fileList = document.querySelector("#file-list");
const versionNode = document.querySelector("#app-version");
const modeButtons = document.querySelectorAll(".mode-card");

async function init() {
  if (window.desktopApi?.getVersion) {
    versionNode.textContent = await window.desktopApi.getVersion();
  }

  selectFilesButton.addEventListener("click", handleSelectFiles);
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      modeButtons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });
}

async function handleSelectFiles() {
  const files = await window.desktopApi.openDocuments();

  if (!files.length) {
    return;
  }

  emptyState.hidden = true;
  fileList.hidden = false;
  fileList.replaceChildren(...files.map(createFileItem));
}

function createFileItem(file) {
  const item = document.createElement("article");
  item.className = "file-item";

  const type = document.createElement("div");
  type.className = "file-type";
  type.textContent = file.extension;

  const details = document.createElement("div");
  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = file.name;

  const filePath = document.createElement("div");
  filePath.className = "file-path";
  filePath.textContent = file.path;
  filePath.title = file.path;

  const status = document.createElement("span");
  status.className = "status-pill";
  status.textContent = "待处理";

  details.append(name, filePath);
  item.append(type, details, status);

  return item;
}

init();

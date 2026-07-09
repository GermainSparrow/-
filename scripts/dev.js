const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:5173";
const ELECTRON_ONLY = process.argv.includes("--electron-only");
const BUILD_AND_START = process.argv.includes("--build");
const isWindows = process.platform === "win32";

let rendererProcess = null;
let electronProcess = null;
let stopping = false;

function requestRenderer() {
  return new Promise((resolve) => {
    const request = http.get(RENDERER_URL, (response) => {
      response.resume();
      resolve(response.statusCode && response.statusCode < 500);
    });

    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForRenderer(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await requestRenderer()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Renderer dev server did not become ready: ${RENDERER_URL}`);
}

function spawnRenderer() {
  const command = isWindows ? "cmd.exe" : "npm";
  const args = isWindows
    ? ["/d", "/s", "/c", "npm", "run", "dev:renderer"]
    : ["run", "dev:renderer"];

  rendererProcess = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "inherit"
  });

  rendererProcess.on("exit", (code) => {
    rendererProcess = null;
    if (!stopping && code !== 0 && !electronProcess) {
      process.exitCode = code || 1;
    }
  });
}

function runBuild() {
  const command = isWindows ? "cmd.exe" : "npm";
  const args = isWindows
    ? ["/d", "/s", "/c", "npm", "run", "build:renderer"]
    : ["run", "build:renderer"];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function spawnElectron({ useRendererUrl = true } = {}) {
  const electronPath = require("electron");
  const env = { ...process.env };
  if (useRendererUrl) {
    env.ELECTRON_RENDERER_URL = RENDERER_URL;
  } else {
    delete env.ELECTRON_RENDERER_URL;
  }
  delete env.ELECTRON_RUN_AS_NODE;

  electronProcess = spawn(electronPath, ["."], {
    cwd: process.cwd(),
    env,
    stdio: "inherit"
  });

  electronProcess.on("exit", (code, signal) => {
    electronProcess = null;
    stopChildren();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
}

function stopProcess(child) {
  if (!child || child.killed) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore"
    });
    return;
  }
  child.kill();
}

function stopChildren() {
  stopping = true;
  stopProcess(electronProcess);
  stopProcess(rendererProcess);
}

async function main() {
  if (BUILD_AND_START) {
    runBuild();
    spawnElectron({ useRendererUrl: false });
    return;
  }

  if (!ELECTRON_ONLY && !(await requestRenderer())) {
    spawnRenderer();
    await waitForRenderer();
  } else if (!ELECTRON_ONLY) {
    console.log(`Using existing renderer dev server: ${RENDERER_URL}`);
  }

  spawnElectron();
}

process.on("SIGINT", () => {
  stopChildren();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopChildren();
  process.exit(143);
});

main().catch((error) => {
  stopChildren();
  console.error(error.message || error);
  process.exit(1);
});

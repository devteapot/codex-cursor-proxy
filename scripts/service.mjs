import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const LABEL = "com.carlid.codex-cursor-proxy";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const ENV_FILE = join(PROJECT_DIR, ".env");
const SERVER_FILE = join(PROJECT_DIR, "src", "server.js");
const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_FILE = join(AGENTS_DIR, `${LABEL}.plist`);
const LOG_DIR = join(homedir(), "Library", "Logs", "codex-cursor-proxy");
const STDOUT_LOG = join(LOG_DIR, "stdout.log");
const STDERR_LOG = join(LOG_DIR, "stderr.log");
const DOMAIN = `gui/${process.getuid()}`;
const SERVICE = `${DOMAIN}/${LABEL}`;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildPlist({ nodePath = process.execPath } = {}) {
  const executableDir = dirname(nodePath);
  const launchPath = [
    executableDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((item, index, values) => values.indexOf(item) === index).join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(`--env-file=${ENV_FILE}`)}</string>
    <string>${xml(SERVER_FILE)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(PROJECT_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>PATH</key>
    <string>${xml(launchPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(STDOUT_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(STDERR_LOG)}</string>
</dict>
</plist>
`;
}

function launchctl(args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`launchctl ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function isLoaded() {
  return launchctl(["print", SERVICE], { allowFailure: true, capture: true }).status === 0;
}

async function ensureInstalledFiles() {
  try {
    await readFile(ENV_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing ${ENV_FILE}. Run \"npm run init\" first.`);
    }
    throw error;
  }

  await mkdir(AGENTS_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  const temporary = `${PLIST_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, buildPlist(), { encoding: "utf8", mode: 0o644 });
  await rename(temporary, PLIST_FILE);
}

async function load() {
  if (!isLoaded()) {
    launchctl(["bootstrap", DOMAIN, PLIST_FILE]);
  }
  launchctl(["enable", SERVICE]);
  launchctl(["kickstart", "-k", SERVICE]);
}

async function install() {
  await ensureInstalledFiles();
  if (isLoaded()) {
    launchctl(["bootout", SERVICE]);
  }
  await load();
  console.log(`Installed and started ${LABEL}.`);
  printLocations();
}

async function start() {
  await ensureInstalledFiles();
  await load();
  console.log(`Started ${LABEL}.`);
}

function stop() {
  if (!isLoaded()) {
    console.log(`${LABEL} is already stopped.`);
    return;
  }
  launchctl(["bootout", SERVICE]);
  console.log(`Stopped ${LABEL}. The LaunchAgent remains installed.`);
}

async function restart() {
  await ensureInstalledFiles();
  if (isLoaded()) {
    launchctl(["kickstart", "-k", SERVICE]);
  } else {
    await load();
  }
  console.log(`Restarted ${LABEL}.`);
}

async function uninstall() {
  if (isLoaded()) {
    launchctl(["bootout", SERVICE]);
  }
  try {
    await unlink(PLIST_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(`Uninstalled ${LABEL}. Logs were kept in ${LOG_DIR}.`);
}

function status() {
  const result = launchctl(["print", SERVICE], { allowFailure: true, capture: true });
  if (result.status !== 0) {
    console.log(`${LABEL} is not running.`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.stdout);
}

function printLocations() {
  console.log(`LaunchAgent: ${PLIST_FILE}`);
  console.log(`stdout: ${STDOUT_LOG}`);
  console.log(`stderr: ${STDERR_LOG}`);
}

function usage() {
  console.log("Usage: node scripts/service.mjs <install|start|stop|restart|status|logs|uninstall>");
}

async function main() {
  switch (process.argv[2]) {
    case "install": await install(); break;
    case "start": await start(); break;
    case "stop": stop(); break;
    case "restart": await restart(); break;
    case "status": status(); break;
    case "logs": printLocations(); break;
    case "uninstall": await uninstall(); break;
    default:
      usage();
      process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

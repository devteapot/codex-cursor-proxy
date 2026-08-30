import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const LABEL = "com.carlid.codex-cursor-proxy.tunnel";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const TOKEN_FILE = join(PROJECT_DIR, ".cloudflared-token");
const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_FILE = join(AGENTS_DIR, `${LABEL}.plist`);
const LOG_DIR = join(homedir(), "Library", "Logs", "codex-cursor-proxy");
const STDOUT_LOG = join(LOG_DIR, "tunnel-stdout.log");
const STDERR_LOG = join(LOG_DIR, "tunnel-stderr.log");
const DOMAIN = `gui/${process.getuid()}`;
const SERVICE = `${DOMAIN}/${LABEL}`;
const DEFAULT_TUNNEL = "codex-cursor-proxy";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function findCloudflared() {
  const result = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  const executable = result.status === 0 ? result.stdout.trim() : "";
  if (!executable) {
    throw new Error("cloudflared is not installed. Install it with: brew install cloudflared");
  }
  return executable;
}

export function extractTunnelToken(value) {
  const candidates = String(value).match(/[A-Za-z0-9_.=-]{100,}/g) || [];
  const token = candidates.filter((candidate) => candidate.startsWith("eyJ"))
    .sort((a, b) => b.length - a.length)[0];
  if (!token) {
    throw new Error("The clipboard does not contain a Cloudflare tunnel token or install command.");
  }
  return token;
}

export function buildTunnelPlist({ cloudflaredPath = "/opt/homebrew/bin/cloudflared" } = {}) {
  const launchPath = [
    dirname(cloudflaredPath),
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
    <string>${xml(cloudflaredPath)}</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>--loglevel</string>
    <string>info</string>
    <string>--transport-loglevel</string>
    <string>warn</string>
    <string>run</string>
    <string>--token-file</string>
    <string>${xml(TOKEN_FILE)}</string>
    <string>--url</string>
    <string>http://127.0.0.1:8787</string>
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
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`launchctl ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function isLoaded() {
  return launchctl(["print", SERVICE], { allowFailure: true, capture: true }).status === 0;
}

async function saveToken(token) {
  extractTunnelToken(token);
  const temporary = `${TOKEN_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, TOKEN_FILE);
  await chmod(TOKEN_FILE, 0o600);
  console.log(`Saved the tunnel token to ${TOKEN_FILE} with mode 0600.`);
  console.log("The token was not printed or copied into the LaunchAgent.");
}

async function configureFromClipboard() {
  const clipboard = spawnSync("pbpaste", [], { encoding: "utf8" });
  if (clipboard.error || clipboard.status !== 0) {
    throw new Error("Could not read the macOS clipboard.");
  }
  await saveToken(extractTunnelToken(clipboard.stdout));
}

async function configureFromCli(tunnel = DEFAULT_TUNNEL) {
  const result = spawnSync(findCloudflared(), ["tunnel", "token", tunnel], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not fetch the token for tunnel ${tunnel}: ${(result.stderr || "unknown error").trim()}`);
  }
  await saveToken(extractTunnelToken(result.stdout));
}

async function ensureInstalledFiles() {
  const token = (await readFile(TOKEN_FILE, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error("No tunnel token configured. Copy the Cloudflare install command, then run: npm run tunnel:configure");
    }
    throw error;
  })).trim();
  extractTunnelToken(token);
  await chmod(TOKEN_FILE, 0o600);

  await mkdir(AGENTS_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  const temporary = `${PLIST_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, buildTunnelPlist({ cloudflaredPath: findCloudflared() }), {
    encoding: "utf8",
    mode: 0o644,
  });
  await rename(temporary, PLIST_FILE);
}

async function load() {
  if (!isLoaded()) launchctl(["bootstrap", DOMAIN, PLIST_FILE]);
  launchctl(["enable", SERVICE]);
  launchctl(["kickstart", "-k", SERVICE]);
}

async function install() {
  await ensureInstalledFiles();
  if (isLoaded()) launchctl(["bootout", SERVICE]);
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
  if (isLoaded()) launchctl(["kickstart", "-k", SERVICE]);
  else await load();
  console.log(`Restarted ${LABEL}.`);
}

async function uninstall() {
  if (isLoaded()) launchctl(["bootout", SERVICE]);
  try {
    await unlink(PLIST_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(`Uninstalled ${LABEL}. The token and logs were kept.`);
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
  console.log("Usage: node scripts/tunnel-service.mjs <configure|configure-cli|install|start|stop|restart|status|logs|uninstall>");
}

async function main() {
  switch (process.argv[2]) {
    case "configure": await configureFromClipboard(); break;
    case "configure-cli": await configureFromCli(process.argv[3]); break;
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

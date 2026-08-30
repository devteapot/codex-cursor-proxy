import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";

function positiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function detectCodexVersion() {
  if (process.env.CODEX_CLIENT_VERSION) return process.env.CODEX_CLIENT_VERSION;
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const match = result.stdout?.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? "0.1.0";
}

function authFilePath() {
  if (process.env.CODEX_AUTH_FILE) return resolve(process.env.CODEX_AUTH_FILE);
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
  return join(codexHome, "auth.json");
}

function parseModels(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig() {
  const apiKey = process.env.PROXY_API_KEY?.trim();
  if (!apiKey || apiKey.length < 24) {
    throw new Error("PROXY_API_KEY is required and must contain at least 24 characters. Run `npm run init`.");
  }

  return {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: positiveInt(process.env.PORT, 8787, "PORT"),
    apiKey,
    authFile: authFilePath(),
    upstreamBaseUrl: (process.env.CODEX_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM).replace(/\/+$/, ""),
    clientVersion: detectCodexVersion(),
    configuredModels: parseModels(process.env.CODEX_PROXY_MODELS),
    defaultReasoningEffort: process.env.DEFAULT_REASONING_EFFORT?.trim() || "high",
    maxConcurrentRequests: positiveInt(process.env.MAX_CONCURRENT_REQUESTS, 4, "MAX_CONCURRENT_REQUESTS"),
    maxRequestBytes: positiveInt(process.env.MAX_REQUEST_BYTES, 20 * 1024 * 1024, "MAX_REQUEST_BYTES"),
    requestTimeoutMs: positiveInt(process.env.REQUEST_TIMEOUT_MS, 15 * 60 * 1000, "REQUEST_TIMEOUT_MS"),
    refreshSkewMs: positiveInt(process.env.REFRESH_SKEW_MS, 5 * 60 * 1000, "REFRESH_SKEW_MS"),
    originator: process.env.CODEX_ORIGINATOR?.trim() || "codex_cli_rs"
  };
}

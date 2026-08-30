import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HttpError } from "./errors.js";

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function tokenExpiresSoon(token, now, skewMs) {
  const exp = decodeJwtPayload(token)?.exp;
  if (!Number.isFinite(exp)) return false;
  return exp * 1000 <= now() + skewMs;
}

function accountIdFrom(data) {
  const direct = data?.tokens?.account_id;
  if (typeof direct === "string" && direct) return direct;

  for (const token of [data?.tokens?.access_token, data?.tokens?.id_token]) {
    const payload = decodeJwtPayload(token);
    const auth = payload?.["https://api.openai.com/auth"];
    const accountId = auth?.chatgpt_account_id
      ?? payload?.["https://api.openai.com/auth.chatgpt_account_id"]
      ?? payload?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId) return accountId;
  }
  return null;
}

async function readAuthFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(503, `Codex authentication was not found at ${path}. Run \`codex login\` first.`, "codex_auth_missing");
    }
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(503, `Codex authentication at ${path} is not valid JSON.`, "codex_auth_invalid");
  }
}

async function atomicWriteJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export class CodexAuth {
  #refreshPromise = null;

  constructor({ authFile, refreshSkewMs = 300_000, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.authFile = authFile;
    this.refreshSkewMs = refreshSkewMs;
    this.fetch = fetchImpl;
    this.now = now;
  }

  async getCredentials({ forceRefresh = false } = {}) {
    const envToken = process.env.CODEX_ACCESS_TOKEN?.trim();
    if (envToken) {
      const accountId = process.env.CODEX_ACCOUNT_ID?.trim()
        || accountIdFrom({ tokens: { access_token: envToken } });
      if (!accountId) {
        throw new HttpError(503, "CODEX_ACCOUNT_ID is required when the access token does not contain a workspace identifier.", "codex_account_missing");
      }
      return { accessToken: envToken, accountId };
    }

    let data = await readAuthFile(this.authFile);
    const accessToken = data?.tokens?.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new HttpError(503, "The Codex auth file does not contain a ChatGPT access token. Run `codex login`.", "codex_auth_mode_unsupported");
    }

    if (forceRefresh || tokenExpiresSoon(accessToken, this.now, this.refreshSkewMs)) {
      data = await this.#refresh(forceRefresh);
    }

    const accountId = accountIdFrom(data);
    if (!accountId) {
      throw new HttpError(503, "The Codex auth file does not identify the active ChatGPT workspace.", "codex_account_missing");
    }
    return { accessToken: data.tokens.access_token, accountId };
  }

  async #refresh(force = false) {
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#performRefresh(force).finally(() => {
        this.#refreshPromise = null;
      });
    }
    return this.#refreshPromise;
  }

  async #performRefresh(force) {
    const latest = await readAuthFile(this.authFile);
    const currentAccessToken = latest?.tokens?.access_token;
    if (!force
      && typeof currentAccessToken === "string"
      && !tokenExpiresSoon(currentAccessToken, this.now, this.refreshSkewMs)) {
      return latest;
    }

    const refreshToken = latest?.tokens?.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) {
      throw new HttpError(503, "The Codex login cannot be refreshed. Run `codex login` again.", "codex_refresh_missing");
    }

    let response;
    try {
      response = await this.fetch(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID || OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken
        })
      });
    } catch {
      throw new HttpError(503, "Codex authentication refresh could not reach the authentication service.", "codex_refresh_unavailable");
    }

    if (!response.ok) {
      throw new HttpError(503, "Codex authentication has expired or was revoked. Run `codex login` again.", "codex_refresh_failed");
    }

    const refreshed = await response.json();
    if (typeof refreshed.access_token !== "string" || !refreshed.access_token) {
      throw new HttpError(503, "The authentication service returned an invalid refresh response.", "codex_refresh_invalid");
    }

    latest.tokens.access_token = refreshed.access_token;
    if (typeof refreshed.id_token === "string" && refreshed.id_token) {
      latest.tokens.id_token = refreshed.id_token;
    }
    if (typeof refreshed.refresh_token === "string" && refreshed.refresh_token) {
      latest.tokens.refresh_token = refreshed.refresh_token;
    }
    latest.last_refresh = new Date(this.now()).toISOString();
    await atomicWriteJson(this.authFile, latest);
    return latest;
  }
}

export const authInternals = { accountIdFrom, decodeJwtPayload, tokenExpiresSoon };

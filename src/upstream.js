import { UpstreamError } from "./errors.js";
import { normalizeResponsesRequest } from "./translate.js";

async function safeErrorMessage(response) {
  const text = await response.text().catch(() => "");
  if (!text) return `Codex upstream returned HTTP ${response.status}`;
  try {
    const json = JSON.parse(text);
    return json?.error?.message || json?.detail || `Codex upstream returned HTTP ${response.status}`;
  } catch {
    return text.slice(0, 500);
  }
}

export class CodexUpstream {
  constructor({ config, auth, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.auth = auth;
    this.fetch = fetchImpl;
  }

  async #request(path, options, retryAuth = true) {
    const credentials = await this.auth.getCredentials();
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${credentials.accessToken}`);
    headers.set("chatgpt-account-id", credentials.accountId);
    headers.set("originator", this.config.originator);
    headers.set("user-agent", `codex-cursor-proxy/0.1.0 codex/${this.config.clientVersion}`);

    let response;
    try {
      response = await this.fetch(`${this.config.upstreamBaseUrl}/${path.replace(/^\/+/, "")}`, {
        ...options,
        headers
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new UpstreamError(502, "Could not connect to the Codex upstream service.", "upstream_unavailable");
    }

    if (response.status === 401 && retryAuth) {
      await this.auth.getCredentials({ forceRefresh: true });
      return this.#request(path, options, false);
    }
    if (!response.ok) {
      const message = await safeErrorMessage(response);
      throw new UpstreamError(response.status, message, "upstream_rejected_request");
    }
    return response;
  }

  async listModels(signal) {
    const query = new URLSearchParams({ client_version: this.config.clientVersion });
    const response = await this.#request(`models?${query}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal
    });
    return response.json();
  }

  async createResponse(body, signal) {
    const normalized = normalizeResponsesRequest(body, this.config.defaultReasoningEffort);
    return this.#request("responses", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "x-codex-routing-hint": `model=${normalized.model}`
      },
      body: JSON.stringify(normalized),
      signal
    });
  }
}

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { CodexAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { HttpError, openAIError } from "./errors.js";
import { encodeSse, jsonFromSse, parseSse } from "./sse.js";
import {
  ChatCompletionState,
  chatToResponsesRequest,
  completedResponseFromEvents
} from "./translate.js";
import { CodexUpstream } from "./upstream.js";

function hash(value) {
  return createHash("sha256").update(value).digest();
}

function authorized(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(hash(header.slice(7)), hash(expected));
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  response.end(payload);
}

async function readJson(request, maxBytes) {
  const declared = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (declared > maxBytes) throw new HttpError(413, "Request body is too large.", "request_too_large");

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large.", "request_too_large");
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, "A JSON request body is required.", "body_required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

function modelId(model) {
  return model?.slug || model?.id || model?.model;
}

function mapModels(payload, configuredModels) {
  const upstreamModels = Array.isArray(payload) ? payload : payload?.models;
  const ids = (Array.isArray(upstreamModels) ? upstreamModels : [])
    .filter((model) => model?.supported_in_api !== false)
    .filter((model) => model?.visibility === undefined || model.visibility === "list")
    .map(modelId)
    .filter(Boolean);
  const selected = configuredModels.length ? configuredModels : ids;
  return {
    object: "list",
    data: Array.from(new Set(selected)).map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "openai"
    }))
  };
}

async function collectEvents(body) {
  const events = [];
  for await (const sse of parseSse(body)) {
    const event = jsonFromSse(sse);
    if (event) events.push(event);
  }
  return events;
}

async function relayResponsesStream(upstreamResponse, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  for await (const chunk of upstreamResponse.body) {
    if (!response.write(Buffer.from(chunk))) {
      await new Promise((resolve) => response.once("drain", resolve));
    }
  }
  response.end();
}

async function relayChatStream(upstreamResponse, response, model) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const state = new ChatCompletionState(model);
  for await (const sse of parseSse(upstreamResponse.body)) {
    const event = jsonFromSse(sse);
    if (!event) continue;
    for (const chunk of state.consume(event)) response.write(encodeSse(chunk));
  }
  if (!state.completed) throw new Error("Upstream stream ended without a completed response");
  response.end(encodeSse("[DONE]"));
}

export function createProxyServer({ config, upstream }) {
  let activeRequests = 0;

  return createServer(async (request, response) => {
    const started = Date.now();
    const url = new URL(request.url || "/", "http://proxy.local");
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs);
    request.once("aborted", () => abortController.abort());

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { status: "ok" });
      }

      if (!authorized(request.headers.authorization, config.apiKey)) {
        throw new HttpError(401, "Invalid or missing proxy API key.", "invalid_api_key", "authentication_error");
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const payload = await upstream.listModels(abortController.signal);
        return sendJson(response, 200, mapModels(payload, config.configuredModels));
      }

      if (request.method !== "POST" || !["/v1/responses", "/v1/chat/completions"].includes(url.pathname)) {
        throw new HttpError(404, "Route not found.", "not_found");
      }
      if (config.maxConcurrentRequests > 0 && activeRequests >= config.maxConcurrentRequests) {
        throw new HttpError(429, "The proxy concurrency limit has been reached.", "rate_limit_exceeded", "rate_limit_error");
      }

      const body = await readJson(request, config.maxRequestBytes);
      if (typeof body.model !== "string" || !body.model) {
        throw new HttpError(400, "The model field is required.", "model_required");
      }

      activeRequests += 1;
      try {
        if (url.pathname === "/v1/responses") {
          const upstreamResponse = await upstream.createResponse(body, abortController.signal);
          if (body.stream !== false) return await relayResponsesStream(upstreamResponse, response);
          const completed = completedResponseFromEvents(await collectEvents(upstreamResponse.body));
          return sendJson(response, 200, completed);
        }

        const responsesRequest = chatToResponsesRequest(body, config.defaultReasoningEffort);
        const upstreamResponse = await upstream.createResponse(responsesRequest, abortController.signal);
        if (body.stream) return await relayChatStream(upstreamResponse, response, body.model);

        const state = new ChatCompletionState(body.model);
        for await (const sse of parseSse(upstreamResponse.body)) {
          const event = jsonFromSse(sse);
          if (event) state.consume(event);
        }
        if (!state.completed) throw new Error("Upstream stream ended without a completed response");
        return sendJson(response, 200, state.completion());
      } finally {
        activeRequests -= 1;
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
      } else {
        const normalized = error?.name === "AbortError"
          ? new HttpError(504, "The request timed out.", "request_timeout", "timeout_error")
          : error;
        const { status, body } = openAIError(normalized);
        sendJson(response, status, body);
      }
      if (!error?.status || error.status >= 500) {
        console.error(`[proxy] ${request.method} ${url.pathname} failed after ${Date.now() - started}ms: ${error.message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}

export function buildServer(config = loadConfig()) {
  const auth = new CodexAuth({ authFile: config.authFile, refreshSkewMs: config.refreshSkewMs });
  const upstream = new CodexUpstream({ config, auth });
  return createProxyServer({ config, upstream });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = buildServer(config);
    server.listen(config.port, config.host, () => {
      console.log(`[proxy] listening on http://${config.host}:${config.port}`);
      console.log(`[proxy] Codex auth: ${config.authFile}`);
      console.log("[proxy] request bodies and credentials are not logged");
    });
  } catch (error) {
    console.error(`[proxy] startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export const serverInternals = { authorized, mapModels, readJson };

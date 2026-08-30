import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createProxyServer } from "../src/server.js";
import { encodeSse } from "../src/sse.js";

function upstreamStream() {
  const response = {
    id: "resp_test",
    object: "response",
    model: "gpt-test",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
  };
  return [
    encodeSse({ type: "response.created", response: { id: response.id, model: response.model } }),
    encodeSse({ type: "response.output_text.delta", delta: "hello" }),
    encodeSse({ type: "response.completed", response }),
    encodeSse("[DONE]")
  ].join("");
}

async function startTestServer() {
  const calls = [];
  const config = {
    apiKey: "test-proxy-api-key-that-is-long-enough",
    configuredModels: [],
    defaultReasoningEffort: "high",
    maxConcurrentRequests: 2,
    maxRequestBytes: 1024 * 1024,
    requestTimeoutMs: 10_000
  };
  const upstream = {
    async listModels() {
      return { models: [
        { slug: "gpt-test", supported_in_api: true, visibility: "list" },
        { slug: "hidden-test", supported_in_api: true, visibility: "hide" }
      ] };
    },
    async createResponse(body) {
      calls.push(body);
      return new Response(upstreamStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const server = createProxyServer({ config, upstream });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    calls,
    key: config.apiKey,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}

test("server protects API routes and exposes health without credentials", async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
  const denied = await fetch(`${app.origin}/v1/models`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, "invalid_api_key");
});

test("server maps the Codex model catalog to OpenAI format", async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/models`, {
    headers: { authorization: `Bearer ${app.key}` }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map((model) => model.id), ["gpt-test"]);
});

test("server translates non-streaming Chat Completions requests", async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${app.key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].message.content, "hello");
  assert.equal(app.calls[0].input[0].role, "user");
});

test("server translates streaming Chat Completions requests and terminates with DONE", async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${app.key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /data: \[DONE\]/);
});

test("server aggregates a non-streaming Responses request", async (t) => {
  const app = await startTestServer();
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${app.key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: "gpt-test", stream: false, input: "hi" })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.id, "resp_test");
  assert.equal(result.output[0].content[0].text, "hello");
});

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { encodeSse, parseSse } from "../src/sse.js";

test("parseSse handles split chunks, CRLF, comments, and multiline data", async () => {
  const stream = Readable.from([
    ": ping\r\nevent: response.output_text.delta\r\ndata: {\"delta\":",
    "\"hello\"}\r\n\r\n",
    "event: custom\ndata: first\ndata: second\n\n",
    "data: [DONE]\n\n"
  ]);
  const events = [];
  for await (const event of parseSse(stream)) events.push(event);
  assert.deepEqual(events, [
    { event: "response.output_text.delta", data: "{\"delta\":\"hello\"}", id: undefined },
    { event: "custom", data: "first\nsecond", id: undefined },
    { event: "message", data: "[DONE]", id: undefined }
  ]);
});

test("encodeSse emits a data event", () => {
  assert.equal(encodeSse({ ok: true }), "data: {\"ok\":true}\n\n");
});

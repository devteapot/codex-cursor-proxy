import assert from "node:assert/strict";
import test from "node:test";
import { ChatCompletionState, chatToResponsesRequest, normalizeResponsesRequest } from "../src/translate.js";

test("chatToResponsesRequest converts roles, tool calls, tool output, and definitions", () => {
  const request = chatToResponsesRequest({
    model: "gpt-test",
    messages: [
      { role: "system", content: "Use tools carefully." },
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }]
      },
      { role: "tool", tool_call_id: "call_1", content: "hello" }
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }],
    reasoning_effort: "medium"
  });

  assert.equal(request.instructions, "Use tools carefully.");
  assert.equal(request.reasoning.effort, "medium");
  assert.equal(request.tools[0].name, "read_file");
  assert.equal(request.input[1].type, "function_call");
  assert.equal(request.input[2].type, "function_call_output");
  assert.equal(request.input[2].output, "hello");
});

test("normalizeResponsesRequest strips unsupported fields and forces safe transport fields", () => {
  const request = normalizeResponsesRequest({
    model: "gpt-test",
    input: "hello",
    store: true,
    stream: false,
    temperature: 2,
    include: ["custom"]
  });
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.temperature, undefined);
  assert.equal(request.input[0].content[0].text, "hello");
  assert.deepEqual(request.include, ["custom", "reasoning.encrypted_content"]);
});

test("ChatCompletionState translates text, tool calls, finish reason, and usage", () => {
  const state = new ChatCompletionState("gpt-test");
  const chunks = [
    ...state.consume({ type: "response.created", response: { id: "resp_1", model: "gpt-test" } }),
    ...state.consume({ type: "response.output_text.delta", delta: "hello" }),
    ...state.consume({ type: "response.output_item.added", item: { id: "item_1", call_id: "call_1", type: "function_call", name: "read_file", arguments: "" } }),
    ...state.consume({ type: "response.function_call_arguments.delta", item_id: "item_1", delta: "{\"path\":\"a.txt\"}" }),
    ...state.consume({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
  ];

  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(state.completion().choices[0].message.content, "hello");
  assert.equal(state.completion().choices[0].message.tool_calls[0].function.arguments, "{\"path\":\"a.txt\"}");
  assert.equal(state.completion().choices[0].finish_reason, "tool_calls");
  assert.equal(state.completion().usage.total_tokens, 15);
});

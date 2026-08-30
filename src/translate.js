import { randomUUID } from "node:crypto";

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .filter((part) => part?.type === "text" || part?.type === "input_text" || part?.type === "output_text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function messageContent(content, role) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [{ type: textType, text: textFromContent(content) }];

  const converted = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (["text", "input_text", "output_text"].includes(part.type)) {
      converted.push({ type: textType, text: part.text ?? "" });
      continue;
    }
    if (role !== "assistant" && part.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (imageUrl) converted.push({ type: "input_image", image_url: imageUrl });
      continue;
    }
    if (role !== "assistant" && part.type === "input_image") {
      converted.push(part);
    }
  }
  return converted.length ? converted : [{ type: textType, text: "" }];
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description ?? "",
      parameters: tool.function.parameters ?? { type: "object", properties: {} },
      ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {})
    }));
}

function convertToolChoice(choice) {
  if (["auto", "none", "required"].includes(choice)) return choice;
  return "auto";
}

export function chatToResponsesRequest(body, defaultReasoningEffort = "high") {
  const instructions = [];
  const input = [];

  for (const message of body.messages ?? []) {
    const role = message?.role;
    if (role === "system" || role === "developer") {
      const text = textFromContent(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: textFromContent(message.content)
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;

    if (message.content != null) {
      input.push({ type: "message", role, content: messageContent(message.content, role) });
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.type !== "function" || !toolCall.function?.name) continue;
        input.push({
          type: "function_call",
          call_id: toolCall.id || `call_${randomUUID().replaceAll("-", "")}`,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments || "{}"
        });
      }
    }
  }

  if (input.length === 0) {
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "" }] });
  }

  const tools = convertTools(body.tools);
  const effort = body.reasoning_effort || body.reasoning?.effort || defaultReasoningEffort;
  return {
    model: body.model,
    instructions: instructions.join("\n\n") || "You are a coding assistant. Follow the supplied user instructions and tool definitions.",
    input,
    ...(tools ? { tools } : {}),
    tool_choice: convertToolChoice(body.tool_choice),
    parallel_tool_calls: body.parallel_tool_calls !== false,
    reasoning: { effort, summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"]
  };
}

function responseId(event, fallback) {
  return event?.response?.id || event?.response_id || fallback;
}

function responseModel(event, fallback) {
  return event?.response?.model || fallback;
}

function usageFromResponse(response) {
  const usage = response?.usage;
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? promptTokens + completionTokens
  };
}

export class ChatCompletionState {
  constructor(model) {
    this.id = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.content = "";
    this.toolCalls = [];
    this.toolIndexByItem = new Map();
    this.started = false;
    this.completed = false;
    this.usage = undefined;
    this.finishReason = "stop";
  }

  chunk(delta, finishReason = null, usage) {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {})
    };
  }

  consume(event) {
    const chunks = [];
    const type = event?.type;
    this.id = responseId(event, this.id);
    this.model = responseModel(event, this.model);

    if (!this.started && type !== "response.created") {
      this.started = true;
      chunks.push(this.chunk({ role: "assistant", content: "" }));
    }

    if (type === "response.created") {
      if (!this.started) {
        this.started = true;
        chunks.push(this.chunk({ role: "assistant", content: "" }));
      }
      return chunks;
    }

    if (type === "response.output_text.delta") {
      const delta = event.delta ?? "";
      this.content += delta;
      chunks.push(this.chunk({ content: delta }));
      return chunks;
    }

    if (type === "response.output_item.added" && event.item?.type === "function_call") {
      const index = this.toolCalls.length;
      const itemId = event.item.id || event.item.call_id || `item_${index}`;
      const call = {
        id: event.item.call_id || event.item.id || `call_${randomUUID().replaceAll("-", "")}`,
        type: "function",
        function: { name: event.item.name || "", arguments: event.item.arguments || "" }
      };
      this.toolCalls.push(call);
      this.toolIndexByItem.set(itemId, index);
      if (event.item.call_id) this.toolIndexByItem.set(event.item.call_id, index);
      this.finishReason = "tool_calls";
      chunks.push(this.chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] }));
      return chunks;
    }

    if (type === "response.function_call_arguments.delta") {
      let index = this.toolIndexByItem.get(event.item_id ?? event.call_id);
      if (index === undefined && Number.isInteger(event.output_index)) index = event.output_index;
      if (index === undefined) index = Math.max(0, this.toolCalls.length - 1);
      const delta = event.delta ?? "";
      if (this.toolCalls[index]) this.toolCalls[index].function.arguments += delta;
      chunks.push(this.chunk({ tool_calls: [{ index, function: { arguments: delta } }] }));
      return chunks;
    }

    if (type === "response.completed") {
      this.completed = true;
      this.usage = usageFromResponse(event.response);
      chunks.push(this.chunk({}, this.finishReason, this.usage));
      return chunks;
    }

    if (type === "response.failed" || type === "error") {
      const message = event?.response?.error?.message || event?.error?.message || event?.message || "Upstream response failed";
      throw new Error(message);
    }

    return chunks;
  }

  completion() {
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: this.content || null,
          ...(this.toolCalls.length ? { tool_calls: this.toolCalls } : {})
        },
        finish_reason: this.finishReason
      }],
      ...(this.usage ? { usage: this.usage } : {})
    };
  }
}

export function normalizeResponsesRequest(body, defaultReasoningEffort = "high") {
  const allowed = [
    "model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls",
    "reasoning", "service_tier", "prompt_cache_key", "text", "client_metadata"
  ];
  const normalized = Object.fromEntries(allowed.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
  normalized.instructions ||= "You are a coding assistant. Follow the supplied user instructions and tool definitions.";
  normalized.input ??= [];
  if (typeof normalized.input === "string") {
    normalized.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: normalized.input }] }];
  }
  normalized.tool_choice ??= "auto";
  normalized.parallel_tool_calls ??= true;
  normalized.reasoning ??= { effort: defaultReasoningEffort, summary: "auto" };
  normalized.store = false;
  normalized.stream = true;
  normalized.include = Array.from(new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"]));
  return normalized;
}

export function completedResponseFromEvents(events) {
  let completed;
  for (const event of events) {
    if (event?.type === "response.completed") completed = event.response;
    if (event?.type === "response.failed" || event?.type === "error") {
      throw new Error(event?.response?.error?.message || event?.error?.message || event?.message || "Upstream response failed");
    }
  }
  if (!completed) throw new Error("Upstream stream ended without a completed response");
  return completed;
}

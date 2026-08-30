export async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = findBoundary(buffer)) !== null) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const event = parseBlock(block);
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  const tail = parseBlock(buffer);
  if (tail) yield tail;
}

function findBoundary(value) {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseBlock(block) {
  if (!block.trim()) return null;
  let event = "message";
  const data = [];
  let id;

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    if (field === "id") id = value;
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}

export function encodeSse(data, event) {
  const prefix = event ? `event: ${event}\n` : "";
  return `${prefix}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

export function jsonFromSse(event) {
  if (event.data === "[DONE]") return null;
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

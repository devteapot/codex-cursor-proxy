export class HttpError extends Error {
  constructor(status, message, code = "proxy_error", type = "invalid_request_error") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export class UpstreamError extends HttpError {
  constructor(status, message, code = "upstream_error") {
    super(status >= 400 && status < 600 ? status : 502, message, code, "upstream_error");
    this.name = "UpstreamError";
  }
}

export function openAIError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status >= 500 ? "The proxy could not complete the request." : error.message;
  return {
    status,
    body: {
      error: {
        message,
        type: error?.type ?? "proxy_error",
        param: null,
        code: error?.code ?? "proxy_error"
      }
    }
  };
}

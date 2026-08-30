# Codex Cursor Proxy

An experimental, single-user OpenAI-compatible proxy for using an existing Codex CLI ChatGPT login with clients that can supply a custom OpenAI base URL.

It is aimed at Cursor's Agents Window (formerly called Glass), but it is not an official OpenAI or Cursor integration.

## Important status

OpenAI documents ChatGPT sign-in as subscription access for Codex clients and Platform API keys as the supported credential for general API usage. This proxy talks to the same Responses transport used by the open-source Codex CLI, but using that transport as a third-party API is unsupported and can change without notice.

Do not deploy this as a multi-user service. Do not expose it without the downstream bearer key. You are responsible for checking the terms and policies that apply to your account.

## What it provides

- `GET /v1/models`
- `POST /v1/responses`, streaming and non-streaming
- `POST /v1/chat/completions`, streaming and non-streaming
- Chat Completions to Responses translation, including function calls
- Automatic reuse and refresh of `~/.codex/auth.json`
- A separate bearer key for Cursor; the Codex token is never returned to Cursor
- Loopback-only binding by default, bounded request size, and bounded concurrency
- No request-body, response-body, or credential logging

This service does not run `codex exec`. Cursor remains the agent harness and executes its own tools; the proxy only carries model requests.

## Requirements

- Node.js 22 or newer
- A working Codex CLI ChatGPT login
- An HTTPS endpoint reachable by Cursor's servers

Check the login first:

```bash
codex login status
```

If needed:

```bash
codex login
```

## Local setup

```bash
cd ~/dev/codex-cursor-proxy
npm run init
npm test
npm start
```

`npm run init` creates a gitignored `.env` with mode `0600` and prints the generated downstream API key once. Keep that terminal output private.

Verify the service locally:

```bash
curl http://127.0.0.1:8787/healthz

set -a
source .env
set +a

curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

## Run in the background on macOS

Install the proxy as a per-user LaunchAgent:

```bash
npm run service:install
```

It starts immediately, starts again whenever you log in, and restarts after a crash. It reads the project's `.env` in place; credentials are not copied into the LaunchAgent plist.

Manage it with:

```bash
npm run service:status
npm run service:restart
npm run service:stop
npm run service:start
npm run service:uninstall
```

To find its persistent stdout and stderr logs:

```bash
npm run service:logs
```

The proxy and tunnel use separate LaunchAgents, so each can be restarted or removed independently.

## Make it reachable from Cursor Glass

Cursor routes custom-model requests through Cursor's backend, so `127.0.0.1` is not a usable base URL in Glass. Put an authenticated HTTPS tunnel in front of the loopback listener. A named Cloudflare Tunnel is recommended because it has a stable hostname and supports the SSE streams used for model output.

### Persistent Cloudflare Tunnel

Create and route a locally managed tunnel from the CLI:

```bash
cloudflared tunnel login
cloudflared tunnel create codex-cursor-proxy
cloudflared tunnel route dns codex-cursor-proxy codex.example.com

npm run tunnel:configure-cli -- codex-cursor-proxy
npm run tunnel:install
```

The CLI login requires a one-time browser authorization for the Cloudflare zone. The configure command fetches the connector token into the gitignored `.cloudflared-token` file with mode `0600`; it never prints the token or puts it in the LaunchAgent plist.

For a remotely managed tunnel created in the dashboard, copy its `cloudflared service install ...` command and run `npm run tunnel:configure` instead. That variant extracts the connector token from the clipboard without printing it.

Manage the tunnel with:

```bash
npm run tunnel:status
npm run tunnel:restart
npm run tunnel:stop
npm run tunnel:start
npm run tunnel:logs
npm run tunnel:uninstall
```

The tunnel token is equivalent to a connector credential. Revoke or rotate it from Cloudflare if the file is exposed.

### Temporary test only

For a temporary non-streaming connectivity test:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

Quick Tunnel URLs change whenever the process restarts, have no uptime guarantee, and do not support Server-Sent Events. They are therefore unsuitable for normal Cursor Glass model streaming.

Keep `HOST=127.0.0.1`. Once the named tunnel is connected, configure Cursor:

1. Open **Cursor Settings → Models**.
2. Under OpenAI, enter the `PROXY_API_KEY` value from `.env`.
3. Enable **Override OpenAI Base URL** and enter `https://codex.example.com/v1` (using your actual hostname).
4. Add or enable one of the model IDs returned by `/v1/models`.
5. Open the Agents Window and select that model.

If Cursor asks for an endpoint rather than a base URL, use either:

- `https://your-tunnel.example/v1/responses`
- `https://your-tunnel.example/v1/chat/completions`

The exact custom-model controls available in Glass vary by Cursor release. Custom endpoints may work for local chats while remaining unavailable for cloud agents, background agents, Tab, or other Cursor-managed features.

## Configuration

Copy `.env.example` for the full list. Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_API_KEY` | required | Downstream bearer key sent by Cursor |
| `HOST` | `127.0.0.1` | Listener address |
| `PORT` | `8787` | Listener port |
| `CODEX_AUTH_FILE` | `~/.codex/auth.json` | Existing Codex CLI login |
| `CODEX_PROXY_MODELS` | dynamic | Optional comma-separated model allowlist |
| `DEFAULT_REASONING_EFFORT` | `high` | Default when the client omits reasoning effort |
| `MAX_CONCURRENT_REQUESTS` | `0` | Process-wide in-flight request limit; `0` disables it |
| `MAX_REQUEST_BYTES` | `20971520` | Maximum JSON body size |

You may supply `CODEX_ACCESS_TOKEN` and `CODEX_ACCOUNT_ID` instead of an auth file, but an access token cannot be automatically refreshed. Never put either value in Cursor settings.

## Security notes

- Cursor receives only `PROXY_API_KEY`; it must never receive your Codex access or refresh token.
- Anyone with the proxy key and public tunnel URL can consume your Codex allowance.
- Quick tunnel URLs are suitable only for short tests. Use a stable tunnel with access logs, key rotation, and revocation for longer use.
- Rotate the downstream key by replacing `PROXY_API_KEY` in `.env` and restarting the proxy.
- If the Codex refresh token is revoked, run `codex login` again.

## Known limitations

- Unsupported by OpenAI and Cursor.
- Upstream fields and event types can change.
- Chat Completions translation covers text, images-by-URL, and function tools; other modalities are not implemented.
- The proxy does not implement embeddings, audio, files, batches, image generation, or fine-tuning endpoints.
- Cursor-specific agent behavior depends on the model and on which request fields Cursor forwards through its custom-provider path.

## Development

```bash
npm run check
```

The test suite uses mock credentials and mock upstream responses. It does not consume Codex quota.

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAuth, authInternals } from "../src/auth.js";

function jwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("auth helpers read account IDs and JWT expiration without exposing token content", () => {
  const token = jwt({ exp: 100, "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } });
  assert.equal(authInternals.accountIdFrom({ tokens: { access_token: token } }), "acct_1");
  assert.equal(authInternals.tokenExpiresSoon(token, () => 100_000, 1), true);
});

test("CodexAuth refreshes and atomically persists an expired login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-auth-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({ exp: 1 }),
      id_token: jwt({}),
      refresh_token: "refresh-old",
      account_id: "acct_1"
    }
  }), { mode: 0o600 });

  let calls = 0;
  const auth = new CodexAuth({
    authFile,
    now: () => 1_000_000,
    fetchImpl: async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      assert.equal(request.refresh_token, "refresh-old");
      return new Response(JSON.stringify({
        access_token: jwt({ exp: 9_999 }),
        refresh_token: "refresh-new"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const credentials = await auth.getCredentials();
  assert.equal(credentials.accountId, "acct_1");
  assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(saved.tokens.refresh_token, "refresh-new");
  assert.ok(saved.last_refresh);
});

test("forceRefresh rotates an otherwise unexpired token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-auth-force-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({
    tokens: {
      access_token: jwt({ exp: 9_999 }),
      id_token: jwt({}),
      refresh_token: "refresh-old",
      account_id: "acct_1"
    }
  }));
  let calls = 0;
  const auth = new CodexAuth({
    authFile,
    now: () => 1_000_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: jwt({ exp: 20_000 }) }), { status: 200 });
    }
  });
  await auth.getCredentials({ forceRefresh: true });
  assert.equal(calls, 1);
});

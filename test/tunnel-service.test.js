import assert from "node:assert/strict";
import test from "node:test";

import { buildTunnelPlist, extractTunnelToken } from "../scripts/tunnel-service.mjs";

const TOKEN = `eyJ${"a".repeat(150)}`;

test("extractTunnelToken accepts a copied cloudflared install command", () => {
  assert.equal(
    extractTunnelToken(`sudo cloudflared service install ${TOKEN}`),
    TOKEN,
  );
});

test("extractTunnelToken rejects unrelated clipboard text", () => {
  assert.throws(() => extractTunnelToken("not a token"), /does not contain/);
});

test("tunnel plist uses a token file and never embeds the token", () => {
  const plist = buildTunnelPlist({ cloudflaredPath: "/path/with & special/cloudflared" });

  assert.match(plist, /com\.carlid\.codex-cursor-proxy\.tunnel/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /--token-file/);
  assert.match(plist, /\.cloudflared-token/);
  assert.match(plist, /--url/);
  assert.match(plist, /http:\/\/127\.0\.0\.1:8787/);
  assert.match(plist, /\/path\/with &amp; special\/cloudflared/);
  assert.doesNotMatch(plist, new RegExp(TOKEN));
});

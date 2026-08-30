import assert from "node:assert/strict";
import test from "node:test";

import { buildPlist } from "../scripts/service.mjs";

test("LaunchAgent plist starts the proxy at login without embedding credentials", () => {
  const plist = buildPlist({ nodePath: "/path/with & special/node" });

  assert.match(plist, /com\.carlid\.codex-cursor-proxy/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /--env-file=.*codex-cursor-proxy\/\.env/);
  assert.match(plist, /\/src\/server\.js/);
  assert.match(plist, /\/path\/with &amp; special\/node/);
  assert.doesNotMatch(plist, /PROXY_API_KEY/);
  assert.doesNotMatch(plist, /CODEX_ACCESS_TOKEN/);
});

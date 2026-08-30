import { randomBytes } from "node:crypto";
import { access, chmod, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const path = resolve(".env");
try {
  await access(path, constants.F_OK);
  console.error(`${path} already exists; refusing to overwrite it.`);
  process.exitCode = 1;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const key = randomBytes(32).toString("base64url");
  const contents = [
    `PROXY_API_KEY=${key}`,
    "HOST=127.0.0.1",
    "PORT=8787",
    "DEFAULT_REASONING_EFFORT=high",
    "MAX_CONCURRENT_REQUESTS=4",
    ""
  ].join("\n");
  await writeFile(path, contents, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  console.log(`Created ${path} with mode 0600.`);
  console.log(`Cursor API key: ${key}`);
}

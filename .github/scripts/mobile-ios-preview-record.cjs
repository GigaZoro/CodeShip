const { readFileSync } = require("node:fs");

function readClient(value, now = Date.now()) {
  try {
    const record = JSON.parse(value);
    return typeof record?.link === "string" && Date.parse(record.expiresAt) > now
      ? record.link
      : "";
  } catch {
    return "";
  }
}

function createRecord(link, profile) {
  const expiration = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(profile)?.[1];
  if (!expiration || !Number.isFinite(Date.parse(expiration))) {
    throw new Error("The provisioning profile has no valid ExpirationDate.");
  }
  return JSON.stringify({ link, expiresAt: new Date(expiration).toISOString() });
}

if (require.main === module) {
  const { positionals } = require("node:util").parseArgs({ allowPositionals: true });
  const [command, link, file] = positionals;
  if (command === "read" && positionals.length === 1) {
    process.stdout.write(readClient(readFileSync(0, "utf8")));
  } else if (command === "create" && positionals.length === 3) {
    process.stdout.write(createRecord(link, readFileSync(file, "utf8")));
  } else {
    throw new Error("Usage: mobile-ios-preview-record.cjs read | create <link> <profile>");
  }
}

module.exports = { createRecord, readClient };

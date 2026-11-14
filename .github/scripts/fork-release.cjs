#!/usr/bin/env node
// Steps shared by the fork's release workflows, release-fork.yml and
// release-fork-macos.yml. Plain CommonJS: their jobs run it without installing.
"use strict";

const fs = require("node:fs");

const PUBLIC_CONFIG = [
  ["clerk_publishable_key", "T3CODE_CLERK_PUBLISHABLE_KEY"],
  ["clerk_jwt_template", "T3CODE_CLERK_JWT_TEMPLATE"],
  ["clerk_cli_oauth_client_id", "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID"],
  ["relay_url", "T3CODE_RELAY_URL"],
];
const SAFE_CONFIG_VALUE = /^[A-Za-z0-9._:/-]+$/;
const SAFE_TAG = /^[A-Za-z0-9._-]+$/;
const CARRIED_PREFIX = "../";
const FEED_FILE_LINE = /^(\s*(?:-\s+)?(?:url|path):\s*)(['"]?)([^'"\s]+)\2[ \t]*$/gm;

/**
 * The public T3 Connect identifiers that development builds read, as
 * `output=value` lines for GITHUB_OUTPUT. A missing one is empty: the build
 * then has no T3 Connect.
 */
function publicConfig(envExample) {
  return PUBLIC_CONFIG.map(([output, name]) => {
    const line = envExample.split("\n").find((entry) => entry.startsWith(`${name}=`));
    const value = line === undefined ? "" : line.slice(name.length + 1).trim();
    if (value !== "" && !SAFE_CONFIG_VALUE.test(value)) {
      throw new Error(`${name} is malformed in .env.example.`);
    }
    return `${output}=${value}`;
  });
}

/**
 * Rewrites a release's latest-mac.yml so another release can serve it.
 * electron-updater's GitHub provider resolves each file against
 * `releases/download/<the latest tag>/`, so `../<tag>/<file>` reaches the
 * release that holds the file. A feed carried before already points there.
 */
function carryMacosFeed(feed, tag) {
  if (!SAFE_TAG.test(tag)) {
    throw new Error(`Release tag '${tag}' is not a plain tag name.`);
  }
  let files = 0;
  const carried = feed.replace(FEED_FILE_LINE, (line, key, quote, file) => {
    files += 1;
    return file.startsWith(CARRIED_PREFIX)
      ? line
      : `${key}${quote}${CARRIED_PREFIX}${tag}/${file}${quote}`;
  });
  if (files === 0) {
    throw new Error(`The latest-mac.yml of ${tag} names no files.`);
  }
  return carried;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "public-config") {
    const [file = ".env.example"] = args;
    process.stdout.write(`${publicConfig(fs.readFileSync(file, "utf8")).join("\n")}\n`);
    return;
  }
  if (command === "carry-macos-feed" && args.length === 2) {
    const [tag, file] = args;
    process.stdout.write(carryMacosFeed(fs.readFileSync(file, "utf8"), tag));
    return;
  }
  throw new Error(
    "Usage: fork-release.cjs public-config [.env.example] | carry-macos-feed <tag> <latest-mac.yml>",
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { carryMacosFeed, publicConfig };

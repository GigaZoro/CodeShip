import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  GIT_CALL_LIMITS,
  GIT_OUTPUT_MAX_BYTES,
  REAL_HISTORY_ENV,
} from "../.github/scripts/git-history.cjs";

export const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
export const NEEDS_RUN_SKIP_EXIT_CODE = 10;

const USAGE =
  "Usage: node scripts/upstream-drift-radar.mjs [--needs-run] [--cwd <dir>] [--base <ref>] [--upstream <ref>] [--upstream-url <url>] [--no-fetch] [--verify] [--verify-cmd <cmd>]";

const ADVISORY_PATTERNS = [
  /\bCVE-\d{4}-\d{4,}\b/gi,
  /\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/gi,
  /\b(?:fix\s*\(\s*security\s*\)|security\s+(?:fix|patch|advisory|vulnerability)|vulnerabilit(?:y|ies))\b/gi,
];

function defaultRunCommand(command, args, { cwd, env = process.env }) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...env, ...REAL_HISTORY_ENV },
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
    ...GIT_CALL_LIMITS,
    windowsHide: true,
  });
  if (result.error) {
    return {
      status: null,
      stdout: "",
      stderr: result.error.message,
      error: result.error,
    };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function splitVerifyCommand(command) {
  const parts = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => part.replace(/^["']|["']$/g, ""));
}

export function parseDriftRadarArgs(argv) {
  let parsed;
  try {
    parsed = NodeUtil.parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "needs-run": { type: "boolean", default: false },
        cwd: { type: "string" },
        base: { type: "string", default: "origin/main" },
        upstream: { type: "string", default: "upstream/main" },
        "upstream-url": { type: "string", default: UPSTREAM_URL },
        "no-fetch": { type: "boolean", default: false },
        verify: { type: "boolean", default: false },
        "verify-cmd": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`, {
      cause: error,
    });
  }

  const values = parsed.values;
  if (values.help) {
    return { help: true };
  }
  if (values["verify-cmd"] !== undefined && splitVerifyCommand(values["verify-cmd"]).length === 0) {
    throw new Error(`--verify-cmd must not be blank.\n${USAGE}`);
  }
  return {
    help: false,
    needsRun: values["needs-run"],
    cwd: values.cwd ? NodePath.resolve(values.cwd) : process.cwd(),
    base: values.base,
    upstream: values.upstream,
    upstreamUrl: values["upstream-url"],
    fetch: !values["no-fetch"],
    verify: values.verify || values["verify-cmd"] !== undefined,
    verifyCommand:
      values["verify-cmd"] !== undefined
        ? splitVerifyCommand(values["verify-cmd"])
        : ["vp", "run", "typecheck"],
  };
}

export function parseWriteTreeMergeOutput(stdout, status) {
  const tokens = stdout.split("\0").filter((entry) => entry.length > 0);
  const treeOid = tokens[0]?.trim() || null;
  if (status === 0) {
    return { treeOid, conflicts: [] };
  }
  return {
    treeOid,
    conflicts: [...new Set(tokens.slice(1))],
  };
}

export function parseLegacyMergeTreeOutput(stdout) {
  const conflicts = new Set();
  let inConflictBlock = false;
  let blockPath = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^(?:changed in both|added in both|removed in (?:local|remote)|merged)$/.test(line)) {
      inConflictBlock = line !== "merged";
      blockPath = null;
      continue;
    }
    const headerMatch = line.match(/^\s+(?:base|our|their|result)\s+\d+\s+[0-9a-f]+\s+(.+)$/);
    if (headerMatch?.[1]) {
      blockPath = headerMatch[1].trim();
      if (inConflictBlock) conflicts.add(blockPath);
      continue;
    }
    if (line.startsWith("+<<<<<<<") && blockPath) {
      conflicts.add(blockPath);
    }
  }
  return [...conflicts];
}

export function detectSecurityAdvisories(logOutput) {
  const advisories = [];
  for (const record of logOutput.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [hash = "", subject = "", body = ""] = trimmed.split("\x1f");
    const haystack = `${subject}\n${body}`;
    const matches = new Set();
    for (const pattern of ADVISORY_PATTERNS) {
      for (const match of haystack.matchAll(pattern)) {
        if (match[0]) matches.add(match[0]);
      }
    }
    if (matches.size > 0) {
      advisories.push({
        commit: hash.slice(0, 12),
        subject: subject.trim(),
        matches: [...matches],
      });
    }
  }
  return advisories;
}

function summarizeList(items, limit = 5) {
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} (+${items.length - limit} more)`;
}

function trimDetail(text, maxLength = 200) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function isUnsupportedWriteTree(result) {
  return (
    result.status === 129 ||
    /unknown option.*write-tree|usage:\s*git merge-tree/i.test(result.stderr)
  );
}

function remoteFromRef(ref) {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const candidate = ref.slice(0, slash);
  if (candidate === "refs") return null;
  return candidate;
}

export function checkUpstreamDrift({
  cwd = process.cwd(),
  base = "origin/main",
  upstream = "upstream/main",
  upstreamUrl = UPSTREAM_URL,
  fetch = true,
  verify = false,
  verifyCommand = ["vp", "run", "typecheck"],
  runCommand = defaultRunCommand,
  tmpRoot = NodeOS.tmpdir(),
} = {}) {
  const git = (...args) => runCommand("git", args, { cwd });
  let resolvedUpstream = upstream;

  if (fetch) {
    const baseRemote = remoteFromRef(base);
    if (baseRemote && git("remote", "get-url", baseRemote).status === 0) {
      const fetchedBase = git("fetch", "-q", baseRemote);
      if (fetchedBase.status !== 0) {
        return {
          ok: false,
          needs_run: false,
          error: `git fetch ${baseRemote} failed: ${trimDetail(fetchedBase.stderr || fetchedBase.stdout)}`,
        };
      }
    }

    const upstreamRemote = remoteFromRef(upstream);
    if (upstreamRemote && git("remote", "get-url", upstreamRemote).status === 0) {
      const fetchedUpstream = git("fetch", "-q", upstreamRemote);
      if (fetchedUpstream.status !== 0) {
        return {
          ok: false,
          needs_run: false,
          error: `git fetch ${upstreamRemote} failed: ${trimDetail(fetchedUpstream.stderr || fetchedUpstream.stdout)}`,
        };
      }
    } else if (upstream === "upstream/main") {
      const fetchedDirect = git("fetch", "-q", upstreamUrl, "main");
      if (fetchedDirect.status !== 0) {
        return {
          ok: false,
          needs_run: false,
          error: `git fetch ${upstreamUrl} main failed: ${trimDetail(fetchedDirect.stderr || fetchedDirect.stdout)}`,
        };
      }
      resolvedUpstream = "FETCH_HEAD";
    }
  }

  const baseRev = git("rev-parse", "--verify", base);
  if (baseRev.status !== 0) {
    return {
      ok: false,
      needs_run: false,
      error: `Could not resolve base ref ${base}: ${trimDetail(baseRev.stderr || baseRev.stdout)}`,
    };
  }
  const upstreamRev = git("rev-parse", "--verify", resolvedUpstream);
  if (upstreamRev.status !== 0) {
    return {
      ok: false,
      needs_run: false,
      error: `Could not resolve upstream ref ${resolvedUpstream}: ${trimDetail(upstreamRev.stderr || upstreamRev.stdout)}`,
    };
  }

  const baseOid = baseRev.stdout.trim();
  const upstreamOid = upstreamRev.stdout.trim();
  const shortUpstream = upstreamOid.slice(0, 9);

  if (git("merge-base", "--is-ancestor", upstreamOid, baseOid).status === 0) {
    return {
      ok: true,
      needs_run: false,
      status: "up-to-date",
      reason: `Already up to date with upstream (${shortUpstream}); 0 new upstream commits.`,
      base: baseOid,
      upstream: upstreamOid,
      behindCount: 0,
      mergeMethod: null,
      treeOid: null,
      conflictCount: 0,
      conflicts: [],
      advisoryCount: 0,
      advisories: [],
      verification: null,
    };
  }

  const countResult = git("rev-list", "--count", `${baseOid}..${upstreamOid}`);
  if (countResult.status !== 0) {
    return {
      ok: false,
      needs_run: false,
      error: `git rev-list failed: ${trimDetail(countResult.stderr || countResult.stdout)}`,
    };
  }
  const behindCount = Number.parseInt(countResult.stdout.trim(), 10) || 0;

  const logResult = git(
    "log",
    "--no-merges",
    "--format=%H%x1f%s%x1f%b%x1e",
    `${baseOid}..${upstreamOid}`,
  );
  if (logResult.status !== 0) {
    return {
      ok: false,
      needs_run: false,
      error: `git log failed: ${trimDetail(logResult.stderr || logResult.stdout)}`,
    };
  }
  const advisories = detectSecurityAdvisories(logResult.stdout);

  let mergeMethod = "write-tree";
  let treeOid = null;
  let conflicts = [];

  const mergeTree = git(
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "-z",
    baseOid,
    upstreamOid,
  );
  if (mergeTree.status === 0 || mergeTree.status === 1) {
    const parsed = parseWriteTreeMergeOutput(mergeTree.stdout, mergeTree.status);
    treeOid = parsed.treeOid;
    conflicts = parsed.conflicts;
    if (mergeTree.status === 1 && conflicts.length === 0) {
      conflicts = ["<unresolved merge conflict>"];
    }
  } else if (isUnsupportedWriteTree(mergeTree)) {
    mergeMethod = "legacy-3way";
    const mergeBase = git("merge-base", baseOid, upstreamOid);
    if (mergeBase.status !== 0) {
      return {
        ok: false,
        needs_run: false,
        error: `git merge-base failed during fallback: ${trimDetail(mergeBase.stderr || mergeBase.stdout)}`,
      };
    }
    const legacy = git("merge-tree", mergeBase.stdout.trim(), baseOid, upstreamOid);
    if (legacy.status !== 0) {
      return {
        ok: false,
        needs_run: false,
        error: `Legacy git merge-tree failed: ${trimDetail(legacy.stderr || legacy.stdout)}`,
      };
    }
    conflicts = parseLegacyMergeTreeOutput(legacy.stdout);
  } else {
    return {
      ok: false,
      needs_run: false,
      error: `git merge-tree failed: ${trimDetail(mergeTree.stderr || mergeTree.stdout)}`,
    };
  }

  let verification = null;
  if (verify && conflicts.length === 0 && treeOid) {
    const probeCommitResult = git(
      "commit-tree",
      treeOid,
      "-p",
      baseOid,
      "-p",
      upstreamOid,
      "-m",
      "upstream-drift-radar verification probe",
    );
    if (probeCommitResult.status !== 0) {
      return {
        ok: false,
        needs_run: false,
        error: `git commit-tree failed: ${trimDetail(probeCommitResult.stderr || probeCommitResult.stdout)}`,
      };
    }
    const probeCommit = probeCommitResult.stdout.trim();
    const probeDir = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "codeship-drift-radar-"));
    try {
      const added = git("worktree", "add", "--detach", "--force", probeDir, probeCommit);
      if (added.status !== 0) {
        return {
          ok: false,
          needs_run: false,
          error: `git worktree add failed: ${trimDetail(added.stderr || added.stdout)}`,
        };
      }
      const [cmd, ...args] = verifyCommand;
      const checked = runCommand(cmd, args, { cwd: probeDir });
      verification = {
        ok: checked.status === 0,
        command: verifyCommand.join(" "),
        status: checked.status,
        detail:
          checked.status === 0
            ? "passed"
            : trimDetail(checked.stderr || checked.stdout || `exit ${checked.status}`),
      };
    } finally {
      git("worktree", "remove", "--force", probeDir);
      NodeFS.rmSync(probeDir, { recursive: true, force: true });
    }
  }

  const reasons = [];
  if (conflicts.length > 0) {
    reasons.push(
      `${conflicts.length} merge conflict${conflicts.length === 1 ? "" : "s"} (${summarizeList(conflicts)})`,
    );
  }
  if (advisories.length > 0) {
    const tags = advisories.flatMap((item) => item.matches);
    reasons.push(
      `${advisories.length} security advisor${advisories.length === 1 ? "y" : "ies"} (${summarizeList(tags, 3)})`,
    );
  }
  if (verification && !verification.ok) {
    reasons.push(`verification failed (${verification.command}: ${verification.detail})`);
  }

  const OUTPUT_SAMPLE_LIMIT = 25;

  if (reasons.length > 0) {
    const status =
      conflicts.length > 0
        ? "conflicts"
        : advisories.length > 0
          ? "security-advisory"
          : "verification-failed";
    return {
      ok: true,
      needs_run: true,
      status,
      reason: `Upstream drift at ${shortUpstream} (${behindCount} commits) needs attention: ${reasons.join("; ")}.`,
      base: baseOid,
      upstream: upstreamOid,
      behindCount,
      mergeMethod,
      treeOid,
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, OUTPUT_SAMPLE_LIMIT),
      advisoryCount: advisories.length,
      advisories: advisories.slice(0, OUTPUT_SAMPLE_LIMIT),
      verification,
    };
  }

  return {
    ok: true,
    needs_run: false,
    status: "clean",
    reason: `Clean merge with upstream (${shortUpstream}, ${behindCount} commits, no conflicts or security advisories); 0-LLM skip.`,
    base: baseOid,
    upstream: upstreamOid,
    behindCount,
    mergeMethod,
    treeOid,
    conflictCount: 0,
    conflicts: [],
    advisoryCount: 0,
    advisories: [],
    verification,
  };
}

export function exitCodeForResult(result, needsRun) {
  if (!result.ok) return 1;
  if (!needsRun) return 0;
  return result.needs_run ? 0 : NEEDS_RUN_SKIP_EXIT_CODE;
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseDriftRadarArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const result = checkUpstreamDrift(options);
    console.log(JSON.stringify(result));
    process.exit(exitCodeForResult(result, options.needsRun));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

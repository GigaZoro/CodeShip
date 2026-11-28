const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  CANDIDATE_REF,
  CHECK_METRICS_FILE_ENV,
  LEASE_REF,
  LEASE_TTL_MS,
  land,
  withTurn,
  testing: { release, runCheck, tryAcquire },
} = require("./landing-turn.cjs");
const { recordPass, requirePass } = require("./check-changed-receipt.cjs");
const { ELSEWHERE, readLandings, setup, signalServer } = require("./landing-turn.testkit.cjs");

const NO_RENEWAL = () => () => {};
const NOW = 1_800_000_000_000;

function readOriginLeasePayload(origin, git) {
  const sha = git(origin, "rev-parse", "--verify", LEASE_REF);
  const firstLine = git(origin, "show", "-s", "--format=%B", sha).split("\n")[0];
  return { sha, data: JSON.parse(firstLine) };
}

test("AB#7666: holder publishes candidate, head waiter speculatively pre-checks, reuses receipt, skips underTurnCheck, and logs telemetry", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const other = clone("other");

    commit(holder, "holder.txt");
    commit(waiter, "waiter.txt");
    const initialWaiterHead = git(waiter, "rev-parse", "HEAD");
    const initialBase = git(origin, "rev-parse", "main");

    // Both landers enter preWaitCheck against initialBase before `other` moves main so `holder` must rebase under turn.
    const holderPreDone = Promise.withResolvers();
    const waiterPreDone = Promise.withResolvers();
    const allowHolderAcquire = Promise.withResolvers();
    const holderInUnderTurn = Promise.withResolvers();
    const releaseHolder = Promise.withResolvers();
    const waiterSpecDone = Promise.withResolvers();

    let triggerHolderRenewal = null;
    let holderUnderTurnBase = null;
    let holderUnderTurnTip = null;
    let waiterUnderTurnCalls = 0;
    let waiterSpecCheck = null;

    const holderPromise = land({
      cwd: holder,
      remote: "origin",
      every: (_ms, tick) => {
        triggerHolderRenewal = tick;
        return () => {};
      },
      check: async (turn, base, _budget, directory) => {
        if (!turn) {
          holderPreDone.resolve();
          await allowHolderAcquire.promise;
          return true;
        }
        holderUnderTurnBase = base;
        holderUnderTurnTip = git(directory, "rev-parse", "HEAD");
        holderInUnderTurn.resolve();
        await releaseHolder.promise;
        return true;
      },
    });

    const waiterPromise = land({
      cwd: waiter,
      remote: "origin",
      every: NO_RENEWAL,
      sleep: async () => {
        await waiterSpecDone.promise;
        releaseHolder.resolve();
        await holderPromise;
      },
      check: async (turn, base, budgetSeconds, directory, signal, checkoutContext) => {
        if (!turn && base === initialBase) {
          waiterPreDone.resolve();
          await holderInUnderTurn.promise;
          return true;
        }
        if (!turn) {
          // Real waiter worktree must remain untouched while speculative check runs in a private checkout.
          assert.equal(git(waiter, "rev-parse", "HEAD"), initialWaiterHead);
          assert.equal(signal instanceof AbortSignal, true);
          assert.equal(signal.aborted, false);
          const specCheckCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            `require("node:fs").writeFileSync(process.env[${JSON.stringify(CHECK_METRICS_FILE_ENV)}], JSON.stringify({ schema: 1, slotWaitMs: 450 }))`,
          )}`;
          const ok = await runCheck(directory, turn, base, budgetSeconds, signal, {
            ...checkoutContext,
            installCommand: `"${process.execPath}" -e "process.exit(0)"`,
            checkCommand: specCheckCmd,
            stdio: "pipe",
            onCheckMetrics: ({ slotWaitMs }) => checkoutContext?.recordSlotWait?.(slotWaitMs),
          });
          assert.equal(ok, true);
          const tree = git(directory, "rev-parse", "HEAD^{tree}");
          recordPass(directory, tree, base);
          waiterSpecCheck = { base, tree, head: git(directory, "rev-parse", "HEAD") };
          waiterSpecDone.resolve();
          return true;
        }
        waiterUnderTurnCalls += 1;
        return true;
      },
    });

    await Promise.all([holderPreDone.promise, waiterPreDone.promise]);

    // Move main while holder is still before wait, so holder rebases under its turn and publishes its candidate.
    commit(other, "other.txt");
    git(other, "push", "-q", "origin", "HEAD:main");
    const movedMain = git(origin, "rev-parse", "main");

    allowHolderAcquire.resolve();
    await holderInUnderTurn.promise;

    // Verify candidate ref and lease payload on origin while holder is in underTurnCheck.
    assert.equal(holderUnderTurnBase, movedMain);
    assert.equal(git(origin, "rev-parse", CANDIDATE_REF), holderUnderTurnTip);
    const leaseBeforeRenew = readOriginLeasePayload(origin, git);
    assert.equal(leaseBeforeRenew.data.candidate, holderUnderTurnTip);

    // Periodic renewal must preserve `candidate` in the renewed lease commit.
    assert.equal(typeof triggerHolderRenewal, "function");
    triggerHolderRenewal();
    const leaseAfterRenew = readOriginLeasePayload(origin, git);
    assert.notEqual(leaseAfterRenew.sha, leaseBeforeRenew.sha);
    assert.equal(leaseAfterRenew.data.candidate, holderUnderTurnTip);

    const [holderResult, waiterResult] = await Promise.all([holderPromise, waiterPromise]);
    assert.equal(holderResult.status, "landed");
    assert.equal(holderResult.commit, holderUnderTurnTip);
    assert.equal(waiterResult.status, "landed");
    assert.equal(waiterUnderTurnCalls, 0);
    assert.ok(waiterSpecCheck);
    assert.equal(waiterSpecCheck.base, holderResult.commit);
    assert.equal(waiterSpecCheck.tree, git(waiter, "rev-parse", `${waiterResult.commit}^{tree}`));
    assert.equal(git(origin, "rev-parse", "main"), waiterResult.commit);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // End-to-end receipt written during speculative pre-check satisfies requirePass for the landed commit.
    assert.doesNotThrow(() => requirePass(waiter, waiterResult.commit, holderResult.commit));

    // Telemetry records speculativeReused, phases.speculativeCheck, and phases.checkSlotWait on waiter's landing record.
    const waiterRecords = readLandings(waiter, git);
    assert.equal(waiterRecords.length, 1);
    assert.equal(waiterRecords[0].status, "landed");
    assert.equal(waiterRecords[0].speculativeReused, true);
    assert.equal(typeof waiterRecords[0].phases.speculativeCheck, "number");
    assert.equal(waiterRecords[0].phases.checkSlotWait, 450);
    assert.equal(waiterRecords[0].phases.underTurnCheck, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7666: in-flight speculative pre-check finishes under turn and reuses pass; turn loss aborts in-flight speculative check", async () => {
  // Subcase A: in-flight speculative check finishes after waiter acquires turn; waiter publishes its own tip while awaiting it.
  {
    const { root, origin, git, clone, commit } = setup();
    let candidatePublishCount = 0;
    const waiterPublishedCandidate = Promise.withResolvers();
    const signals = await signalServer(root, (name) => {
      if (name !== "candidate-published") return;
      candidatePublishCount += 1;
      if (candidatePublishCount === 2) waiterPublishedCandidate.resolve();
    });
    try {
      fs.writeFileSync(
        path.join(origin, "hooks", "post-receive"),
        [
          "#!/bin/sh",
          "while read old new ref; do",
          `  if [ "$ref" = "${CANDIDATE_REF}" ] && [ "$new" != "0000000000000000000000000000000000000000" ]; then`,
          `    ${signals.notifyCommand("candidate-published")}`,
          "  fi",
          "done",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const holder = clone("holder");
      const waiter = clone("waiter");
      const other = clone("other");
      commit(holder, "holder.txt");
      commit(waiter, "waiter.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPreDone = Promise.withResolvers();
      const waiterPreDone = Promise.withResolvers();
      const allowHolderAcquire = Promise.withResolvers();
      const holderInUnderTurn = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const specStarted = Promise.withResolvers();
      const allowSpecFinish = Promise.withResolvers();

      let waiterUnderTurnCalls = 0;

      const holderPromise = land({
        cwd: holder,
        remote: "origin",
        every: NO_RENEWAL,
        check: async (turn) => {
          if (!turn) {
            holderPreDone.resolve();
            await allowHolderAcquire.promise;
            return true;
          }
          holderInUnderTurn.resolve();
          await releaseHolder.promise;
          return true;
        },
      });

      const waiterPromise = land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        sleep: async () => {
          await specStarted.promise;
          // Holder lands while waiter's speculative check is still in flight.
          releaseHolder.resolve();
          await holderPromise;
        },
        check: async (turn, base, _budget, directory) => {
          if (!turn && base === initialBase) {
            waiterPreDone.resolve();
            await holderInUnderTurn.promise;
            return true;
          }
          if (!turn) {
            specStarted.resolve();
            await allowSpecFinish.promise;
            recordPass(directory, git(directory, "rev-parse", "HEAD^{tree}"), base);
            return true;
          }
          waiterUnderTurnCalls += 1;
          return true;
        },
      });

      await Promise.all([holderPreDone.promise, waiterPreDone.promise]);
      commit(other, "other.txt");
      git(other, "push", "-q", "origin", "HEAD:main");

      allowHolderAcquire.resolve();
      await holderInUnderTurn.promise;
      await specStarted.promise;
      // Wait for holder to land, then verify waiter publishes its own rebased tip BEFORE its in-flight spec check ends.
      await holderPromise;
      await waiterPublishedCandidate.promise;
      const waiterRebasedTip = git(waiter, "rev-parse", "HEAD");
      assert.equal(git(origin, "rev-parse", CANDIDATE_REF), waiterRebasedTip);
      assert.equal(readOriginLeasePayload(origin, git).data.candidate, waiterRebasedTip);

      allowSpecFinish.resolve();

      const waiterResult = await waiterPromise;
      assert.equal(waiterResult.status, "landed");
      assert.equal(waiterResult.commit, waiterRebasedTip);
      assert.equal(waiterUnderTurnCalls, 0);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
      const waiterRecords = readLandings(waiter, git);
      assert.equal(waiterRecords.at(-1).speculativeReused, true);
    } finally {
      await signals.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase B: turn loss while awaiting in-flight speculative check aborts specSignal cleanly.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      const thief = clone("thief");
      const other = clone("other");
      commit(holder, "holder.txt");
      commit(waiter, "waiter.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPreDone = Promise.withResolvers();
      const waiterPreDone = Promise.withResolvers();
      const allowHolderAcquire = Promise.withResolvers();
      const holderInUnderTurn = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const specStarted = Promise.withResolvers();
      const waiterAcquiredTurn = Promise.withResolvers();
      let specSignalSeen = null;
      let tickWaiterRenewal = null;

      const holderPromise = land({
        cwd: holder,
        remote: "origin",
        now: () => NOW,
        every: NO_RENEWAL,
        check: async (turn) => {
          if (!turn) {
            holderPreDone.resolve();
            await allowHolderAcquire.promise;
            return true;
          }
          holderInUnderTurn.resolve();
          await releaseHolder.promise;
          return true;
        },
      });

      const waiterPromise = land({
        cwd: waiter,
        remote: "origin",
        now: () => NOW,
        every: (_ms, tick) => {
          tickWaiterRenewal = tick;
          waiterAcquiredTurn.resolve();
          return () => {};
        },
        sleep: async () => {
          await specStarted.promise;
          releaseHolder.resolve();
          await holderPromise;
        },
        check: async (turn, base, _budget, _directory, signal) => {
          if (!turn && base === initialBase) {
            waiterPreDone.resolve();
            await holderInUnderTurn.promise;
            return true;
          }
          if (!turn) {
            specSignalSeen = signal;
            specStarted.resolve();
            await new Promise((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", resolve, { once: true });
            });
            return false;
          }
          return true;
        },
      });

      await Promise.all([holderPreDone.promise, waiterPreDone.promise]);
      commit(other, "other.txt");
      git(other, "push", "-q", "origin", "HEAD:main");

      allowHolderAcquire.resolve();
      await holderInUnderTurn.promise;
      await waiterAcquiredTurn.promise;

      // Steal waiter's lease from another machine's clock and trigger renewal so waiter loses its turn.
      const thiefLease = tryAcquire({
        cwd: thief,
        remote: "origin",
        runId: "thief",
        machine: ELSEWHERE,
        now: () => NOW + 3 * LEASE_TTL_MS,
      });
      assert.ok(thiefLease);
      tickWaiterRenewal();

      const waiterResult = await waiterPromise;
      assert.equal(waiterResult.status, "lost-turn");
      assert.equal(specSignalSeen?.aborted, true);

      release({ cwd: thief, remote: "origin" }, thiefLease);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("AB#7666: holder failure cleans CANDIDATE_REF and waiter falls back; holder landing a different commit discards speculative pass", async () => {
  // Subcase A: holder fails check-failed after publishing candidate.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      const other = clone("other");
      commit(holder, "holder.txt");
      commit(waiter, "waiter.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPreDone = Promise.withResolvers();
      const waiterPreDone = Promise.withResolvers();
      const allowHolderAcquire = Promise.withResolvers();
      const holderInUnderTurn = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const waiterSpecDone = Promise.withResolvers();

      let waiterUnderTurnCalls = 0;

      const holderPromise = land({
        cwd: holder,
        remote: "origin",
        every: NO_RENEWAL,
        check: async (turn) => {
          if (!turn) {
            holderPreDone.resolve();
            await allowHolderAcquire.promise;
            return true;
          }
          holderInUnderTurn.resolve();
          await releaseHolder.promise;
          return false;
        },
      });

      const waiterPromise = land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        sleep: async () => {
          await waiterSpecDone.promise;
          releaseHolder.resolve();
          const holderRes = await holderPromise;
          assert.equal(holderRes.status, "check-failed");
          // Holder release must have deleted CANDIDATE_REF along with LEASE_REF (waiter's queue ref remains).
          assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
          assert.equal(git(origin, "for-each-ref", CANDIDATE_REF), "");
        },
        check: async (turn, base) => {
          if (!turn && base === initialBase) {
            waiterPreDone.resolve();
            await holderInUnderTurn.promise;
            return true;
          }
          if (!turn) {
            waiterSpecDone.resolve();
            return true;
          }
          waiterUnderTurnCalls += 1;
          assert.equal(base, movedMain);
          return true;
        },
      });

      await Promise.all([holderPreDone.promise, waiterPreDone.promise]);
      commit(other, "other.txt");
      git(other, "push", "-q", "origin", "HEAD:main");
      const movedMain = git(origin, "rev-parse", "main");

      allowHolderAcquire.resolve();
      const waiterResult = await waiterPromise;
      assert.equal(waiterResult.status, "landed");
      assert.equal(waiterUnderTurnCalls, 1);
      assert.equal(git(origin, "rev-parse", "main"), waiterResult.commit);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
      const records = readLandings(waiter, git);
      assert.equal(records.at(-1).speculativeReused, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase B: holder publishes C but actually pushes a different commit D to main.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const holder = clone("holder");
      const alt = clone("alt");
      const waiter = clone("waiter");
      commit(holder, "candidate-c.txt");
      const commitC = git(holder, "rev-parse", "HEAD");
      commit(alt, "actual-d.txt");
      const commitD = git(alt, "rev-parse", "HEAD");
      git(holder, "fetch", "-q", alt, "HEAD");
      commit(waiter, "waiter.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPublished = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const waiterSpecDone = Promise.withResolvers();
      let waiterUnderTurnBase = null;

      const holderPromise = withTurn(
        { cwd: holder, remote: "origin", every: NO_RENEWAL },
        async (_turn, _signal, pushMain, publishCandidate) => {
          assert.equal(publishCandidate(commitC), true);
          holderPublished.resolve();
          await releaseHolder.promise;
          assert.equal(await pushMain("main", commitD), true);
        },
      );

      await holderPublished.promise;

      const waiterPromise = land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        sleep: async () => {
          await waiterSpecDone.promise;
          releaseHolder.resolve();
          await holderPromise;
        },
        check: (turn, base) => {
          if (!turn && base === initialBase) return true;
          if (!turn) {
            assert.equal(base, commitC);
            waiterSpecDone.resolve();
            return true;
          }
          waiterUnderTurnBase = base;
          return true;
        },
      });

      const waiterResult = await waiterPromise;
      assert.equal(waiterResult.status, "landed");
      assert.equal(waiterUnderTurnBase, commitD);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
      const records = readLandings(waiter, git);
      assert.equal(records.at(-1).speculativeReused, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  CANDIDATE_REF,
  LEASE_REF,
  LEASE_TTL_MS,
  land,
  withTurn,
  testing: { acquireCheckoutSlot, checkoutsFolder, release, tryAcquire },
} = require("./landing-turn.cjs");
const { recordPass, requirePass } = require("./check-changed-receipt.cjs");
const { ELSEWHERE, QUEUE_PREFIX, setup } = require("./landing-turn.testkit.cjs");

const NO_RENEWAL = () => () => {};
const NOW = 1_800_000_000_000;

function readLandings(dir, git) {
  const commonDir = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const file = path.join(commonDir, "t3-landing", "landings.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

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
      check: async (turn, base, _budget, directory, signal) => {
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

    // Telemetry records speculativeReused and phases.speculativeCheck on waiter's landing record.
    const waiterRecords = readLandings(waiter, git);
    assert.equal(waiterRecords.length, 1);
    assert.equal(waiterRecords[0].status, "landed");
    assert.equal(waiterRecords[0].speculativeReused, true);
    assert.equal(typeof waiterRecords[0].phases.speculativeCheck, "number");
    assert.equal(waiterRecords[0].phases.underTurnCheck, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7666: in-flight speculative pre-check finishes under turn and reuses pass; turn loss aborts in-flight speculative check", async () => {
  // Subcase A: in-flight speculative check finishes after waiter acquires turn.
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
      // Wait for holder to land, then let waiter's in-flight speculative check finish under turn.
      await holderPromise;
      allowSpecFinish.resolve();

      const waiterResult = await waiterPromise;
      assert.equal(waiterResult.status, "landed");
      assert.equal(waiterUnderTurnCalls, 0);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
      const waiterRecords = readLandings(waiter, git);
      assert.equal(waiterRecords.at(-1).speculativeReused, true);
    } finally {
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

test("AB#7666: depth-one enforcement, abort on queue drop and candidate change, and local slot abort cleanup", async () => {
  // Subcase A: second waiter (firstInQueue === false) never starts speculative check.
  {
    const { root, origin, git, clone, commit, seedEntries, dropEntries } = setup();
    try {
      const holder = clone("holder");
      const secondWaiter = clone("second-waiter");
      commit(holder, "holder.txt");
      const candidateC = git(holder, "rev-parse", "HEAD");
      commit(secondWaiter, "second.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPublished = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const holderPromise = withTurn(
        { cwd: holder, remote: "origin", now: () => NOW, every: NO_RENEWAL },
        async (_turn, _signal, pushMain, publishCandidate) => {
          assert.equal(publishCandidate(candidateC), true);
          holderPublished.resolve();
          await releaseHolder.promise;
          assert.equal(await pushMain("main", candidateC), true);
        },
      );
      await holderPublished.promise;

      // Seed an earlier queue waiter so secondWaiter is NOT firstInQueue.
      seedEntries([["ahead-waiter", NOW - 60_000]]);
      let pollCount = 0;
      let speculativeCalls = 0;
      let underTurnCalls = 0;

      const waiterResult = await land({
        cwd: secondWaiter,
        remote: "origin",
        now: () => NOW,
        every: NO_RENEWAL,
        sleep: async () => {
          pollCount += 1;
          if (pollCount === 2) {
            releaseHolder.resolve();
            await holderPromise;
            dropEntries(["ahead-waiter"]);
          }
        },
        check: (turn, base) => {
          if (!turn && base === initialBase) return true;
          if (!turn) {
            speculativeCalls += 1;
            return true;
          }
          underTurnCalls += 1;
          return true;
        },
      });

      assert.equal(waiterResult.status, "landed");
      assert.equal(speculativeCalls, 0);
      assert.equal(underTurnCalls, 1);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase B: losing firstInQueue aborts active speculative check via AbortSignal.
  {
    const { root, origin, git, clone, commit, seedEntries, dropEntries } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      commit(holder, "holder.txt");
      const candidateC = git(holder, "rev-parse", "HEAD");
      commit(waiter, "waiter.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPublished = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const holderPromise = withTurn(
        { cwd: holder, remote: "origin", now: () => NOW, every: NO_RENEWAL },
        async (_turn, _signal, pushMain, publishCandidate) => {
          assert.equal(publishCandidate(candidateC), true);
          holderPublished.resolve();
          await releaseHolder.promise;
          assert.equal(await pushMain("main", candidateC), true);
        },
      );
      await holderPublished.promise;

      const specStarted = Promise.withResolvers();
      const specAborted = Promise.withResolvers();
      let pollCount = 0;

      const waiterResult = await land({
        cwd: waiter,
        remote: "origin",
        now: () => NOW,
        every: NO_RENEWAL,
        sleep: async () => {
          pollCount += 1;
          if (pollCount === 1) {
            await specStarted.promise;
            // Insert an earlier waiter so next poll observes firstInQueue === false.
            seedEntries([["older-waiter", NOW - 120_000]]);
          } else if (pollCount === 2) {
            await specAborted.promise;
            releaseHolder.resolve();
            await holderPromise;
            dropEntries(["older-waiter"]);
          }
        },
        check: async (turn, base, _budget, _directory, signal) => {
          if (!turn && base === initialBase) return true;
          if (!turn) {
            specStarted.resolve();
            await new Promise((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", resolve, { once: true });
            });
            assert.equal(signal.aborted, true);
            specAborted.resolve();
            return false;
          }
          return true;
        },
      });

      assert.equal(waiterResult.status, "landed");
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase C: holder changing candidate aborts old speculative check and starts new one.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      commit(holder, "c1.txt");
      const candidate1 = git(holder, "rev-parse", "HEAD");
      commit(holder, "c2.txt");
      const candidate2 = git(holder, "rev-parse", "HEAD");
      commit(waiter, "waiter.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const published1 = Promise.withResolvers();
      const switchTo2 = Promise.withResolvers();
      const published2 = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const spec1Started = Promise.withResolvers();
      const spec1Aborted = Promise.withResolvers();
      const spec2Done = Promise.withResolvers();

      const holderPromise = withTurn(
        { cwd: holder, remote: "origin", every: NO_RENEWAL },
        async (_turn, _signal, pushMain, publishCandidate) => {
          assert.equal(publishCandidate(candidate1), true);
          published1.resolve();
          await switchTo2.promise;
          assert.equal(publishCandidate(candidate2), true);
          published2.resolve();
          await releaseHolder.promise;
          assert.equal(await pushMain("main", candidate2), true);
        },
      );
      await published1.promise;

      let pollCount = 0;
      let underTurnCalls = 0;

      const waiterResult = await land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        sleep: async () => {
          pollCount += 1;
          if (pollCount === 1) {
            await spec1Started.promise;
            switchTo2.resolve();
            await published2.promise;
          } else if (pollCount === 2) {
            await spec1Aborted.promise;
            await spec2Done.promise;
            releaseHolder.resolve();
            await holderPromise;
          }
        },
        check: async (turn, base, _budget, _directory, signal) => {
          if (!turn && base === initialBase) return true;
          if (!turn && base === candidate1) {
            spec1Started.resolve();
            await new Promise((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", resolve, { once: true });
            });
            assert.equal(signal.aborted, true);
            spec1Aborted.resolve();
            return false;
          }
          if (!turn && base === candidate2) {
            spec2Done.resolve();
            return true;
          }
          underTurnCalls += 1;
          return true;
        },
      });

      assert.equal(waiterResult.status, "landed");
      assert.equal(underTurnCalls, 0);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase D: aborting acquireCheckoutSlot while queued releases local queue ticket cleanly.
  {
    const { root, git, clone } = setup();
    try {
      const dir = clone("slot-test");
      const common = fs.realpathSync.native(
        git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      );
      const queueDir = path.join(checkoutsFolder(common), "queue");

      const heldSlot = await acquireCheckoutSlot({ cwd: dir, role: "preWait", warmLimit: 1 });
      const waitingStarted = Promise.withResolvers();
      const controller = new AbortController();
      try {
        const queuedPromise = acquireCheckoutSlot({
          cwd: dir,
          role: "preWait",
          warmLimit: 1,
          signal: controller.signal,
          onWaitStart: () => waitingStarted.resolve(),
          waitSlot: () => new Promise(() => {}),
        });
        await waitingStarted.promise;
        controller.abort(new Error("cancelled"));
        await assert.rejects(queuedPromise, { name: "AbortError" });
        const leftover = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [];
        assert.deepEqual(leftover, []);
      } finally {
        heldSlot.release();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("AB#7666: speculative rebase conflict does not fail wait; .github/scripts change skips speculation; rebuild restores specTip", async () => {
  // Subcase A: speculative rebase conflict caught cleanly; waiter lands when holder fails.
  {
    const { root, origin, git, clone } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      fs.writeFileSync(path.join(holder, "shared.txt"), "holder version\n");
      git(holder, "add", "shared.txt");
      git(holder, "commit", "-qm", "holder shared");
      const holderCommit = git(holder, "rev-parse", "HEAD");

      fs.writeFileSync(path.join(waiter, "shared.txt"), "waiter version\n");
      git(waiter, "add", "shared.txt");
      git(waiter, "commit", "-qm", "waiter shared");
      const waiterHead = git(waiter, "rev-parse", "HEAD");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPublished = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const holderPromise = withTurn(
        { cwd: holder, remote: "origin", every: NO_RENEWAL },
        async (_turn, _signal, _pushMain, publishCandidate) => {
          assert.equal(publishCandidate(holderCommit), true);
          holderPublished.resolve();
          await releaseHolder.promise;
          // Holder exits without landing.
        },
      );
      await holderPublished.promise;

      let specCheckRan = false;
      // recordClock ticks: 1=start, 2=preWait begin, 3=preWait end, 4=waitForTurn begin,
      // 5=speculativeCheck begin, 6=speculativeCheck end (after speculative rebase conflict).
      let clockTicks = 0;
      const specPhaseEnded = Promise.withResolvers();

      const waiterResult = await land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        recordClock: () => {
          clockTicks += 1;
          if (clockTicks === 6) specPhaseEnded.resolve();
          return clockTicks * 10;
        },
        sleep: async () => {
          await specPhaseEnded.promise;
          releaseHolder.resolve();
          await holderPromise;
        },
        check: (turn, base) => {
          if (!turn && base === initialBase) return true;
          if (!turn) specCheckRan = true;
          return true;
        },
      });

      assert.equal(waiterResult.status, "landed");
      assert.equal(waiterResult.commit, waiterHead);
      assert.equal(specCheckRan, false);
      assert.equal(git(origin, "rev-parse", "main"), waiterHead);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
      const records = readLandings(waiter, git);
      assert.equal(records.at(-1).speculativeReused, false);
      assert.equal(typeof records.at(-1).phases.speculativeCheck, "number");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase B: candidate touching .github/scripts/ skips speculative pre-check.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      fs.mkdirSync(path.join(holder, ".github", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(holder, ".github", "scripts", "extra.cjs"), "// extra\n");
      git(holder, "add", ".");
      git(holder, "commit", "-qm", "touch scripts");
      const holderCommit = git(holder, "rev-parse", "HEAD");
      commit(waiter, "waiter.txt");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPublished = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const holderPromise = withTurn(
        { cwd: holder, remote: "origin", every: NO_RENEWAL },
        async (_turn, _signal, pushMain, publishCandidate) => {
          assert.equal(publishCandidate(holderCommit), true);
          holderPublished.resolve();
          await releaseHolder.promise;
          assert.equal(await pushMain("main", holderCommit), true);
        },
      );
      await holderPublished.promise;

      let specCheckRan = false;
      let underTurnRan = false;
      let pollCount = 0;

      const waiterResult = await land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        sleep: async () => {
          pollCount += 1;
          if (pollCount === 2) {
            releaseHolder.resolve();
            await holderPromise;
          }
        },
        check: (turn, base) => {
          if (!turn && base === initialBase) return true;
          if (!turn) {
            specCheckRan = true;
            return true;
          }
          underTurnRan = true;
          return true;
        },
      });

      assert.equal(waiterResult.status, "landed");
      assert.equal(specCheckRan, false);
      assert.equal(underTurnRan, true);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
      const records = readLandings(waiter, git);
      assert.equal(records.at(-1).phases.speculativeCheck, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase C: checkoutContext.rebuild inside speculative check restores specTip (rebased commit), not pre-rebase tip.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      commit(holder, "holder.txt");
      const holderCommit = git(holder, "rev-parse", "HEAD");
      commit(waiter, "waiter.txt");
      const waiterPreTip = git(waiter, "rev-parse", "HEAD");
      const initialBase = git(origin, "rev-parse", "main");

      const holderPublished = Promise.withResolvers();
      const releaseHolder = Promise.withResolvers();
      const specDone = Promise.withResolvers();
      const holderPromise = withTurn(
        { cwd: holder, remote: "origin", every: NO_RENEWAL },
        async (_turn, _signal, pushMain, publishCandidate) => {
          assert.equal(publishCandidate(holderCommit), true);
          holderPublished.resolve();
          await releaseHolder.promise;
          assert.equal(await pushMain("main", holderCommit), true);
        },
      );
      await holderPublished.promise;

      let rebuiltHead = null;
      let specTipBeforeRebuild = null;

      const waiterResult = await land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        sleep: async () => {
          await specDone.promise;
          releaseHolder.resolve();
          await holderPromise;
        },
        check: async (turn, base, _budget, directory, signal, checkoutContext) => {
          if (!turn && base === initialBase) return true;
          if (!turn) {
            specTipBeforeRebuild = git(directory, "rev-parse", "HEAD");
            assert.notEqual(specTipBeforeRebuild, waiterPreTip);
            await checkoutContext.rebuild(signal);
            rebuiltHead = git(directory, "rev-parse", "HEAD");
            specDone.resolve();
            return true;
          }
          return true;
        },
      });

      assert.equal(waiterResult.status, "landed");
      assert.equal(rebuiltHead, specTipBeforeRebuild);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("AB#7666: lapsed lease takeover cleans up stale CANDIDATE_REF left by crashed holder", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const crashed = clone("crashed");
    const nextLander = clone("next");
    commit(crashed, "crashed.txt");
    const staleCandidate = git(crashed, "rev-parse", "HEAD");
    commit(nextLander, "next.txt");

    // Simulate a holder on another machine that acquired the lease, published CANDIDATE_REF, and vanished.
    const acquiredAt = NOW - 4 * LEASE_TTL_MS;
    const staleLease = tryAcquire({
      cwd: crashed,
      remote: "origin",
      runId: "crashed-holder",
      machine: ELSEWHERE,
      now: () => acquiredAt,
    });
    assert.ok(staleLease);
    git(crashed, "push", "-q", "origin", `+${staleCandidate}:${CANDIDATE_REF}`);
    assert.equal(git(origin, "rev-parse", CANDIDATE_REF), staleCandidate);
    assert.notEqual(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // Verify next lander takes over the lapsed lease, cleans up stale CANDIDATE_REF, and lands cleanly.
    let candidateDuringNextTurn = "unchecked";
    const result = await land({
      cwd: nextLander,
      remote: "origin",
      now: () => NOW,
      every: NO_RENEWAL,
      check: () => true,
      finalize: () => {
        candidateDuringNextTurn = git(origin, "rev-parse", "--verify", CANDIDATE_REF);
        return true;
      },
    });

    assert.equal(result.status, "landed");
    assert.equal(candidateDuringNextTurn, result.commit);
    assert.equal(git(origin, "rev-parse", "main"), result.commit);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    assert.equal(git(origin, "for-each-ref", QUEUE_PREFIX), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

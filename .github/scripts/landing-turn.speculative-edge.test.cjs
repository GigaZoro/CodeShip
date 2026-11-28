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
  testing: { acquireCheckoutSlot, checkoutsFolder, deleteLease, tryAcquire },
} = require("./landing-turn.cjs");
const {
  ELSEWHERE,
  QUEUE_PREFIX,
  loseNextAnswer,
  readLandings,
  setup,
  stderrOf,
} = require("./landing-turn.testkit.cjs");

const NO_RENEWAL = () => () => {};
const NOW = 1_800_000_000_000;

function readOriginLeasePayload(origin, git) {
  const sha = git(origin, "rev-parse", "--verify", LEASE_REF);
  const firstLine = git(origin, "show", "-s", "--format=%B", sha).split("\n")[0];
  return { sha, data: JSON.parse(firstLine) };
}

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
      const specSettled = Promise.withResolvers();

      const waiterResult = await land({
        cwd: waiter,
        remote: "origin",
        every: NO_RENEWAL,
        onSpeculativeSettled: (info) => specSettled.resolve(info),
        sleep: async () => {
          const settled = await specSettled.promise;
          assert.equal(settled.passed, false);
          assert.equal(settled.checkingStarted, false);
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

test("AB#7666: active turn holder aborts unstarted speculation queued on warm slots and finishes in an overflow checkout", async () => {
  const { root, origin, git, clone, commit } = setup();
  let occupiedSlot = null;
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    commit(holder, "holder.txt");
    const holderCommit = git(holder, "rev-parse", "HEAD");
    commit(waiter, "waiter.txt");
    const initialBase = git(origin, "rev-parse", "main");
    const waiterCommon = fs.realpathSync.native(
      git(waiter, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const queueDir = path.join(checkoutsFolder(waiterCommon), "queue");

    const holderHasTurn = Promise.withResolvers();
    const allowHolderPublish = Promise.withResolvers();
    const holderPublished = Promise.withResolvers();
    const releaseHolder = Promise.withResolvers();

    const holderPromise = withTurn(
      { cwd: holder, remote: "origin", every: NO_RENEWAL },
      async (_turn, _signal, pushMain, publishCandidate) => {
        holderHasTurn.resolve();
        await allowHolderPublish.promise;
        assert.equal(publishCandidate(holderCommit), true);
        holderPublished.resolve();
        await releaseHolder.promise;
        assert.equal(await pushMain("main", holderCommit), true);
      },
    );
    await holderHasTurn.promise;

    const specQueuedInLocalFifo = Promise.withResolvers();
    let pollCount = 0;
    let specCheckRan = false;
    let underTurnCalls = 0;
    let underTurnDirName = null;
    let queueEntriesAtUnderTurn = null;

    const waiterResult = await land({
      cwd: waiter,
      remote: "origin",
      warmLimit: 1,
      every: NO_RENEWAL,
      waitSlot: () => {
        specQueuedInLocalFifo.resolve();
        // Never resolves on its own: only aborting the unstarted speculative task can unblock it.
        return new Promise(() => {});
      },
      sleep: async () => {
        pollCount += 1;
        if (pollCount === 1) {
          // Waiter's own preWaitCheck has released warm slot 0; occupy it before holder publishes a candidate.
          occupiedSlot = await acquireCheckoutSlot({
            cwd: waiter,
            role: "preWait",
            warmLimit: 1,
          });
          allowHolderPublish.resolve();
          await holderPublished.promise;
        } else if (pollCount === 2) {
          await specQueuedInLocalFifo.promise;
          const tickets = fs
            .readdirSync(queueDir)
            .filter((name) => /^wait-\d+-[0-9a-f-]+\.lock$/.test(name));
          assert.equal(tickets.length, 1);
          releaseHolder.resolve();
          await holderPromise;
        }
      },
      check: (turn, base, _budget, directory) => {
        if (!turn && base === initialBase) return true;
        if (!turn) {
          specCheckRan = true;
          return true;
        }
        underTurnCalls += 1;
        underTurnDirName = path.basename(directory);
        queueEntriesAtUnderTurn = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [];
        return true;
      },
    });

    assert.equal(waiterResult.status, "landed");
    assert.equal(specCheckRan, false);
    assert.equal(underTurnCalls, 1);
    assert.match(underTurnDirName ?? "", /^extra-[0-9a-f-]+$/);
    assert.deepEqual(queueEntriesAtUnderTurn, []);
    assert.equal(git(origin, "rev-parse", "main"), waiterResult.commit);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    const records = readLandings(waiter, git);
    assert.equal(records.at(-1).speculativeReused, false);
  } finally {
    occupiedSlot?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AB#7666: CANDIDATE_REF fallback and error recovery (deleteLease, pushMain retry, publishCandidate RemoteFailure)", async () => {
  // Subcase A: deleteLease(..., { deleteCandidate: true }) falls back to deleting LEASE_REF alone when CANDIDATE_REF is absent.
  {
    const { root, origin, git, clone } = setup();
    try {
      const dir = clone("delete-fallback");
      const leaseSha = tryAcquire({ cwd: dir, remote: "origin", runId: "r-del", now: () => NOW });
      assert.ok(leaseSha);
      assert.equal(git(origin, "for-each-ref", CANDIDATE_REF), "");
      assert.equal(
        deleteLease({ cwd: dir, remote: "origin" }, leaseSha, { deleteCandidate: true }),
        true,
      );
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase B: pushMain retries without :CANDIDATE_REF when candidatePresent is true but CANDIDATE_REF was removed on origin.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const dir = clone("push-retry");
      commit(dir, "retry.txt");
      const tip = git(dir, "rev-parse", "HEAD");
      await withTurn(
        { cwd: dir, remote: "origin", every: NO_RENEWAL },
        async (_turn, _signal, pushMain, publishCandidate) => {
          assert.equal(publishCandidate(tip), true);
          assert.equal(git(origin, "rev-parse", CANDIDATE_REF), tip);
          // Externally remove CANDIDATE_REF while holder still believes candidatePresent === true.
          git(origin, "update-ref", "-d", CANDIDATE_REF);
          assert.equal(git(origin, "for-each-ref", CANDIDATE_REF), "");
          assert.equal(await pushMain("main", tip), true);
        },
      );
      assert.equal(git(origin, "rev-parse", "main"), tip);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase C: publishCandidate RemoteFailure sets failing = true; subsequent renew() settles pending candidate and pushMain lands cleanly.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const dir = clone("publish-recover");
      commit(dir, "recover.txt");
      const tip = git(dir, "rev-parse", "HEAD");
      let tickRenewal = null;
      await withTurn(
        {
          cwd: dir,
          remote: "origin",
          every: (_ms, tick) => {
            tickRenewal = tick;
            return () => {};
          },
        },
        async (_turn, signal, pushMain, publishCandidate) => {
          // Disconnect origin to trigger RemoteFailure on publishCandidate.
          fs.renameSync(path.join(origin, "HEAD"), path.join(origin, "HEAD-away"));
          const pubOut = stderrOf(() => publishCandidate(tip));
          assert.equal(pubOut.result, false);
          assert.equal(signal.aborted, false);
          assert.match(pubOut.written.join(""), /could not publish candidate commit/);

          // Consistent with renew(), failing = true suppresses duplicate renewal failure warnings while origin stays down.
          const renewDownOut = stderrOf(() => tickRenewal());
          assert.equal(renewDownOut.written.join(""), "");

          // Reconnect origin: renew() settles pending/pendingCandidate, preserving candidate on LEASE_REF and CANDIDATE_REF.
          fs.renameSync(path.join(origin, "HEAD-away"), path.join(origin, "HEAD"));
          tickRenewal();
          assert.equal(git(origin, "rev-parse", CANDIDATE_REF), tip);
          assert.equal(readOriginLeasePayload(origin, git).data.candidate, tip);
          assert.equal(await pushMain("main", tip), true);
        },
      );
      assert.equal(git(origin, "rev-parse", "main"), tip);
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Subcase D: ambiguous RemoteFailure (push reached origin, readback failed) cleaned up on releaseTurn without leaking refs.
  {
    const { root, origin, git, clone, commit } = setup();
    try {
      const dir = clone("publish-ambiguous");
      commit(dir, "ambiguous.txt");
      const tip = git(dir, "rev-parse", "HEAD");
      await withTurn(
        { cwd: dir, remote: "origin", every: NO_RENEWAL },
        async (_turn, signal, _pushMain, publishCandidate) => {
          const { reconnect } = loseNextAnswer(dir, origin, git, true);
          const pubOut = stderrOf(() => publishCandidate(tip));
          assert.equal(pubOut.result, false);
          assert.equal(signal.aborted, false);
          reconnect();
          // The ambiguous push actually applied CANDIDATE_REF and moved LEASE_REF to `pending` on origin.
          assert.equal(git(origin, "rev-parse", CANDIDATE_REF), tip);
          // Exit without pushing so releaseTurn() must delete both the pending lease and CANDIDATE_REF.
        },
      );
      assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  land,
  withTurn,
  testing: { acquireCheckoutSlot, checkoutsFolder },
} = require("./landing-turn.cjs");
const { setup } = require("./landing-turn.testkit.cjs");

const NO_RENEWAL = () => () => {};
const NOW = 1_800_000_000_000;

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

  // Subcase D: aborting acquireCheckoutSlot while queued (or a sync-throwing waitSlot) releases queue ticket and abort listener cleanly.
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

        // Synchronous throw inside custom waitSlot still removes the abort listener and queue ticket.
        const syncThrowController = new AbortController();
        let addedListeners = 0;
        let removedListeners = 0;
        const origAdd = syncThrowController.signal.addEventListener.bind(
          syncThrowController.signal,
        );
        const origRemove = syncThrowController.signal.removeEventListener.bind(
          syncThrowController.signal,
        );
        syncThrowController.signal.addEventListener = (...args) => {
          addedListeners += 1;
          return origAdd(...args);
        };
        syncThrowController.signal.removeEventListener = (...args) => {
          removedListeners += 1;
          return origRemove(...args);
        };
        await assert.rejects(
          acquireCheckoutSlot({
            cwd: dir,
            role: "preWait",
            warmLimit: 1,
            signal: syncThrowController.signal,
            waitSlot: () => {
              throw new Error("sync waitSlot boom");
            },
          }),
          /sync waitSlot boom/,
        );
        assert.equal(addedListeners, 1);
        assert.equal(removedListeners, 1);
        assert.deepEqual(fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [], []);
      } finally {
        heldSlot.release();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

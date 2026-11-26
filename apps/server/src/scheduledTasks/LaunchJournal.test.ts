import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as LaunchJournal from "./LaunchJournal.ts";

it.effect("keeps each milestone of a run in a log of its own, in order", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const journal = yield* LaunchJournal.LaunchJournal;

    yield* journal.record({ taskId: "t1", runId: "r1", milestone: "started", detail: "scheduled" });
    yield* journal.record({
      taskId: "t1",
      runId: "r1",
      milestone: "launching",
      detail: "thread-1",
    });

    const file = path.join(path.dirname(config.serverTracePath), "scheduled-task-launches.ndjson");
    const lines = (yield* fileSystem.readFileString(file))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>);
    assert.deepEqual(
      lines.map(({ taskId, runId, milestone, detail }) => ({ taskId, runId, milestone, detail })),
      [
        { taskId: "t1", runId: "r1", milestone: "started", detail: "scheduled" },
        { taskId: "t1", runId: "r1", milestone: "launching", detail: "thread-1" },
      ],
    );
    assert.match(lines[0]?.time ?? "", /^\d{4}-\d\d-\d\dT/);
  }).pipe(
    Effect.provide(
      LaunchJournal.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "journal-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

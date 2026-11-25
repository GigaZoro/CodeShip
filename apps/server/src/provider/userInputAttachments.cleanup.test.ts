// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as DocumentText from "./DocumentText.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { appendUserInputAttachmentPaths } from "./userInputAttachments.ts";

const layer = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-answer-paths-" }),
  DocumentText.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const attachment = {
  type: "file" as const,
  id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
  sizeBytes: 4,
};

describe("question answer paths", () => {
  it.effect("extracts notebook cells and outputs once and keeps both readable paths", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const file = {
        ...attachment,
        id: attachment.id.replace(/txt$/, "ipynb"),
        name: "survey.ipynb",
        mimeType: "application/x-ipynb+json",
      };
      const path = NodePath.join(config.attachmentsDir, `${file.id}.ipynb`);
      const notebook = JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Survey\n", "Vessel: Larkspur"] },
          {
            cell_type: "code",
            source: ["print(43 * 7)"],
            outputs: [
              { text: ["301\n"] },
              { data: { "text/plain": ["42"] } },
              {
                output_type: "error",
                ename: "ZeroDivisionError",
                evalue: "division by zero",
                traceback: [
                  "\u001b[32mCell In[1], line 1\u001b[0m",
                  "\u001b[31m----> 1 1 / 0\u001b[0m",
                  "ZeroDivisionError: division by zero",
                ],
              },
            ],
          },
        ],
      });
      NodeFS.writeFileSync(path, notebook);
      const answers = yield* appendUserInputAttachmentPaths({
        answers: { q: "Read this" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [file] },
      });
      expect(answers.q).toContain(`text extracted to: ${JSON.stringify(`${path}.txt`)}`);
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Vessel: Larkspur");
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("301");
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("42");
      const extracted = NodeFS.readFileSync(`${path}.txt`, "utf8");
      expect(extracted).toContain(
        "ZeroDivisionError: division by zero\nCell In[1], line 1\n----> 1 1 / 0\nZeroDivisionError: division by zero",
      );
      expect(extracted).not.toContain("\u001b");
      expect(NodeFS.readFileSync(path, "utf8")).toBe(notebook);
      const before = NodeFS.statSync(path + ".txt").mtimeMs;
      // A changed binary would fail parsing if the cached extraction were not reused.
      NodeFS.writeFileSync(path, "invalid notebook");
      const documents = yield* DocumentText.DocumentText;
      const results = yield* Effect.all([documents.ensure(path), documents.ensure(path)], {
        concurrency: "unbounded",
      });
      expect(results).toEqual([path + ".txt", path + ".txt"]);
      expect(NodeFS.statSync(path + ".txt").mtimeMs).toBe(before);
      yield* Effect.gen(function* () {
        const cleanup = yield* Cleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([file.id]);
        expect(NodeFS.existsSync(path)).toBe(false);
        expect(NodeFS.existsSync(path + ".txt")).toBe(false);
        NodeFS.writeFileSync(path + ".txt", "orphaned extraction");
        yield* cleanup.cleanupAttachments([file.id]);
        expect(NodeFS.existsSync(path + ".txt")).toBe(false);
      }).pipe(
        Effect.provide(
          Cleanup.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(DeviceService.DeviceService)({}),
                Layer.mock(TerminalManager.TerminalManager)({}),
                Layer.mock(PreviewManager.PreviewManager)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(layer)),
  );
});

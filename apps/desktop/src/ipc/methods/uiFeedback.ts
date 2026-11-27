import { DesktopUiFeedbackScreenshotSchema } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const SCREENSHOT_MAX_WIDTH = 1600;
const SCREENSHOT_JPEG_QUALITY = 75;
const EXPORT_MAX_BYTES = 2 * 1024 * 1024;
const EXPORT_DIRECTORY = "ui-feedback";
const EXPORT_FILE_NAME = "ui-feedback.md";

class UiFeedbackCaptureError extends Schema.TaggedError<UiFeedbackCaptureError>()(
  "UiFeedbackCaptureError",
  {
    cause: Schema.Defect(),
  },
) {}

export const captureUiFeedbackWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UI_FEEDBACK_CAPTURE_WINDOW_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(DesktopUiFeedbackScreenshotSchema),
  handler: Effect.fn("desktop.ipc.uiFeedback.captureWindow")(function* (_input, event) {
    if (event === undefined) return null;
    return yield* Effect.tryPromise({
      try: async () => {
        const window = Electron.BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.isDestroyed() && candidate.webContents.id === event.sender.id,
        );
        if (window === undefined) return null;
        const captured = await window.webContents.capturePage();
        if (captured.isEmpty()) return null;
        const image =
          captured.getSize().width > SCREENSHOT_MAX_WIDTH
            ? captured.resize({ width: SCREENSHOT_MAX_WIDTH, quality: "good" })
            : captured;
        const { width, height } = image.getSize();
        const jpeg = image.toJPEG(SCREENSHOT_JPEG_QUALITY);
        return { dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, width, height };
      },
      catch: (cause) => new UiFeedbackCaptureError({ cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not capture the window for UI feedback", cause).pipe(
          Effect.as(null),
        ),
      ),
    );
  }),
});

const ExportMarkdown = Schema.String.check(
  Schema.makeFilter((markdown) => Buffer.byteLength(markdown, "utf8") <= EXPORT_MAX_BYTES),
);

export const writeUiFeedbackExport = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UI_FEEDBACK_WRITE_EXPORT_CHANNEL,
  payload: ExportMarkdown,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.uiFeedback.writeExport")(function* (markdown) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const path = yield* Path.Path;
    const filePath = path.join(environment.stateDir, EXPORT_DIRECTORY, EXPORT_FILE_NAME);
    yield* writeFileStringAtomically({ filePath, contents: markdown });
    return filePath;
  }),
});

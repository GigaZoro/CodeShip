#!/usr/bin/env node

// Android masks a 72dp safe area inside 108dp; separate full-bleed backgrounds keep the mark clear of every mask.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

type IconVariant = "dev" | "nightly" | "prod";

const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const NOTIFICATION_CANVAS = 96;
const MARK_BOUNDS = { x: 19, y: 28, width: 90, height: 72 };
const MARK_FRACTION = 0.48;
const NOTIFICATION_MARK_FRACTION = 2 / 3;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";
const BACKGROUND_COLORS = { dev: "#14243b", nightly: "#211b38", prod: "#090e19" } as const;

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const markTransform = (size: number, fraction: number) => {
  const scale = (size * fraction) / MARK_BOUNDS.width;
  const tx = (size - MARK_BOUNDS.width * scale) / 2 - MARK_BOUNDS.x * scale;
  const ty = (size - MARK_BOUNDS.height * scale) / 2 - MARK_BOUNDS.y * scale;
  return `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})`;
};

const canvasSvg = (size: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${inner}</svg>`;

const rasterize = Effect.fn("androidIcons.rasterize")((layer: string, svg: string, size: number) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(size, size).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  }),
);

const composite = Effect.fn("androidIcons.composite")(
  (layer: string, base: Buffer, foreground: Buffer) =>
    Effect.tryPromise({
      try: () =>
        sharp(base)
          .composite([{ input: foreground }])
          .png()
          .toBuffer(),
      catch: (cause) => new AndroidIconRenderError({ layer, cause }),
    }),
);

const renderBackground = Effect.fn("androidIcons.renderBackground")(
  (variant: IconVariant, size: number) =>
    Effect.tryPromise({
      try: () =>
        sharp({
          create: {
            width: size,
            height: size,
            channels: 4,
            background: BACKGROUND_COLORS[variant],
          },
        })
          .png()
          .toBuffer(),
      catch: (cause) => new AndroidIconRenderError({ layer: `${variant}-background`, cause }),
    }),
);

const renderForeground = Effect.fn("androidIcons.renderForeground")(function* (
  repositoryRoot: string,
  size: number,
  monochrome = false,
  fraction = MARK_FRACTION,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(
    path.join(repositoryRoot, "assets", "prod", "app-icon.icon", "Assets", "text.svg"),
  );
  const paths = source.match(/<path[^>]*\/>/g);
  if (!paths?.length) {
    return yield* new AndroidIconRenderError({
      layer: "foreground",
      cause: new Error("The brand mark must contain SVG paths."),
    });
  }
  const mark = paths
    .map((svgPath) => (monochrome ? svgPath.replace(/fill="[^"]*"/g, 'fill="#ffffff"') : svgPath))
    .join("");
  return yield* rasterize(
    "foreground",
    canvasSvg(size, `<g transform="${markTransform(size, fraction)}">${mark}</g>`),
    size,
  );
});

const renderSplashIcon = Effect.fn("androidIcons.renderSplashIcon")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const background = yield* renderBackground(variant, SPLASH_CANVAS);
  const foreground = yield* renderForeground(repositoryRoot, SPLASH_CANVAS);
  return yield* composite(`${variant}-splash`, background, foreground);
});

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputs = [
    ["android-icon-foreground.png", yield* renderForeground(repositoryRoot, ADAPTIVE_CANVAS)],
    ["android-icon-mark.png", yield* renderForeground(repositoryRoot, ADAPTIVE_CANVAS, true)],
    [
      "android-notification-icon.png",
      yield* renderForeground(
        repositoryRoot,
        NOTIFICATION_CANVAS,
        true,
        NOTIFICATION_MARK_FRACTION,
      ),
    ],
    ["android-icon-background-dev.png", yield* renderBackground("dev", ADAPTIVE_CANVAS)],
    ["android-icon-background-nightly.png", yield* renderBackground("nightly", ADAPTIVE_CANVAS)],
    ["android-splash-icon-dev.png", yield* renderSplashIcon(repositoryRoot, "dev")],
    ["android-splash-icon-nightly.png", yield* renderSplashIcon(repositoryRoot, "nightly")],
    ["android-splash-icon-prod.png", yield* renderSplashIcon(repositoryRoot, "prod")],
  ] as const;
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}

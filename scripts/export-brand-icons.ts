#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebIconOverrides,
} from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const SOURCE_PATH = "assets/prod/logo.svg";
const SOURCE_SIZE = 128;
const APP_ICON_SIZE = 1024;
const MAC_ICON_INSET = 100;
const MAC_ICON_BODY_SIZE = APP_ICON_SIZE - MAC_ICON_INSET * 2;
const SVG_BASE_DENSITY = 72;
const IOS_BACKGROUND = "#090e19";
const PUBLIC_ICON_OVERRIDES = [
  ...DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  ...resolveWebIconOverrides("production", "apps/marketing/public"),
];

class IconExportRenderError extends Schema.TaggedError<IconExportRenderError>()(
  "IconExportRenderError",
  { variant: Schema.String, size: Schema.Int, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not render the ${this.variant} icon at ${this.size}x${this.size}.`;
  }
}

class IconExportEncodingError extends Schema.TaggedError<IconExportEncodingError>()(
  "IconExportEncodingError",
  { variant: Schema.String, cause: Schema.Defect() },
) {}

class IconExportSourceError extends Schema.TaggedError<IconExportSourceError>()(
  "IconExportSourceError",
  { message: Schema.String },
) {}

class IconExportAssetsStaleError extends Schema.TaggedError<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

const ICON_VARIANTS = [
  {
    label: "development",
    colors: { base: "#2563eb", highlight: "#60a5fa" },
    outputs: {
      nativeMark: `${BRAND_ASSET_PATHS.developmentIconComposerProject}/Assets/text.svg`,
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  },
  {
    label: "nightly",
    colors: { base: "#7c3aed", highlight: "#a78bfa" },
    outputs: {
      nativeMark: `${BRAND_ASSET_PATHS.nightlyIconComposerProject}/Assets/text.svg`,
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    },
  },
  {
    label: "production",
    colors: { base: "#0d9488", highlight: "#2dd4bf" },
    outputs: {
      nativeMark: `${BRAND_ASSET_PATHS.productionIconComposerProject}/Assets/text.svg`,
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    },
  },
] as const;

type IconVariant = (typeof ICON_VARIANTS)[number];

const renderIcon = Effect.fn("iconExport.renderIcon")(function* (
  variant: string,
  source: string,
  size: number,
  sourceSize = SOURCE_SIZE,
  opaque = false,
) {
  return yield* Effect.tryPromise({
    try: () => {
      const rendition = sharp(Buffer.from(source), {
        density: (SVG_BASE_DENSITY * size) / sourceSize,
      }).resize(size, size);
      if (opaque) rendition.flatten({ background: IOS_BACKGROUND });
      return rendition.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
    },
    catch: (cause) => new IconExportRenderError({ variant, size, cause }),
  });
});

const macosCanvas = (source: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${APP_ICON_SIZE}" height="${APP_ICON_SIZE}" viewBox="0 0 ${APP_ICON_SIZE} ${APP_ICON_SIZE}"><image x="${MAC_ICON_INSET}" y="${MAC_ICON_INSET}" width="${MAC_ICON_BODY_SIZE}" height="${MAC_ICON_BODY_SIZE}" href="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}"/></svg>`;

const renderVariant = Effect.fn("iconExport.renderVariant")(function* (
  source: string,
  variant: IconVariant,
) {
  const svg = source
    .replaceAll("#0d9488", variant.colors.base)
    .replaceAll("#2dd4bf", variant.colors.highlight);
  const paths = svg.match(/<path\b[^>]*\/>/g);
  if (paths?.length !== 1 || paths[0] === undefined) {
    return yield* new IconExportSourceError({
      message: `${SOURCE_PATH} must contain exactly one self-closing path for the brand mark.`,
    });
  }
  const nativeMark = `<svg width="${SOURCE_SIZE}" height="${SOURCE_SIZE}" viewBox="0 0 ${SOURCE_SIZE} ${SOURCE_SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">${paths[0].replace(/fill="[^"]*"/, `fill="${variant.colors.highlight}"`)}</svg>\n`;
  const renditionCache = new Map<number, Buffer>();
  const render = Effect.fn("iconExport.renderVariant.rendition")(function* (size: number) {
    const cached = renditionCache.get(size);
    if (cached !== undefined) return cached;
    const contents = yield* renderIcon(variant.label, svg, size);
    renditionCache.set(size, contents);
    return contents;
  });

  const universal = yield* render(APP_ICON_SIZE);
  const ios = yield* renderIcon(variant.label, svg, APP_ICON_SIZE, SOURCE_SIZE, true);
  const macos = yield* renderIcon(variant.label, macosCanvas(svg), APP_ICON_SIZE, APP_ICON_SIZE);
  const icoRenditions = yield* Effect.forEach(
    WINDOWS_ICON_SIZES,
    (size) => render(size).pipe(Effect.map((contents) => ({ size, contents }))),
    { concurrency: 1 },
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new IconExportEncodingError({ variant: variant.label, cause }),
  });

  const outputs = new Map<string, Buffer>([
    [variant.outputs.nativeMark, Buffer.from(nativeMark)],
    [variant.outputs.ios, ios],
    [variant.outputs.macos, macos],
    [variant.outputs.universal, universal],
    [variant.outputs.appleTouch, yield* render(180)],
    [variant.outputs.favicon16, yield* render(16)],
    [variant.outputs.favicon32, yield* render(32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
  ]);

  if (variant.label !== "development") {
    const webp = yield* Effect.tryPromise({
      try: () => sharp(universal).webp({ quality: 90, effort: 6 }).toBuffer(),
      catch: (cause) => new IconExportEncodingError({ variant: variant.label, cause }),
    });
    outputs.set(
      variant.label === "production"
        ? "apps/marketing/src/assets/icon.webp"
        : "apps/marketing/src/assets/icon-nightly.webp",
      webp,
    );
  }
  return outputs;
});

const writeAtomically = Effect.fn("iconExport.writeAtomically")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const targetDirectory = path.dirname(targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true });
  const temporaryPath = yield* fs.makeTempFileScoped({
    directory: targetDirectory,
    prefix: ".codeship-icon-export-",
    suffix: ".tmp",
  });
  yield* fs.writeFile(temporaryPath, contents);
  yield* fs.rename(temporaryPath, targetPath);
});

const isCurrent = Effect.fn("iconExport.isCurrent")(function* (
  repositoryRoot: string,
  relativePath: string,
  expected: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  if (!(yield* fs.exists(targetPath))) return false;
  const actual = yield* fs.readFile(targetPath);
  return Buffer.from(actual).equals(expected);
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const source = yield* fs.readFileString(path.join(repositoryRoot, SOURCE_PATH));
  const generated = new Map<string, Buffer>();

  for (const variant of ICON_VARIANTS) {
    yield* Console.log(`Rendering ${variant.label} from ${SOURCE_PATH}...`);
    for (const [relativePath, contents] of yield* renderVariant(source, variant)) {
      generated.set(relativePath, contents);
    }
  }

  for (const override of PUBLIC_ICON_OVERRIDES) {
    const sourceContents = generated.get(override.sourceRelativePath);
    if (sourceContents === undefined) {
      return yield* Effect.die(
        new Error(`Generated web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, sourceContents);
  }

  if (checkOnly) {
    const stale = yield* Effect.filter(
      [...generated.entries()],
      ([relativePath, contents]) =>
        isCurrent(repositoryRoot, relativePath, contents).pipe(Effect.map((current) => !current)),
      { concurrency: 4 },
    );
    if (stale.length > 0) {
      return yield* new IconExportAssetsStaleError({
        paths: stale.map(([relativePath]) => relativePath).sort(),
      });
    }
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => writeAtomically(repositoryRoot, relativePath, contents),
    { concurrency: 1, discard: true },
  );
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check).pipe(Effect.scoped),
).pipe(Command.withDescription("Render CodeShip application icons from the canonical SVG."));

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

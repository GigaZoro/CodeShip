# CodeShip brand icons

[`prod/logo.svg`](prod/logo.svg) is the source for the generated application icons.
Production uses teal, development uses blue, and nightly uses violet. The exporter
applies those channel colors to the same artwork, so every surface keeps the same mark.

From the repository root, run:

```sh
vp run icons:export
vp run icons:check
```

The exporter uses the repository's `sharp` dependency; Icon Composer is not required.
It regenerates the iOS, macOS, Linux, Windows, and web assets for all three channels,
copies the development web icons into `apps/web/public`, and updates the marketing
site's production public icons and production/nightly WebP images. The check command
compares every generated file byte for byte without writing files. Do not edit the
generated PNG, ICO, or WebP files directly. The iOS PNGs are flattened against the
dark brand background so they remain opaque for native distribution.

The macOS PNGs use a transparent 1024×1024 canvas with the icon's 824×824 body inset
100 pixels on each side. They are regenerated from the SVG along with the other
assets, so a logo change cannot leave the desktop Dock icon on an older design.

## Native icon projects

The `dev/app-icon.icon`, `nightly/app-icon.icon`, and `prod/app-icon.icon` projects
remain inputs to native iOS packaging. The exporter updates each project's
`Assets/text.svg` from the canonical SVG's mark path and channel highlight color.
Keep the projects' other layers and configuration aligned with `prod/logo.svg`
when changing the brand; the exporter does not rewrite those native settings.

## Android launcher and splash artwork

Run `vp run icons:export:android` after updating the native SVG layers. Android
uses a separate transparent foreground, full-bleed backgrounds, and splash artwork
to keep the mark within the launcher's and splash screen's masks. The generated
files live in `apps/mobile/assets`, including `android-icon-mark.png` for themed
launcher icons and `android-notification-icon.png` for notification silhouettes.

# Appearance, themes, and language

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser, unless you [use the same look on all your devices](#the-same-look-on-all-your-devices). Each Settings page has a **Reset page** button in its header to restore that page's defaults.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## The same look on all your devices

Appearance preferences are saved separately on each device, unless you turn on **Use the same
appearance and layout on all my devices** at the top of **Settings → Appearance** on web and
desktop. The machine that app is connected to must follow shared settings (**Settings → Machines &
access → Follow shared settings**), and the machines you want to share between must be linked. The
switch says what is missing when it cannot be turned on.

With it on, this device takes the shared profile when it starts and whenever it changes, and every
change you make here is saved to the profile, so your other devices that turned it on take it too.
Turning it on takes the profile as it is, so changes you made here before are replaced; the first
device to turn it on makes its own settings the profile.

The profile holds fonts and sizes, word wrap, sidebar grouping and sorting, the Working and manual
steps shelves, confirmations, diff preferences, chat width, effort display, glass opacity, contrast,
panel animations, time format, language, composer and send behavior, math rendering and
notifications. Themes, window sizes, browser settings, model favorites and per-project choices stay
on each device.

If you change something while this device cannot reach its machine and another device changes the
profile meanwhile, the newer profile wins and a message says so. A device with the switch off is
never changed. Mobile does not take part.

## Language

T3.CodeShip's interface is available in English and Ukrainian. On web and desktop, choose a language
under **Settings → General → Language**; the app reloads in that language. On mobile, choose it
under **Settings → Appearance → Language**. **System default** follows your browser, operating
system, or phone language and falls back to English. The language is saved separately on each
device or browser.

The language changes T3.CodeShip's own text, and dates and numbers follow it. Agent replies, your
messages, and names from your projects or git host stay as they are, and T3.CodeShip still writes
English in prompts, commit messages, and pull requests it prepares for you.

## Branch and machine pickers

Git-backed projects show branch, worktree and machine pickers below the composer until you send a
new thread's first message. After that, change them in the thread details card.

## Math

Turn on **Render math** in **Settings → Chat & diffs** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a T3.CodeShip or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. app.t3.codes and additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, T3.CodeShip falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
t3 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `t3 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`t3 theme clear` removes the default without changing anyone's current theme. `t3 theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from T3.CodeShip into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `t3 theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. T3.CodeShip
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

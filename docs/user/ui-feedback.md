# UI feedback

UI feedback keeps a private log of what annoys you in the app, so that it can be fixed later. Nothing
in it leaves your device.

## Capturing an annoyance

Press **Mod+Shift+.** (⌘⇧. on macOS, Ctrl+Shift+. elsewhere) when something gets in your way. To
change the key, go to **Settings** > **Keybindings** and find **Capture UI Feedback**. A small
dialog asks for an optional note of up to 120 characters. The capture also records:

- the page you are on
- the marked components under the pointer, or under the keyboard focus when you moved the focus
  after the pointer
- the visible notices and open panels
- the window size, theme and density

In the desktop app you can also attach a screenshot of the window. The dialog shows it, so check
it for secrets before you save: it is kept with the capture.

## Click counters

The app counts clicks on each nav rail destination, each thread details control and each composer
control. It stores only the counts, keyed by the ids the app gives its controls. It never stores
what you typed, what a control showed or its label.

## Reviewing and exporting

Open **Settings** > **Diagnostics** > **UI feedback**. The page lists your captures and the counters
and has these actions:

- **Export as Markdown** downloads a summary.
- **Clear** deletes every capture and resets the counters.

The desktop app also keeps an up-to-date copy of the summary at
`~/.t3/userdata/ui-feedback/ui-feedback.md`. A weekly task can read that file and turn repeated
annoyances into work items.

## Evening reminder

In the evening, from 18:00, the app can ask "Anything annoy you today?" once a day. Choose when in
**Settings** > **Diagnostics** > **UI feedback** > **Evening reminder**:

- **After two days without a capture**, the default, reminds you only when you have not captured
  anything for two days.
- **Every evening** reminds you every day.
- **Off** never reminds you.

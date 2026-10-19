# macOS page zoom shortcuts

In the native macOS app, use:

| Shortcut | Action |
| --- | --- |
| ⌘+ or ⌘= | Increase page zoom by 10 percentage points |
| ⌘− | Decrease page zoom by 10 percentage points |
| ⌘0 | Return to actual size |

Zoom is limited to 75–200%. The preference is saved after the native operation
succeeds, restored at startup and shared with other app windows through storage
events. Invalid stored values recover to a valid zoom level.

The shortcuts work while the composer or terminal input has focus. Handled zoom
keys do not reach terminal input; ordinary typing, copy/paste, Control/Option
combinations and IME composition remain untouched. A resize event lets existing
layout and terminal-fit handlers recalculate after successful zoom.

Only the native Mac entry activates these shortcuts. Browser, Windows, Android
and iPad desktop user agents keep their existing behavior. WKWebView page zoom
requires macOS 11 or newer; the native command checks the OS before invoking it
and rejects unsupported systems. The app's minimum OS version is unchanged.

## Validation

The frontend tests exercise actual keyboard-event propagation through focused
composer and terminal elements, bounds, preference recovery, cross-window
storage events and retry after a failed native command. The native command is
stubbed in these tests; they do not prove WKWebView behavior.

```sh
npm ci
npm ci --prefix bridge
node --test test/frontend/macos-zoom.test.mjs
npm run build
```

Native acceptance on a Mac remains required:

1. Run the branch with `npm run tauri -- dev`. In a conversation, focus the
   composer and try each shortcut. Confirm visible zoom and unchanged draft.
2. Repeat with terminal input focused. Confirm zoom keys are not entered into
   the terminal, while copy/paste and ordinary typing still work.
3. Check both bounds, rapid repeated shortcuts and ⌘0.
4. Open another window, change zoom and confirm the windows converge. Relaunch
   and confirm the last successful preference is restored.
5. Check that keyboard handling does not duplicate an existing system action.
   On macOS earlier than 11, confirm the command fails without invoking
   `WKWebView.pageZoom`.

This change adds no menu accelerators and requires no Bridge or Server update.

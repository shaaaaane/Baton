# Conversation Goal controls

Open **Goal** above the composer in an existing, writable Codex conversation. The panel shows the runtime's objective, status, cumulative execution time, tokens used and optional token budget. It reads on opening and every five seconds while visible; opening it never resumes the conversation or takes over another terminal.

Use **Pause**, **Resume**, **Set goal** or **Clear goal** to update that same persisted Goal. Pause prevents further Goal continuation; an in-flight turn may still finish. Use the existing Stop control to interrupt that turn. A new objective resets usage, whereas Pause/Resume preserve it. Goal uses the conversation's current mode; this feature does not automatically switch Plan to Default.

The chat draft is independent of the objective field. Closing the panel, including Escape while a task is running, preserves the draft and does not interrupt execution. A failed request shows unavailable status until a successful refresh. Connection loss is reported and requires an explicit Resume; the panel never automatically terminates an external terminal's writer.

## Requirements and implementation

Update both the frontend and Bridge. The existing `list_command_options` / `command_options` channel carries the versioned `__baton_goal_v1` request and response, so this change needs no new Server action. Older Bridges receive an explicit unsupported-controls message rather than showing an empty Goal. The runtime must support `thread/goal/get`, `thread/goal/set` and `thread/goal/clear`.

The Bridge keeps the subscribed execution connection while a Goal is active and forwards autonomous turns through the normal streaming callbacks. Goal-only stream envelopes carry `goalContinuation: true`, allowing them to render after existing messages without fabricating a user prompt. Ordinary turns still wait for their own user anchor. This also applies when reconnecting at a later block. The connection is released after the Goal stops and any active turn finishes.

Protocol reference: [OpenAI App Server — Manage a thread goal](https://developers.openai.com/codex/app-server#manage-a-thread-goal). The local `codex-cli 0.160.0` generated JSON schemas were also checked for Goal status and usage fields. These schema checks do not establish runtime execution acceptance.

## Screenshots and validation scope

These are real 390px Chromium screenshots. The browser uses a real local WebSocket, the production Goal RPC dispatcher, Bridge handler, Codex interaction adapter and stream envelope implementation. Only the Codex App Server is a synthetic fixture. They are not native-device or production execution screenshots.

| Active | Paused |
| --- | --- |
| ![Goal status and cumulative usage](assets/showcase/goal-active.png) | ![Paused Goal with Resume available](assets/showcase/goal-paused.png) |

Automated checks cover read/set/pause/resume/clear, preserved usage on status changes, autonomous output, late joining, read-only conversations, stale responses, duplicate requests, unsupported Bridges, runtime disconnects, writer ownership and Escape handling. Real model execution and native keyboard behavior still require acceptance with a compatible Codex runtime and updated Bridge.

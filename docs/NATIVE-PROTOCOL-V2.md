# Native protocol 2 — frozen Node integration contract

Worker version: **0.2.0**, Windows x64, Rust 1.94+. This document supersedes conflicting protocol-1 material. Every object uses snake_case except the retained receipt fields `inputInjected` and `deliveryVerified`.

## Transport and envelopes

UTF-8 JSON, one line per request/response; request line limit 2,097,152 bytes. Request `id` is a signed 64-bit integer. Unknown fields, unknown enum values, nonfinite numbers and malformed requests are rejected. No unsolicited stdout. Diagnostics use stderr. Commands queue at most 64; input operations never queue. Responses preserve:

```json
{"id":1,"ok":true,"result":{}}
{"id":1,"ok":false,"error":{"code":"invalid_request","message":"Explanation"}}
```

Malformed/unidentifiable IDs produce `id:null`. All retained operation/snapshot/gesture IDs are 1–128 UTF-8 bytes without control characters. A new process has a new snapshot epoch and no resumable operation; never replay after worker loss.

## Commands: exact request shapes

Fields shown below are required unless explicitly listed as optional. Each request has exactly one `command`.

```json
{"id":1,"command":"hello"}
{"id":2,"command":"ping"}
{"id":3,"command":"observe","hwnd":"12345"}
{"id":4,"command":"status","operation_id":"op-1"}
{"id":5,"command":"cancel","operation_id":"op-1","reason":"explicit_stop"}
{"id":6,"command":"pause","operation_id":"op-1","reason":"explicit_pause"}
{"id":7,"command":"events","after_seq":0,"limit":32}
```

`cancel.operation_id` and `cancel.reason` are optional/null; absent operation means current owner, absent reason means `explicit_cancel`. `pause.reason` is optional/null and defaults to `explicit_pause`; its operation ID is required. `events.after_seq` is optional unsigned integer (default 0), `limit` optional integer 1–128 (default 32).

`hello.result`:

```json
{"protocol":2,"version":"0.2.0","platform":"windows","capabilities":{"move":true,"click":true,"drag":true,"typing":true,"reading":true,"scroll":true,"key":true,"copy":true,"cut":true,"paste":true,"activate":true,"pause":true,"resume":true,"events":true,"cancel_on_user_message":false,"page_change_detection":false,"delivery_verified":false,"hooks":false,"capture":false,"parent_lease_ms":3000,"guard_interval_ms":20,"max_line_bytes":2097152,"max_events":12000,"exclusive_lock":"Local\\HumanInputMCP.Input.v1"}}
```

`ping.result` is `{"alive":true}`. No heartbeat capability implies detecting messages sent to another MCP tool. Node must keep lease traffic active while paused and explicitly cancel on stop/mode-off.

## Observation

`hwnd` is a positive decimal HWND string. `observe.result` has this exact shape (values illustrative):

```json
{"snapshot_id":"s-100-1","target_id":"12345:678:901","hwnd":"12345","identity":"678:901","rect":{"x":0,"y":0,"width":800,"height":600},"client":{"x":8,"y":32,"width":784,"height":560},"virtual_desktop":{"x":-1920,"y":0,"width":3840,"height":1080},"cursor":{"x":300,"y":200},"foreground":"12345","focus":"12346","dpi":96,"ready":true,"visible":true,"enabled":true,"minimized":false,"is_foreground":true,"observed_at":"2026-10-25T00:00:00.000Z"}
```

All rectangles/points use signed 32-bit physical screen pixels, including negative monitor coordinates. Rectangles are half-open. Identity binds process ID and creation time. `ready` requires foreground root, visible/enabled/unminimized target, positive client geometry and DPI. Only `activate` admits visible/enabled/unminimized nonforeground observations. Native retains 32 snapshots; admission freshness is 5,000 ms. `virtual_desktop` supports activation approach planning outside the client; native independently checks it.

## Start

```json
{"id":10,"command":"start","operation_id":"op-1","snapshot_id":"s-100-1","kind":"move","duration_ms":200,"events":[{"type":"move","x":302,"y":202,"at_ms":100}],"threshold_px":8,"force_ime_off":false,"pause_policy":{"stable_ms":350,"small_excursion_px":80,"large_range_px":180,"large_path_px":240,"sustained_ms":500,"window_ms":3000,"lifetime_ms":300000}}
```

Required fields: `operation_id`, `snapshot_id`, `kind`, `duration_ms`, `events`. Optional fields: `threshold_px` (default 8, integer 1–100), `force_ime_off` (default false, only typing), `pause_policy` (each omitted member gets its displayed default), `safe_area` (optional/null), `safe_area_confirmed` (default false). Safe-area fields are valid only with `kind:"activate"`.

Kinds: `move | click | drag | typing | reading | scroll | key | copy | cut | paste | activate`. Duration is finite and positive: typing ≤45,000 ms, reading ≤60,000 ms, all others ≤15,000 ms. Event count 1–12,000; finite nonnegative timestamps are monotonic and ≤duration. Fractional milliseconds and move coordinates are accepted; native rounds coordinates to physical integers. No caller-specified key-down/up or replacement event plan is accepted through resume.

Start returns only `{"operation_id":"op-1","state":"running"}` after admission. Platform preparation can still report a subsequent failure. New starts are rejected `input_busy` while any operation is running, pausing, paused, resuming or cancelling. Retained IDs cannot be reused. Cleanup failure poisons admission.

Event union (each object rejects extra fields):

```json
{"type":"move","x":300,"y":200,"at_ms":0}
{"type":"button_down","at_ms":20}
{"type":"button_up","at_ms":70}
{"type":"char","text":"字","at_ms":0}
{"type":"backspace","at_ms":100}
{"type":"wheel","axis":"vertical","delta":-120,"at_ms":0}
{"type":"key","key":"enter","modifiers":["ctrl"],"at_ms":0}
{"type":"clipboard","action":"paste","at_ms":0}
```

`modifiers` alone may be omitted (defaults to `[]`). No other event member is optional.

| Kind | Permitted event plan |
|---|---|
| move, reading | moves only |
| click | moves and exactly one balanced left-button pair; no held move |
| activate | approach moves and exactly one balanced left-button pair; no held move; button-up is the final input, including when timestamps tie |
| drag | moves and exactly one balanced left-button pair; at least one held move |
| typing | printable single Unicode codepoints or backspace; no control/newline/paragraph separator; nonoverlapping holds |
| scroll | wheel packets only, exactly one axis and sign, each +120 or −120, sum of absolute deltas ≤1,200, ≥40 ms between packets, ≥40 ms settling inside duration |
| key | exactly one allowlisted key event, ≥40 ms hold inside duration |
| copy, cut, paste | exactly one clipboard event with matching action, ≥40 ms hold inside duration |

Scroll delta is Windows wheel units, never pixels/lines. Vertical positive means forward; horizontal positive means right. Clipboard actions compile only to Ctrl+C/X/V and never open, inspect, read or write clipboard contents in worker memory. Generic key cannot spell these actions.

Named key spellings and complete modifier allowlist:

| Modifiers (order independent, no duplicates) | Keys |
|---|---|
| `[]` | `enter, tab, escape, backspace, delete, insert, left, right, up, down, home, end, page_up, page_down` |
| `["ctrl"]` | `a, z, y, f, enter, backspace, delete, left, right, up, down, home, end, page_up, page_down` |
| `["shift"]` | `left, right, up, down, home, end, page_up, page_down` |
| `["ctrl","shift"]` | `left, right, up, down, home, end, page_up, page_down` |

No Alt/Win, Ctrl+C/X/V, Shift+Delete/Insert, arbitrary VK/scan code, arbitrary printable key name, sequence, or implicit Enter. Enter/Ctrl+Enter may submit and must be requested explicitly.

Typing uses 35 ms per UTF-16 unit (supplementary codepoint 70 ms); backspace holds 40 ms. ASCII maps through the target keyboard layout and Caps state; Unicode uses packet input. Keyboard kinds all recheck focus, process lifetime, layout/Caps state and held input. Before keyboard/clipboard input and at resume, all ordinary VKs plus modifiers/buttons are sampled conservatively; per-frame guards reject held unowned keys. Generic aggregate Shift/Ctrl/Alt aliases are excluded because side-specific keys are sampled. Physical owned scan codes map back to their VK; owned Unicode units map to VK_PACKET. Unicode cannot establish physical-key provenance, so simultaneous external packet input may be indistinguishable and delivery remains unverified. IME forcing is scoped to typing only.

## Explicit safe activation

```json
{"id":11,"command":"start","operation_id":"activate-1","snapshot_id":"s-100-1","kind":"activate","duration_ms":150,"safe_area":{"x":295,"y":195,"width":20,"height":20},"safe_area_confirmed":true,"events":[{"type":"move","x":300,"y":200,"at_ms":0},{"type":"button_down","at_ms":40},{"type":"button_up","at_ms":90}]}
```

Caller confirmation asserts it freshly observed that the area does not edit, navigate, submit or otherwise activate content. Native cannot establish that semantic fact. The entire positive-sized integer safe rectangle must lie inside the observed target client; actual click must lie inside it and be an unoccluded target/child client hit immediately before down and up. Button-up must be the final input; any event after it, including motion at the same timestamp, is rejected before admission. It uses SendInput only, never a focus-setting API or window mutation.

Approach may start outside the target client and cross other windows, borders and titlebars with **motion only**. Plan consecutive moves ≤8 physical pixels apart and positive-distance moves ≥4 ms apart, measured from the observed cursor at time zero. A no-op first move at zero is valid. Plan enough duration for the full route plus button hold; duration cap remains 15,000 ms. Native validates all planned points against the observed virtual desktop before input and checks each traversed approach point against live desktop bounds. Target identity, geometry/DPI, visibility, held input, pointer deviation and original foreground remain guarded throughout. Only the original foreground and the target transition after the operation's own down are allowed; after observing target foreground, a transition back is rejected. Unexpected third foreground pauses. Immediately after the completed click's button-up verification, native observes foreground and terminates/reports, without waiting for unused `duration_ms` or emitting following motion/input. Completion includes `foreground_observed`; inserted click without observed foreground ends `failed/activation_not_observed` without retry. Delayed activation may therefore report failure despite an inserted click. Every following operation needs a fresh observation.

If release verification or the final observation fails, the activation result obligation survives pause even when no input frames remain. After a fresh checked continuation (with external effect resolution when required), native retries only the final foreground observation; no sent click or other input is replayed. Observing false ends `failed/activation_not_observed`; observing true permits completion. An explicit activation `finish` ends `cancelled` with reason `external_finish`, rather than asserting unchecked completion. Activation never reports `completed` with `foreground_observed:null`.

## Pause, resume and semantic outcomes

Pause and cancel replies are cleanup barriers. An already in-flight OS call can finish before acknowledgment. After confirmed `paused`, no ordinary input is emitted until a validated continuation; owned releases are finished. The same execution thread, session and OS input mutex remain owned during pause. Stop/EOF/3-second parent lease loss cancel while paused. Pause lifetime is capped at 300,000 ms and expiry cancels. At most 64 pause/resume revisions; the next pause cleans up and cancels with `pause_limit`, retaining revision 64 in every status/event rather than publishing an overflow revision.

Policy members are unsigned integers (including all pixel thresholds). Policy validation: stable 100–2,000 ms; small excursion from `threshold_px` through 200 px; large range strictly greater than small and ≤1,000 px; large path ≥large range and ≤3,000 px; sustained 200–2,000 ms; window ≥max(stable,sustained) and ≤3,000 ms; lifetime 1,000–300,000 ms. Only pointer anomalies can auto-resume, after small stable motion and safe revalidation with no uncertain effect or interrupted hold. Sustained classification needs at least three separated changed samples over the sustained interval, both range and path thresholds, and a bounded local history (≤256 samples). A single jump or three seconds without motion does not establish takeover. Sustained large motion emits `pointer_takeover` early; unresolved motion at window expiry stays manually paused. Explicit pause, focus/geometry/key failures, and unknown effects never auto-resume.

Exact manual resume envelope:

```json
{"id":20,"command":"resume","operation_id":"op-1","pause_revision":1,"snapshot_id":"s-100-9","external_checked":true,"resolution":{"type":"continue"}}
```

`pause_revision` is an unsigned integer matching current paused status. `external_checked:true` is mandatory. Snapshot must be captured **after the pause cleanup barrier**, ≤5,000 ms old, same HWND/process lifetime, and match original geometry, DPI and keyboard focus (restore changed geometry/focus first). Session rechecks live snapshot, foreground, held input and layout. `resuming` is live/nonterminal while validation executes; duplicates/stale revisions are rejected. Rejected continuation retains the paused owner and current revision. Known live guard refusals (`target_changed`, `foreground_changed`, `focus_changed`, `stale_snapshot`, `user_input_held`, `keyboard_state_changed`, `pointer_anomaly`) may be returned directly; Node requires a new matching paused/cleanup status receipt before allowing another explicit checked attempt. The underlying guard code remains in status error when rejection occurs on the execution thread. Unknown faults, transport ambiguity and cleanup failure remain fail-closed. Result is a status snapshot, possibly already paused again or terminal. On `resume_pending`, inspect status/events; do not replay.

A `stale_pause_revision` refusal can occur after Node reads a valid pause but
native sampling auto-resumes and pauses again before the resume request arrives.
Node may preserve retryability only after validating the same operation's full
clean paused status at a strictly newer revision within the 64-revision bound.
The caller must refresh status and explicitly provide that revision; other
guard refusals still require the requested revision, and unknown/unclean
receipts remain fail-closed.

Resolution is exactly one of:

```json
{"type":"continue"}
{"type":"observed","outcomes":[{"unit_id":"u4","outcome":"not_applied"}]}
{"type":"finish","outcomes":[{"unit_id":"u4","outcome":"applied"}]}
{"type":"remaining_gesture","gesture_id":"gesture-2","safe_anchor":{"x":320,"y":220},"outcomes":[{"unit_id":"u4","outcome":"applied"}]}
```

Outcome enum is `applied | not_applied | unknown`. Outcomes must cover every current `uncertain_unit_ids` exactly once, with no extra/duplicate units. `unknown` is always rejected. `continue` is allowed only when there is no uncertain effect and no interrupted held drag. `observed` resolves sent-effect uncertainty and skips its remaining partial unit; **even `not_applied` never permits replay of any sent primary key/button/wheel effect or Unicode half**. It can continue other definitely-unsent units. `finish` discards all remaining work and emits zero additional input; empty outcomes are required if no uncertainty exists. For activation, explicit finish reports `cancelled/external_finish` and does not claim foreground success.

Interrupted held drag must use finish or `remaining_gesture`. The latter requires a new unused gesture ID, exact fresh current cursor `safe_anchor` and externally checked outcome. Native derives the remaining route only from the retained unsent drag motion, creates a separately journaled new hold at that anchor, and retains original frames/releases. It accepts no caller replacement plan or replay of completed motion. Every synthetic gesture has its own semantic unit and journal `gesture_id`. Anchor ownership is rechecked before the new down.

For known remaining work, only unsent approach motion is rebased from current cursor using ≤8 px / 8 ms bridge samples. Before an unsent button-down, a bridge returns to its original intended anchor before the hold, not to a later drag destination. The final bridge sample always precedes retained frames at the same timestamp, including an original move/down tie. Bridge ≤1,000 ms per continuation and ≤10,000 ms cumulatively; larger paths reject while paused. Scheduling is rebased, unsent key/button hold durations are preserved, and remaining budget includes required bridge time. The existing 100 ms frame lateness and 250 ms scheduling allowance remain enforced. No automatic OS insertion retry or application-delivery inference occurs.

## Status and events

`status`, `pause`, successful `resume`, and non-idle `cancel` return this shape:

```json
{"operation_id":"op-1","state":"paused","elapsed_ms":120,"injected_events":2,"pause_revision":1,"pause_mode":"manual","trajectory":null,"resume_requirement":"resolve_uncertain_effects","remaining_budget_ms":80.0,"progress":{"source_units_total":1,"source_units_complete":0,"plan_events_inserted":1,"cleanup_events_inserted":1,"uncertain_unit_ids":["u0"],"remaining_frames":0,"journal":[{"frame_id":0,"unit_id":"u0","revision":0,"disposition":"uncertain","primary":true,"sent":true,"original_at_ms":0.0,"external_outcome":null,"gesture_id":null},{"frame_id":1,"unit_id":"u0","revision":0,"disposition":"satisfied_by_cleanup","primary":false,"sent":false,"original_at_ms":40.0,"external_outcome":null,"gesture_id":null}],"journal_frames_total":2,"journal_truncated":false,"external_outcomes":[]},"cleanup_confirmed":true,"foreground_observed":null,"reason":"keyboard_state_changed","error":{"code":"keyboard_state_changed","message":"Keyboard state changed"},"inputInjected":true,"deliveryVerified":false}
```

`pause_mode` is null outside pause, `sampling` during the bounded pointer observation, or `manual` when external continuation is required. `trajectory` is null before sampling or an object `{observed_ms,sample_count,range_px,path_px,motion_span_ms,stable_for_ms}`: elapsed observation (capped at window), retained sample count (≤256), maximum pairwise physical-pixel distance, sampled path length, span between first/last changed samples, and time since last motion. No raw coordinates are exported. It is also attached to event records and retained as diagnostic context after resume/termination.

States: `running | pausing | paused | resuming | cancelling | completed | cancelled | failed`. Last three are terminal. Reason/error fields are omitted when absent; other optional status values serialize `null`. Resume requirement is null or `fresh_external_observation | resolve_uncertain_effects | remaining_gesture_or_finish`. Elapsed is wall time including pauses; remaining budget is native execution schedule budget. Completed means executor finished, never application success. `deliveryVerified` is always false.

Source unit IDs are `u` plus zero-based event index. Synthetic drag holds append distinct indices; original IDs never change. Journal frame IDs are stable monotonic indices within the operation; revisions identify appended continuation frames. Dispositions: `unsent | inserted | satisfied_by_cleanup | superseded_motion | uncertain | externally_resolved`. `sent` is immutable evidence once true and is not erased by external resolution. `original_at_ms` preserves that frame's creation schedule. `external_outcome` retains the caller's exact disposition. `progress.external_outcomes` retains `{unit_id,outcome,pause_revision}` receipts even when journal display is truncated. Application outcomes remain caller assertions, never worker verification.

Full original frame journals remain retained while live (bounded at 60,000 with conservative reservation for continuations); status exposes the latest 256 with total/truncation flags. A terminal record retains this bounded diagnostic tail and resolution receipts. History retains 32 terminal records and never evicts a live paused owner. Plan insertion counts and cleanup insertion counts are independent. A cleanup-satisfied release is never resent. Unproven cleanup blocks further input; Drop does not retry uncertain releases.

Events result:

```json
{"records":[{"seq":1,"operation_id":"op-1","event":"paused","state":"paused","pause_revision":1,"pause_mode":"manual","trajectory":null,"reason":"explicit_pause","elapsed_ms":120,"progress":{"source_units_total":1,"source_units_complete":0,"plan_events_inserted":1,"cleanup_events_inserted":1,"uncertain_units_count":1,"remaining_frames":0,"journal_frames_total":2}}],"next_seq":1,"oldest_seq":1,"overflow":false}
```

Records have exactly the displayed fields; `reason` may be null. Sequence is monotonically increasing per worker, retained ring size 256, query returns ≤limit records with seq >after_seq. `next_seq` is last returned sequence or unchanged cursor if empty. `overflow` means requested history was evicted; `oldest_seq` gives the oldest available sequence. Event names: `started, anomaly, paused, pointer_takeover, external_observation_required, auto_resumed, resumed, resume_rejected, terminal`. Detection/pausing happens on the native thread without waiting for Node polling; Node should poll active operations every 100 ms. No `ack_event` command exists in v2.

Every record's `progress` is captured when native creates that event and remains unchanged after resume, termination or operation-history eviction. It has exactly the seven displayed nonnegative integer fields: source unit total/completed counts, plan/cleanup insertion counts, uncertain unit count, remaining frame count and total journal frame count. No journal entries, uncertainty ID list or external-outcome receipts are embedded in events; use status for those bounded diagnostics. An `anomaly` record precedes cleanup and uncertainty classification; `paused` captures the completed cleanup barrier and revised uncertainty. Completion counts are maintained incrementally during scheduling; updates inspect at most the 256-entry diagnostic tail, independent of the total pending journal.

## Failure and platform limits

Common request/admission codes: `invalid_request, invalid_plan, unknown_snapshot, stale_snapshot, target_not_ready, input_busy, input_poisoned, operation_id_reused, unknown_operation, invalid_hwnd, parent_lease_lost, request_overflow, line_too_long`. Continuation errors: `stale_pause_revision, resume_rejected, resume_pending, resume_limit, unsafe_route`. Barrier timeouts: `pause_timeout, cancellation_timeout`. OS guard/preparation errors remain structured `Fault` values; callers must handle unknown codes conservatively.

Windows inspection and SendInput are not atomic. Physical provenance of a simultaneous press on an already tracked owned key cannot be proved without hooks; sampling cannot guarantee detecting every rapid toggle or external motion. Alt/Win/window switching, clipboard content access, hooks, capture, networking, drivers, focus APIs and target window resizing/moving are absent. Tests use fake platform input and readonly IPC only; real application delivery is intentionally not certified by these tests.

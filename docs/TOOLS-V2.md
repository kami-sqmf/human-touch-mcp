# Human Input MCP tools — product 0.2.0 / native protocol 2

The server exposes 30 tools. Every argument object, including nested objects,
rejects unknown properties. `lib/tools.mjs` exports the authoritative JSON
schemas used both in MCP discovery and at execution. Empty arguments mean `{}`.
Each new process starts with human mode **off**, no resumable operation, and no
automatic replay. `human_mode {enabled:true}` explicitly enables input.

All coordinates are physical screen pixels. `hwnd` is a positive decimal string
of at most 20 digits. Operation/event IDs are opaque strings. The worker also
enforces UTF-8 ID limits, geometry, identity, focus, held input, scheduling and
exclusive input ownership. The caller supplies fresh external page observations;
this service does not capture pixels or detect calls to other input tools.

## Input arguments and receipts

Every input tool requires `hwnd`. Optional common controls are
`threshold_px` (integer 1–100, default 8) and `pause_policy` (below).
Pointer destinations `x,y` are numbers from -100000 through 100000 and must
land inside the fresh observed target client. Every point of a move, click,
drag or reading path also stays inside that client, so the current cursor must
already be inside it; otherwise the call fails before admission with
`cursor_outside_client`. Only `human_activate` may approach from outside the
client. Pointer tools optionally accept
`duration_ms` (100–15000), `jitter_px` (0–5), and `overshoot_px` (0–30).

| Tool | Required arguments beyond hwnd | Optional arguments / behavior |
| --- | --- | --- |
| `human_mouse_move` | `x,y` | Pointer controls; one movement |
| `human_mouse_click` | `x,y` | Pointer controls; one left click after approach |
| `human_mouse_drag` | `x,y` | Pointer controls; one held gesture starting at the current cursor |
| `human_type` | `text` | `wpm` 15–180 (default 41), `typo_rate` 0–0.3 (**default 0**), integer `seed` 0–2147483647, `force_ime_off` boolean (default false) |
| `human_scroll` | `delta` | Nonzero integer multiple of 120, absolute total ≤1200 Windows wheel units; `axis` vertical (default) or horizontal; one scroll operation |
| `human_key` | `key` | Optional `modifiers` array: ctrl/shift, no duplicates; allowlist below; one chord |
| `human_copy` | — | One explicit Ctrl+C; no clipboard content access |
| `human_cut` | — | One explicit Ctrl+X; may alter application content |
| `human_paste` | — | One explicit Ctrl+V; may alter application content |
| `human_activate` | `x,y,safe_area,safe_area_confirmed:true` | Distinct guarded safe click; pointer controls accepted; no focus API |
| `reading_start` | `segments` | `replace` boolean (default false); pure movement only; returns promptly |

Typing accepts printable text only, without newline, tab or Unicode line/paragraph
separators. Public text length is 1–2000 UTF-16 units; the planner additionally
caps 1000 codepoints and 45 seconds including key holds. Unsupported speed/hold
budgets fail before admission. Default typing preserves the exact requested
text without deliberate mistakes. Explicit ASCII mistakes are corrected; Unicode
typing does not invent corrections. Typing never implicitly pastes or presses Enter.

`human_key` uses these exact spellings; modifier order does not matter:

| Modifiers | Keys |
| --- | --- |
| None | enter, tab, escape, backspace, delete, insert, left, right, up, down, home, end, page_up, page_down |
| ctrl | a, z, y, f, enter, backspace, delete, left, right, up, down, home, end, page_up, page_down |
| shift or ctrl+shift | left, right, up, down, home, end, page_up, page_down |

Alt/Win, generic Ctrl+C/X/V, Shift+Delete/Insert, arbitrary printable keys,
scan/VK codes, sequences and hidden clipboard operations are rejected. Enter and
Ctrl+Enter may submit content and must be explicitly requested.

Navigation and editing names use the dedicated enhanced-keyboard cluster,
including the E0 scan prefix, rather than NumLock-sensitive keypad aliases.
The worker validates each mapped scan and its layout reverse mapping; unsupported
dedicated mappings fail before injection. Enter and Backspace retain their
ordinary keyboard mappings.

`safe_area` is `{x,y,width,height}` with signed 32-bit integer origins and positive
integer sizes. Its complete rectangle and the click must be inside the fresh
client. `safe_area_confirmed:true` asserts external verification that the area
does not edit, navigate, submit or activate content. Only this tool admits an
otherwise ready nonforeground window. Its motion-only approach can cross other
windows within the virtual desktop, in ≤8 pixel steps separated by ≥4 ms.
Native verifies hit ownership before down/up, and checks foreground after the
click. Following input always observes again. No click is retried to acquire focus.

Each reading segment is exactly
`{region_id,rect:{x,y,width,height},purpose,direction,duration_ms}`. IDs have length
1–128; purpose 1–2000. Direction is `top_to_bottom` or `left_to_right`.
There are 1–128 ordered segments, each budget 100–60000 ms, with total reading
duration ≤60000 ms and all regions inside the client. No buttons, wheel, keys or
clipboard events occur in reading.

Synchronous input waits for executor completion or a manual pause. During native
pointer sampling it waits through the bounded observation window. A manually
paused receipt returns promptly and preserves the operation and native lease;
it does not consume the normal input admission slot. While any work is paused,
all fresh input, including `reading_start {replace:true}`, is rejected until
explicit resume or stop. Running reading can be superseded only through a
confirmed cancellation barrier; another reading requires `replace:true`.
Other normal input is rejected while busy rather than queued.

A pause can race with replacement after the first running-status snapshot. Node
compares the cancellation barrier's pause revision, local explicit-pause
generation, and newly observed safety events (including an anomaly before its
revision advances). It drains native events after the barrier without overlapping
polls. New safety evidence or evicted/unknown event history blocks replacement
and latches further input until explicit `human_resume {}` or `human_stop`.
Mode/target changes and readonly receipts cannot clear this latch.

The old pure-movement reading is already **cancelled** in this narrow race; it is
not a resumable paused owner. `human_status` exposes `interrupted_operation` with
the complete cancelled receipt/progress, a `pause_discovered_during_replacement`
reason, available native safety-event reason, `old_operation_resumable:false`, and
`requires_reobservation_and_replan:true`. Idle resume clears only admission and
returns that context without native input; the caller must observe again and
replan any remaining reading. Native cancellation cannot be undone.

Receipts use native `operation_id,state,pause_revision,pause_mode`, progress and
cleanup evidence. States are running, pausing, paused, resuming, cancelling,
completed, cancelled or failed. **Completed means the executor finished**;
`deliveryVerified:false` never asserts receiver/application success. Already
inserted OS input cannot be undone. A failed cleanup barrier permanently blocks
further admission in this server process.
Native start receipts use only the exact operation ID/running-state pair; idle
cancel uses only `{state:"idle"}`. All other operation replies require the full
documented status and bounded progress/journal schema, and operation IDs must
match their requests. Paused/terminal service barriers require
`cleanup_confirmed:true`. A minimal idle-cancel reply does not prove cleanup for
a known admitted owner. Missing, mismatched or unproven evidence poisons admission,
including when a worker is supplied directly to the service.

A validated, request-matched native `ok:false` start rejection can prove that no
new owner was admitted. The retryable allowlist is input_busy, invalid_request,
invalid_plan, unknown_snapshot, stale_snapshot, target_not_ready,
operation_id_reused and request_overflow. The transport carries explicit command
and operation-bound rejection provenance; error code/message alone is not proof.
For such a rejected start, an exact idle-cancel receipt confirms absence, clears
the unadmitted local record, and leaves input retryable after a fresh observation.
Pending, accepted, rejected and ambiguous start outcomes remain distinct. An
accepted owner still needs a full matching terminal cleanup receipt; malformed
responses, transport loss, wrong/missing provenance, unknown rejection codes,
input_poisoned and lease loss remain fail-closed. Nothing automatically retries
the caller's input.

Known native continuation refusals (`target_changed`, `foreground_changed`,
`focus_changed`, `stale_snapshot`, `user_input_held`, `keyboard_state_changed`, `pointer_anomaly`,
`stale_pause_revision`, `resume_rejected`, `resume_limit`, `unsafe_route`) permit
another explicit checked attempt only after Node re-confirms the matching
operation's full paused status, matching pause revision and confirmed cleanup.
For a matched native `stale_pause_revision` refusal only, a strictly newer
current revision (still at most 64) also proves a clean pause: native sampling
may have auto-resumed and paused again during Node's observation. The caller
must query current status and explicitly retry with its new revision. The old
revision remains rejected; no automatic resume or revision substitution occurs.
Other refusal codes and backward revisions do not receive this exception.
A concurrent stop, mode or target change supersedes that attempt; a matching
terminal cleanup receipt can prove the cancellation instead. Unknown faults,
transport errors, mismatched receipts and unproven cleanup remain poisoned.
`resume_pending` requires status inspection, never automatic resend.

## Configurable pointer pause policy

`pause_policy` is a strict optional object. Omitted members use native defaults.
These detection thresholds are configurable engineering defaults, not calibrated
proof of physical-user identity.

| Member | Default | Accepted bounds |
| --- | --- | --- |
| `stable_ms` | 350 | integer 100–2000 |
| `small_excursion_px` | 80 | integer ≥threshold_px and ≤200 |
| `large_range_px` | 180 | integer >small_excursion_px and ≤1000 |
| `large_path_px` | 240 | integer ≥large_range_px and ≤3000 |
| `sustained_ms` | 500 | integer 200–2000 |
| `window_ms` | 3000 | integer ≥max(stable_ms,sustained_ms), ≤3000 |
| `lifetime_ms` | 300000 | integer 1000–300000 |

The worker alone performs sampling and checked automatic continuation after a
small stable pointer anomaly. Explicit pause, unknown effects and focus/geometry/
keyboard failures require external observation. Node never auto-confirms effects.

## Mode, observation and operation control

| Tool | Exact arguments | Result / effect |
| --- | --- | --- |
| `human_capabilities` | `{}` | Protocol/version, current mode and truthful limits; `safe_activate:true`, `agent_push_supported:false`, clipboard shortcuts supported but content access false |
| `human_mode` | `{enabled?:boolean}` | Empty query is readonly; mode change cancels current work with a barrier |
| `human_observe` | `{hwnd}` | Native identity, geometry/DPI, foreground/focus and cursor; no cancellation/input |
| `human_target_update` | `{hwnd}` | Cancels current work, invalidates timer anchors conservatively, observes/replaces target |
| `human_stop` | `{reason?:string}` | Reason length 1–512; cancels current/pending input through a barrier; clears idle pause |
| `human_pause` | `{operation_id?:string}` | Current operation only; waits for native pause cleanup; when idle latches Node admission without native work |
| `human_resume` | See below | Explicit continuation; idle resume clears latch without any native command or input |
| `human_status` | `{operation_id?:string}` | Native current/retained status, idle latch and bounded pending events; no input/cancellation |
| `reading_status` | `{operation_id?:string}` | Current or retained reading status; omitted ID selects active reading |
| `reading_cancel` | `{operation_id?:string,reason?:string}` | Reading cancellation barrier |
| `human_input_plan` | Strict variant `{kind,...}` | Preview only; never injects or cancels |

Plan preview kinds are move, click, drag, typing and reading. They accept the same
kind-specific fields listed above. Typing preview needs text without hwnd;
pointer/reading previews require hwnd and observe client bounds. Fields irrelevant
to the kind are rejected. Previews do not enable mode or authorize later input.

An idle resume is exactly `{}`. An operation resume requires all of:

```json
{"operation_id":"opaque-id","pause_revision":1,"external_checked":true,"resolution":{"type":"continue"}}
```

The revision is an integer 1–64. Node first fetches current native paused status
with confirmed cleanup, then observes the original HWND again, and passes that
new snapshot to native. Native checks freshness, process lifetime, original
geometry/DPI/focus, held input and continuation semantics. Stop/mode/target
generations are checked before and after acceptance. A stop/mode/target barrier
waits for pending acceptance and cancels again if needed; superseded work cannot
resume after that barrier. No worker restart replays work.

`resolution` is exactly one variant:

* `{type:"continue"}` — no uncertainty or interrupted held drag.
* `{type:"observed",outcomes:[{unit_id,outcome}]}` — exact externally checked
  uncertain units; outcome is applied or not_applied. No sent effect is replayed.
* `{type:"finish",outcomes:[{unit_id,outcome}]}` — discard remaining work with no
  additional input; use an empty array when no uncertainty exists. Explicit
  activation finish reports cancelled/external_finish, without claiming activation.
* `{type:"remaining_gesture",gesture_id,safe_anchor:{x,y},outcomes:[...]}` — new
  unused gesture ID, exact freshly observed integer cursor anchor, and complete
  outcomes; native derives only retained unsent drag motion, without caller plans.

Unknown outcomes, duplicate/missing/extra units, stale revisions and unsupported
continuations are rejected and remain paused. `resume_pending` means inspect
status/events rather than replay the resume. A resume receipt may already be
paused again, resuming, or terminal. See [the native contract](NATIVE-PROTOCOL-V2.md)
for semantic journals and continuation bounds.

## Event discovery and caller acknowledgments

`human_events` takes
`{after_seq?:integer>=0,limit?:integer(1..128),pending_only?:boolean}`. Defaults
are 0, 128 and false. It returns retained events, session epoch, next/oldest
sequence, eviction/overflow counters and `agent_push_supported:false`.
Active/paused work is polled every 100 ms without overlapping native event
requests; explicit queries share a poll. Querying retained history also drains
native events after terminal status. Native uses query responses, never
unsolicited stdout. Malformed safety events poison admission and attempt a
cancellation barrier.

Node retains at most 128 records and 256 KiB of serialized records, evicting oldest
first. Native history overflow is separately reported. IDs and receipt tokens are
session-bound, native sequences are deduplicated, and progress is copied as the
native immutable seven-counter snapshot. Node adds discovery timestamps and
delivery/acknowledgment timestamps. Eviction does not clear the current native
pause or its reason/revision; fetch status for the current owner.

`human_event_ack` requires exactly
`{event_id,session_epoch,pause_generation,receipt_token}` from a retained event.
Wrong tokens/sessions/generations, unknown or evicted events fail. Duplicate valid
ACKs return the original acknowledgment timestamp. ACK changes event bookkeeping
only and **never resumes input**. `acknowledgment_scope:"mcp_caller_receipt"`
records an observed MCP request, without authenticating model/human identity.

Delivery states are pending, transport_written, transport_failed and acknowledged.
The independent `pending` boolean remains true after transport write/failure until
ACK. Attempt/error/write timestamps remain available after ACK.

Default operation sends no unsolicited diagnostic logs. Optional
`HUMAN_INPUT_DIAGNOSTIC_NOTIFICATIONS=1` declares logging capability and enables
one best-effort diagnostic attempt per new event, only when negotiated MCP
2025-11-25. It observes actual transport.send completion, detects SDK filtering
without recording a write, limits sends to 1000 ms, and never retries. Diagnostic
failure/disconnect has no resume effect. No helper resolution, stdout drain, UI
log, harness ACK or client name changes `agent_push_supported:false`. The exact
production-client context-delivery path has not been certified.

## External-observation timers

| Tool | Exact arguments |
| --- | --- |
| `timer_attach` | `{target_id,section_id,timer_id?:string}` |
| `timer_prepare` | `{timer_id}` |
| `timer_calibrate` | `{timer_id,ticket_id,observed_seconds:integer(0..31536000),state?:"running"|"paused_observed"|"expired_observed"}` |
| `timer_status` | `{timer_id}` |
| `timer_invalidate` | `{timer_id,reason?:string}` |
| `timer_detach` | `{timer_id}` |

Calibration state defaults to running; expired_observed requires zero. Target and
section IDs have length 1–128. Timers preserve observed values separately from
uncertain monotonic-clock estimates. Pause/resume events invalidate affected
anchors and pending observation tickets; unknown target bindings invalidate all.
Target replacement invalidates conservatively. Old observed values remain
available after invalidation; fresh calibration is required for an estimate.
Queries never request pixels, cancel reading or inject input. Normal staleness is
60 seconds, or 10 seconds in the estimated final 30 seconds; estimated expiry
never triggers input.

# Windows input worker v2

Build from this directory using Rust 1.94 or later:

```powershell
cargo test --locked
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo build --locked --release
node --test tests/ipc-readonly.mjs
```

The executable is `target/release/human-input-worker.exe`. Protocol 2 / version 0.2.0 is specified in [NATIVE-PROTOCOL-V2.md](../docs/NATIVE-PROTOCOL-V2.md). JSON uses bounded newline framing and request/response envelopes; events are queried, never written unsolicited. The readonly IPC test observes HWND 0 and references nonexistent snapshots, so no input can execute.

The stdin reader, dispatcher and single operation thread are independent. The reader renews the three-second parent lease and immediately signals pause/cancel. The execution thread retains `Local\HumanInputMCP.Input.v1` across pauses; confirmed pause releases only owned input, and confirmed cancellation releases the mutex. One operation is live, including while paused; new input never queues. EOF, explicit stop and lease loss cancel.

Supported operations are move, click, drag, typing, reading, wheel scroll, allowlisted named key/chord, dedicated copy/cut/paste, and explicit safe-area activation. Clipboard contents never enter worker memory. Activation uses one guarded SendInput click and permits only its resulting foreground transition; it never calls focus APIs. Smooth motion may approach across other windows, while the final click must be an unoccluded target-client safe point. Observe includes physical client and virtual-desktop rectangles.

Semantic journals preserve source-unit/frame IDs, immutable sent evidence, cleanup-satisfied releases and caller-supplied outcome dispositions. Resume requires a fresh post-pause observation and exact revision. Unknown or already-sent effects never replay, even if a caller reports not_applied. Partial Unicode is skipped only after explicit outcome resolution. Interrupted held drag requires a separately identified remaining gesture and fresh safe anchor, or finish/stop. Status reports execution completion, not application success; `deliveryVerified` is always false.

Pointer anomalies release owned input immediately. Bounded local sampling uses default 8 px deviation, 350 ms stability, 80 px small excursion, and a large-motion threshold requiring 180 px range, 240 px path and at least three separated changed samples over 500 ms within at most 3 seconds. Small stable interruptions can auto-resume only if all remaining work is known and guards pass. Manual pause, geometry/focus/key failures and uncertain effects require checked continuation. Status and events distinguish sampling/manual pause and include a bounded trajectory summary. Pause lifetime is at most 300 seconds and there are at most 64 continuation revisions.

Plans and compilation are bounded before input. Resumption uses smooth bounded bridges for unsent motion, preserves real hold durations and retains the 100 ms lateness / 250 ms scheduling allowance. OS calls and cleanup cannot be preempted; timeouts retain/poison admission rather than falsely acknowledging cleanup. There are no retries of failed insertion, capture, hooks, networking, drivers or application imports.

Keyboard guard sampling includes ordinary virtual keys, side-specific modifiers and mouse buttons, excluding tracked owned input. Unicode ownership uses VK_PACKET; no-hook sampling cannot prove provenance of an external simultaneous press/packet on an already owned input. Caps Lock is never toggled. GetKeyState has queued-state limitations; rapid toggles may escape sampling. Explicit typing-only force_ime_off is restored on suspension/termination only for the same target process lifetime. Named keys and clipboard chords preserve IME state. Application behavior and delivery require external observation.
//! Fake OS boundary only: runtime thread, deadlines, journal and barriers are real.
use super::*;
use crate::protocol::{EffectOutcome, Event, Outcome};
use std::sync::atomic::AtomicUsize;

struct Control {
    held: AtomicBool,
    sent: AtomicUsize,
    releases: AtomicUsize,
    foreground: AtomicBool,
    observation_fault_after: Mutex<Option<usize>>,
    fault: Mutex<Option<(usize, bool, &'static str)>>,
    cursor: Mutex<Point>,
    log: Mutex<Vec<(Action, Instant)>>,
}
struct TestPlatform {
    control: Arc<Control>,
    frames: Vec<Frame>,
}
struct TestSession {
    control: Arc<Control>,
    keys: Vec<Key>,
    button: bool,
    cleaned: bool,
}
fn snapshot(point: Point) -> Snapshot {
    Snapshot {
        snapshot_id: String::new(),
        target_id: "t".into(),
        hwnd: "1".into(),
        identity: "1:10".into(),
        rect: Rect {
            x: 0,
            y: 0,
            width: 1000,
            height: 1000,
        },
        client: Rect {
            x: 0,
            y: 0,
            width: 1000,
            height: 1000,
        },
        virtual_desktop: Rect {
            x: -1000,
            y: -1000,
            width: 4000,
            height: 4000,
        },
        cursor: point,
        foreground: "1".into(),
        focus: "2".into(),
        dpi: 96,
        ready: true,
        visible: true,
        enabled: true,
        minimized: false,
        is_foreground: true,
        observed_at: String::new(),
        captured: None,
    }
}
impl Platform for TestPlatform {
    fn observe(&self, _: &str) -> Result<Snapshot> {
        let mut fault = lock(&self.control.observation_fault_after);
        if fault.is_some_and(|n| self.control.sent.load(Ordering::SeqCst) >= n) {
            fault.take();
            return Err(Fault::new(
                "observation_unavailable",
                "Scripted observation failure",
            ));
        }
        let mut s = snapshot(*lock(&self.control.cursor));
        s.is_foreground = self.control.foreground.load(Ordering::SeqCst);
        Ok(s)
    }
    fn begin(&self, _: &Snapshot, _: &Start) -> Result<Execution> {
        assert!(!self.control.held.swap(true, Ordering::SeqCst));
        Ok(Execution {
            frames: self.frames.clone(),
            session: Box::new(TestSession {
                control: Arc::clone(&self.control),
                keys: Vec::new(),
                button: false,
                cleaned: false,
            }),
        })
    }
}
impl TestSession {
    fn check(&mut self, post: bool) -> Result<()> {
        let mut f = lock(&self.control.fault);
        if let Some((n, is_post, code)) = *f
            && is_post == post
            && self.control.sent.load(Ordering::SeqCst) >= n
        {
            f.take();
            return Err(Fault::new(code, "Scripted OS boundary failure"));
        }
        Ok(())
    }
}
impl Session for TestSession {
    fn initialize(&mut self) -> Result<()> {
        self.cleaned = false;
        Ok(())
    }
    fn guard(&mut self, _: Option<Action>) -> Result<()> {
        self.check(false)
    }
    fn verify(&mut self, _: Action) -> Result<()> {
        self.check(true)
    }
    fn inject(&mut self, action: Action) -> Result<usize> {
        match action {
            Action::KeyDown(k) => self.keys.push(k),
            Action::KeyUp(k) => self.keys.retain(|x| *x != k),
            Action::ButtonDown => self.button = true,
            Action::ButtonUp => self.button = false,
            Action::Move(p) => *lock(&self.control.cursor) = p,
            Action::Wheel { .. } => {}
        }
        lock(&self.control.log).push((action, Instant::now()));
        self.control.sent.fetch_add(1, Ordering::SeqCst);
        Ok(1)
    }
    fn cleanup(&mut self) -> Cleanup {
        if self.cleaned {
            return Cleanup {
                injected_events: 0,
                error: None,
            };
        }
        self.cleaned = true;
        let count = self.keys.len() + usize::from(self.button);
        self.keys.clear();
        self.button = false;
        self.control.releases.fetch_add(count, Ordering::SeqCst);
        Cleanup {
            injected_events: count,
            error: None,
        }
    }
}
impl Drop for TestSession {
    fn drop(&mut self) {
        self.control.held.store(false, Ordering::SeqCst);
    }
}
fn setup(
    frames: Vec<Frame>,
    fault: Option<(usize, bool, &'static str)>,
) -> (Arc<Runtime>, Arc<Control>) {
    let control = Arc::new(Control {
        held: AtomicBool::new(false),
        sent: AtomicUsize::new(0),
        releases: AtomicUsize::new(0),
        foreground: AtomicBool::new(true),
        observation_fault_after: Mutex::new(None),
        fault: Mutex::new(fault),
        cursor: Mutex::new(Point { x: 10, y: 10 }),
        log: Mutex::new(Vec::new()),
    });
    (
        Runtime::new(Arc::new(TestPlatform {
            control: Arc::clone(&control),
            frames,
        })),
        control,
    )
}
fn f(unit_id: usize, at_ms: f64, action: Action, primary: bool) -> Frame {
    Frame {
        unit_id,
        at_ms,
        action,
        primary,
    }
}
fn start(runtime: &Arc<Runtime>, kind: Kind, events: Vec<Event>, duration: f64) -> String {
    let s = runtime.observe("1").unwrap();
    runtime
        .start(Start {
            operation_id: "op".into(),
            snapshot_id: s.snapshot_id,
            kind,
            duration_ms: duration,
            events,
            threshold_px: 8,
            force_ime_off: false,
            safe_area: None,
            safe_area_confirmed: false,
            pause_policy: Default::default(),
        })
        .unwrap();
    "op".into()
}
fn boundary(runtime: &Runtime, state: &str) -> Status {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let s = runtime.status("op").unwrap();
        if s.state == state {
            return s;
        }
        assert!(
            Instant::now() < deadline,
            "Expected {state}; got {}",
            s.state
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn resume(runtime: &Runtime, revision: u64, resolution: Resolution) -> Result<Value> {
    let s = runtime.observe("1")?;
    runtime.resume(Resume {
        operation_id: "op".into(),
        pause_revision: revision,
        snapshot_id: s.snapshot_id,
        external_checked: true,
        resolution,
    })
}

fn check_node_contract(wire: Value) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let node = std::env::var_os("HUMAN_TEST_NODE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("work/prerequisites/node-v24.22.1-win-x64/node.exe"));
    let mut child = Command::new(node)
        .arg(root.join("tests/helpers/native-contract-check.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(wire.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node contract: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn clean_resume_guard_rejections_are_retryable_through_node_contract() {
    for code in [
        "target_changed",
        "foreground_changed",
        "focus_changed",
        "stale_snapshot",
        "user_input_held",
        "keyboard_state_changed",
        "pointer_anomaly",
    ] {
        let (runtime, control) = setup(
            vec![f(0, 5000.0, Action::Move(Point { x: 10, y: 10 }), false)],
            Some((0, false, "explicit_pause")),
        );
        start(
            &runtime,
            Kind::Reading,
            vec![Event::Move {
                x: 10.0,
                y: 10.0,
                at_ms: 5000.0,
            }],
            6000.0,
        );
        let paused = boundary(&runtime, "paused");
        *lock(&control.fault) = Some((0, false, code));
        let error = resume(&runtime, paused.pause_revision, Resolution::Continue).unwrap_err();
        let rejected = runtime.status("op").unwrap();
        assert_eq!(error.code, code);
        assert_eq!(rejected.state, "paused");
        assert!(rejected.cleanup_confirmed && control.held.load(Ordering::SeqCst));
        assert_eq!(rejected.pause_revision, paused.pause_revision);
        resume(
            &runtime,
            paused.pause_revision,
            Resolution::Finish { outcomes: vec![] },
        )
        .unwrap();
        let finished = boundary(&runtime, "completed");
        assert_eq!(control.sent.load(Ordering::SeqCst), 0);
        check_node_contract(
            json!({"kind":"resume", "paused":paused, "rejected":rejected, "error":error, "finished":finished}),
        );
    }
}

#[test]
fn stale_resume_after_automatic_continuation_accepts_only_refreshed_node_retry() {
    let (runtime, control) = setup(
        vec![f(0, 5000.0, Action::Move(Point { x: 10, y: 10 }), false)],
        Some((0, false, "pointer_anomaly")),
    );
    start(
        &runtime,
        Kind::Reading,
        vec![Event::Move {
            x: 10.0,
            y: 10.0,
            at_ms: 5000.0,
        }],
        6000.0,
    );
    let paused = boundary(&runtime, "paused");
    assert_eq!(paused.pause_mode.as_deref(), Some("sampling"));
    assert_eq!(paused.pause_revision, 1);
    // The public service can read revision 1 and observe while native sampling
    // independently auto-resumes, before its manual resume reaches native.
    let observed = runtime.observe("1").unwrap();
    boundary(&runtime, "running");
    *lock(&control.fault) = Some((0, false, "explicit_pause"));
    let rejected = boundary(&runtime, "paused");
    assert_eq!(rejected.pause_revision, 2);
    assert!(rejected.cleanup_confirmed && control.held.load(Ordering::SeqCst));
    let events = runtime.events(0, 128).unwrap();
    assert!(
        events["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event"] == "auto_resumed")
    );
    let error = runtime
        .resume(Resume {
            operation_id: "op".into(),
            pause_revision: paused.pause_revision,
            snapshot_id: observed.snapshot_id,
            external_checked: true,
            resolution: Resolution::Continue,
        })
        .unwrap_err();
    assert_eq!(error.code, "stale_pause_revision");
    assert_eq!(runtime.status("op").unwrap().pause_revision, 2);
    resume(&runtime, 2, Resolution::Finish { outcomes: vec![] }).unwrap();
    let finished = boundary(&runtime, "completed");
    assert_eq!(control.sent.load(Ordering::SeqCst), 0);
    check_node_contract(
        json!({"kind":"stale_resume", "paused":paused, "rejected":rejected, "error":error, "finished":finished}),
    );
}

#[test]
fn pause_exhaustion_stays_within_node_event_and_status_revision_bound() {
    let (runtime, control) = setup(
        vec![f(0, 50000.0, Action::Move(Point { x: 10, y: 10 }), false)],
        Some((0, false, "explicit_pause")),
    );
    start(
        &runtime,
        Kind::Reading,
        vec![Event::Move {
            x: 10.0,
            y: 10.0,
            at_ms: 50000.0,
        }],
        60000.0,
    );
    let mut pages = vec![];
    let mut after = 0;
    for revision in 1..=64 {
        let paused = boundary(&runtime, "paused");
        assert_eq!(paused.pause_revision, revision);
        let page = runtime.events(after, 128).unwrap();
        after = page["next_seq"].as_u64().unwrap();
        pages.push(page);
        runtime.renew();
        resume(&runtime, revision, Resolution::Continue).unwrap();
        *lock(&control.fault) = Some((0, false, "explicit_pause"));
    }
    let status = boundary(&runtime, "cancelled");
    // Wait for the final event, which is published immediately after terminal status.
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let page = runtime.events(after, 128).unwrap();
        if page["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event"] == "terminal")
        {
            pages.push(page);
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(control.sent.load(Ordering::SeqCst), 0);
    assert_eq!(control.releases.load(Ordering::SeqCst), 0);
    assert!(!control.held.load(Ordering::SeqCst));
    check_node_contract(json!({"kind":"exhaustion", "status":status, "pages":pages}));
}

#[test]
fn manual_pause_retains_owner_blocks_input_and_requires_current_revision() {
    let (runtime, control) = setup(
        vec![f(0, 200.0, Action::Move(Point { x: 12, y: 10 }), false)],
        None,
    );
    start(
        &runtime,
        Kind::Reading,
        vec![Event::Move {
            x: 12.0,
            y: 10.0,
            at_ms: 200.0,
        }],
        300.0,
    );
    while !control.held.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }
    let paused = runtime.pause("op", "manual_pause").unwrap();
    assert_eq!(paused["state"], "paused");
    assert!(control.held.load(Ordering::SeqCst));
    assert_eq!(control.sent.load(Ordering::SeqCst), 0);
    assert_eq!(
        resume(&runtime, 0, Resolution::Continue).unwrap_err().code,
        "stale_pause_revision"
    );
    assert_eq!(runtime.status("op").unwrap().state, "paused");
    resume(&runtime, 1, Resolution::Continue).unwrap();
    boundary(&runtime, "completed");
    assert_eq!(control.sent.load(Ordering::SeqCst), 1);
    assert!(!control.held.load(Ordering::SeqCst));
}
#[test]
fn paused_stop_eof_and_lease_loss_cancel_without_new_input() {
    for reason in ["stop", "eof", "lease"] {
        let (runtime, control) = setup(
            vec![f(0, 200.0, Action::Move(Point { x: 10, y: 10 }), false)],
            None,
        );
        start(
            &runtime,
            Kind::Reading,
            vec![Event::Move {
                x: 10.0,
                y: 10.0,
                at_ms: 200.0,
            }],
            300.0,
        );
        while !control.held.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        runtime.pause("op", "explicit_pause").unwrap();
        match reason {
            "stop" => {
                runtime.cancel(Some("op"), "stop").unwrap();
            }
            "eof" => runtime.eof(),
            _ => *lock(&runtime.last_request) = Instant::now() - Duration::from_secs(4),
        }
        let s = boundary(&runtime, "cancelled");
        assert_eq!(
            s.reason.as_deref(),
            Some(match reason {
                "stop" => "stop",
                "eof" => "stdin_eof",
                _ => "parent_lease_lost",
            })
        );
        assert_eq!(control.sent.load(Ordering::SeqCst), 0);
        assert!(!control.held.load(Ordering::SeqCst));
    }
}
#[test]
fn pointer_transient_auto_resumes_without_polling_and_emits_sequenced_events() {
    let (runtime, control) = setup(
        vec![
            f(0, 0.0, Action::Move(Point { x: 20, y: 10 }), false),
            f(1, 100.0, Action::Move(Point { x: 24, y: 10 }), false),
        ],
        Some((1, true, "pointer_anomaly")),
    );
    start(
        &runtime,
        Kind::Move,
        vec![
            Event::Move {
                x: 20.0,
                y: 10.0,
                at_ms: 0.0,
            },
            Event::Move {
                x: 24.0,
                y: 10.0,
                at_ms: 100.0,
            },
        ],
        180.0,
    );
    std::thread::sleep(Duration::from_millis(650));
    assert_eq!(runtime.status("op").unwrap().state, "completed");
    assert_eq!(control.sent.load(Ordering::SeqCst), 2);
    let records = runtime.events(0, 128).unwrap()["records"]
        .as_array()
        .unwrap()
        .clone();
    assert!(records.iter().any(|v| v["event"] == "auto_resumed"));
    let anomaly = records.iter().find(|v| v["event"] == "anomaly").unwrap();
    assert_eq!(
        anomaly["progress"],
        json!({
            "source_units_total":2,"source_units_complete":1,
            "plan_events_inserted":1,"cleanup_events_inserted":0,
            "uncertain_units_count":0,"remaining_frames":1,"journal_frames_total":2
        })
    );
    let terminal = records.iter().find(|v| v["event"] == "terminal").unwrap();
    assert_eq!(terminal["progress"]["source_units_complete"], 2);
    assert!(
        records
            .iter()
            .any(|v| v["event"] == "paused" && v["pause_mode"] == "sampling")
    );
    assert!(
        runtime
            .status("op")
            .unwrap()
            .trajectory
            .unwrap()
            .sample_count
            <= 256
    );
    assert!(
        records
            .windows(2)
            .all(|w| w[0]["seq"].as_u64() < w[1]["seq"].as_u64())
    );
}

#[test]
fn activation_checks_foreground_and_terminates_at_click_boundary() {
    for foreground in [false, true] {
        let (runtime, control) = setup(
            vec![
                f(0, 0.0, Action::Move(Point { x: 20, y: 30 }), false),
                f(1, 10.0, Action::ButtonDown, true),
                f(2, 50.0, Action::ButtonUp, true),
                // Deliberately invalid compiler output: the runtime must stop at up too.
                f(0, 80.0, Action::Move(Point { x: 90, y: 30 }), false),
            ],
            None,
        );
        control.foreground.store(foreground, Ordering::SeqCst);
        let s = runtime.observe("1").unwrap();
        runtime
            .start(
                serde_json::from_value(json!({
                    "operation_id":"op","snapshot_id":s.snapshot_id,"kind":"activate",
                    "duration_ms":1000,"safe_area":{"x":15,"y":25,"width":20,"height":20},
                    "safe_area_confirmed":true,"events":[
                        {"type":"move","x":20,"y":30,"at_ms":0},
                        {"type":"button_down","at_ms":10},
                        {"type":"button_up","at_ms":50}
                    ]
                }))
                .unwrap(),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_millis(500);
        let status = loop {
            let s = runtime.status("op").unwrap();
            if matches!(s.state.as_str(), "failed" | "completed") {
                break s;
            }
            assert!(
                Instant::now() < deadline,
                "Activation must report at click boundary, got {}",
                s.state
            );
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(status.foreground_observed, Some(foreground));
        assert_eq!(
            status.state,
            if foreground { "completed" } else { "failed" }
        );
        if !foreground {
            assert_eq!(status.error.unwrap().code, "activation_not_observed");
        }
        assert_eq!(control.sent.load(Ordering::SeqCst), 3);
        assert_eq!(*lock(&control.cursor), Point { x: 20, y: 30 });
    }
}

fn assert_activation_resume_rechecks_final_result(post_up_verify_failure: bool) {
    for foreground in [false, true] {
        let (runtime, control) = setup(
            vec![
                f(0, 0.0, Action::Move(Point { x: 20, y: 30 }), false),
                f(1, 10.0, Action::ButtonDown, true),
                f(2, 50.0, Action::ButtonUp, true),
            ],
            post_up_verify_failure.then_some((3, true, "verification_unavailable")),
        );
        if !post_up_verify_failure {
            *lock(&control.observation_fault_after) = Some(3);
        }
        control.foreground.store(false, Ordering::SeqCst);
        let snapshot = runtime.observe("1").unwrap();
        runtime
            .start(
                serde_json::from_value(json!({
                    "operation_id":"op","snapshot_id":snapshot.snapshot_id,"kind":"activate",
                    "duration_ms":100,"safe_area":{"x":15,"y":25,"width":20,"height":20},
                    "safe_area_confirmed":true,"events":[
                        {"type":"move","x":20,"y":30,"at_ms":0},
                        {"type":"button_down","at_ms":10},
                        {"type":"button_up","at_ms":50}
                    ]
                }))
                .unwrap(),
            )
            .unwrap();
        let paused = boundary(&runtime, "paused");
        assert_eq!(paused.foreground_observed, None);
        assert_eq!(paused.progress.remaining_frames, 0);
        assert_eq!(control.sent.load(Ordering::SeqCst), 3);
        control.foreground.store(foreground, Ordering::SeqCst);
        let resolution = if post_up_verify_failure {
            assert_eq!(paused.progress.uncertain_unit_ids, vec!["u2"]);
            Resolution::Observed {
                outcomes: vec![Outcome {
                    unit_id: "u2".into(),
                    outcome: EffectOutcome::Applied,
                }],
            }
        } else {
            assert!(paused.progress.uncertain_unit_ids.is_empty());
            Resolution::Continue
        };
        resume(&runtime, paused.pause_revision, resolution).unwrap();
        let deadline = Instant::now() + Duration::from_millis(500);
        let terminal = loop {
            let s = runtime.status("op").unwrap();
            if matches!(s.state.as_str(), "failed" | "completed") {
                break s;
            }
            assert!(
                Instant::now() < deadline,
                "Activation finalization did not terminate"
            );
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(
            terminal.foreground_observed,
            Some(foreground),
            "Checked continuation must retain the activation result obligation"
        );
        assert_eq!(
            terminal.state,
            if foreground { "completed" } else { "failed" }
        );
        if !foreground {
            assert_eq!(terminal.error.unwrap().code, "activation_not_observed");
        }
        assert_eq!(
            control.sent.load(Ordering::SeqCst),
            3,
            "Finalization may not replay click input"
        );
        assert!(!control.held.load(Ordering::SeqCst));
    }
}

#[test]
fn activation_observation_error_resume_rechecks_without_click_replay() {
    assert_activation_resume_rechecks_final_result(false);
}

#[test]
fn activation_post_up_verify_error_resume_rechecks_without_click_replay() {
    assert_activation_resume_rechecks_final_result(true);
}

#[test]
fn activation_explicit_finish_does_not_claim_unchecked_completion() {
    let (runtime, control) = setup(
        vec![
            f(0, 0.0, Action::Move(Point { x: 20, y: 30 }), false),
            f(1, 10.0, Action::ButtonDown, true),
            f(2, 50.0, Action::ButtonUp, true),
        ],
        None,
    );
    *lock(&control.observation_fault_after) = Some(3);
    control.foreground.store(false, Ordering::SeqCst);
    let snapshot = runtime.observe("1").unwrap();
    runtime
        .start(
            serde_json::from_value(json!({
                "operation_id":"op","snapshot_id":snapshot.snapshot_id,"kind":"activate",
                "duration_ms":100,"safe_area":{"x":15,"y":25,"width":20,"height":20},
                "safe_area_confirmed":true,"events":[
                    {"type":"move","x":20,"y":30,"at_ms":0},
                    {"type":"button_down","at_ms":10},
                    {"type":"button_up","at_ms":50}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
    let paused = boundary(&runtime, "paused");
    resume(
        &runtime,
        paused.pause_revision,
        Resolution::Finish { outcomes: vec![] },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_millis(500);
    let terminal = loop {
        let s = runtime.status("op").unwrap();
        if matches!(s.state.as_str(), "cancelled" | "failed" | "completed") {
            break s;
        }
        assert!(
            Instant::now() < deadline,
            "Explicit finish did not terminate"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(terminal.state, "cancelled");
    assert_eq!(terminal.reason.as_deref(), Some("external_finish"));
    assert_eq!(terminal.foreground_observed, None);
    assert_eq!(control.sent.load(Ordering::SeqCst), 3);
}

#[test]
fn large_plan_schedules_progress_and_remains_responsive_to_stop() {
    let frames = (0..12000)
        .map(|i| {
            f(
                i,
                i as f64 * 2.0,
                Action::Move(Point { x: 10, y: 10 }),
                false,
            )
        })
        .collect();
    let events = (0..12000)
        .map(|i| Event::Move {
            x: 10.0,
            y: 10.0,
            at_ms: i as f64 * 2.0,
        })
        .collect();
    let (runtime, control) = setup(frames, None);
    start(&runtime, Kind::Reading, events, 24000.0);
    let deadline = Instant::now() + Duration::from_millis(600);
    loop {
        let s = runtime.status("op").unwrap();
        if s.progress.source_units_complete >= 100 {
            assert_eq!(s.state, "running");
            assert_eq!(
                s.progress.remaining_frames,
                12000 - s.progress.source_units_complete
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Large-plan scheduling stalled: {} after {} frames",
            s.state,
            control.sent.load(Ordering::SeqCst)
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let before = Instant::now();
    let stopped = runtime.cancel(Some("op"), "stop").unwrap();
    assert!(
        before.elapsed() < Duration::from_millis(300),
        "Stop must not wait for a full pending-unit scan"
    );
    assert_eq!(stopped["state"], "cancelled");
    let sent = control.sent.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(25));
    assert_eq!(control.sent.load(Ordering::SeqCst), sent);
    assert!(!control.held.load(Ordering::SeqCst));
}
#[test]
fn sent_key_interruption_releases_owned_input_and_rejects_unknown_outcome() {
    let k = Key {
        code: 30,
        unicode: false,
        extended: false,
    };
    let (runtime, control) = setup(
        vec![
            f(0, 0.0, Action::KeyDown(k), true),
            f(0, 40.0, Action::KeyUp(k), false),
        ],
        Some((1, true, "keyboard_state_changed")),
    );
    start(
        &runtime,
        Kind::Typing,
        vec![Event::Char {
            text: "a".into(),
            at_ms: 0.0,
        }],
        100.0,
    );
    let s = boundary(&runtime, "paused");
    assert_eq!(s.progress.uncertain_unit_ids, vec!["u0"]);
    assert_eq!(control.releases.load(Ordering::SeqCst), 1);
    assert!(resume(&runtime, s.pause_revision, Resolution::Continue).is_err());
    assert!(
        resume(
            &runtime,
            s.pause_revision,
            Resolution::Observed {
                outcomes: vec![Outcome {
                    unit_id: "u0".into(),
                    outcome: EffectOutcome::Unknown
                }]
            }
        )
        .is_err()
    );
    assert_eq!(runtime.status("op").unwrap().state, "paused");
    resume(
        &runtime,
        s.pause_revision,
        Resolution::Observed {
            outcomes: vec![Outcome {
                unit_id: "u0".into(),
                outcome: EffectOutcome::NotApplied,
            }],
        },
    )
    .unwrap();
    let finished = boundary(&runtime, "completed");
    assert_eq!(
        finished.progress.external_outcomes[0].outcome,
        EffectOutcome::NotApplied
    );
    assert!(!finished.delivery_verified);
    assert_eq!(control.sent.load(Ordering::SeqCst), 1);
}
#[test]
fn geometry_failure_before_input_requires_manual_checked_resume() {
    let (runtime, control) = setup(
        vec![f(0, 0.0, Action::Move(Point { x: 10, y: 10 }), false)],
        Some((0, false, "target_changed")),
    );
    start(
        &runtime,
        Kind::Move,
        vec![Event::Move {
            x: 10.0,
            y: 10.0,
            at_ms: 0.0,
        }],
        100.0,
    );
    let s = boundary(&runtime, "paused");
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(control.sent.load(Ordering::SeqCst), 0);
    resume(&runtime, s.pause_revision, Resolution::Continue).unwrap();
    boundary(&runtime, "completed");
    assert_eq!(control.sent.load(Ordering::SeqCst), 1);
}

#[test]
fn cancellation_cleanup_preserves_exact_release_disposition() {
    let key = Key {
        code: 30,
        unicode: false,
        extended: false,
    };
    let (runtime, control) = setup(
        vec![
            f(0, 0.0, Action::KeyDown(key), true),
            f(0, 40.0, Action::KeyUp(key), false),
        ],
        None,
    );
    start(
        &runtime,
        Kind::Typing,
        vec![Event::Char {
            text: "a".into(),
            at_ms: 0.0,
        }],
        100.0,
    );
    while control.sent.load(Ordering::SeqCst) == 0 {
        std::thread::yield_now();
    }
    let status = runtime.cancel(Some("op"), "stop").unwrap();
    assert_eq!(
        status["progress"]["journal"][1]["disposition"],
        "satisfied_by_cleanup"
    );
    assert_eq!(status["progress"]["cleanup_events_inserted"], 1);
    assert_eq!(status["progress"]["journal"][0]["sent"], true);
}
#[test]
fn pause_immediately_after_admission_is_a_pause_barrier_not_failure() {
    let (runtime, _) = setup(
        vec![f(0, 200.0, Action::Move(Point { x: 10, y: 10 }), false)],
        None,
    );
    start(
        &runtime,
        Kind::Reading,
        vec![Event::Move {
            x: 10.0,
            y: 10.0,
            at_ms: 200.0,
        }],
        300.0,
    );
    assert_eq!(
        runtime.pause("op", "explicit_pause").unwrap()["state"],
        "paused"
    );
    runtime.cancel(Some("op"), "stop").unwrap();
}

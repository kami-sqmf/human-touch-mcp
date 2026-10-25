//! Thread-independent admission, lease, cancellation barriers, and bounded history.
use crate::protocol::{Fault, Kind, Resolution, Result, Resume, Start, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const LEASE: Duration = Duration::from_secs(3);
pub const GUARD_INTERVAL: Duration = Duration::from_millis(20);
pub const MAX_FRAME_LATENESS: Duration = Duration::from_millis(100);
pub const DEADLINE_TOLERANCE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Rect {
    pub fn contains(self, p: Point) -> bool {
        p.x >= self.x
            && p.y >= self.y
            && i64::from(p.x) < i64::from(self.x) + i64::from(self.width)
            && i64::from(p.y) < i64::from(self.y) + i64::from(self.height)
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub snapshot_id: String,
    pub target_id: String,
    pub hwnd: String,
    pub identity: String,
    pub rect: Rect,
    pub client: Rect,
    pub virtual_desktop: Rect,
    pub cursor: Point,
    pub foreground: String,
    pub focus: String,
    pub dpi: u32,
    pub ready: bool,
    pub visible: bool,
    pub enabled: bool,
    pub minimized: bool,
    pub is_foreground: bool,
    pub observed_at: String,
    #[serde(skip)]
    pub captured: Option<Instant>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub code: u16,
    pub unicode: bool,
    pub extended: bool,
}
#[derive(Clone, Copy, Debug)]
pub enum Action {
    Move(Point),
    ButtonDown,
    ButtonUp,
    KeyDown(Key),
    KeyUp(Key),
    Wheel {
        axis: crate::protocol::Axis,
        delta: i32,
    },
}
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub at_ms: f64,
    pub action: Action,
    pub unit_id: usize,
    pub primary: bool,
}
pub struct Execution {
    pub session: Box<dyn Session>,
    pub frames: Vec<Frame>,
}
pub struct Cleanup {
    pub injected_events: usize,
    pub error: Option<Fault>,
}

/// Platform objects contain no thread-affine handles. Sessions are created and
/// destroyed solely on the execution thread (not required to be Send).
pub trait Platform: Send + Sync + 'static {
    fn observe(&self, hwnd: &str) -> Result<Snapshot>;
    fn begin(&self, baseline: &Snapshot, plan: &Start) -> Result<Execution>;
}
pub trait Session {
    fn initialize(&mut self) -> Result<()> {
        Ok(())
    }
    fn guard(&mut self, next: Option<Action>) -> Result<()>;
    fn inject(&mut self, action: Action) -> Result<usize>;
    fn verify(&mut self, action: Action) -> Result<()>;
    /// Releases only owned keys/buttons and restores explicitly changed IME.
    fn cleanup(&mut self) -> Cleanup;
    /// Revalidate a clean suspended session; implementation retains its mutex.
    fn revalidate(&mut self, _fresh: &Snapshot) -> Result<()> {
        self.guard(None)
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Unsent,
    Inserted,
    SatisfiedByCleanup,
    SupersededMotion,
    Uncertain,
    ExternallyResolved,
}
#[derive(Clone, Debug, Serialize)]
pub struct JournalEntry {
    pub frame_id: usize,
    pub unit_id: String,
    pub revision: u64,
    pub disposition: Disposition,
    pub primary: bool,
    pub sent: bool,
    pub original_at_ms: f64,
    pub external_outcome: Option<crate::protocol::EffectOutcome>,
    pub gesture_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Default)]
pub struct WorkProgress {
    pub source_units_total: usize,
    pub source_units_complete: usize,
    pub plan_events_inserted: usize,
    pub cleanup_events_inserted: usize,
    pub uncertain_unit_ids: Vec<String>,
    pub remaining_frames: usize,
    pub journal: Vec<JournalEntry>,
    pub journal_frames_total: usize,
    pub journal_truncated: bool,
    pub external_outcomes: Vec<ResolvedEffect>,
}
#[derive(Clone, Debug, Serialize)]
pub struct ResolvedEffect {
    pub unit_id: String,
    pub outcome: crate::protocol::EffectOutcome,
    pub pause_revision: u64,
}
#[derive(Clone, Debug, Serialize, Default)]
pub struct TrajectorySummary {
    pub observed_ms: u64,
    pub sample_count: usize,
    pub range_px: f64,
    pub path_px: f64,
    pub motion_span_ms: u64,
    pub stable_for_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub operation_id: String,
    pub state: String,
    pub elapsed_ms: u64,
    pub injected_events: usize,
    pub pause_revision: u64,
    pub pause_mode: Option<String>,
    pub trajectory: Option<TrajectorySummary>,
    pub resume_requirement: Option<String>,
    pub remaining_budget_ms: f64,
    pub progress: WorkProgress,
    pub cleanup_confirmed: bool,
    pub foreground_observed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Fault>,
    #[serde(rename = "inputInjected")]
    pub input_injected: bool,
    #[serde(rename = "deliveryVerified")]
    pub delivery_verified: bool,
}
struct Progress {
    status: Status,
    started: Instant,
    terminal: bool,
    paused_at: Option<Instant>,
    resume: Option<(Resume, Snapshot)>,
    resume_result: Option<Result<()>>,
}
struct Operation {
    progress: Mutex<Progress>,
    changed: Condvar,
    cancel: AtomicBool,
    pause: AtomicBool,
}
struct State {
    snapshots: VecDeque<Snapshot>,
    records: VecDeque<Arc<Operation>>,
    active: Option<Arc<Operation>>,
    poisoned: bool,
}
pub struct Runtime {
    platform: Arc<dyn Platform>,
    state: Mutex<State>,
    last_request: Mutex<Instant>,
    eof: AtomicBool,
    sequence: AtomicU64,
    events: Mutex<VecDeque<Value>>,
    event_sequence: AtomicU64,
}
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Runtime {
    pub fn new(platform: Arc<dyn Platform>) -> Arc<Self> {
        Arc::new(Self {
            platform,
            state: Mutex::new(State {
                snapshots: VecDeque::new(),
                records: VecDeque::new(),
                active: None,
                poisoned: false,
            }),
            last_request: Mutex::new(Instant::now()),
            eof: AtomicBool::new(false),
            sequence: AtomicU64::new(1),
            events: Mutex::new(VecDeque::new()),
            event_sequence: AtomicU64::new(1),
        })
    }
    pub fn renew(&self) {
        *lock(&self.last_request) = Instant::now();
    }
    pub fn eof(&self) {
        self.eof.store(true, Ordering::SeqCst);
        self.request_cancel(None, "stdin_eof");
    }
    pub fn observe(&self, hwnd: &str) -> Result<Snapshot> {
        let mut snapshot = self.platform.observe(hwnd)?;
        snapshot.snapshot_id = format!(
            "s-{}-{}",
            std::process::id(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        snapshot.captured = Some(Instant::now());
        let mut state = lock(&self.state);
        state.snapshots.push_back(snapshot.clone());
        while state.snapshots.len() > 32 {
            state.snapshots.pop_front();
        }
        Ok(snapshot)
    }
    pub fn start(self: &Arc<Self>, plan: Start) -> Result<Value> {
        plan.validate()?;
        let mut state = lock(&self.state);
        if state.poisoned {
            return Err(Fault::new(
                "input_poisoned",
                "Input cleanup is not proven; new work is blocked",
            ));
        }
        if state.active.is_some() {
            return Err(Fault::new(
                "input_busy",
                "An input operation is already live",
            ));
        }
        if state
            .records
            .iter()
            .any(|op| lock(&op.progress).status.operation_id == plan.operation_id)
        {
            return Err(Fault::new(
                "operation_id_reused",
                "Operation ID is retained and cannot be reused",
            ));
        }
        let baseline = state
            .snapshots
            .iter()
            .find(|s| s.snapshot_id == plan.snapshot_id)
            .cloned()
            .ok_or_else(|| Fault::new("unknown_snapshot", "Snapshot is not retained"))?;
        if baseline
            .captured
            .is_none_or(|at| at.elapsed() > Duration::from_millis(5000))
        {
            return Err(Fault::new(
                "stale_snapshot",
                "Snapshot is older than 5000 ms",
            ));
        }
        if !(baseline.ready
            || (plan.kind == Kind::Activate
                && baseline.visible
                && baseline.enabled
                && !baseline.minimized
                && baseline.client.width > 0
                && baseline.client.height > 0))
        {
            return Err(Fault::new(
                "target_not_ready",
                "Observed target was not ready",
            ));
        }
        if self.eof.load(Ordering::SeqCst) || lock(&self.last_request).elapsed() > LEASE {
            return Err(Fault::new("parent_lease_lost", "Parent lease is not live"));
        }
        let operation_id = plan.operation_id.clone();
        let op = Arc::new(Operation {
            progress: Mutex::new(Progress {
                status: Status {
                    operation_id: operation_id.clone(),
                    state: "running".into(),
                    elapsed_ms: 0,
                    injected_events: 0,
                    pause_revision: 0,
                    pause_mode: None,
                    trajectory: None,
                    resume_requirement: None,
                    remaining_budget_ms: plan.duration_ms,
                    progress: WorkProgress {
                        source_units_total: plan.events.len(),
                        ..Default::default()
                    },
                    cleanup_confirmed: false,
                    foreground_observed: None,
                    reason: None,
                    error: None,
                    input_injected: false,
                    delivery_verified: false,
                },
                started: Instant::now(),
                terminal: false,
                paused_at: None,
                resume: None,
                resume_result: None,
            }),
            changed: Condvar::new(),
            cancel: AtomicBool::new(false),
            pause: AtomicBool::new(false),
        });
        state.active = Some(Arc::clone(&op));
        state.records.push_back(Arc::clone(&op));
        let runtime = Arc::clone(self);
        let op_for_thread = Arc::clone(&op);
        match std::thread::Builder::new()
            .name("human-input-execution".into())
            .spawn(move || runtime.execute(op_for_thread, baseline, plan))
        {
            Ok(_) => Ok(json!({ "operation_id": operation_id, "state": "running" })),
            Err(error) => {
                state.active = None;
                state.records.retain(|record| !Arc::ptr_eq(record, &op));
                Err(Fault::new("execution_thread_failed", error.to_string()))
            }
        }
    }
    fn find(&self, operation_id: Option<&str>) -> Option<Arc<Operation>> {
        let state = lock(&self.state);
        match operation_id {
            Some(id) => state
                .records
                .iter()
                .find(|op| lock(&op.progress).status.operation_id == id)
                .cloned(),
            None => state.active.clone(),
        }
    }
    pub fn status(&self, operation_id: &str) -> Result<Status> {
        let op = self
            .find(Some(operation_id))
            .ok_or_else(|| Fault::new("unknown_operation", "Operation is not retained"))?;
        Ok(Self::snapshot_status(&lock(&op.progress)))
    }
    fn snapshot_status(progress: &Progress) -> Status {
        let mut status = progress.status.clone();
        if !progress.terminal {
            status.elapsed_ms = elapsed_ms(progress.started);
        }
        status
    }
    /// May be called by the independent line reader even while dispatch is waiting.
    pub fn request_cancel(&self, operation_id: Option<&str>, reason: &str) {
        if let Some(op) = self.find(operation_id) {
            let mut progress = lock(&op.progress);
            if !progress.terminal {
                if !op.cancel.swap(true, Ordering::SeqCst) {
                    progress.status.reason = Some(reason.chars().take(256).collect());
                }
                progress.status.state = "cancelling".into();
            }
        }
    }
    pub fn cancel(&self, operation_id: Option<&str>, reason: &str) -> Result<Value> {
        if operation_id.is_some_and(|id| !valid_id(id)) {
            return Err(Fault::new("invalid_request", "Invalid operation_id"));
        }
        let Some(op) = self.find(operation_id) else {
            return Ok(json!({ "state": "idle" }));
        };
        self.request_cancel(operation_id, reason);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut progress = lock(&op.progress);
        while !progress.terminal {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                drop(progress);
                let mut state = lock(&self.state);
                let progress = lock(&op.progress);
                if progress.terminal {
                    return serde_json::to_value(Self::snapshot_status(&progress))
                        .map_err(|e| Fault::new("serialization_error", e.to_string()));
                }
                state.poisoned = true;
                return Err(Fault::new(
                    "cancellation_timeout",
                    "Cleanup barrier exceeded 2000 ms; new work is blocked",
                ));
            }
            let waited = op
                .changed
                .wait_timeout(progress, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            progress = waited.0;
        }
        serde_json::to_value(Self::snapshot_status(&progress))
            .map_err(|e| Fault::new("serialization_error", e.to_string()))
    }
    fn emit(&self, op: &Operation, event: &str) {
        let status = Self::snapshot_status(&lock(&op.progress));
        let mut events = lock(&self.events);
        let seq = self.event_sequence.fetch_add(1, Ordering::SeqCst);
        let progress = &status.progress;
        let value = json!({"seq":seq,"operation_id":status.operation_id,"event":event,"state":status.state,"pause_revision":status.pause_revision,"pause_mode":status.pause_mode,"trajectory":status.trajectory,"reason":status.reason,"elapsed_ms":status.elapsed_ms,"progress":{
            "source_units_total":progress.source_units_total,
            "source_units_complete":progress.source_units_complete,
            "plan_events_inserted":progress.plan_events_inserted,
            "cleanup_events_inserted":progress.cleanup_events_inserted,
            "uncertain_units_count":progress.uncertain_unit_ids.len(),
            "remaining_frames":progress.remaining_frames,
            "journal_frames_total":progress.journal_frames_total
        }});
        events.push_back(value);
        while events.len() > 256 {
            events.pop_front();
        }
    }
    pub fn events(&self, after_seq: u64, limit: usize) -> Result<Value> {
        if !(1..=128).contains(&limit) {
            return Err(Fault::new("invalid_request", "events limit must be 1..128"));
        }
        let events = lock(&self.events);
        let oldest = events
            .front()
            .and_then(|v| v["seq"].as_u64())
            .unwrap_or(self.event_sequence.load(Ordering::SeqCst));
        let records: Vec<_> = events
            .iter()
            .filter(|v| v["seq"].as_u64().is_some_and(|s| s > after_seq))
            .take(limit)
            .cloned()
            .collect();
        let next = records
            .last()
            .and_then(|v| v["seq"].as_u64())
            .unwrap_or(after_seq);
        Ok(
            json!({"records":records,"next_seq":next,"oldest_seq":oldest,"overflow":after_seq.saturating_add(1)<oldest}),
        )
    }
    pub fn request_pause(&self, operation_id: &str, reason: &str) {
        if let Some(op) = self.find(Some(operation_id)) {
            let mut p = lock(&op.progress);
            if !p.terminal {
                op.pause.store(true, Ordering::SeqCst);
                if p.status.state == "running" {
                    p.status.state = "pausing".into();
                }
                p.status.reason = Some(reason.chars().take(256).collect());
            }
        }
    }
    pub fn pause(&self, operation_id: &str, reason: &str) -> Result<Value> {
        let op = self
            .find(Some(operation_id))
            .ok_or_else(|| Fault::new("unknown_operation", "Operation is not retained"))?;
        self.request_pause(operation_id, reason);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut p = lock(&op.progress);
        while !p.terminal && p.status.state != "paused" {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Fault::new(
                    "pause_timeout",
                    "Pause cleanup barrier exceeded 2000 ms; operation remains live",
                ));
            }
            p = op
                .changed
                .wait_timeout(p, left)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
        serde_json::to_value(Self::snapshot_status(&p))
            .map_err(|e| Fault::new("serialization_error", e.to_string()))
    }
    pub fn resume(&self, request: Resume) -> Result<Value> {
        if !valid_id(&request.operation_id)
            || !valid_id(&request.snapshot_id)
            || !request.external_checked
        {
            return Err(Fault::new(
                "resume_rejected",
                "Fresh external_checked observation is required",
            ));
        }
        let fresh = lock(&self.state)
            .snapshots
            .iter()
            .find(|s| s.snapshot_id == request.snapshot_id)
            .cloned()
            .ok_or_else(|| Fault::new("unknown_snapshot", "Snapshot is not retained"))?;
        let op = self
            .find(Some(&request.operation_id))
            .ok_or_else(|| Fault::new("unknown_operation", "Operation is not retained"))?;
        let mut p = lock(&op.progress);
        if p.status.state != "paused"
            || p.status.pause_revision != request.pause_revision
            || p.resume.is_some()
        {
            return Err(Fault::new(
                "stale_pause_revision",
                "Resume requires the current paused revision",
            ));
        }
        if fresh.captured.is_none_or(|t| {
            t.elapsed() > Duration::from_secs(5) || p.paused_at.is_none_or(|paused| t < paused)
        }) {
            return Err(Fault::new(
                "stale_snapshot",
                "Resume observation must follow the pause barrier and be <=5000 ms old",
            ));
        }
        p.resume_result = None;
        p.resume = Some((request, fresh));
        op.changed.notify_all();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(result) = p.resume_result.take() {
                result?;
                return serde_json::to_value(Self::snapshot_status(&p))
                    .map_err(|e| Fault::new("serialization_error", e.to_string()));
            }
            if p.terminal {
                return Err(Fault::new(
                    "resume_rejected",
                    "Operation terminated before resume",
                ));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Fault::new(
                    "resume_pending",
                    "Resume validation is still pending; inspect status and do not replay",
                ));
            }
            p = op
                .changed
                .wait_timeout(p, left)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }
    fn cancelled(&self, op: &Operation) -> Result<()> {
        if self.eof.load(Ordering::SeqCst) {
            return Err(Fault::new("cancelled", "stdin_eof"));
        }
        if lock(&self.last_request).elapsed() > LEASE {
            return Err(Fault::new("cancelled", "parent_lease_lost"));
        }
        if op.cancel.load(Ordering::SeqCst) {
            return Err(Fault::new("cancelled", "Cancellation requested"));
        }
        Ok(())
    }
    fn stopped(&self, op: &Operation) -> Result<()> {
        self.cancelled(op)?;
        if op.pause.load(Ordering::SeqCst) {
            Err(Fault::new("explicit_pause", "Pause requested"))
        } else {
            Ok(())
        }
    }
    fn wait_until(
        &self,
        op: &Operation,
        session: &mut dyn Session,
        deadline: Instant,
        hard_deadline: Instant,
    ) -> Result<()> {
        loop {
            self.stopped(op)?;
            session.guard(None)?;
            if Instant::now() > hard_deadline {
                return Err(Fault::new(
                    "duration_exceeded",
                    "Execution exceeded duration_ms plus 250 ms tolerance",
                ));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            std::thread::sleep(remaining.min(GUARD_INTERVAL));
        }
    }
    fn finalize_activation(&self, op: &Operation, hwnd: &str) -> Result<()> {
        self.stopped(op)?;
        let fresh = self.platform.observe(hwnd)?;
        lock(&op.progress).status.foreground_observed = Some(fresh.is_foreground);
        if !fresh.is_foreground {
            return Err(Fault::new(
                "activation_not_observed",
                "Click inserted; target foreground was not observed; no retry",
            ));
        }
        Ok(())
    }
    fn execute(self: Arc<Self>, op: Arc<Operation>, baseline: Snapshot, plan: Start) {
        use crate::checkpoint::{Ledger, MotionClass, PointerTrace};
        let mut execution: Option<Execution> = None;
        let mut retained_ledger: Option<Ledger> = None;
        let mut keys: HashMap<Key, (Instant, f64)> = HashMap::new();
        let mut button = None;
        let mut failed_frame = None;
        let mut cleanup_ok = true;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
            self.cancelled(&op)?;
            execution = Some(self.platform.begin(&baseline, &plan)?);
            let run = execution
                .as_mut()
                .ok_or_else(|| Fault::new("execution_failed", "Session missing"))?;
            retained_ledger = Some(Ledger::new(
                baseline.cursor,
                std::mem::take(&mut run.frames),
                plan.events.len(),
            ));
            let ledger = retained_ledger
                .as_mut()
                .ok_or_else(|| Fault::new("execution_failed", "Journal missing"))?;
            if ledger.frames.len() > 48000 {
                return Err(Fault::new("invalid_plan", "Compiled frame budget exceeded"));
            }
            let mut remaining = plan.duration_ms;
            let mut expected = baseline.cursor;
            let mut needs_initialize = true;
            let mut activation_finalization_pending = false;
            lock(&op.progress).status.progress = ledger.progress();
            self.emit(&op, "started");
            loop {
                keys.clear();
                button = None;
                failed_frame = None;
                let epoch = Instant::now();
                let hard_deadline =
                    epoch + Duration::from_secs_f64(remaining / 1000.0) + DEADLINE_TOLERANCE;
                let segment = (|| -> Result<()> {
                    if needs_initialize {
                        self.stopped(&op)?;
                        run.session.initialize()?;
                    }
                    // A sent release consumes its frame before verification or
                    // final observation can fail. Checked resume must finish
                    // that result obligation before considering any more input.
                    if plan.kind == Kind::Activate
                        && (activation_finalization_pending || ledger.pending.is_empty())
                    {
                        return self.finalize_activation(&op, &baseline.hwnd);
                    }
                    while let Some(index) = ledger.pending.front().copied() {
                        let frame = ledger.frames[index];
                        let scheduled = epoch + Duration::from_secs_f64(frame.at_ms / 1000.0);
                        self.wait_until(&op, run.session.as_mut(), scheduled, hard_deadline)?;
                        let down = match frame.action {
                            Action::KeyUp(key) => keys.get(&key).copied(),
                            Action::ButtonUp => button,
                            _ => None,
                        };
                        if let Some((actual, planned)) = down {
                            self.wait_until(
                                &op,
                                run.session.as_mut(),
                                actual
                                    + Duration::from_secs_f64(
                                        (frame.at_ms - planned).max(0.0) / 1000.0,
                                    ),
                                hard_deadline,
                            )?;
                        }
                        run.session.guard(Some(frame.action))?;
                        self.stopped(&op)?;
                        let now = Instant::now();
                        if now > hard_deadline {
                            return Err(Fault::new(
                                "duration_exceeded",
                                "Execution exceeded remaining duration plus 250 ms",
                            ));
                        }
                        if now.saturating_duration_since(scheduled) > MAX_FRAME_LATENESS {
                            return Err(Fault::new(
                                "timing_overrun",
                                "Frame is over 100 ms late; catch-up is blocked",
                            ));
                        }
                        let count = run.session.inject(frame.action)?;
                        if count != 1 {
                            return Err(Fault::new(
                                "input_count_invalid",
                                "Single frame insertion did not return one; never retry automatically",
                            ));
                        }
                        ledger.sent(index, count);
                        match frame.action {
                            Action::KeyDown(k) => {
                                keys.insert(k, (Instant::now(), frame.at_ms));
                            }
                            Action::KeyUp(k) => {
                                keys.remove(&k);
                            }
                            Action::ButtonDown => button = Some((Instant::now(), frame.at_ms)),
                            Action::ButtonUp => {
                                button = None;
                                activation_finalization_pending = plan.kind == Kind::Activate;
                            }
                            Action::Move(p) => expected = p,
                            Action::Wheel { .. } => {}
                        }
                        {
                            let mut p = lock(&op.progress);
                            p.status.injected_events += count;
                            p.status.input_injected = true;
                            ledger.update_progress(&mut p.status.progress);
                            p.status.remaining_budget_ms =
                                (remaining - epoch.elapsed().as_secs_f64() * 1000.0).max(0.0);
                        }
                        failed_frame = Some(index);
                        run.session.verify(frame.action)?;
                        failed_frame = None;
                        if plan.kind == Kind::Activate && matches!(frame.action, Action::ButtonUp) {
                            return self.finalize_activation(&op, &baseline.hwnd);
                        }
                    }
                    self.wait_until(
                        &op,
                        run.session.as_mut(),
                        epoch + Duration::from_secs_f64(remaining / 1000.0),
                        hard_deadline,
                    )?;
                    Ok(())
                })();
                let active_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                match segment {
                    Ok(()) => return Ok(()),
                    Err(error) if error.code == "activation_not_observed" => return Err(error),
                    Err(error) if error.code == "cancelled" => return Err(error),
                    Err(error) if error.code == "target_replaced" => {
                        return Err(Fault::new("cancelled", "target_replaced"));
                    }
                    Err(error) => {
                        let (revision, pause_limit) = {
                            let mut p = lock(&op.progress);
                            p.status.state = "pausing".into();
                            if error.code != "explicit_pause" {
                                p.status.reason = Some(error.code.clone());
                            }
                            p.status.error = Some(error.clone());
                            p.status.cleanup_confirmed = false;
                            let exhausted = p.status.pause_revision >= 64;
                            if !exhausted {
                                p.status.pause_revision += 1;
                            }
                            (p.status.pause_revision, exhausted)
                        };
                        self.emit(&op, "anomaly");
                        let cleanup = run.session.cleanup();
                        ledger.cleanup_inserted += cleanup.injected_events;
                        {
                            let mut p = lock(&op.progress);
                            p.status.injected_events += cleanup.injected_events;
                            p.status.input_injected |= cleanup.injected_events > 0;
                        }
                        if let Some(error) = cleanup.error {
                            cleanup_ok = false;
                            return Err(error);
                        }
                        let owned: Vec<_> = keys.keys().copied().collect();
                        ledger.suspend(plan.kind, failed_frame, &owned, button.is_some());
                        keys.clear();
                        button = None;
                        failed_frame = None;
                        remaining = (remaining - active_ms).max(0.0);
                        let paused = Instant::now();
                        let mut auto =
                            error.code == "pointer_anomaly" && !op.pause.load(Ordering::SeqCst);
                        {
                            let mut p = lock(&op.progress);
                            p.status.state = "paused".into();
                            p.status.pause_mode =
                                Some(if auto { "sampling" } else { "manual" }.into());
                            p.status.trajectory = None;
                            p.status.cleanup_confirmed = true;
                            p.status.resume_requirement = Some(ledger.requirement().into());
                            p.status.progress = ledger.progress();
                            p.status.remaining_budget_ms = remaining;
                            p.paused_at = Some(paused);
                        }
                        self.emit(&op, "paused");
                        op.changed.notify_all();
                        if pause_limit {
                            return Err(Fault::new("cancelled", "pause_limit"));
                        }
                        let mut trace = PointerTrace::new(expected);
                        loop {
                            self.cancelled(&op)?;
                            if op.pause.load(Ordering::SeqCst) {
                                auto = false;
                                lock(&op.progress).status.pause_mode = Some("manual".into());
                            }
                            if elapsed_ms(paused) >= plan.pause_policy.lifetime_ms {
                                return Err(Fault::new("cancelled", "pause_expired"));
                            }
                            if !auto {
                                match self.platform.observe(&baseline.hwnd) {
                                    Ok(current) if current.identity != baseline.identity => {
                                        return Err(Fault::new("cancelled", "target_replaced"));
                                    }
                                    Err(error)
                                        if matches!(
                                            error.code.as_str(),
                                            "target_changed" | "target_replaced"
                                        ) =>
                                    {
                                        return Err(Fault::new("cancelled", "target_replaced"));
                                    }
                                    _ => {}
                                }
                            }
                            let request = lock(&op.progress).resume.take();
                            let candidate = if let Some((request, fresh)) = request {
                                Some((request.resolution, fresh, false))
                            } else if auto {
                                match self.platform.observe(&baseline.hwnd) {
                                    Ok(fresh) => {
                                        if fresh.identity != baseline.identity {
                                            return Err(Fault::new("cancelled", "target_replaced"));
                                        }
                                        let class = trace.sample(
                                            elapsed_ms(paused),
                                            fresh.cursor,
                                            &plan.pause_policy,
                                            plan.threshold_px,
                                        );
                                        lock(&op.progress).status.trajectory =
                                            Some(trace.summary.clone());
                                        match class {
                                            MotionClass::Transient
                                                if ledger.uncertain.is_empty()
                                                    && !ledger.interrupted_drag =>
                                            {
                                                Some((Resolution::Continue, fresh, true))
                                            }
                                            MotionClass::Transient => {
                                                auto = false;
                                                lock(&op.progress).status.pause_mode =
                                                    Some("manual".into());
                                                self.emit(&op, "external_observation_required");
                                                None
                                            }
                                            MotionClass::Large => {
                                                auto = false;
                                                lock(&op.progress).status.pause_mode =
                                                    Some("manual".into());
                                                lock(&op.progress).status.reason =
                                                    Some("pointer_takeover".into());
                                                self.emit(&op, "pointer_takeover");
                                                None
                                            }
                                            MotionClass::Manual => {
                                                auto = false;
                                                lock(&op.progress).status.pause_mode =
                                                    Some("manual".into());
                                                self.emit(&op, "external_observation_required");
                                                None
                                            }
                                            MotionClass::Sampling => None,
                                        }
                                    }
                                    Err(_) => {
                                        auto = false;
                                        lock(&op.progress).status.pause_mode =
                                            Some("manual".into());
                                        None
                                    }
                                }
                            } else {
                                None
                            };
                            if let Some((resolution, fresh, automatic)) = candidate {
                                {
                                    let mut p = lock(&op.progress);
                                    if automatic && p.resume.is_some() {
                                        continue;
                                    }
                                    p.status.state = "resuming".into();
                                    op.pause.store(false, Ordering::SeqCst);
                                }
                                let validation = (|| -> Result<f64> {
                                    self.stopped(&op)?;
                                    if fresh.identity != baseline.identity
                                        || fresh.hwnd != baseline.hwnd
                                    {
                                        return Err(Fault::new(
                                            "resume_rejected",
                                            "Target process lifetime changed",
                                        ));
                                    }
                                    if fresh.rect != baseline.rect
                                        || fresh.client != baseline.client
                                        || fresh.dpi != baseline.dpi
                                        || (plan.kind.keyboard() && fresh.focus != baseline.focus)
                                    {
                                        return Err(Fault::new(
                                            "resume_rejected",
                                            "Restore bound geometry/DPI/focus before continuation",
                                        ));
                                    }
                                    ledger.check_resolution(&resolution, fresh.cursor)?;
                                    run.session.revalidate(&fresh)?;
                                    self.stopped(&op)?;
                                    ledger.anchor = expected;
                                    ledger.continuation(
                                        &resolution,
                                        fresh.cursor,
                                        revision,
                                        active_ms,
                                    )
                                })();
                                match validation {
                                    Ok(bridge) => {
                                        expected = fresh.cursor;
                                        remaining += bridge;
                                        if matches!(resolution, Resolution::RemainingGesture { .. })
                                        {
                                            remaining = remaining.max(
                                                ledger
                                                    .pending
                                                    .iter()
                                                    .map(|i| ledger.frames[*i].at_ms)
                                                    .fold(0.0, f64::max)
                                                    + 40.0,
                                            );
                                        }
                                        {
                                            let mut p = lock(&op.progress);
                                            p.status.state = "running".into();
                                            p.status.pause_mode = None;
                                            p.status.reason = None;
                                            p.status.error = None;
                                            p.status.resume_requirement = None;
                                            p.status.progress = ledger.progress();
                                            p.status.remaining_budget_ms = remaining;
                                            p.paused_at = None;
                                            p.resume_result = Some(Ok(()));
                                        }
                                        self.emit(
                                            &op,
                                            if automatic { "auto_resumed" } else { "resumed" },
                                        );
                                        op.changed.notify_all();
                                        if matches!(resolution, Resolution::Finish { .. }) {
                                            if plan.kind == Kind::Activate {
                                                return Err(Fault::new(
                                                    "cancelled",
                                                    "external_finish",
                                                ));
                                            }
                                            return Ok(());
                                        }
                                        needs_initialize = true;
                                        break;
                                    }
                                    Err(error) => {
                                        auto = false;
                                        {
                                            let mut p = lock(&op.progress);
                                            p.status.state = "paused".into();
                                            p.status.pause_mode = Some("manual".into());
                                            p.status.error = Some(error.clone());
                                            p.resume_result = Some(Err(error));
                                        }
                                        self.emit(&op, "resume_rejected");
                                        op.changed.notify_all();
                                    }
                                }
                            }
                            std::thread::sleep(GUARD_INTERVAL);
                        }
                    }
                }
            }
        }));
        let mut result = match outcome {
            Ok(r) => r,
            Err(_) => Err(Fault::new(
                "execution_panic",
                "Execution panicked; cleanup attempted",
            )),
        };
        if let Some(run) = execution.as_mut() {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run.session.cleanup())) {
                Ok(cleanup) => {
                    let mut p = lock(&op.progress);
                    p.status.injected_events += cleanup.injected_events;
                    p.status.progress.cleanup_events_inserted += cleanup.injected_events;
                    p.status.input_injected |= cleanup.injected_events > 0;
                    if let Some(ledger) = retained_ledger.as_mut() {
                        ledger.cleanup_inserted += cleanup.injected_events;
                        if cleanup.error.is_none() {
                            let owned: Vec<_> = keys.keys().copied().collect();
                            ledger.suspend(plan.kind, failed_frame, &owned, button.is_some());
                        }
                        p.status.progress = ledger.progress();
                    }
                    if let Some(error) = cleanup.error {
                        cleanup_ok = false;
                        result = Err(error);
                    }
                }
                Err(_) => {
                    cleanup_ok = false;
                    result = Err(Fault::new(
                        "cleanup_failed",
                        "Cleanup panicked; admission blocked",
                    ));
                }
            }
        }
        drop(execution);
        {
            let mut state = lock(&self.state);
            let mut p = lock(&op.progress);
            p.status.elapsed_ms = elapsed_ms(p.started);
            p.status.cleanup_confirmed = cleanup_ok;
            p.status.state = match result {
                Ok(()) if !op.cancel.load(Ordering::SeqCst) => "completed".into(),
                Ok(()) => "cancelled".into(),
                Err(ref e) if e.code == "cancelled" => {
                    if !op.cancel.load(Ordering::SeqCst) || p.status.reason.is_none() {
                        p.status.reason = Some(e.message.clone());
                    }
                    "cancelled".into()
                }
                Err(e) => {
                    p.status.error = Some(e);
                    "failed".into()
                }
            };
            p.terminal = true;
            p.status.pause_mode = None;
            if p.status.state == "completed" {
                p.status.remaining_budget_ms = 0.0;
            }
            p.status.resume_requirement = None;
            state.active = None;
            state.poisoned = !cleanup_ok;
            while state.records.len() > 32 {
                state.records.pop_front();
            }
        }
        self.emit(&op, "terminal");
        op.changed.notify_all();
    }
}
fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
#[cfg(test)]
#[path = "runtime_v2_tests.rs"]
mod v2_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Event, Kind};
    use std::sync::atomic::AtomicUsize;

    struct FakePlatform {
        injected: Arc<AtomicUsize>,
        cleaned: Arc<AtomicBool>,
        verify_fails: bool,
        cleanup_fails: bool,
        cleanup_delay: Duration,
    }
    struct FakeSession {
        injected: Arc<AtomicUsize>,
        cleaned: Arc<AtomicBool>,
        verify_fails: bool,
        cleanup_fails: bool,
        cleanup_delay: Duration,
    }
    fn baseline() -> Snapshot {
        Snapshot {
            snapshot_id: String::new(),
            target_id: "target".into(),
            hwnd: "1".into(),
            identity: "1:123".into(),
            rect: Rect {
                x: 0,
                y: 0,
                width: 400,
                height: 300,
            },
            client: Rect {
                x: 0,
                y: 0,
                width: 400,
                height: 300,
            },
            virtual_desktop: Rect {
                x: -1000,
                y: -1000,
                width: 4000,
                height: 4000,
            },
            cursor: Point { x: 1, y: 1 },
            foreground: "1".into(),
            focus: "2".into(),
            dpi: 96,
            ready: true,
            visible: true,
            enabled: true,
            minimized: false,
            is_foreground: true,
            observed_at: "2026-10-24T00:00:00.000Z".into(),
            captured: None,
        }
    }
    impl Platform for FakePlatform {
        fn observe(&self, _: &str) -> Result<Snapshot> {
            Ok(baseline())
        }
        fn begin(&self, _: &Snapshot, plan: &Start) -> Result<Execution> {
            Ok(Execution {
                session: Box::new(FakeSession {
                    injected: Arc::clone(&self.injected),
                    cleaned: Arc::clone(&self.cleaned),
                    verify_fails: self.verify_fails,
                    cleanup_fails: self.cleanup_fails,
                    cleanup_delay: self.cleanup_delay,
                }),
                frames: plan
                    .events
                    .iter()
                    .map(|event| Frame {
                        unit_id: 0,
                        primary: false,
                        at_ms: event.at_ms(),
                        action: Action::Move(Point { x: 2, y: 3 }),
                    })
                    .collect(),
            })
        }
    }
    impl Session for FakeSession {
        fn guard(&mut self, _: Option<Action>) -> Result<()> {
            Ok(())
        }
        fn inject(&mut self, _: Action) -> Result<usize> {
            self.injected.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        }
        fn verify(&mut self, _: Action) -> Result<()> {
            if self.verify_fails {
                Err(Fault::new(
                    "pointer_takeover",
                    "Tool detected pointer takeover",
                ))
            } else {
                Ok(())
            }
        }
        fn cleanup(&mut self) -> Cleanup {
            std::thread::sleep(self.cleanup_delay);
            self.cleaned.store(true, Ordering::SeqCst);
            Cleanup {
                injected_events: 0,
                error: self
                    .cleanup_fails
                    .then(|| Fault::new("cleanup_failed", "Fake cleanup failed")),
            }
        }
    }
    fn fake(
        verify_fails: bool,
        cleanup_fails: bool,
        cleanup_delay: Duration,
    ) -> (Arc<Runtime>, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let injected = Arc::new(AtomicUsize::new(0));
        let cleaned = Arc::new(AtomicBool::new(false));
        (
            Runtime::new(Arc::new(FakePlatform {
                injected: Arc::clone(&injected),
                cleaned: Arc::clone(&cleaned),
                verify_fails,
                cleanup_fails,
                cleanup_delay,
            })),
            injected,
            cleaned,
        )
    }
    fn plan(snapshot_id: String, operation_id: &str, at_ms: u64, duration_ms: u64) -> Start {
        Start {
            operation_id: operation_id.into(),
            snapshot_id,
            kind: Kind::Reading,
            duration_ms: duration_ms as f64,
            events: vec![Event::Move {
                x: 2.,
                y: 3.,
                at_ms: at_ms as f64,
            }],
            threshold_px: 60,
            force_ime_off: false,
            safe_area: None,
            safe_area_confirmed: false,
            pause_policy: Default::default(),
        }
    }
    fn terminal(runtime: &Runtime, id: &str) -> Status {
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let status = runtime.status(id).unwrap();
            if !matches!(status.state.as_str(), "running" | "cancelling") {
                return status;
            }
            assert!(Instant::now() < deadline, "Operation did not terminate");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn v2_guard_failure_pauses_retains_admission_and_never_retries_input() {
        let (runtime, injected, cleaned) = fake(true, false, Duration::ZERO);
        let snapshot = runtime.observe("1").unwrap();
        runtime
            .start(plan(snapshot.snapshot_id.clone(), "pause", 0, 100))
            .unwrap();
        let status = terminal(&runtime, "pause");
        assert_eq!(status.state, "paused");
        assert!(cleaned.load(Ordering::SeqCst));
        assert_eq!(injected.load(Ordering::SeqCst), 1);
        assert_eq!(
            runtime
                .start(plan(snapshot.snapshot_id, "other", 0, 100))
                .unwrap_err()
                .code,
            "input_busy"
        );
        runtime.eof();
    }
    #[test]
    fn cancellation_barrier_prevents_every_future_injection_and_is_idempotent() {
        let (runtime, injected, cleaned) = fake(false, false, Duration::ZERO);
        let snapshot = runtime.observe("1").unwrap();
        runtime
            .start(plan(snapshot.snapshot_id.clone(), "cancel", 2000, 2500))
            .unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let cancelled = runtime.cancel(Some("cancel"), "test_stop").unwrap();
        assert_eq!(cancelled["state"], "cancelled");
        assert!(cleaned.load(Ordering::SeqCst));
        assert_eq!(injected.load(Ordering::SeqCst), 0);
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(injected.load(Ordering::SeqCst), 0);
        assert_eq!(
            runtime.cancel(Some("cancel"), "again").unwrap()["reason"],
            "test_stop"
        );
        assert_eq!(
            runtime
                .start(plan(snapshot.snapshot_id, "cancel", 0, 1))
                .unwrap_err()
                .code,
            "operation_id_reused"
        );
    }
    #[test]
    fn status_queries_do_not_cancel_and_admission_never_queues() {
        let (runtime, injected, _) = fake(false, false, Duration::ZERO);
        let snapshot = runtime.observe("1").unwrap();
        runtime
            .start(plan(snapshot.snapshot_id.clone(), "read", 80, 120))
            .unwrap();
        assert_eq!(
            runtime
                .start(plan(snapshot.snapshot_id, "other", 0, 1))
                .unwrap_err()
                .code,
            "input_busy"
        );
        assert_eq!(runtime.status("read").unwrap().state, "running");
        assert_eq!(terminal(&runtime, "read").state, "completed");
        assert_eq!(injected.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn lease_loss_and_eof_cancel_without_further_injection() {
        for eof in [false, true] {
            let (runtime, injected, _) = fake(false, false, Duration::ZERO);
            let snapshot = runtime.observe("1").unwrap();
            runtime
                .start(plan(snapshot.snapshot_id, "lease", 1000, 1500))
                .unwrap();
            if eof {
                runtime.eof();
            } else {
                *lock(&runtime.last_request) = Instant::now() - Duration::from_secs(4);
            }
            let status = terminal(&runtime, "lease");
            assert_eq!(status.state, "cancelled");
            assert_eq!(
                status.reason.as_deref(),
                Some(if eof {
                    "stdin_eof"
                } else {
                    "parent_lease_lost"
                })
            );
            assert_eq!(injected.load(Ordering::SeqCst), 0);
        }
    }
    #[test]
    fn post_injection_failure_still_reports_input_and_cleanup_failure_poison() {
        let (runtime, _, cleaned) = fake(true, true, Duration::ZERO);
        let snapshot = runtime.observe("1").unwrap();
        runtime
            .start(plan(snapshot.snapshot_id.clone(), "failure", 0, 1))
            .unwrap();
        let status = terminal(&runtime, "failure");
        assert_eq!(status.state, "failed");
        assert!(status.input_injected);
        assert_eq!(status.injected_events, 1);
        assert!(cleaned.load(Ordering::SeqCst));
        assert_eq!(status.error.unwrap().code, "cleanup_failed");
        assert_eq!(
            runtime
                .start(plan(snapshot.snapshot_id, "next", 0, 1))
                .unwrap_err()
                .code,
            "input_poisoned"
        );
    }
    #[test]
    fn cancellation_timeout_blocks_admission_until_cleanup_is_proven() {
        let (runtime, _, cleaned) = fake(false, false, Duration::from_millis(2150));
        let snapshot = runtime.observe("1").unwrap();
        runtime
            .start(plan(snapshot.snapshot_id.clone(), "slow", 1000, 1500))
            .unwrap();
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(
            runtime.cancel(Some("slow"), "stop").unwrap_err().code,
            "cancellation_timeout"
        );
        assert!(!cleaned.load(Ordering::SeqCst));
        assert_eq!(
            runtime
                .start(plan(snapshot.snapshot_id.clone(), "new", 0, 1))
                .unwrap_err()
                .code,
            "input_poisoned"
        );
        assert_eq!(terminal(&runtime, "slow").state, "cancelled");
        assert!(cleaned.load(Ordering::SeqCst));
        runtime
            .start(plan(snapshot.snapshot_id, "new", 1000, 1500))
            .unwrap();
        runtime.eof();
        terminal(&runtime, "new");
    }
    #[test]
    fn observation_history_and_terminal_history_are_bounded() {
        let (runtime, _, _) = fake(false, false, Duration::ZERO);
        let first = runtime.observe("1").unwrap();
        for _ in 0..33 {
            runtime.observe("1").unwrap();
        }
        assert_eq!(
            runtime
                .start(plan(first.snapshot_id, "old", 0, 1))
                .unwrap_err()
                .code,
            "unknown_snapshot"
        );
        let snapshot = runtime.observe("1").unwrap();
        for index in 0..34 {
            let id = format!("op{index}");
            runtime
                .start(plan(snapshot.snapshot_id.clone(), &id, 0, 1))
                .unwrap();
            terminal(&runtime, &id);
        }
        assert_eq!(lock(&runtime.state).records.len(), 32);
        assert_eq!(runtime.status("op0").unwrap_err().code, "unknown_operation");
    }
    struct TimedPlatform {
        frames: Vec<Frame>,
        first_guard_delay: Duration,
        log: Arc<Mutex<Vec<(Action, Instant)>>>,
    }
    struct TimedSession {
        first_guard_delay: Option<Duration>,
        log: Arc<Mutex<Vec<(Action, Instant)>>>,
    }
    impl Platform for TimedPlatform {
        fn observe(&self, _: &str) -> Result<Snapshot> {
            Ok(baseline())
        }
        fn begin(&self, _: &Snapshot, _: &Start) -> Result<Execution> {
            Ok(Execution {
                session: Box::new(TimedSession {
                    first_guard_delay: Some(self.first_guard_delay),
                    log: Arc::clone(&self.log),
                }),
                frames: self.frames.clone(),
            })
        }
    }
    impl Session for TimedSession {
        fn guard(&mut self, _: Option<Action>) -> Result<()> {
            if let Some(delay) = self.first_guard_delay.take() {
                std::thread::sleep(delay);
            }
            Ok(())
        }
        fn inject(&mut self, action: Action) -> Result<usize> {
            lock(&self.log).push((action, Instant::now()));
            Ok(1)
        }
        fn verify(&mut self, _: Action) -> Result<()> {
            Ok(())
        }
        fn cleanup(&mut self) -> Cleanup {
            Cleanup {
                injected_events: 0,
                error: None,
            }
        }
    }
    #[test]
    fn slow_guard_fails_overdue_frames_without_any_catchup_injection() {
        for (delay_ms, duration_ms, code) in
            [(130, 500, "timing_overrun"), (300, 1, "duration_exceeded")]
        {
            let log = Arc::new(Mutex::new(Vec::new()));
            let runtime = Runtime::new(Arc::new(TimedPlatform {
                frames: vec![
                    Frame {
                        unit_id: 0,
                        primary: false,
                        at_ms: 0.0,
                        action: Action::Move(Point { x: 2, y: 3 }),
                    },
                    Frame {
                        unit_id: 0,
                        primary: false,
                        at_ms: 0.5,
                        action: Action::Move(Point { x: 3, y: 4 }),
                    },
                ],
                first_guard_delay: Duration::from_millis(delay_ms),
                log: Arc::clone(&log),
            }));
            let snapshot = runtime.observe("1").unwrap();
            runtime
                .start(plan(snapshot.snapshot_id, "lag", 0, duration_ms))
                .unwrap();
            let status = terminal(&runtime, "lag");
            assert_eq!(status.state, "paused");
            assert_eq!(status.error.unwrap().code, code);
            assert!(!status.input_injected);
            assert!(lock(&log).is_empty(), "No overdue frame may be emitted");
            runtime.cancel(Some("lag"), "test_stop").unwrap();
        }
    }
    #[test]
    fn scheduling_lag_cannot_collapse_actual_key_or_button_hold() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let key = Key {
            code: 30,
            unicode: false,
            extended: false,
        };
        let runtime = Runtime::new(Arc::new(TimedPlatform {
            frames: vec![
                Frame {
                    unit_id: 0,
                    primary: false,
                    at_ms: 0.0,
                    action: Action::KeyDown(key),
                },
                Frame {
                    unit_id: 0,
                    primary: false,
                    at_ms: 35.0,
                    action: Action::KeyUp(key),
                },
                Frame {
                    unit_id: 0,
                    primary: false,
                    at_ms: 35.0,
                    action: Action::ButtonDown,
                },
                Frame {
                    unit_id: 0,
                    primary: false,
                    at_ms: 75.0,
                    action: Action::ButtonUp,
                },
            ],
            first_guard_delay: Duration::from_millis(50),
            log: Arc::clone(&log),
        }));
        let snapshot = runtime.observe("1").unwrap();
        runtime
            .start(plan(snapshot.snapshot_id, "holds", 0, 150))
            .unwrap();
        assert_eq!(terminal(&runtime, "holds").state, "completed");
        let log = lock(&log);
        assert_eq!(log.len(), 4);
        assert!(log[1].1.duration_since(log[0].1) >= Duration::from_millis(35));
        assert!(log[3].1.duration_since(log[2].1) >= Duration::from_millis(40));
    }
}

//! Retained semantic journal and bounded, operation-local pointer classification.
use crate::protocol::{EffectOutcome, Fault, Kind, PausePolicy, Resolution, Result, valid_id};
use crate::runtime::{
    Action, Disposition, Frame, JournalEntry, Key, Point, ResolvedEffect, WorkProgress,
};
use std::collections::VecDeque;

pub(crate) struct Ledger {
    pub anchor: Point,
    pub frames: Vec<Frame>,
    pub entries: Vec<JournalEntry>,
    pub pending: VecDeque<usize>,
    pub uncertain: Vec<usize>,
    pub interrupted_drag: bool,
    pub inserted: usize,
    pub cleanup_inserted: usize,
    pub total_units: usize,
    remaining_by_unit: Vec<usize>,
    complete_units: usize,
    gestures: Vec<String>,
    current_gesture: Option<String>,
    external_outcomes: Vec<ResolvedEffect>,
    pub bridge_ms: f64,
}
impl Ledger {
    pub fn new(anchor: Point, frames: Vec<Frame>, total_units: usize) -> Self {
        let entries = frames
            .iter()
            .enumerate()
            .map(|(i, f)| JournalEntry {
                frame_id: i,
                unit_id: format!("u{}", f.unit_id),
                revision: 0,
                disposition: Disposition::Unsent,
                primary: f.primary,
                sent: false,
                original_at_ms: f.at_ms,
                external_outcome: None,
                gesture_id: None,
            })
            .collect();
        let pending = (0..frames.len()).collect();
        let mut remaining_by_unit = vec![0; total_units];
        for frame in &frames {
            remaining_by_unit[frame.unit_id] += 1;
        }
        let complete_units = remaining_by_unit.iter().filter(|n| **n == 0).count();
        Self {
            anchor,
            frames,
            entries,
            pending,
            uncertain: Vec::new(),
            interrupted_drag: false,
            inserted: 0,
            cleanup_inserted: 0,
            total_units,
            remaining_by_unit,
            complete_units,
            gestures: Vec::new(),
            current_gesture: None,
            external_outcomes: Vec::new(),
            bridge_ms: 0.0,
        }
    }
    pub fn sent(&mut self, index: usize, count: usize) {
        self.entries[index].disposition = Disposition::Inserted;
        self.entries[index].sent = true;
        self.inserted += count;
        self.pending.pop_front();
        let remaining = &mut self.remaining_by_unit[self.frames[index].unit_id];
        *remaining -= 1;
        if *remaining == 0 {
            self.complete_units += 1;
        }
    }
    fn uncertain(&mut self, unit: usize) {
        if !self.uncertain.contains(&unit) {
            self.uncertain.push(unit);
        }
        for (f, e) in self.frames.iter().zip(&mut self.entries) {
            if f.unit_id == unit && f.primary && e.disposition == Disposition::Inserted {
                e.disposition = Disposition::Uncertain;
            }
        }
    }
    pub fn suspend(&mut self, kind: Kind, failed: Option<usize>, keys: &[Key], button: bool) {
        if let Some(i) = failed
            && self.entries[i].sent
            && self
                .frames
                .iter()
                .zip(&self.entries)
                .any(|(f, e)| f.unit_id == self.frames[i].unit_id && f.primary && e.sent)
        {
            self.uncertain(self.frames[i].unit_id);
        }
        let partial: Vec<_> = self
            .frames
            .iter()
            .zip(&self.entries)
            .filter(|(f, e)| {
                f.primary
                    && e.disposition == Disposition::Inserted
                    && self.remaining_by_unit[f.unit_id] > 0
            })
            .map(|(f, _)| f.unit_id)
            .collect();
        for unit in partial {
            self.uncertain(unit);
        }
        for key in keys {
            if let Some(i) = self
                .pending
                .iter()
                .copied()
                .find(|i| matches!(self.frames[*i].action,Action::KeyUp(k) if k==*key))
            {
                self.entries[i].disposition = Disposition::SatisfiedByCleanup;
            }
        }
        if button {
            if let Some(i) = self
                .pending
                .iter()
                .copied()
                .find(|i| matches!(self.frames[*i].action, Action::ButtonUp))
            {
                self.entries[i].disposition = Disposition::SatisfiedByCleanup;
            }
            if let Some(f) = self
                .frames
                .iter()
                .zip(&self.entries)
                .rev()
                .find(|(f, e)| {
                    matches!(f.action, Action::ButtonDown) && e.disposition == Disposition::Inserted
                })
                .map(|(f, _)| *f)
            {
                self.uncertain(f.unit_id);
            }
            self.interrupted_drag = kind == Kind::Drag;
        }
        self.pending
            .retain(|i| self.entries[*i].disposition == Disposition::Unsent);
        self.recount_pending();
    }
    // Structural changes happen only at pause/resume barriers. The scheduled
    // frame path decrements one unit count and never scans the pending journal.
    fn recount_pending(&mut self) {
        self.remaining_by_unit.clear();
        self.remaining_by_unit.resize(self.total_units, 0);
        for i in &self.pending {
            self.remaining_by_unit[self.frames[*i].unit_id] += 1;
        }
        let mut uncertain = vec![false; self.total_units];
        for unit in &self.uncertain {
            uncertain[*unit] = true;
        }
        self.complete_units = self
            .remaining_by_unit
            .iter()
            .enumerate()
            .filter(|(unit, remaining)| **remaining == 0 && !uncertain[*unit])
            .count();
    }
    /// Fixed-size scheduling update; resolution receipts and uncertainty change
    /// only at barriers, where the full progress snapshot is refreshed.
    pub fn update_progress(&self, progress: &mut WorkProgress) {
        progress.source_units_total = self.total_units;
        progress.source_units_complete = self.complete_units;
        progress.plan_events_inserted = self.inserted;
        progress.cleanup_events_inserted = self.cleanup_inserted;
        progress.remaining_frames = self.pending.len();
        progress.journal = self.entries.iter().rev().take(256).cloned().collect();
        progress.journal.reverse();
        progress.journal_frames_total = self.entries.len();
        progress.journal_truncated = self.entries.len() > 256;
    }
    pub fn progress(&self) -> WorkProgress {
        WorkProgress {
            source_units_total: self.total_units,
            source_units_complete: self.complete_units,
            plan_events_inserted: self.inserted,
            cleanup_events_inserted: self.cleanup_inserted,
            uncertain_unit_ids: self.uncertain.iter().map(|i| format!("u{i}")).collect(),
            remaining_frames: self.pending.len(),
            journal: self
                .entries
                .iter()
                .rev()
                .take(256)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
            journal_frames_total: self.entries.len(),
            journal_truncated: self.entries.len() > 256,
            external_outcomes: self.external_outcomes.clone(),
        }
    }
    pub fn requirement(&self) -> &'static str {
        if self.interrupted_drag {
            "remaining_gesture_or_finish"
        } else if !self.uncertain.is_empty() {
            "resolve_uncertain_effects"
        } else {
            "fresh_external_observation"
        }
    }
    pub fn check_resolution(&self, resolution: &Resolution, current: Point) -> Result<()> {
        let reject = |s| Fault::new("resume_rejected", s);
        let outcomes = match resolution {
            Resolution::Continue => None,
            Resolution::Observed { outcomes }
            | Resolution::Finish { outcomes }
            | Resolution::RemainingGesture { outcomes, .. } => Some(outcomes),
        };
        if let Some(outcomes) = outcomes {
            if outcomes.len() != self.uncertain.len() {
                return Err(reject("Resolve every uncertain unit exactly once"));
            }
            for unit in &self.uncertain {
                let id = format!("u{unit}");
                let found: Vec<_> = outcomes.iter().filter(|o| o.unit_id == id).collect();
                if found.len() != 1 || found[0].outcome == EffectOutcome::Unknown {
                    return Err(reject(
                        "Unknown or duplicate effect disposition cannot resume",
                    ));
                }
            }
        } else if !self.uncertain.is_empty() {
            return Err(reject(
                "Uncertain sent effects require external disposition; they can never be replayed",
            ));
        }
        match resolution {
            Resolution::RemainingGesture {
                gesture_id,
                safe_anchor,
                ..
            } => {
                if !self.interrupted_drag
                    || !valid_id(gesture_id)
                    || self.gestures.contains(gesture_id)
                    || *safe_anchor != current
                {
                    return Err(reject(
                        "Remaining gesture needs interrupted drag, new gesture_id and fresh current safe_anchor",
                    ));
                }
                if !self
                    .pending
                    .iter()
                    .any(|i| matches!(self.frames[*i].action, Action::Move(_)))
                {
                    return Err(reject("No remaining drag motion"));
                }
            }
            Resolution::Finish { .. } => {}
            _ if self.interrupted_drag => {
                return Err(reject(
                    "Interrupted drag requires remaining_gesture or finish",
                ));
            }
            _ => {}
        }
        Ok(())
    }
    fn append(&mut self, frame: Frame, revision: u64) -> usize {
        let index = self.frames.len();
        self.frames.push(frame);
        self.entries.push(JournalEntry {
            frame_id: index,
            unit_id: format!("u{}", frame.unit_id),
            revision,
            disposition: Disposition::Unsent,
            primary: frame.primary,
            sent: false,
            original_at_ms: frame.at_ms,
            external_outcome: None,
            gesture_id: self.current_gesture.clone(),
        });
        index
    }
    /// Preserve original frame dispositions. New modifier/bridge/gesture frames
    /// receive new frame IDs; a sent primary effect is never returned to unsent.
    pub fn continuation(
        &mut self,
        resolution: &Resolution,
        current: Point,
        revision: u64,
        active_ms: f64,
    ) -> Result<f64> {
        self.check_resolution(resolution, current)?;
        if self.frames.len() + self.pending.len() * 3 + 128 > 60000 {
            return Err(Fault::new("resume_limit", "Journal frame budget exhausted"));
        }
        let mut bridge = 0.0;
        let bridge_target = self
            .pending
            .iter()
            .copied()
            .find(|i| !self.uncertain.contains(&self.frames[*i].unit_id))
            .and_then(|i| match self.frames[i].action {
                Action::Move(p) => Some((p, Some(i), self.frames[i].unit_id)),
                Action::ButtonDown
                    if !matches!(resolution, Resolution::RemainingGesture { .. }) =>
                {
                    Some((self.anchor, None, self.frames[i].unit_id))
                }
                _ => None,
            });
        if !matches!(resolution, Resolution::Finish { .. })
            && let Some((destination, _, _)) = bridge_target
        {
            let distance = (f64::from(destination.x) - f64::from(current.x))
                .hypot(f64::from(destination.y) - f64::from(current.y));
            bridge = (distance / 8.0).ceil() * 8.0;
            if bridge > 1000.0 || self.bridge_ms + bridge > 10000.0 {
                return Err(Fault::new(
                    "unsafe_route",
                    "Smooth bridge exceeds 1000 ms or cumulative 10000 ms budget",
                ));
            }
        }
        for unit in &self.uncertain {
            let outcomes = match resolution {
                Resolution::Continue => None,
                Resolution::Observed { outcomes }
                | Resolution::Finish { outcomes }
                | Resolution::RemainingGesture { outcomes, .. } => Some(outcomes),
            };
            let outcome = outcomes.and_then(|outcomes| {
                outcomes
                    .iter()
                    .find(|o| o.unit_id == format!("u{unit}"))
                    .map(|o| o.outcome)
            });
            if let Some(outcome) = outcome {
                self.external_outcomes.push(ResolvedEffect {
                    unit_id: format!("u{unit}"),
                    outcome,
                    pause_revision: revision,
                });
            }
            for (frame, entry) in self.frames.iter().zip(&mut self.entries) {
                if frame.unit_id == *unit {
                    entry.external_outcome = outcome;
                }
                if frame.unit_id == *unit
                    && matches!(
                        entry.disposition,
                        Disposition::Unsent | Disposition::Uncertain
                    )
                {
                    entry.disposition = Disposition::ExternallyResolved;
                }
            }
        }
        self.uncertain.clear();
        self.pending
            .retain(|i| self.entries[*i].disposition == Disposition::Unsent);
        if matches!(resolution, Resolution::Finish { .. }) {
            for i in self.pending.drain(..) {
                self.entries[i].disposition = Disposition::ExternallyResolved;
            }
            self.interrupted_drag = false;
            self.recount_pending();
            return Ok(0.0);
        }
        let rebase = self
            .pending
            .front()
            .map(|i| self.frames[*i].at_ms.min(active_ms))
            .unwrap_or(active_ms);
        for i in &self.pending {
            self.frames[*i].at_ms = (self.frames[*i].at_ms - rebase).max(0.0) + bridge;
        }
        // A completed modifier-down may be needed for an unsent primary key.
        // Its old up was satisfied by cleanup; append a new balanced pulse.
        let modifiers: Vec<_> =
            self.frames
                .iter()
                .zip(&self.entries)
                .filter_map(|(f, e)| {
                    if e.disposition == Disposition::Inserted
                        && !f.primary
                        && let Action::KeyDown(k) = f.action
                        && self.pending.iter().any(|i| {
                            self.frames[*i].unit_id == f.unit_id && self.frames[*i].primary
                        })
                    {
                        Some((f.unit_id, k))
                    } else {
                        None
                    }
                })
                .collect();
        let mut extra = Vec::new();
        for (unit, key) in modifiers {
            if extra
                .iter()
                .any(|(_, u, k): &(usize, usize, Key)| *u == unit && *k == key)
            {
                continue;
            }
            let start = self
                .pending
                .iter()
                .find(|i| self.frames[**i].unit_id == unit)
                .map(|i| self.frames[*i].at_ms)
                .unwrap_or(bridge);
            let end = self
                .pending
                .iter()
                .filter(|i| self.frames[**i].unit_id == unit)
                .map(|i| self.frames[*i].at_ms)
                .fold(start + 35.0, f64::max);
            let down = self.append(
                Frame {
                    at_ms: start,
                    action: Action::KeyDown(key),
                    unit_id: unit,
                    primary: false,
                },
                revision,
            );
            let up = self.append(
                Frame {
                    at_ms: end,
                    action: Action::KeyUp(key),
                    unit_id: unit,
                    primary: false,
                },
                revision,
            );
            extra.push((down, unit, key));
            self.pending.push_back(up);
        }
        for (index, _, _) in extra.into_iter().rev() {
            self.pending.push_front(index);
        }
        if let Resolution::RemainingGesture { gesture_id, .. } = resolution {
            self.gestures.push(gesture_id.clone());
            self.current_gesture = Some(gesture_id.clone());
            let old: Vec<_> = self.pending.drain(..).collect();
            let mut motion = Vec::new();
            for i in old {
                if matches!(self.frames[i].action, Action::Move(_)) {
                    let f = self.frames[i];
                    self.entries[i].disposition = Disposition::SupersededMotion;
                    let id = self.append(f, revision);
                    motion.push(id);
                } else {
                    self.entries[i].disposition = Disposition::ExternallyResolved;
                }
            }
            let unit = self.total_units;
            self.total_units += 1;
            let down = self.append(
                Frame {
                    at_ms: 0.0,
                    action: Action::ButtonDown,
                    unit_id: unit,
                    primary: true,
                },
                revision,
            );
            let end = motion
                .iter()
                .map(|i| self.frames[*i].at_ms)
                .fold(40.0, f64::max)
                + 40.0;
            let up = self.append(
                Frame {
                    at_ms: end,
                    action: Action::ButtonUp,
                    unit_id: unit,
                    primary: true,
                },
                revision,
            );
            self.pending.push_back(down);
            self.pending.extend(motion);
            self.pending.push_back(up);
            self.interrupted_drag = false;
        }
        if bridge > 0.0
            && let Some((destination, replace, unit)) = bridge_target
        {
            let n = (bridge / 8.0) as usize;
            let replace =
                if replace.is_some() && matches!(resolution, Resolution::RemainingGesture { .. }) {
                    self.pending
                        .iter()
                        .copied()
                        .find(|i| matches!(self.frames[*i].action, Action::Move(_)))
                } else {
                    replace
                };
            if let Some(i) = replace {
                self.entries[i].disposition = Disposition::SupersededMotion;
                self.pending.retain(|id| *id != i);
            }
            let mut approach = Vec::with_capacity(n);
            for step in 1..=n {
                let t = step as f64 / n as f64;
                let point = Point {
                    x: (f64::from(current.x)
                        + (f64::from(destination.x) - f64::from(current.x)) * t)
                        .round() as i32,
                    y: (f64::from(current.y)
                        + (f64::from(destination.y) - f64::from(current.y)) * t)
                        .round() as i32,
                };
                let id = self.append(
                    Frame {
                        at_ms: step as f64 * 8.0,
                        action: Action::Move(point),
                        unit_id: unit,
                        primary: false,
                    },
                    revision,
                );
                approach.push(id);
            }
            // Stable timestamp sorting must retain the approach before original
            // frames at the endpoint, including a down at exactly bridge ms.
            for id in approach.into_iter().rev() {
                self.pending.push_front(id);
            }
        }
        let mut pending: Vec<_> = self.pending.drain(..).collect();
        pending.sort_by(|a, b| self.frames[*a].at_ms.total_cmp(&self.frames[*b].at_ms));
        self.pending = pending.into();
        self.recount_pending();
        self.bridge_ms += bridge;
        Ok(bridge + active_ms - rebase)
    }
}

pub(crate) struct PointerTrace {
    samples: VecDeque<(u64, Point)>,
    anchor: Point,
    last_motion: u64,
    pub summary: crate::runtime::TrajectorySummary,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MotionClass {
    Sampling,
    Transient,
    Large,
    Manual,
}
impl PointerTrace {
    pub fn new(point: Point) -> Self {
        Self {
            samples: VecDeque::from([(0, point)]),
            anchor: point,
            last_motion: 0,
            summary: Default::default(),
        }
    }
    pub fn sample(
        &mut self,
        at: u64,
        point: Point,
        p: &PausePolicy,
        _deviation: u32,
    ) -> MotionClass {
        if at > p.window_ms {
            self.summary.observed_ms = p.window_ms;
            return MotionClass::Manual;
        }
        if let Some((_, last)) = self.samples.back()
            && distance(*last, point) > 1.0
        {
            self.last_motion = at;
        }
        self.samples.push_back((at, point));
        while self.samples.len() > 256
            || self
                .samples
                .front()
                .is_some_and(|(t, _)| at.saturating_sub(*t) > p.window_ms)
        {
            self.samples.pop_front();
        }
        let mut path = 0.0;
        let mut range: f64 = 0.0;
        let mut changes = Vec::new();
        for i in 1..self.samples.len() {
            let (t, b) = self.samples[i];
            let (_, a) = self.samples[i - 1];
            let d = distance(a, b);
            if d > 1.0 {
                path += d;
                changes.push(t);
            }
            for (_, prior) in self.samples.iter().take(i) {
                range = range.max(distance(*prior, b));
            }
        }
        let span = changes
            .last()
            .zip(changes.first())
            .map(|(a, b)| a.saturating_sub(*b))
            .unwrap_or(0);
        self.summary = crate::runtime::TrajectorySummary {
            observed_ms: at,
            sample_count: self.samples.len(),
            range_px: range,
            path_px: path,
            motion_span_ms: span,
            stable_for_ms: at.saturating_sub(self.last_motion),
        };
        let sustained = changes.len() >= 3
            && changes
                .last()
                .zip(changes.first())
                .is_some_and(|(a, b)| a.saturating_sub(*b) >= p.sustained_ms);
        if range >= f64::from(p.large_range_px) && path >= f64::from(p.large_path_px) && sustained {
            MotionClass::Large
        } else if at >= p.stable_ms
            && at.saturating_sub(self.last_motion) >= p.stable_ms
            && distance(self.anchor, point) <= f64::from(p.small_excursion_px)
            && range <= f64::from(p.small_excursion_px)
        {
            MotionClass::Transient
        } else if at >= p.window_ms {
            MotionClass::Manual
        } else {
            MotionClass::Sampling
        }
    }
}
fn distance(a: Point, b: Point) -> f64 {
    (f64::from(a.x) - f64::from(b.x)).hypot(f64::from(a.y) - f64::from(b.y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{EffectOutcome, Outcome};
    fn frame(unit_id: usize, at_ms: f64, action: Action, primary: bool) -> Frame {
        Frame {
            unit_id,
            at_ms,
            action,
            primary,
        }
    }
    fn key(code: u16, unicode: bool) -> Key {
        Key {
            code,
            unicode,
            extended: false,
        }
    }
    fn observed(unit: &str, outcome: EffectOutcome) -> Resolution {
        Resolution::Observed {
            outcomes: vec![Outcome {
                unit_id: unit.into(),
                outcome,
            }],
        }
    }
    #[test]
    fn supplementary_unicode_never_replays_sent_half_even_when_not_applied() {
        let high = key(0xd83d, true);
        let low = key(0xde00, true);
        let mut ledger = Ledger::new(
            Point { x: 0, y: 0 },
            vec![
                frame(0, 0.0, Action::KeyDown(high), true),
                frame(0, 35.0, Action::KeyUp(high), false),
                frame(0, 35.0, Action::KeyDown(low), true),
                frame(0, 70.0, Action::KeyUp(low), false),
            ],
            1,
        );
        ledger.sent(0, 1);
        ledger.suspend(Kind::Typing, None, &[high], false);
        assert!(
            ledger
                .check_resolution(&Resolution::Continue, Point { x: 0, y: 0 })
                .is_err()
        );
        assert!(
            ledger
                .check_resolution(
                    &observed("u0", EffectOutcome::Unknown),
                    Point { x: 0, y: 0 }
                )
                .is_err()
        );
        assert_eq!(ledger.entries[0].disposition, Disposition::Uncertain);
        ledger
            .continuation(
                &observed("u0", EffectOutcome::NotApplied),
                Point { x: 0, y: 0 },
                1,
                10.0,
            )
            .unwrap();
        assert!(ledger.pending.is_empty());
        assert_eq!(ledger.inserted, 1);
        assert_eq!(
            ledger.entries[1].disposition,
            Disposition::SatisfiedByCleanup
        );
    }
    #[test]
    fn modifier_only_interruption_gets_new_balanced_modifier_frames() {
        let ctrl = key(29, false);
        let main = key(30, false);
        let mut ledger = Ledger::new(
            Point { x: 0, y: 0 },
            vec![
                frame(0, 0.0, Action::KeyDown(ctrl), false),
                frame(0, 0.0, Action::KeyDown(main), true),
                frame(0, 40.0, Action::KeyUp(main), false),
                frame(0, 40.0, Action::KeyUp(ctrl), false),
            ],
            1,
        );
        ledger.sent(0, 1);
        ledger.suspend(Kind::Key, None, &[ctrl], false);
        ledger
            .continuation(&Resolution::Continue, Point { x: 0, y: 0 }, 1, 0.0)
            .unwrap();
        let actions: Vec<_> = ledger
            .pending
            .iter()
            .map(|i| ledger.frames[*i].action)
            .collect();
        assert!(matches!(actions[0],Action::KeyDown(k) if k==ctrl));
        assert!(matches!(actions[1],Action::KeyDown(k) if k==main));
        assert!(matches!(actions[3],Action::KeyUp(k) if k==ctrl));
        assert_eq!(ledger.entries[0].disposition, Disposition::Inserted);
        assert_eq!(
            ledger.entries[3].disposition,
            Disposition::SatisfiedByCleanup
        );
        assert_eq!(ledger.entries[4].revision, 1);
    }
    #[test]
    fn resume_does_not_shorten_unstarted_key_hold_after_scheduling_delay() {
        let main = key(30, false);
        let mut ledger = Ledger::new(
            Point { x: 0, y: 0 },
            vec![
                frame(0, 0.0, Action::KeyDown(main), true),
                frame(0, 40.0, Action::KeyUp(main), false),
            ],
            1,
        );
        ledger
            .continuation(&Resolution::Continue, Point { x: 0, y: 0 }, 1, 20.0)
            .unwrap();
        let pending: Vec<_> = ledger
            .pending
            .iter()
            .map(|i| ledger.frames[*i].at_ms)
            .collect();
        assert!(pending[1] - pending[0] >= 40.0);
    }
    #[test]
    fn resume_before_drag_down_bridges_to_original_anchor_before_new_hold() {
        let mut ledger = Ledger::new(
            Point { x: 0, y: 0 },
            vec![
                frame(0, 0.0, Action::ButtonDown, true),
                frame(1, 40.0, Action::Move(Point { x: 40, y: 0 }), false),
                frame(2, 80.0, Action::ButtonUp, true),
            ],
            3,
        );
        ledger
            .continuation(&Resolution::Continue, Point { x: 10, y: 0 }, 1, 10.0)
            .unwrap();
        let actions: Vec<_> = ledger
            .pending
            .iter()
            .map(|i| ledger.frames[*i].action)
            .collect();
        assert!(
            matches!(actions[0],Action::Move(Point{x,..}) if x<10),
            "Approach must return to intended source before down, never bridge to the later drag destination"
        );
    }
    #[test]
    fn bridge_endpoint_precedes_button_down_even_when_original_move_and_down_tie() {
        for tied_move in [false, true] {
            let mut frames = Vec::new();
            if tied_move {
                frames.push(frame(0, 0.0, Action::Move(Point { x: 0, y: 0 }), false));
            }
            frames.push(frame(usize::from(tied_move), 0.0, Action::ButtonDown, true));
            frames.push(frame(
                usize::from(tied_move) + 1,
                40.0,
                Action::ButtonUp,
                true,
            ));
            let mut ledger =
                Ledger::new(Point { x: 0, y: 0 }, frames, if tied_move { 3 } else { 2 });
            ledger
                .continuation(&Resolution::Continue, Point { x: 10, y: 0 }, 1, 10.0)
                .unwrap();
            let mut cursor = Point { x: 10, y: 0 };
            let mut held = false;
            let mut actual = Vec::new();
            for i in &ledger.pending {
                let f = ledger.frames[*i];
                match f.action {
                    Action::Move(p) => {
                        assert!(!held, "Approach must finish before the hold");
                        cursor = p;
                        actual.push(("move", p.x, f.at_ms));
                    }
                    Action::ButtonDown => {
                        assert_eq!(
                            cursor,
                            Point { x: 0, y: 0 },
                            "Down must use retained anchor"
                        );
                        held = true;
                        actual.push(("down", cursor.x, f.at_ms));
                    }
                    Action::ButtonUp => {
                        assert!(held);
                        held = false;
                        actual.push(("up", cursor.x, f.at_ms));
                    }
                    _ => panic!("Unexpected input"),
                }
            }
            assert!(!held);
            assert_eq!(
                actual,
                vec![
                    ("move", 5, 8.0),
                    ("move", 0, 16.0),
                    ("down", 0, 16.0),
                    ("up", 0, 56.0)
                ]
            );
        }
    }
    #[test]
    fn sent_wheel_and_clipboard_primary_need_outcome_and_never_replay() {
        for action in [
            Action::Wheel {
                axis: crate::protocol::Axis::Vertical,
                delta: 120,
            },
            Action::KeyDown(key(47, false)),
        ] {
            let mut ledger =
                Ledger::new(Point { x: 0, y: 0 }, vec![frame(0, 0.0, action, true)], 1);
            ledger.sent(0, 1);
            ledger.suspend(Kind::Paste, Some(0), &[], false);
            assert_eq!(ledger.uncertain, vec![0]);
            ledger
                .continuation(
                    &observed("u0", EffectOutcome::NotApplied),
                    Point { x: 0, y: 0 },
                    1,
                    0.0,
                )
                .unwrap();
            assert!(ledger.pending.is_empty());
        }
    }
    #[test]
    fn verification_failure_after_key_release_retains_unit_uncertainty() {
        let k = key(30, false);
        let mut ledger = Ledger::new(
            Point { x: 0, y: 0 },
            vec![
                frame(0, 0.0, Action::KeyDown(k), true),
                frame(0, 40.0, Action::KeyUp(k), false),
            ],
            1,
        );
        ledger.sent(0, 1);
        ledger.sent(1, 1);
        ledger.suspend(Kind::Key, Some(1), &[], false);
        assert_eq!(ledger.uncertain, vec![0]);
    }
    #[test]
    fn held_drag_needs_new_checked_gesture_and_retains_original_journal() {
        let mut ledger = Ledger::new(
            Point { x: 0, y: 0 },
            vec![
                frame(0, 0.0, Action::ButtonDown, true),
                frame(1, 40.0, Action::Move(Point { x: 16, y: 0 }), false),
                frame(2, 80.0, Action::ButtonUp, true),
            ],
            3,
        );
        ledger.sent(0, 1);
        ledger.suspend(Kind::Drag, None, &[], true);
        assert!(
            ledger
                .check_resolution(
                    &observed("u0", EffectOutcome::Applied),
                    Point { x: 0, y: 0 }
                )
                .is_err()
        );
        let resume = Resolution::RemainingGesture {
            gesture_id: "g1".into(),
            safe_anchor: Point { x: 0, y: 0 },
            outcomes: vec![Outcome {
                unit_id: "u0".into(),
                outcome: EffectOutcome::Applied,
            }],
        };
        assert!(
            ledger
                .check_resolution(&resume, Point { x: 1, y: 0 })
                .is_err()
        );
        ledger
            .continuation(&resume, Point { x: 0, y: 0 }, 1, 20.0)
            .unwrap();
        assert_eq!(
            ledger.entries[0].disposition,
            Disposition::ExternallyResolved
        );
        assert_eq!(ledger.entries[1].disposition, Disposition::SupersededMotion);
        assert_eq!(
            ledger.entries[2].disposition,
            Disposition::SatisfiedByCleanup
        );
        assert!(matches!(
            ledger.frames[*ledger.pending.front().unwrap()].action,
            Action::ButtonDown
        ));
        assert_eq!(
            ledger
                .pending
                .iter()
                .filter(|i| matches!(ledger.frames[**i].action, Action::ButtonDown))
                .count(),
            1
        );
    }
    #[test]
    fn pointer_classifier_requires_separated_sustained_motion_and_detects_before_three_seconds() {
        let p = PausePolicy::default();
        let mut trace = PointerTrace::new(Point { x: 0, y: 0 });
        assert_eq!(
            trace.sample(20, Point { x: 500, y: 0 }, &p, 8),
            MotionClass::Sampling
        );
        assert_eq!(
            trace.sample(3000, Point { x: 500, y: 0 }, &p, 8),
            MotionClass::Manual
        );
        let mut trace = PointerTrace::new(Point { x: 0, y: 0 });
        for (at, x) in [(100, 80), (300, 160), (500, 240)] {
            assert_eq!(
                trace.sample(at, Point { x, y: 0 }, &p, 8),
                MotionClass::Sampling
            );
        }
        assert_eq!(
            trace.sample(700, Point { x: 320, y: 0 }, &p, 8),
            MotionClass::Large
        );
        let mut trace = PointerTrace::new(Point { x: 0, y: 0 });
        assert_eq!(
            trace.sample(20, Point { x: 20, y: 0 }, &p, 8),
            MotionClass::Sampling
        );
        assert_eq!(
            trace.sample(370, Point { x: 20, y: 0 }, &p, 8),
            MotionClass::Transient
        );
        let mut trace = PointerTrace::new(Point { x: 0, y: 0 });
        trace.sample(100, Point { x: -100, y: 0 }, &p, 8);
        trace.sample(400, Point { x: 100, y: 0 }, &p, 8);
        assert_eq!(
            trace.sample(700, Point { x: -100, y: 0 }, &p, 8),
            MotionClass::Large
        );
    }
}

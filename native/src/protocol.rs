use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Move {
        x: f64,
        y: f64,
        at_ms: f64,
    },
    ButtonDown {
        at_ms: f64,
    },
    ButtonUp {
        at_ms: f64,
    },
    Char {
        text: String,
        at_ms: f64,
    },
    Backspace {
        at_ms: f64,
    },
    Wheel {
        axis: Axis,
        delta: i32,
        at_ms: f64,
    },
    Key {
        key: NamedKey,
        #[serde(default)]
        modifiers: Vec<Modifier>,
        at_ms: f64,
    },
    Clipboard {
        action: ClipboardAction,
        at_ms: f64,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    Vertical,
    Horizontal,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardAction {
    Copy,
    Cut,
    Paste,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Modifier {
    Ctrl,
    Shift,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NamedKey {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Insert,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    A,
    Z,
    Y,
    F,
}
impl NamedKey {
    pub fn vk(self) -> u16 {
        match self {
            Self::Enter => 13,
            Self::Tab => 9,
            Self::Escape => 27,
            Self::Backspace => 8,
            Self::Delete => 46,
            Self::Insert => 45,
            Self::Left => 37,
            Self::Right => 39,
            Self::Up => 38,
            Self::Down => 40,
            Self::Home => 36,
            Self::End => 35,
            Self::PageUp => 33,
            Self::PageDown => 34,
            Self::A => 65,
            Self::Z => 90,
            Self::Y => 89,
            Self::F => 70,
        }
    }
    pub fn allowed(self, modifiers: &[Modifier]) -> bool {
        if modifiers.len() > 2 || (modifiers.len() == 2 && modifiers[0] == modifiers[1]) {
            return false;
        }
        let ctrl = modifiers.contains(&Modifier::Ctrl);
        let shift = modifiers.contains(&Modifier::Shift);
        let navigation = matches!(
            self,
            Self::Left
                | Self::Right
                | Self::Up
                | Self::Down
                | Self::Home
                | Self::End
                | Self::PageUp
                | Self::PageDown
        );
        match (ctrl, shift) {
            (false, false) => !matches!(self, Self::A | Self::Z | Self::Y | Self::F),
            (false, true) | (true, true) => navigation,
            (true, false) => {
                navigation
                    || matches!(
                        self,
                        Self::A
                            | Self::Z
                            | Self::Y
                            | Self::F
                            | Self::Backspace
                            | Self::Delete
                            | Self::Enter
                    )
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Move,
    Click,
    Drag,
    Typing,
    Reading,
    Scroll,
    Key,
    Copy,
    Cut,
    Paste,
    Activate,
}
impl Kind {
    pub fn keyboard(self) -> bool {
        matches!(
            self,
            Self::Typing | Self::Key | Self::Copy | Self::Cut | Self::Paste
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SafeArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl SafeArea {
    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= f64::from(self.x)
            && y >= f64::from(self.y)
            && x < f64::from(self.x) + f64::from(self.width)
            && y < f64::from(self.y) + f64::from(self.height)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PausePolicy {
    pub stable_ms: u64,
    pub small_excursion_px: u32,
    pub large_range_px: u32,
    pub large_path_px: u32,
    pub sustained_ms: u64,
    pub window_ms: u64,
    pub lifetime_ms: u64,
}
impl Default for PausePolicy {
    fn default() -> Self {
        Self {
            stable_ms: 350,
            small_excursion_px: 80,
            large_range_px: 180,
            large_path_px: 240,
            sustained_ms: 500,
            window_ms: 3000,
            lifetime_ms: 300000,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    pub operation_id: String,
    pub snapshot_id: String,
    pub kind: Kind,
    pub duration_ms: f64,
    pub events: Vec<Event>,
    #[serde(default = "default_threshold")]
    pub threshold_px: u32,
    #[serde(default)]
    pub force_ime_off: bool,
    #[serde(default)]
    pub safe_area: Option<SafeArea>,
    #[serde(default)]
    pub safe_area_confirmed: bool,
    #[serde(default)]
    pub pause_policy: PausePolicy,
}

fn default_threshold() -> u32 {
    8
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Fault {
    pub code: String,
    pub message: String,
}
impl Fault {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Fault>;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub unit_id: String,
    pub outcome: EffectOutcome,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectOutcome {
    Applied,
    NotApplied,
    Unknown,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Resolution {
    Continue,
    Observed {
        outcomes: Vec<Outcome>,
    },
    Finish {
        outcomes: Vec<Outcome>,
    },
    RemainingGesture {
        gesture_id: String,
        safe_anchor: crate::runtime::Point,
        outcomes: Vec<Outcome>,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resume {
    pub operation_id: String,
    pub pause_revision: u64,
    pub snapshot_id: String,
    pub external_checked: bool,
    pub resolution: Resolution,
}

impl Start {
    pub fn validate(&self) -> Result<()> {
        let invalid = |message| Fault::new("invalid_plan", message);
        if !valid_id(&self.operation_id) || !valid_id(&self.snapshot_id) {
            return Err(invalid("IDs must contain 1..128 non-control characters"));
        }
        let max_duration = match self.kind {
            Kind::Typing => 45_000.0,
            Kind::Reading => 60_000.0,
            _ => 15_000.0,
        };
        if !self.duration_ms.is_finite()
            || self.duration_ms <= 0.0
            || self.duration_ms > max_duration
            || self.events.is_empty()
            || self.events.len() > 12_000
        {
            return Err(invalid("Empty or unbounded plan"));
        }
        if !(1..=100).contains(&self.threshold_px) {
            return Err(invalid("threshold_px must be 1..100"));
        }
        let p = &self.pause_policy;
        if !(100..=2000).contains(&p.stable_ms)
            || !(self.threshold_px..=200).contains(&p.small_excursion_px)
            || !(p.small_excursion_px + 1..=1000).contains(&p.large_range_px)
            || !(p.large_range_px..=3000).contains(&p.large_path_px)
            || !(200..=2000).contains(&p.sustained_ms)
            || !(p.sustained_ms.max(p.stable_ms)..=3000).contains(&p.window_ms)
            || !(1000..=300000).contains(&p.lifetime_ms)
        {
            return Err(invalid("Invalid bounded pause policy"));
        }
        if self.kind == Kind::Activate {
            if !self.safe_area_confirmed
                || self.safe_area.is_none_or(|s| s.width <= 0 || s.height <= 0)
            {
                return Err(invalid(
                    "Activation requires explicit safe area confirmation",
                ));
            }
        } else if self.safe_area.is_some() || self.safe_area_confirmed {
            return Err(invalid("Safe area is only valid for activate"));
        }
        if matches!(self.kind, Kind::Key | Kind::Copy | Kind::Cut | Kind::Paste)
            && self.events.len() != 1
        {
            return Err(invalid(
                "Exactly one semantic key/clipboard operation is required",
            ));
        }
        if self.force_ime_off && self.kind != Kind::Typing {
            return Err(invalid("force_ime_off is only valid for typing"));
        }
        let mut previous = 0.0;
        let mut available = 0.0;
        let mut down = false;
        let mut pairs = 0;
        let mut moved_while_down = false;
        let mut point = None;
        let mut scroll: Option<(Axis, i32, i32)> = None;
        for event in &self.events {
            if self.kind == Kind::Activate && pairs != 0 {
                return Err(invalid("Activation button_up must be the final input"));
            }
            let at = event.at_ms();
            if !at.is_finite() || at < previous || at > self.duration_ms {
                return Err(invalid(
                    "Event times must be finite, monotonic, and within duration_ms",
                ));
            }
            previous = at;
            match event {
                Event::Move { x, y, .. } => {
                    if !matches!(
                        self.kind,
                        Kind::Move | Kind::Click | Kind::Drag | Kind::Reading | Kind::Activate
                    ) || !x.is_finite()
                        || !y.is_finite()
                        || x.abs() > i32::MAX as f64
                        || y.abs() > i32::MAX as f64
                    {
                        return Err(invalid("Invalid move event"));
                    }
                    if down {
                        moved_while_down = true;
                    }
                    point = Some((*x, *y));
                }
                Event::ButtonDown { .. } => {
                    if !matches!(self.kind, Kind::Click | Kind::Drag | Kind::Activate)
                        || down
                        || pairs != 0
                    {
                        return Err(invalid("Invalid button_down"));
                    }
                    if self.kind == Kind::Activate
                        && point
                            .is_none_or(|(x, y)| !self.safe_area.is_some_and(|s| s.contains(x, y)))
                    {
                        return Err(invalid(
                            "Activation click must be inside declared safe area",
                        ));
                    }
                    down = true;
                }
                Event::ButtonUp { .. } => {
                    if !down {
                        return Err(invalid("Unbalanced button_up"));
                    }
                    down = false;
                    pairs += 1;
                }
                Event::Char { text, .. } => {
                    let mut chars = text.chars();
                    let Some(c) = chars.next() else {
                        return Err(invalid("Character must contain one Unicode codepoint"));
                    };
                    if self.kind != Kind::Typing
                        || chars.next().is_some()
                        || c.is_control()
                        || matches!(c, '\u{2028}' | '\u{2029}')
                    {
                        return Err(invalid("Only one printable Unicode codepoint is allowed"));
                    }
                    if at < available {
                        return Err(invalid("Typing pulses overlap"));
                    }
                    available = at + c.len_utf16() as f64 * 35.0;
                    if available > self.duration_ms {
                        return Err(invalid("Character hold exceeds duration_ms"));
                    }
                }
                Event::Backspace { .. } => {
                    if self.kind != Kind::Typing || at < available {
                        return Err(invalid("Invalid or overlapping backspace"));
                    }
                    available = at + 40.0;
                    if available > self.duration_ms {
                        return Err(invalid("Backspace hold exceeds duration_ms"));
                    }
                }
                Event::Wheel { axis, delta, .. } => {
                    if self.kind != Kind::Scroll
                        || *delta == 0
                        || delta.unsigned_abs() > 120
                        || delta % 120 != 0
                    {
                        return Err(invalid("Scroll packets must be +/-120 wheel units"));
                    }
                    if let Some((a, d, total)) = scroll {
                        if a != *axis
                            || d != delta.signum()
                            || total + delta.abs() > 1200
                            || at < available
                        {
                            return Err(invalid(
                                "Scroll requires one axis/direction, <=1200 total and >=40 ms packet spacing",
                            ));
                        }
                        scroll = Some((a, d, total + delta.abs()));
                    } else {
                        scroll = Some((*axis, delta.signum(), delta.abs()));
                    }
                    available = at + 40.0;
                    if available > self.duration_ms {
                        return Err(invalid("Scroll settling exceeds duration"));
                    }
                }
                Event::Key { key, modifiers, .. } => {
                    if self.kind != Kind::Key
                        || !key.allowed(modifiers)
                        || at + 40.0 > self.duration_ms
                    {
                        return Err(invalid(
                            "Key/chord is not allowlisted or hold exceeds duration",
                        ));
                    }
                }
                Event::Clipboard { action, .. } => {
                    let valid = matches!(
                        (self.kind, action),
                        (Kind::Copy, ClipboardAction::Copy)
                            | (Kind::Cut, ClipboardAction::Cut)
                            | (Kind::Paste, ClipboardAction::Paste)
                    );
                    if !valid || at + 40.0 > self.duration_ms {
                        return Err(invalid(
                            "Clipboard event must match dedicated kind and fit hold",
                        ));
                    }
                }
            }
        }
        if down
            || (matches!(self.kind, Kind::Click | Kind::Drag | Kind::Activate) && pairs != 1)
            || (matches!(self.kind, Kind::Click | Kind::Activate) && moved_while_down)
            || (self.kind == Kind::Drag && !moved_while_down)
        {
            return Err(invalid(
                "Click/drag requires one balanced pair; drag requires a held move",
            ));
        }
        Ok(())
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
}

impl Event {
    pub fn at_ms(&self) -> f64 {
        match self {
            Self::Move { at_ms, .. }
            | Self::ButtonDown { at_ms }
            | Self::ButtonUp { at_ms }
            | Self::Char { at_ms, .. }
            | Self::Backspace { at_ms } => *at_ms,
            Self::Wheel { at_ms, .. } | Self::Key { at_ms, .. } | Self::Clipboard { at_ms, .. } => {
                *at_ms
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Hello {
        id: i64,
    },
    Ping {
        id: i64,
    },
    Observe {
        id: i64,
        hwnd: String,
    },
    Start {
        id: i64,
        #[serde(flatten)]
        plan: Start,
    },
    Status {
        id: i64,
        operation_id: String,
    },
    Cancel {
        id: i64,
        operation_id: Option<String>,
        reason: Option<String>,
    },
    Pause {
        id: i64,
        operation_id: String,
        reason: Option<String>,
    },
    Resume {
        id: i64,
        #[serde(flatten)]
        request: Resume,
    },
    Events {
        id: i64,
        #[serde(default)]
        after_seq: u64,
        #[serde(default = "default_event_limit")]
        limit: usize,
    },
}
fn default_event_limit() -> usize {
    32
}
impl Request {
    pub fn id(&self) -> i64 {
        match self {
            Self::Hello { id }
            | Self::Ping { id }
            | Self::Observe { id, .. }
            | Self::Start { id, .. }
            | Self::Status { id, .. }
            | Self::Cancel { id, .. }
            | Self::Pause { id, .. }
            | Self::Resume { id, .. }
            | Self::Events { id, .. } => *id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parses_valid(value: serde_json::Value) -> bool {
        serde_json::from_value::<Start>(value).is_ok_and(|p| p.validate().is_ok())
    }
    #[test]
    fn v2_new_operations_are_one_allowlisted_semantic_action() {
        for (kind, event) in [
            (
                "scroll",
                serde_json::json!({"type":"wheel","axis":"vertical","delta":-120,"at_ms":0}),
            ),
            (
                "key",
                serde_json::json!({"type":"key","key":"insert","modifiers":[],"at_ms":0}),
            ),
            (
                "key",
                serde_json::json!({"type":"key","key":"left","modifiers":["ctrl","shift"],"at_ms":0}),
            ),
            (
                "paste",
                serde_json::json!({"type":"clipboard","action":"paste","at_ms":0}),
            ),
        ] {
            let p = serde_json::json!({"operation_id":"o","snapshot_id":"s","kind":kind,"duration_ms":100,"events":[event]});
            assert!(parses_valid(p.clone()), "{p}");
            if kind != "scroll" {
                let mut duplicate = p;
                duplicate["events"].as_array_mut().unwrap().push(event);
                assert!(!parses_valid(duplicate));
            }
        }
    }
    #[test]
    fn v2_generic_keys_cannot_smuggle_clipboard_or_window_chords() {
        for (key, modifiers) in [
            ("x", vec!["ctrl"]),
            ("v", vec!["ctrl"]),
            ("c", vec!["ctrl"]),
            ("delete", vec!["shift"]),
            ("insert", vec!["shift"]),
            ("tab", vec!["alt"]),
            ("a", vec!["win"]),
        ] {
            assert!(!parses_valid(
                serde_json::json!({"operation_id":"o","snapshot_id":"s","kind":"key","duration_ms":100,"events":[{"type":"key","key":key,"modifiers":modifiers,"at_ms":0}]})
            ));
        }
    }
    #[test]
    fn v2_activation_requires_explicit_safe_area() {
        let mut p = serde_json::json!({"operation_id":"o","snapshot_id":"s","kind":"activate","duration_ms":100,"events":[{"type":"move","x":20,"y":30,"at_ms":0},{"type":"button_down","at_ms":20},{"type":"button_up","at_ms":70}]});
        assert!(!parses_valid(p.clone()));
        p["safe_area"] = serde_json::json!({"x":15,"y":25,"width":20,"height":20});
        p["safe_area_confirmed"] = serde_json::json!(true);
        assert!(parses_valid(p));
    }
    #[test]
    fn activation_rejects_motion_after_button_up_including_timestamp_ties() {
        for at in [70, 80] {
            let p = serde_json::json!({"operation_id":"o","snapshot_id":"s","kind":"activate","duration_ms":100,"safe_area":{"x":15,"y":25,"width":20,"height":20},"safe_area_confirmed":true,"events":[{"type":"move","x":20,"y":30,"at_ms":0},{"type":"button_down","at_ms":20},{"type":"button_up","at_ms":70},{"type":"move","x":40,"y":30,"at_ms":at}]});
            assert!(!parses_valid(p), "Activation must stop at button-up");
        }
    }
    #[test]
    fn pointer_observation_window_cannot_exceed_three_seconds() {
        let p = serde_json::json!({"operation_id":"o","snapshot_id":"s","kind":"move","duration_ms":100,"events":[{"type":"move","x":1,"y":1,"at_ms":0}],"pause_policy":{"window_ms":3001}});
        assert!(!parses_valid(p));
    }
    fn plan(kind: Kind, events: Vec<Event>, duration_ms: u64) -> Start {
        Start {
            operation_id: "op".into(),
            snapshot_id: "snap".into(),
            kind,
            duration_ms: duration_ms as f64,
            events,
            threshold_px: 60,
            force_ime_off: false,
            safe_area: None,
            safe_area_confirmed: false,
            pause_policy: Default::default(),
        }
    }
    #[test]
    fn rejects_unbalanced_or_wrong_kind_buttons() {
        assert!(
            plan(Kind::Drag, vec![Event::ButtonDown { at_ms: 0.0 }], 100)
                .validate()
                .is_err()
        );
        assert!(
            plan(
                Kind::Reading,
                vec![
                    Event::ButtonDown { at_ms: 0.0 },
                    Event::ButtonUp { at_ms: 50.0 }
                ],
                100
            )
            .validate()
            .is_err()
        );
    }
    #[test]
    fn rejects_invalid_char_and_hold_overlap() {
        for text in ["", "\n", "ab", "\u{007f}"] {
            assert!(
                plan(
                    Kind::Typing,
                    vec![Event::Char {
                        text: text.into(),
                        at_ms: 0.0
                    }],
                    100
                )
                .validate()
                .is_err()
            );
        }
        assert!(
            plan(
                Kind::Typing,
                vec![
                    Event::Char {
                        text: "a".into(),
                        at_ms: 0.0
                    },
                    Event::Backspace { at_ms: 20.0 }
                ],
                100
            )
            .validate()
            .is_err()
        );
        assert!(
            plan(
                Kind::Typing,
                vec![Event::Char {
                    text: "😀".into(),
                    at_ms: 0.0
                }],
                69
            )
            .validate()
            .is_err()
        );
    }
    #[test]
    fn rejects_nonfinite_and_unbounded_plans() {
        assert!(
            plan(
                Kind::Move,
                vec![Event::Move {
                    x: f64::NAN,
                    y: 1.,
                    at_ms: 0.0
                }],
                100
            )
            .validate()
            .is_err()
        );
        assert!(plan(Kind::Move, vec![], 100).validate().is_err());
        assert!(
            plan(
                Kind::Move,
                vec![Event::Move {
                    x: 1.,
                    y: 1.,
                    at_ms: 0.0
                }],
                15001
            )
            .validate()
            .is_err()
        );
    }
    #[test]
    fn accepts_balanced_click_drag_and_unicode() {
        assert!(
            plan(
                Kind::Click,
                vec![
                    Event::Move {
                        x: 2.,
                        y: 3.,
                        at_ms: 0.0
                    },
                    Event::ButtonDown { at_ms: 10.0 },
                    Event::ButtonUp { at_ms: 50.0 }
                ],
                100
            )
            .validate()
            .is_ok()
        );
        assert!(
            plan(
                Kind::Drag,
                vec![
                    Event::ButtonDown { at_ms: 0.0 },
                    Event::Move {
                        x: 2.,
                        y: 3.,
                        at_ms: 10.0
                    },
                    Event::ButtonUp { at_ms: 50.0 }
                ],
                100
            )
            .validate()
            .is_ok()
        );
        assert!(
            plan(
                Kind::Typing,
                vec![Event::Char {
                    text: "😀".into(),
                    at_ms: 0.0
                }],
                70
            )
            .validate()
            .is_ok()
        );
    }
    #[test]
    fn request_parser_is_strict_and_start_fields_are_flat() {
        let start = r#"{"id":1,"command":"start","operation_id":"op","snapshot_id":"s","kind":"move","duration_ms":100,"events":[{"type":"move","x":1,"y":2,"at_ms":0}]}"#;
        assert!(serde_json::from_str::<Request>(start).is_ok());
        for raw in [
            r#"{"id":1,"command":"ping","extra":true}"#,
            r#"{"id":1,"command":"wat"}"#,
            r#"{"id":1.5,"command":"hello"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(raw).is_err());
        }
    }
    #[test]
    fn ipc_accepts_fractional_move_and_typing_milliseconds() {
        for raw in [
            r#"{"id":10,"command":"start","operation_id":"move-fraction","snapshot_id":"s","kind":"move","duration_ms":100.125,"events":[{"type":"move","x":1.25,"y":2.5,"at_ms":50.0625}]}"#,
            r#"{"id":11,"command":"start","operation_id":"type-fraction","snapshot_id":"s","kind":"typing","duration_ms":1463.4146341463415,"events":[{"type":"char","text":"H","at_ms":0.25},{"type":"char","text":"i","at_ms":292.6829268292683},{"type":"char","text":" ","at_ms":585.3658536585366},{"type":"char","text":"4","at_ms":878.0487804878048},{"type":"char","text":"!","at_ms":1170.7317073170732}]}"#,
        ] {
            match serde_json::from_str::<Request>(raw).unwrap() {
                Request::Start { plan, .. } => assert!(plan.validate().is_ok()),
                _ => panic!("Expected start"),
            }
        }
        let mut invalid = plan(
            Kind::Move,
            vec![Event::Move {
                x: 1.,
                y: 2.,
                at_ms: f64::NAN,
            }],
            100,
        );
        assert!(invalid.validate().is_err());
        invalid.events = vec![Event::Move {
            x: 1.,
            y: 2.,
            at_ms: -0.001,
        }];
        assert!(invalid.validate().is_err());
        invalid.duration_ms = f64::INFINITY;
        assert!(invalid.validate().is_err());
    }
}

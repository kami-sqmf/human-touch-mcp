//! Read-only window inspection and one-at-a-time SendInput injection.
//! No hooks, clipboard-content access, focus APIs, capture, or application imports.
use crate::protocol::{Axis, ClipboardAction, Event, Fault, Kind, Modifier, Result, Start};
use crate::runtime::{
    Action, Cleanup, Execution, Frame, Key, Platform, Point, Rect, Session, Snapshot,
};
use std::mem::size_of;
use windows::Win32::Foundation::{
    CloseHandle, FILETIME, HANDLE, HWND, LPARAM, POINT, RECT, WAIT_ABANDONED, WAIT_OBJECT_0, WPARAM,
};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::SystemInformation::GetSystemTime;
use windows::Win32::System::Threading::{
    CreateMutexW, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, ReleaseMutex,
    WaitForSingleObject,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::w;

pub struct WindowsPlatform;

fn fault(code: &str, message: &str) -> Fault {
    Fault::new(code, message)
}
fn os_error(context: &str) -> Fault {
    Fault::new(
        "access_restricted",
        format!("{context}: {}", windows::core::Error::from_thread()),
    )
}
fn handle_text(hwnd: HWND) -> String {
    (hwnd.0 as usize).to_string()
}
fn hwnd(text: &str) -> Result<HWND> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|c| c.is_ascii_digit()) {
        return Err(fault("invalid_hwnd", "HWND must be positive decimal"));
    }
    let value = text
        .parse::<usize>()
        .map_err(|_| fault("invalid_hwnd", "HWND is out of range"))?;
    if value == 0 {
        return Err(fault("invalid_hwnd", "HWND must be positive decimal"));
    }
    Ok(HWND(value as *mut std::ffi::c_void))
}

/// Thread DPI context is restored on the same thread; this changes only how
/// this worker interprets coordinates, never the target window's DPI state.
struct DpiContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
impl DpiContext {
    fn enter() -> Result<Self> {
        // SAFETY: documented pseudo-handle; thread-local context only.
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            return Err(os_error("Cannot enter physical-coordinate DPI context"));
        }
        Ok(Self(previous))
    }
}
impl Drop for DpiContext {
    fn drop(&mut self) {
        // SAFETY: context was returned by the matching call on this thread.
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}

struct NativeHandle(HANDLE);
impl Drop for NativeHandle {
    fn drop(&mut self) {
        // SAFETY: the wrapper exclusively owns a successfully created handle.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
struct InputMutex {
    handle: NativeHandle,
    owned: bool,
}
impl InputMutex {
    fn acquire() -> Result<Self> {
        // SAFETY: valid static NUL-terminated name, default security, no owner.
        let handle = unsafe { CreateMutexW(None, false, w!("Local\\HumanInputMCP.Input.v1")) }
            .map_err(|e| Fault::new("input_owner_conflict", e.to_string()))?;
        let mut guard = Self {
            handle: NativeHandle(handle),
            owned: false,
        };
        // SAFETY: live mutex handle; nonblocking acquisition on execution thread.
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == WAIT_OBJECT_0 {
            guard.owned = true;
            return Ok(guard);
        }
        if wait == WAIT_ABANDONED {
            guard.owned = true;
        }
        Err(fault(
            "input_owner_conflict",
            "Another Human worker owns input, or the previous owner abandoned it",
        ))
    }
}
impl Drop for InputMutex {
    fn drop(&mut self) {
        if self.owned {
            // SAFETY: this thread acquired this mutex and is its only releaser.
            unsafe {
                let _ = ReleaseMutex(self.handle.0);
            }
        }
    }
}

fn identity(target: HWND) -> Result<String> {
    let mut pid = 0;
    // SAFETY: valid output pointer; invalid HWND is rejected by zero thread ID.
    if unsafe { GetWindowThreadProcessId(target, Some(&mut pid)) } == 0 {
        return Err(fault("target_changed", "Target no longer exists"));
    }
    // SAFETY: query-only access to an existing process ID, handle is RAII-owned.
    let process = NativeHandle(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map_err(|e| {
            Fault::new(
                "access_restricted",
                format!("Cannot identify target process: {e}"),
            )
        })?,
    );
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: all four output structures are initialized and live for this call.
    unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) }
        .map_err(|e| Fault::new("access_restricted", e.to_string()))?;
    let start = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Ok(format!("{pid}:{start}"))
}
fn rectangle(rect: RECT) -> Rect {
    Rect {
        x: rect.left,
        y: rect.top,
        width: rect.right.saturating_sub(rect.left),
        height: rect.bottom.saturating_sub(rect.top),
    }
}
fn client_rect(target: HWND) -> Result<Rect> {
    let mut client = RECT::default();
    // SAFETY: valid output structures; failures are propagated.
    unsafe { GetClientRect(target, &mut client) }
        .map_err(|e| Fault::new("target_changed", e.to_string()))?;
    let mut origin = POINT {
        x: client.left,
        y: client.top,
    };
    // SAFETY: live point output pointer, no target mutation.
    if !unsafe { ClientToScreen(target, &mut origin) }.as_bool() {
        return Err(os_error("Cannot map target client coordinates"));
    }
    Ok(Rect {
        x: origin.x,
        y: origin.y,
        width: client.right.saturating_sub(client.left),
        height: client.bottom.saturating_sub(client.top),
    })
}
fn cursor() -> Result<Point> {
    let mut point = POINT::default();
    // SAFETY: valid output pointer.
    unsafe { GetCursorPos(&mut point) }
        .map_err(|e| Fault::new("access_restricted", e.to_string()))?;
    Ok(Point {
        x: point.x,
        y: point.y,
    })
}
fn capture(target: HWND) -> Result<Snapshot> {
    // SAFETY: all HWND queries tolerate stale handles; results are checked.
    unsafe {
        if !IsWindow(Some(target)).as_bool() {
            return Err(fault("target_changed", "Target window no longer exists"));
        }
        let identity = identity(target)?;
        let mut rect = RECT::default();
        GetWindowRect(target, &mut rect)
            .map_err(|e| Fault::new("target_changed", e.to_string()))?;
        let client = client_rect(target)?;
        let foreground = GetForegroundWindow();
        let root = GetAncestor(target, GA_ROOT);
        let thread = GetWindowThreadProcessId(target, None);
        let mut gui = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        GetGUIThreadInfo(thread, &mut gui).map_err(|e| {
            Fault::new(
                "access_restricted",
                format!("Cannot inspect target focus: {e}"),
            )
        })?;
        let dpi = GetDpiForWindow(target);
        let ready = !root.0.is_null()
            && foreground == root
            && IsWindowVisible(target).as_bool()
            && IsWindowEnabled(target).as_bool()
            && !IsIconic(target).as_bool()
            && client.width > 0
            && client.height > 0
            && dpi > 0;
        let time = GetSystemTime();
        Ok(Snapshot {
            snapshot_id: String::new(),
            target_id: format!("{}:{}", handle_text(target), identity),
            hwnd: handle_text(target),
            identity,
            rect: rectangle(rect),
            client,
            virtual_desktop: Rect {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            },
            cursor: cursor()?,
            foreground: handle_text(foreground),
            focus: handle_text(gui.hwndFocus),
            dpi,
            ready,
            visible: IsWindowVisible(target).as_bool(),
            enabled: IsWindowEnabled(target).as_bool(),
            minimized: IsIconic(target).as_bool(),
            is_foreground: foreground == root,
            observed_at: format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                time.wYear,
                time.wMonth,
                time.wDay,
                time.wHour,
                time.wMinute,
                time.wSecond,
                time.wMilliseconds
            ),
            captured: None,
        })
    }
}
fn distance_exceeds(a: Point, b: Point, threshold: u32) -> bool {
    let dx = i64::from(a.x) - i64::from(b.x);
    let dy = i64::from(a.y) - i64::from(b.y);
    // i32 coordinate differences can exceed i64 square; calculate as f64.
    (dx as f64).hypot(dy as f64) > f64::from(threshold)
}
fn takeover() -> Fault {
    fault(
        "pointer_anomaly",
        "Pointer deviated; operation-local classification required",
    )
}
fn verify_binding(baseline: &Snapshot, current: &Snapshot, typing: bool) -> Result<()> {
    if baseline.identity != current.identity {
        return Err(fault("target_replaced", "Target process identity changed"));
    }
    if baseline.foreground != current.foreground || !current.ready {
        return Err(fault(
            "target_changed",
            "Target is no longer foreground, visible, enabled, or unminimized",
        ));
    }
    if baseline.rect != current.rect
        || baseline.client != current.client
        || baseline.virtual_desktop != current.virtual_desktop
        || baseline.dpi != current.dpi
    {
        return Err(fault("target_changed", "Target geometry or DPI changed"));
    }
    if typing && (baseline.focus == "0" || baseline.focus != current.focus) {
        return Err(fault("focus_changed", "Typing focus changed"));
    }
    Ok(())
}
fn verify_activation_binding(
    baseline: &Snapshot,
    current: &Snapshot,
    triggered: bool,
    target_seen: bool,
) -> Result<()> {
    if baseline.identity != current.identity || baseline.hwnd != current.hwnd {
        return Err(fault("target_replaced", "Target process lifetime changed"));
    }
    if !current.visible
        || !current.enabled
        || current.minimized
        || baseline.rect != current.rect
        || baseline.client != current.client
        || baseline.virtual_desktop != current.virtual_desktop
        || baseline.dpi != current.dpi
    {
        return Err(fault(
            "target_changed",
            "Activation target visibility or geometry changed",
        ));
    }
    let original = current.foreground == baseline.foreground;
    if (target_seen && !current.is_foreground) || !(original || triggered && current.is_foreground)
    {
        return Err(fault(
            "foreground_changed",
            "Unexpected activation foreground transition",
        ));
    }
    Ok(())
}
/// Activation approach sends only smooth motion. Check every traversed point
/// against the virtual desktop; button guards require exact target ownership.
fn activation_route(from: Point, to: Point) -> Result<()> {
    let steps = (i64::from(to.x) - i64::from(from.x))
        .abs()
        .max((i64::from(to.y) - i64::from(from.y)).abs());
    if steps > 8 {
        return Err(fault(
            "unsafe_route",
            "Activation approach step exceeds 8 physical pixels",
        ));
    }
    // SAFETY: read-only virtual desktop metrics; the target's state is checked
    // independently by the session guard before any approach frame.
    let desktop = unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    };
    for step in 0..=steps {
        let t = if steps == 0 {
            0.0
        } else {
            step as f64 / steps as f64
        };
        let point = Point {
            x: (f64::from(from.x) + (f64::from(to.x) - f64::from(from.x)) * t).round() as i32,
            y: (f64::from(from.y) + (f64::from(to.y) - f64::from(from.y)) * t).round() as i32,
        };
        if !desktop.contains(point) {
            return Err(fault(
                "unsafe_route",
                "Activation route leaves the virtual desktop",
            ));
        }
    }
    Ok(())
}
/// Every pointer step must land on the target or a descendant, so foreign
/// windows always occlude. Beyond that, a pure move may cross a child's
/// non-client border or scrollbar; a button or wheel (strict), or a point on
/// the target itself, also needs a client hit on the window under the cursor.
fn requires_client_hit(strict: bool, owner_is_child: bool) -> bool {
    strict || !owner_is_child
}
fn point_owner(target: HWND, point: Point, client: Rect, strict: bool) -> Result<()> {
    if !client.contains(point) {
        return Err(fault(
            "point_outside_client",
            "Mouse point is outside target client",
        ));
    }
    // SAFETY: read-only hit queries, HWNDs checked by Win32 and bounded message.
    unsafe {
        let owner = WindowFromPoint(POINT {
            x: point.x,
            y: point.y,
        });
        let owner_is_child =
            !owner.0.is_null() && owner != target && IsChild(target, owner).as_bool();
        if owner.0.is_null() || !(owner == target || owner_is_child) {
            return Err(fault(
                "point_occluded",
                "Mouse point is occluded or belongs to window chrome",
            ));
        }
        if !requires_client_hit(strict, owner_is_child) {
            return Ok(());
        }
        if !client_rect(owner)?.contains(point) {
            return Err(fault(
                "point_occluded",
                "Mouse point is occluded or belongs to window chrome",
            ));
        }
        let mut hit = 0usize;
        // WM_NCHITTEST uses signed 16-bit screen coordinates. Reject rather
        // than truncate extreme virtual-desktop positions.
        if i16::try_from(point.x).is_err() || i16::try_from(point.y).is_err() {
            return Err(fault(
                "unsupported_coordinates",
                "Hit-test coordinates exceed Win32 signed 16-bit range",
            ));
        }
        let packed = ((point.y as u16 as u32) << 16) | point.x as u16 as u32;
        let answered = SendMessageTimeoutW(
            owner,
            WM_NCHITTEST,
            WPARAM(0),
            LPARAM(packed as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            10,
            Some(&mut hit),
        );
        if answered.0 == 0 {
            return Err(os_error("Client hit-test was restricted or timed out"));
        }
        if hit as isize != HTCLIENT as isize {
            return Err(fault(
                "point_occluded",
                "Mouse point is not an unoccluded client hit",
            ));
        }
    }
    Ok(())
}

fn is_down(vk: VIRTUAL_KEY) -> bool {
    // SAFETY: documented virtual-key code, read-only query.
    unsafe { GetAsyncKeyState(i32::from(vk.0)) < 0 }
}
const START_KEYS: [VIRTUAL_KEY; 14] = [
    VK_LSHIFT,
    VK_RSHIFT,
    VK_LCONTROL,
    VK_RCONTROL,
    VK_LMENU,
    VK_RMENU,
    VK_LWIN,
    VK_RWIN,
    VK_LBUTTON,
    VK_RBUTTON,
    VK_MBUTTON,
    VK_XBUTTON1,
    VK_XBUTTON2,
    VK_CAPITAL,
];
fn sampled_keys(keyboard: bool) -> impl Iterator<Item = VIRTUAL_KEY> {
    START_KEYS.into_iter().chain(
        (8u16..=254)
            .filter(move |vk| keyboard && !matches!(*vk, 0x10..=0x12))
            .map(VIRTUAL_KEY),
    )
}
fn reject_held_input(keyboard: bool) -> Result<()> {
    if sampled_keys(keyboard).any(is_down) {
        return Err(fault(
            "user_input_held",
            "A user key or mouse button is held",
        ));
    }
    Ok(())
}
fn ime_message(target: HWND, set: Option<bool>) -> Result<bool> {
    // SAFETY: IMM returns a borrowed HWND; messages are bounded and use values.
    unsafe {
        let ime = ImmGetDefaultIMEWnd(target);
        if ime.0.is_null() {
            return Ok(false);
        }
        let mut result = 0usize;
        let command = if set.is_some() { 6 } else { 5 };
        let answer = SendMessageTimeoutW(
            ime,
            0x0283,
            WPARAM(command),
            LPARAM(isize::from(set.unwrap_or(false))),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            20,
            Some(&mut result),
        );
        if answer.0 == 0 {
            return Err(os_error("IME query or change was restricted or timed out"));
        }
        Ok(result != 0)
    }
}

fn scan_key(vk: u16, layout: HKL) -> Result<Key> {
    // SAFETY: layout was read from the live target thread.
    let scan = unsafe { MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC_EX, Some(layout)) };
    let key = mapped_scan_key(vk, scan)?;
    if key.extended && dedicated_navigation_scan(vk).is_some() && key_vk(key, layout)?.0 != vk {
        return Err(fault(
            "unsupported_layout",
            "Dedicated navigation scan does not map back to the requested key",
        ));
    }
    Ok(key)
}
fn dedicated_navigation_scan(vk: u16) -> Option<u16> {
    // Enhanced-keyboard cluster, distinct from the NumLock-sensitive keypad.
    // https://learn.microsoft.com/windows/win32/inputdev/about-keyboard-input
    match VIRTUAL_KEY(vk) {
        VK_END => Some(0x4f),
        VK_HOME => Some(0x47),
        VK_LEFT => Some(0x4b),
        VK_UP => Some(0x48),
        VK_RIGHT => Some(0x4d),
        VK_DOWN => Some(0x50),
        VK_PRIOR => Some(0x49),
        VK_NEXT => Some(0x51),
        VK_INSERT => Some(0x52),
        VK_DELETE => Some(0x53),
        _ => None,
    }
}
fn mapped_scan_key(vk: u16, scan: u32) -> Result<Key> {
    if scan == 0 || (scan >> 8 != 0 && scan >> 8 != 0xe0) {
        return Err(fault(
            "unsupported_layout",
            "Target layout has no supported physical scan code",
        ));
    }
    let mut key = Key {
        code: (scan & 0xff) as u16,
        unicode: false,
        extended: scan >> 8 == 0xe0,
    };
    if let Some(expected) = dedicated_navigation_scan(vk) {
        if key.code != expected {
            return Err(fault(
                "unsupported_layout",
                "Target layout has no supported dedicated navigation scan code",
            ));
        }
        // Some installed layouts return the keypad alias even for _EX. Infer
        // E0 only for the documented dedicated keys, after validating the scan.
        key.extended = true;
    }
    Ok(key)
}
fn key_vk(key: Key, layout: HKL) -> Result<VIRTUAL_KEY> {
    if key.unicode {
        return Ok(VK_PACKET);
    }
    let scan = u32::from(key.code) | if key.extended { 0xe000 } else { 0 };
    // SAFETY: physical scan code and layout came from the compiled plan.
    let vk =
        VIRTUAL_KEY(unsafe { MapVirtualKeyExW(scan, MAPVK_VSC_TO_VK_EX, Some(layout)) } as u16);
    if vk.0 == 0 {
        Err(fault(
            "unsupported_layout",
            "Compiled key cannot be inspected",
        ))
    } else {
        Ok(vk)
    }
}
fn compile_frames(
    plan: &Start,
    baseline: &Snapshot,
    layout: HKL,
    caps: bool,
) -> Result<Vec<Frame>> {
    if plan.kind == Kind::Activate {
        let area = plan
            .safe_area
            .ok_or_else(|| fault("unsafe_activation", "Missing safe area"))?;
        let c = baseline.client;
        if area.x < c.x
            || area.y < c.y
            || i64::from(area.x) + i64::from(area.width) > i64::from(c.x) + i64::from(c.width)
            || i64::from(area.y) + i64::from(area.height) > i64::from(c.y) + i64::from(c.height)
            || !baseline.virtual_desktop.contains(baseline.cursor)
        {
            return Err(fault(
                "unsafe_activation",
                "Safe area must lie wholly in target client and approach must start inside virtual desktop",
            ));
        }
    }
    let mut frames = Vec::with_capacity(plan.events.len() * 4);
    let mut point = baseline.cursor;
    let mut previous_move_at = 0.0;
    for (unit_id, event) in plan.events.iter().enumerate() {
        let at = event.at_ms();
        let mut push = |at_ms, action, primary| {
            frames.push(Frame {
                at_ms,
                action,
                unit_id,
                primary,
            })
        };
        match event {
            Event::Wheel { axis, delta, .. } => push(
                at,
                Action::Wheel {
                    axis: *axis,
                    delta: *delta,
                },
                true,
            ),
            Event::Key { key, modifiers, .. } => {
                let mut held = Vec::new();
                for modifier in modifiers {
                    let k = scan_key(
                        match modifier {
                            Modifier::Ctrl => VK_LCONTROL.0,
                            Modifier::Shift => VK_LSHIFT.0,
                        },
                        layout,
                    )?;
                    push(at, Action::KeyDown(k), false);
                    held.push(k);
                }
                let key = scan_key(key.vk(), layout)?;
                push(at, Action::KeyDown(key), true);
                push(at + 40.0, Action::KeyUp(key), false);
                for key in held.into_iter().rev() {
                    push(at + 40.0, Action::KeyUp(key), false);
                }
            }
            Event::Clipboard { action, .. } => {
                let ctrl = scan_key(VK_LCONTROL.0, layout)?;
                let key = scan_key(
                    match action {
                        ClipboardAction::Copy => 0x43,
                        ClipboardAction::Cut => 0x58,
                        ClipboardAction::Paste => 0x56,
                    },
                    layout,
                )?;
                push(at, Action::KeyDown(ctrl), false);
                push(at, Action::KeyDown(key), true);
                push(at + 40.0, Action::KeyUp(key), false);
                push(at + 40.0, Action::KeyUp(ctrl), false);
            }
            Event::Move { x, y, .. } => {
                let previous = point;
                point = Point {
                    x: x.round() as i32,
                    y: y.round() as i32,
                };
                if plan.kind != Kind::Activate && !baseline.client.contains(point) {
                    return Err(fault(
                        "point_outside_client",
                        "Plan contains a point outside target client",
                    ));
                }
                if plan.kind == Kind::Activate {
                    if !baseline.virtual_desktop.contains(point) {
                        return Err(fault(
                            "unsafe_route",
                            "Activation plan leaves observed virtual desktop",
                        ));
                    }
                    let distance = (f64::from(point.x) - f64::from(previous.x))
                        .hypot(f64::from(point.y) - f64::from(previous.y));
                    if distance > 8.0 || (distance > 0.0 && at - previous_move_at < 4.0) {
                        return Err(fault(
                            "unsafe_route",
                            "Activation requires <=8 px motion steps spaced >=4 ms, including approach from outside",
                        ));
                    }
                    previous_move_at = at;
                }
                push(at, Action::Move(point), false);
            }
            Event::ButtonDown { .. } | Event::ButtonUp { .. } => {
                if !baseline.client.contains(point) {
                    return Err(fault(
                        "point_outside_client",
                        "Button would target a point outside target client",
                    ));
                }
                if plan.kind == Kind::Activate
                    && !plan
                        .safe_area
                        .is_some_and(|s| s.contains(f64::from(point.x), f64::from(point.y)))
                {
                    return Err(fault(
                        "unsafe_activation",
                        "Activation point is outside declared safe area",
                    ));
                }
                push(
                    at,
                    if matches!(event, Event::ButtonDown { .. }) {
                        Action::ButtonDown
                    } else {
                        Action::ButtonUp
                    },
                    true,
                );
            }
            Event::Backspace { .. } => {
                let key = scan_key(VK_BACK.0, layout)?;
                push(at, Action::KeyDown(key), true);
                push(at + 40.0, Action::KeyUp(key), false);
            }
            Event::Char { text, .. } => {
                let c = text
                    .chars()
                    .next()
                    .ok_or_else(|| fault("invalid_plan", "Missing character"))?;
                if c.is_ascii() {
                    // SAFETY: printable BMP character and target keyboard layout.
                    let mapping = unsafe { VkKeyScanExW(c as u16, layout) };
                    if mapping == -1 {
                        return Err(fault(
                            "unsupported_layout",
                            "ASCII character is unavailable in target layout",
                        ));
                    }
                    let vk = mapping as u16 & 0xff;
                    let mut modifiers = (mapping as u16 >> 8) & 0xff;
                    if modifiers & !7 != 0 {
                        return Err(fault(
                            "unsupported_layout",
                            "Unsupported target layout modifier requirements",
                        ));
                    }
                    if caps && (0x41..=0x5a).contains(&vk) {
                        modifiers ^= 1;
                    }
                    let key = scan_key(vk, layout)?;
                    let mut state = [0u8; 256];
                    if caps {
                        state[VK_CAPITAL.0 as usize] = 1;
                    }
                    if modifiers & 1 != 0 {
                        state[VK_SHIFT.0 as usize] = 0x80;
                    }
                    if modifiers & 2 != 0 {
                        state[VK_CONTROL.0 as usize] = 0x80;
                    }
                    if modifiers & 4 != 0 {
                        state[VK_MENU.0 as usize] = 0x80;
                    }
                    let mut translated = [0u16; 8];
                    // SAFETY: arrays have API-required sizes; flag 4 prevents
                    // keyboard translation from modifying dead-key state.
                    let count = unsafe {
                        ToUnicodeEx(
                            u32::from(vk),
                            u32::from(key.code),
                            &state,
                            &mut translated,
                            4,
                            Some(layout),
                        )
                    };
                    if count != 1 || translated[0] != c as u16 {
                        return Err(fault(
                            "unsupported_layout",
                            "ASCII mapping is a dead key or does not reproduce the character",
                        ));
                    }
                    let mut owned_modifiers = Vec::new();
                    for (bit, modifier_vk) in [(1, VK_LSHIFT), (2, VK_LCONTROL), (4, VK_LMENU)] {
                        if modifiers & bit != 0 {
                            let modifier = scan_key(modifier_vk.0, layout)?;
                            push(at, Action::KeyDown(modifier), false);
                            owned_modifiers.push(modifier);
                        }
                    }
                    push(at, Action::KeyDown(key), true);
                    push(at + 35.0, Action::KeyUp(key), false);
                    for modifier in owned_modifiers.into_iter().rev() {
                        push(at + 35.0, Action::KeyUp(modifier), false);
                    }
                } else {
                    let mut units = [0u16; 2];
                    for (index, unit) in c.encode_utf16(&mut units).iter().enumerate() {
                        let key = Key {
                            code: *unit,
                            unicode: true,
                            extended: false,
                        };
                        let start = at + index as f64 * 35.0;
                        push(start, Action::KeyDown(key), true);
                        push(start + 35.0, Action::KeyUp(key), false);
                    }
                }
            }
        }
    }
    Ok(frames)
}

impl Platform for WindowsPlatform {
    fn observe(&self, text: &str) -> Result<Snapshot> {
        let _dpi = DpiContext::enter()?;
        capture(hwnd(text)?)
    }
    fn begin(&self, baseline: &Snapshot, plan: &Start) -> Result<Execution> {
        let dpi = DpiContext::enter()?;
        let owner = InputMutex::acquire()?;
        let target = hwnd(&baseline.hwnd)?;
        // SAFETY: valid live window; keyboard layout and caps are read-only.
        let (layout, caps) = unsafe {
            (
                GetKeyboardLayout(GetWindowThreadProcessId(target, None)),
                GetKeyState(i32::from(VK_CAPITAL.0)) & 1 != 0,
            )
        };
        let frames = compile_frames(plan, baseline, layout, caps)?;
        let mut participating = Vec::new();
        for frame in &frames {
            if let Action::KeyDown(key) = frame.action
                && !key.unicode
            {
                let scan = u32::from(key.code) | if key.extended { 0xe000 } else { 0 };
                // SAFETY: physical scan code compiled for the captured layout.
                let vk =
                    VIRTUAL_KEY(
                        unsafe { MapVirtualKeyExW(scan, MAPVK_VSC_TO_VK_EX, Some(layout)) } as u16,
                    );
                if vk.0 == 0 {
                    return Err(fault(
                        "user_input_held",
                        "A participating key is already held or cannot be inspected",
                    ));
                }
                if !participating.contains(&vk) {
                    participating.push(vk);
                }
            }
        }
        // compile_frames validates the entire plan's client geometry before
        // input. Dynamic hit ownership is checked immediately before each
        // injection; prechecking 12,000 remote messages would delay STOP.
        let session = WindowsSession {
            target,
            baseline: baseline.clone(),
            expected: baseline.cursor,
            threshold: plan.threshold_px,
            typing: plan.kind == Kind::Typing,
            keyboard: plan.kind.keyboard(),
            activation: plan.safe_area,
            activation_triggered: false,
            activation_target_seen: false,
            participating,
            force_ime_off: plan.force_ime_off,
            layout,
            caps,
            keys: Vec::new(),
            button: false,
            restore_ime: false,
            cleaned: false,
            _owner: owner,
            _dpi: dpi,
        };
        Ok(Execution {
            session: Box::new(session),
            frames,
        })
    }
}

struct WindowsSession {
    target: HWND,
    baseline: Snapshot,
    expected: Point,
    threshold: u32,
    typing: bool,
    keyboard: bool,
    activation: Option<crate::protocol::SafeArea>,
    activation_triggered: bool,
    activation_target_seen: bool,
    participating: Vec<VIRTUAL_KEY>,
    force_ime_off: bool,
    layout: HKL,
    caps: bool,
    keys: Vec<Key>,
    button: bool,
    restore_ime: bool,
    cleaned: bool,
    _owner: InputMutex,
    _dpi: DpiContext,
}
impl WindowsSession {
    fn send(action: Action) -> Result<()> {
        let input = match action {
            Action::Wheel { axis, delta } => INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        mouseData: delta as u32,
                        dwFlags: if axis == Axis::Vertical {
                            MOUSEEVENTF_WHEEL
                        } else {
                            MOUSEEVENTF_HWHEEL
                        },
                        dwExtraInfo: 0x48494d43,
                        ..Default::default()
                    },
                },
            },
            Action::Move(point) => {
                // SAFETY: process-independent virtual desktop metrics.
                let (x, y, width, height) = unsafe {
                    (
                        GetSystemMetrics(SM_XVIRTUALSCREEN),
                        GetSystemMetrics(SM_YVIRTUALSCREEN),
                        GetSystemMetrics(SM_CXVIRTUALSCREEN),
                        GetSystemMetrics(SM_CYVIRTUALSCREEN),
                    )
                };
                if width <= 1
                    || height <= 1
                    || !(Rect {
                        x,
                        y,
                        width,
                        height,
                    })
                    .contains(point)
                {
                    return Err(fault(
                        "unsupported_coordinates",
                        "Mouse point is outside virtual desktop",
                    ));
                }
                let dx = ((i64::from(point.x) - i64::from(x)) * 65535 + i64::from(width - 1) / 2)
                    / i64::from(width - 1);
                let dy = ((i64::from(point.y) - i64::from(y)) * 65535 + i64::from(height - 1) / 2)
                    / i64::from(height - 1);
                INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: dx as i32,
                            dy: dy as i32,
                            dwFlags: MOUSEEVENTF_MOVE
                                | MOUSEEVENTF_ABSOLUTE
                                | MOUSEEVENTF_VIRTUALDESK,
                            dwExtraInfo: 0x48494d43,
                            ..Default::default()
                        },
                    },
                }
            }
            Action::ButtonDown | Action::ButtonUp => INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: if matches!(action, Action::ButtonDown) {
                            MOUSEEVENTF_LEFTDOWN
                        } else {
                            MOUSEEVENTF_LEFTUP
                        },
                        dwExtraInfo: 0x48494d43,
                        ..Default::default()
                    },
                },
            },
            Action::KeyDown(key) | Action::KeyUp(key) => {
                keyboard_input(key, matches!(action, Action::KeyUp(_)))
            }
        };
        // SAFETY: union arm matches INPUT type, slice and ABI size are correct.
        let sent = unsafe { SendInput(&[input], size_of::<INPUT>() as i32) };
        if sent != 1 {
            return Err(os_error(
                "SendInput was rejected (including possible UIPI restriction)",
            ));
        }
        Ok(())
    }
}
// Construction is separate from SendInput so readonly tests inspect the exact
// production INPUT without injecting, acquiring focus, or requiring an HWND.
fn keyboard_input(key: Key, released: bool) -> INPUT {
    let mut flags = if key.unicode {
        KEYEVENTF_UNICODE
    } else {
        KEYEVENTF_SCANCODE
    };
    if key.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if released {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: key.code,
                dwFlags: flags,
                dwExtraInfo: 0x48494d43,
                ..Default::default()
            },
        },
    }
}
impl Session for WindowsSession {
    fn initialize(&mut self) -> Result<()> {
        self.cleaned = false;
        self.guard(None)?;
        if self.typing {
            let focus = hwnd(&self.baseline.focus)?;
            if ime_message(focus, None)? {
                if !self.force_ime_off {
                    return Err(fault(
                        "ime_open",
                        "IME is on; force_ime_off must be explicit",
                    ));
                }
                // Mark restore before attempting the change: a timeout can
                // occur after the receiver already processed the message.
                self.restore_ime = true;
                ime_message(focus, Some(false))?;
                if ime_message(focus, None)? {
                    return Err(fault(
                        "ime_open",
                        "IME remained on after explicit force_ime_off",
                    ));
                }
            }
        }
        Ok(())
    }
    fn guard(&mut self, next: Option<Action>) -> Result<()> {
        let current = capture(self.target)?;
        if self.activation.is_some() {
            verify_activation_binding(
                &self.baseline,
                &current,
                self.activation_triggered,
                self.activation_target_seen,
            )?;
            self.activation_target_seen |= current.is_foreground;
        } else {
            verify_binding(&self.baseline, &current, self.keyboard)?;
        }
        if distance_exceeds(self.expected, current.cursor, self.threshold) {
            return Err(takeover());
        }
        if self.keyboard {
            let focus = hwnd(&current.focus)?;
            // SAFETY: query-only relationship checks on handles validated by capture.
            let belongs = unsafe { focus == self.target || IsChild(self.target, focus).as_bool() };
            if !belongs || identity(focus)? != self.baseline.identity {
                return Err(fault(
                    "focus_changed",
                    "Keyboard focus is outside the bound target",
                ));
            }
            // SAFETY: live target query; no keyboard state mutation.
            let (layout, caps) = unsafe {
                (
                    GetKeyboardLayout(GetWindowThreadProcessId(self.target, None)),
                    GetKeyState(i32::from(VK_CAPITAL.0)) & 1 != 0,
                )
            };
            if layout != self.layout || caps != self.caps {
                return Err(fault(
                    "keyboard_state_changed",
                    "Target layout or Caps Lock changed",
                ));
            }
        }
        for vk in sampled_keys(self.keyboard).chain(self.participating.iter().copied()) {
            if !is_down(vk) {
                continue;
            }
            let owned = if vk == VK_LBUTTON {
                self.button
            } else if matches!(vk, VK_RBUTTON | VK_MBUTTON | VK_XBUTTON1 | VK_XBUTTON2) {
                false
            } else {
                self.keys
                    .iter()
                    .any(|key| key_vk(*key, self.layout).is_ok_and(|owned| owned == vk))
            };
            if !owned {
                return Err(fault(
                    "user_input_held",
                    "A user modifier, Caps Lock key, or mouse button became held",
                ));
            }
        }
        if let Some(action) = next {
            match action {
                Action::Move(point) => {
                    if self.activation.is_some() {
                        activation_route(current.cursor, point)?;
                    } else {
                        point_owner(self.target, point, current.client, false)?;
                    }
                }
                Action::ButtonDown | Action::ButtonUp | Action::Wheel { .. } => {
                    if let Some(area) = self.activation
                        && !area.contains(f64::from(current.cursor.x), f64::from(current.cursor.y))
                    {
                        return Err(fault(
                            "unsafe_activation",
                            "Current cursor left declared safe area",
                        ));
                    }
                    point_owner(self.target, current.cursor, current.client, true)?
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn inject(&mut self, action: Action) -> Result<usize> {
        Self::send(action)?;
        match action {
            Action::ButtonDown => {
                self.button = true;
                self.activation_triggered |= self.activation.is_some();
            }
            Action::ButtonUp => self.button = false,
            Action::KeyDown(key) => self.keys.push(key),
            Action::KeyUp(key) => {
                if let Some(index) = self.keys.iter().rposition(|owned| *owned == key) {
                    self.keys.remove(index);
                }
            }
            Action::Move(_) | Action::Wheel { .. } => {}
        }
        Ok(1)
    }
    fn verify(&mut self, action: Action) -> Result<()> {
        if let Action::Move(planned) = action {
            let actual = cursor()?;
            // Absolute normalization can round by one physical pixel. A larger
            // difference is a failure, never silently adopted as expected.
            if distance_exceeds(planned, actual, 1) {
                return Err(takeover());
            }
            self.expected = actual;
        }
        self.guard(None)
    }
    fn cleanup(&mut self) -> Cleanup {
        if self.cleaned {
            return Cleanup {
                injected_events: 0,
                error: None,
            };
        }
        // Attempt once. On any failure the runtime poisons new admission;
        // Drop must not secretly retry an OS injection that already failed.
        self.cleaned = true;
        let mut count = 0;
        let mut failure = None;
        for key in self.keys.clone().into_iter().rev() {
            match Self::send(Action::KeyUp(key)) {
                Ok(()) => {
                    count += 1;
                    if let Some(index) = self.keys.iter().rposition(|owned| *owned == key) {
                        self.keys.remove(index);
                    }
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        if self.button {
            match Self::send(Action::ButtonUp) {
                Ok(()) => {
                    count += 1;
                    self.button = false;
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        if self.restore_ime {
            // Restore only while both target and focused child still belong to
            // the exact observed process lifetime; never change a reused HWND.
            match hwnd(&self.baseline.focus) {
                Ok(focus) => {
                    let same = identity(self.target).is_ok_and(|id| id == self.baseline.identity)
                        && identity(focus).is_ok_and(|id| id == self.baseline.identity);
                    if same && let Err(error) = ime_message(focus, Some(true)) {
                        failure.get_or_insert(error);
                    }
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
            self.restore_ime = false;
        }
        Cleanup {
            injected_events: count,
            error: failure.map(|error| {
                Fault::new(
                    "cleanup_failed",
                    format!("Owned-input/IME cleanup failed: {}", error.message),
                )
            }),
        }
    }
    fn revalidate(&mut self, fresh: &Snapshot) -> Result<()> {
        let current = capture(self.target)?;
        if fresh.identity != self.baseline.identity || fresh.hwnd != self.baseline.hwnd {
            return Err(fault("target_replaced", "Resume target identity changed"));
        }
        if self.activation.is_some() {
            verify_activation_binding(
                &self.baseline,
                &current,
                self.activation_triggered,
                self.activation_target_seen,
            )?;
        } else {
            verify_binding(&self.baseline, &current, self.keyboard)?;
        }
        if fresh.rect != current.rect
            || fresh.client != current.client
            || fresh.dpi != current.dpi
            || fresh.foreground != current.foreground
            || (self.keyboard && fresh.focus != current.focus)
            || distance_exceeds(fresh.cursor, current.cursor, self.threshold)
        {
            return Err(fault(
                "stale_snapshot",
                "State changed after resume observation",
            ));
        }
        reject_held_input(self.keyboard)?;
        if self.participating.iter().any(|vk| is_down(*vk)) {
            return Err(fault(
                "user_input_held",
                "Participating key is held at resume",
            ));
        }
        if !self.keys.is_empty() || self.button {
            return Err(fault(
                "cleanup_failed",
                "Owned input remained after suspension",
            ));
        }
        self.expected = current.cursor;
        self.guard(None)
    }
}
impl Drop for WindowsSession {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = self.cleanup();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn available_layouts() -> Vec<HKL> {
        // SAFETY: read-only count query; no layout is loaded or activated.
        let count = unsafe { GetKeyboardLayoutList(None) };
        assert!(count > 0);
        let mut layouts = vec![HKL::default(); count as usize];
        // SAFETY: initialized output slice sized by the preceding count query.
        let copied = unsafe { GetKeyboardLayoutList(Some(&mut layouts)) };
        assert!(copied > 0);
        layouts.truncate(copied as usize);
        layouts
    }
    const NAVIGATION: [(&str, u16, u16); 10] = [
        ("end", 0x23, 0x4f),
        ("home", 0x24, 0x47),
        ("left", 0x25, 0x4b),
        ("up", 0x26, 0x48),
        ("right", 0x27, 0x4d),
        ("down", 0x28, 0x50),
        ("page_up", 0x21, 0x49),
        ("page_down", 0x22, 0x51),
        ("insert", 0x2d, 0x52),
        ("delete", 0x2e, 0x53),
    ];
    #[test]
    fn native_navigation_mapping_uses_dedicated_extended_keys_on_available_layouts() {
        for layout in available_layouts() {
            for (name, vk, scan) in NAVIGATION {
                // SAFETY: read-only mappings using an installed layout.
                let (raw, bare_reverse, extended_reverse) = unsafe {
                    (
                        MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC_EX, Some(layout)),
                        MapVirtualKeyExW(u32::from(scan), MAPVK_VSC_TO_VK_EX, Some(layout)),
                        MapVirtualKeyExW(
                            0xe000 | u32::from(scan),
                            MAPVK_VSC_TO_VK_EX,
                            Some(layout),
                        ),
                    )
                };
                println!(
                    "layout={layout:?} key={name} raw={raw:#x} bare_reverse={bare_reverse:#x} extended_reverse={extended_reverse:#x}"
                );
                let key = scan_key(vk, layout).unwrap();
                assert_eq!(key.code, scan, "{name} {layout:?}");
                assert!(
                    key.extended,
                    "{name} must use the dedicated key, not its NumLock-sensitive keypad alias; layout={layout:?} raw={raw:#x}"
                );
                assert!(!key.unicode);
                assert_eq!(key_vk(key, layout).unwrap().0, vk);
            }
        }
    }
    #[test]
    fn native_navigation_compiler_preserves_dedicated_down_up_pair() {
        for layout in available_layouts() {
            for (name, vk, scan) in NAVIGATION {
                let plan: Start = serde_json::from_value(serde_json::json!({
                    "operation_id":"navigation", "snapshot_id":"s", "kind":"key",
                    "duration_ms":100,
                    "events":[{"type":"key", "key":name, "modifiers":[], "at_ms":0}]
                }))
                .unwrap();
                let frames = compile_frames(&plan, &snapshot(), layout, false).unwrap();
                assert_eq!(frames.len(), 2);
                let wanted = Key {
                    code: scan,
                    unicode: false,
                    extended: true,
                };
                assert!(
                    matches!(frames[0].action, Action::KeyDown(key) if key == wanted),
                    "{name} {layout:?}: {:?}",
                    frames[0].action
                );
                assert!(matches!(frames[1].action, Action::KeyUp(key) if key == wanted));
                assert!(frames[0].primary);
                assert!(!frames[1].primary);
                assert_eq!(key_vk(wanted, layout).unwrap().0, vk);
                for (index, released, flags) in [(0, false, 0x9), (1, true, 0xb)] {
                    let key = match frames[index].action {
                        Action::KeyDown(key) | Action::KeyUp(key) => key,
                        other => panic!("Unexpected compiled action: {other:?}"),
                    };
                    assert_keyboard_input(keyboard_input(key, released), scan, flags);
                }
            }
        }
    }
    fn assert_keyboard_input(input: INPUT, scan: u16, flags: u32) {
        assert_eq!(input.r#type, INPUT_KEYBOARD);
        // SAFETY: type was asserted above and keyboard_input initializes ki.
        let keyboard = unsafe { input.Anonymous.ki };
        assert_eq!(keyboard.wVk.0, 0);
        assert_eq!(keyboard.wScan, scan);
        assert_eq!(keyboard.dwFlags.0, flags);
        assert_eq!(keyboard.dwExtraInfo, 0x48494d43);
        assert_eq!(keyboard.time, 0);
    }
    #[test]
    fn native_navigation_rejects_wrong_or_unsupported_scans_without_touching_other_keys() {
        for (_, vk, scan) in NAVIGATION {
            for invalid in [
                0,
                0x1e,
                0xe01e,
                0xe100 | u32::from(scan),
                0x10000 | u32::from(scan),
            ] {
                assert_eq!(
                    mapped_scan_key(vk, invalid).unwrap_err().code,
                    "unsupported_layout"
                );
            }
            for valid in [u32::from(scan), 0xe000 | u32::from(scan)] {
                let key = mapped_scan_key(vk, valid).unwrap();
                assert_eq!(key.code, scan);
                assert!(key.extended);
            }
        }
        // The same low scan on a non-navigation VK must not be rewritten.
        assert!(!mapped_scan_key(VK_NUMPAD1.0, 0x4f).unwrap().extended);
        assert!(mapped_scan_key(VK_RCONTROL.0, 0xe01d).unwrap().extended);
    }
    #[test]
    fn native_navigation_preserves_ordinary_modifiers_enter_backspace_and_unicode_inputs() {
        for layout in available_layouts() {
            for (vk, scan) in [
                (VK_A, 0x1e),
                (VK_LCONTROL, 0x1d),
                (VK_LSHIFT, 0x2a),
                (VK_RETURN, 0x1c),
                (VK_BACK, 0x0e),
            ] {
                let key = scan_key(vk.0, layout).unwrap();
                assert_eq!(key.code, scan);
                assert!(!key.extended);
                assert_eq!(key_vk(key, layout).unwrap(), vk);
                assert_keyboard_input(keyboard_input(key, false), scan, 0x8);
                assert_keyboard_input(keyboard_input(key, true), scan, 0xa);
            }
            for (name, scans) in [
                ("end", vec![0x1d, 0x2a, 0x4f, 0x4f, 0x2a, 0x1d]),
                ("a", vec![0x1d, 0x1e, 0x1e, 0x1d]),
                ("enter", vec![0x1c, 0x1c]),
                ("backspace", vec![0x0e, 0x0e]),
            ] {
                let modifiers: Vec<&str> = match name {
                    "end" => vec!["ctrl", "shift"],
                    "a" => vec!["ctrl"],
                    _ => vec![],
                };
                let plan: Start = serde_json::from_value(serde_json::json!({"operation_id":"ordinary", "snapshot_id":"s", "kind":"key", "duration_ms":100, "events":[{"type":"key", "key":name, "modifiers":modifiers, "at_ms":0}]})).unwrap();
                let frames = compile_frames(&plan, &snapshot(), layout, false).unwrap();
                assert_eq!(frames.len(), scans.len());
                for (frame, scan) in frames.iter().zip(scans) {
                    let (key, released) = match frame.action {
                        Action::KeyDown(key) => (key, false),
                        Action::KeyUp(key) => (key, true),
                        other => panic!("Unexpected action: {other:?}"),
                    };
                    let flags = 0x8
                        | if name == "end" && scan == 0x4f { 1 } else { 0 }
                        | if released { 2 } else { 0 };
                    assert_keyboard_input(keyboard_input(key, released), scan, flags);
                }
            }
            let plan: Start = serde_json::from_value(serde_json::json!({"operation_id":"unicode", "snapshot_id":"s", "kind":"typing", "duration_ms":100, "events":[{"type":"char", "text":"😀", "at_ms":0}]})).unwrap();
            let frames = compile_frames(&plan, &snapshot(), layout, false).unwrap();
            assert_eq!(frames.len(), 4);
            for (index, scan, flags) in [
                (0, 0xd83d, 4),
                (1, 0xd83d, 6),
                (2, 0xde00, 4),
                (3, 0xde00, 6),
            ] {
                let key = match frames[index].action {
                    Action::KeyDown(key) | Action::KeyUp(key) => key,
                    other => panic!("Unexpected action: {other:?}"),
                };
                assert_keyboard_input(keyboard_input(key, flags == 6), scan, flags);
                assert_eq!(key_vk(key, layout).unwrap(), VK_PACKET);
            }
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            snapshot_id: "s".into(),
            target_id: "t".into(),
            hwnd: "1".into(),
            identity: "1:100".into(),
            rect: Rect {
                x: 0,
                y: 0,
                width: 500,
                height: 400,
            },
            client: Rect {
                x: 10,
                y: 30,
                width: 480,
                height: 360,
            },
            virtual_desktop: Rect {
                x: -1000,
                y: -1000,
                width: 4000,
                height: 4000,
            },
            cursor: Point { x: 20, y: 40 },
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
    #[test]
    fn v2_click_release_is_journaled_as_an_effect_for_post_send_failure() {
        let p:Start=serde_json::from_value(serde_json::json!({"operation_id":"o","snapshot_id":"s","kind":"click","duration_ms":100,"events":[{"type":"button_down","at_ms":0},{"type":"button_up","at_ms":40}]})).unwrap();
        let frames = compile_frames(&p, &snapshot(), HKL::default(), false).unwrap();
        assert!(
            frames[1].primary,
            "A release can trigger the application click and must be uncertain after failed verification"
        );
    }
    #[test]
    fn moves_may_cross_child_borders_but_buttons_need_a_client_hit() {
        assert!(
            !requires_client_hit(false, true),
            "move over a child border"
        );
        assert!(requires_client_hit(true, true), "button on a child");
        assert!(
            requires_client_hit(false, false),
            "move over the target itself"
        );
        assert!(
            requires_client_hit(true, false),
            "button on the target itself"
        );
    }
    #[test]
    fn activation_accepts_only_its_own_foreground_transition() {
        let mut baseline = snapshot();
        baseline.foreground = "9".into();
        baseline.ready = false;
        baseline.is_foreground = false;
        assert!(verify_activation_binding(&baseline, &baseline, false, false).is_ok());
        let mut current = baseline.clone();
        current.foreground = "1".into();
        current.is_foreground = true;
        current.ready = true;
        assert!(verify_activation_binding(&baseline, &current, false, false).is_err());
        assert!(verify_activation_binding(&baseline, &current, true, false).is_ok());
        current.foreground = "7".into();
        current.is_foreground = false;
        assert!(verify_activation_binding(&baseline, &current, true, false).is_err());
        assert!(verify_activation_binding(&baseline, &baseline, true, true).is_err());
        current = baseline.clone();
        current.client.width += 1;
        assert!(verify_activation_binding(&baseline, &current, true, false).is_err());
    }
    #[test]
    fn activation_compiler_allows_smooth_outside_approach_and_rejects_teleports_or_unsafe_area() {
        let mut baseline = snapshot();
        baseline.cursor = Point { x: 0, y: 40 };
        let mut p:Start=serde_json::from_value(serde_json::json!({"operation_id":"o","snapshot_id":"s","kind":"activate","duration_ms":120,"safe_area":{"x":16,"y":35,"width":10,"height":10},"safe_area_confirmed":true,"events":[{"type":"move","x":0,"y":40,"at_ms":0},{"type":"move","x":8,"y":40,"at_ms":8},{"type":"move","x":16,"y":40,"at_ms":16},{"type":"move","x":20,"y":40,"at_ms":24},{"type":"button_down","at_ms":40},{"type":"button_up","at_ms":80}]})).unwrap();
        assert!(compile_frames(&p, &baseline, HKL::default(), false).is_ok());
        p.events.remove(1);
        assert_eq!(
            compile_frames(&p, &baseline, HKL::default(), false)
                .unwrap_err()
                .code,
            "unsafe_route"
        );
        p.safe_area.as_mut().unwrap().x = 0;
        assert_eq!(
            compile_frames(&p, &baseline, HKL::default(), false)
                .unwrap_err()
                .code,
            "unsafe_activation"
        );
    }
    #[test]
    fn keyboard_guard_samples_ordinary_keys_and_maps_owned_scan_or_unicode_packets() {
        assert!(sampled_keys(true).any(|vk| vk == VK_A));
        assert!(!sampled_keys(false).any(|vk| vk == VK_A));
        assert!(sampled_keys(true).any(|vk| vk == VK_PACKET));
        assert!(!sampled_keys(true).any(|vk| vk == VK_CONTROL));
        // SAFETY: reads this test thread's current keyboard layout, no input.
        let layout = unsafe { GetKeyboardLayout(0) };
        assert_eq!(
            key_vk(scan_key(VK_A.0, layout).unwrap(), layout).unwrap(),
            VK_A
        );
        assert_eq!(
            key_vk(
                Key {
                    code: 0xd83d,
                    unicode: true,
                    extended: false
                },
                layout
            )
            .unwrap(),
            VK_PACKET
        );
    }
    #[test]
    fn every_binding_change_is_rejected_without_using_windows() {
        let baseline = snapshot();
        assert!(verify_binding(&baseline, &baseline, true).is_ok());
        let mut changed = baseline.clone();
        changed.identity = "1:101".into();
        assert!(verify_binding(&baseline, &changed, false).is_err());
        changed = baseline.clone();
        changed.rect.x += 1;
        assert!(verify_binding(&baseline, &changed, false).is_err());
        changed = baseline.clone();
        changed.client.width -= 1;
        assert!(verify_binding(&baseline, &changed, false).is_err());
        changed = baseline.clone();
        changed.dpi = 144;
        assert!(verify_binding(&baseline, &changed, false).is_err());
        changed = baseline.clone();
        changed.foreground = "3".into();
        assert!(verify_binding(&baseline, &changed, false).is_err());
        changed = baseline.clone();
        changed.ready = false;
        assert!(verify_binding(&baseline, &changed, false).is_err());
        changed = baseline.clone();
        changed.focus = "3".into();
        assert!(verify_binding(&baseline, &changed, true).is_err());
        assert!(verify_binding(&baseline, &changed, false).is_ok());
    }
    #[test]
    fn full_mouse_plan_rejects_late_outside_point_before_any_input() {
        let plan = Start {
            operation_id: "op".into(),
            snapshot_id: "s".into(),
            kind: Kind::Move,
            duration_ms: 200.5,
            events: vec![
                Event::Move {
                    x: 100.,
                    y: 100.,
                    at_ms: 0.0,
                },
                Event::Move {
                    x: 900.,
                    y: 100.,
                    at_ms: 200.5,
                },
            ],
            threshold_px: 60,
            force_ime_off: false,
            safe_area: None,
            safe_area_confirmed: false,
            pause_policy: Default::default(),
        };
        let error = match compile_frames(&plan, &snapshot(), HKL::default(), false) {
            Ok(_) => panic!("Outside point accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, "point_outside_client");
    }
    #[test]
    fn pointer_threshold_and_geometry_are_pure() {
        assert!(!distance_exceeds(
            Point { x: -100, y: 0 },
            Point { x: -40, y: 0 },
            60
        ));
        assert!(distance_exceeds(
            Point { x: -100, y: 0 },
            Point { x: -39, y: 0 },
            60
        ));
        assert!(distance_exceeds(
            Point {
                x: i32::MIN,
                y: i32::MIN
            },
            Point {
                x: i32::MAX,
                y: i32::MAX
            },
            60
        ));
        assert!(
            Rect {
                x: -20,
                y: 10,
                width: 30,
                height: 40
            }
            .contains(Point { x: -20, y: 49 })
        );
        assert!(
            !Rect {
                x: -20,
                y: 10,
                width: 30,
                height: 40
            }
            .contains(Point { x: 10, y: 49 })
        );
    }
}

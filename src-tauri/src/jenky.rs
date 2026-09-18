use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use gtk::gio;
use gtk::glib::object::IsA;
use gtk::prelude::*;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime};

/// NVIDIA's PCI vendor id.
const NVIDIA_VENDOR: u32 = 0x10de;
const DRM_ROOT: &str = "/sys/class/drm";
/// `0` never applies the quirk, `1` applies it without detection.
const FORCE_VAR: &str = "RCLONE_UI_JENKY";

const NOT_WAYLAND: &str = "session is not wayland";
const NOT_NVIDIA: &str = "no nvidia gpu drives the display";

static DECISION: OnceLock<Decision> = OnceLock::new();
static SUMMARY: OnceLock<String> = OnceLock::new();

/// Registers the quirk. Must be registered before `tauri::Builder::build()`
/// creates the windows from `tauri.conf.json`: the plugin setup hook runs first
/// and hooks window construction itself.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("jenky")
        .setup(|app, _api| {
            setup(app);
            Ok(())
        })
        .build()
}

/// The decision line printed at startup, for re-logging once the log plugin is
/// live (the original print happens before it initializes).
pub fn summary() -> String {
    SUMMARY
        .get()
        .cloned()
        .unwrap_or_else(|| "not run (plugin setup never reached)".to_string())
}

/// Stderr always (the logger is not up yet when the decision is made) and the
/// `log` facade too, which is live by the time per-window lines print for
/// windows opened later in the app's life.
fn say(message: &str) {
    eprintln!("jenky: {message}");
    log::info!("jenky: {message}");
}

fn complain(message: &str) {
    eprintln!("jenky: {message}");
    log::warn!("jenky: {message}");
}

fn set_summary(line: String) {
    say(&line);
    let _ = SUMMARY.set(line);
}

/// Detection runs once per process; nothing it reads changes while we run.
fn decision() -> &'static Decision {
    DECISION.get_or_init(|| decide(&Env::from_process(), Path::new(DRM_ROOT)))
}

fn setup<R: Runtime>(app: &tauri::AppHandle<R>) {
    match decision() {
        Decision::Overridden(by) => {
            set_summary(format!("standing down: {by} is set"));
        }
        Decision::NotAffected(reason) => {
            set_summary(format!("not affected: {reason}"));
        }
        Decision::Apply {
            gpu,
            driver,
            session,
        } => {
            match watch_application_windows() {
                Ok(()) => set_summary(format!(
                    "applied: forcing an early GL paint context on every window \
                     (gpu {gpu}, driver {driver}, session {})",
                    session.label()
                )),
                Err(error) => set_summary(format!(
                    "matched (gpu {gpu}, driver {driver}) but cannot watch for windows: {error}"
                )),
            }
            // Nothing here yet in the normal case (this plugin is registered before
            // the config window is built); harmless belt-and-braces otherwise.
            for (label, window) in app.webview_windows() {
                match arm_webview_window(&window) {
                    Ok(()) => say(&format!("window {label:?}: already open, armed directly")),
                    Err(error) => complain(&format!("window {label:?}: {error}")),
                }
            }
        }
    }
}

/// Arms every window the process will ever open. `window-added` fires
/// synchronously as GTK constructs each window — before it is realized and
/// before the event loop draws a frame; Tauri's own window hooks are queued on
/// the event loop and would land after the first frame.
fn watch_application_windows() -> Result<(), String> {
    let application = gio::Application::default()
        .ok_or_else(|| "no GtkApplication in this process".to_string())?;
    let application = application
        .downcast::<gtk::Application>()
        .map_err(|_| "the default GApplication is not a GtkApplication".to_string())?;

    application.connect_window_added(|application, window| {
        // tao sets the title after construction, so there is nothing to name the
        // window by yet; its position in the application is all we have
        let nth = application.windows().len();
        match force_paint_gl_context(window) {
            Ok(()) => say(&format!("window {nth}: armed before its first frame")),
            Err(error) => complain(&format!("window {nth}: {error}")),
        }
    });
    Ok(())
}

fn arm_webview_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let gtk_window = window
        .gtk_window()
        .map_err(|error| format!("no GTK window for this Tauri window: {error}"))?;
    force_paint_gl_context(&gtk_window)
}

fn force_paint_gl_context<W>(window: &W) -> Result<(), String>
where
    W: IsA<gtk::Widget>,
{
    if window.is_realized() {
        return create_gl_context(window);
    }

    // "realize" is G_SIGNAL_RUN_FIRST, so the GdkWindow exists by the time this
    // runs, and it still lands before the first frame.
    window.connect_realize(|window| {
        if let Err(error) = create_gl_context(window) {
            complain(&format!("on realize: {error}"));
        }
    });
    Ok(())
}

fn create_gl_context<W>(window: &W) -> Result<(), String>
where
    W: IsA<gtk::Widget>,
{
    let gdk_window = window
        .window()
        .ok_or_else(|| "the widget has no GdkWindow".to_string())?;

    // The returned context is dropped straight away; only the paint context this
    // forces GDK to create as a side effect matters.
    gdk_window
        .create_gl_context()
        .map_err(|error| format!("no GL context for the window: {error}"))?;
    Ok(())
}

/// The display server the process decided it is talking to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionType {
    Wayland,
    /// An X11 session, including XWayland.
    X11,
    Unknown,
}

impl SessionType {
    fn label(self) -> &'static str {
        match self {
            SessionType::Wayland => "wayland",
            SessionType::X11 => "x11",
            SessionType::Unknown => "unknown",
        }
    }
}

/// The environment the decision is made from.
#[derive(Debug, Clone, Default)]
struct Env {
    gdk_backend: Option<String>,
    xdg_session_type: Option<String>,
    wayland_display: Option<String>,
    wayland_socket: Option<String>,
    display: Option<String>,
    webkit_disable_dmabuf: Option<String>,
    prime_offload: Option<String>,
    /// `RCLONE_UI_JENKY`
    force: Option<String>,
}

impl Env {
    fn from_process() -> Self {
        let get = |k: &str| std::env::var(k).ok();
        Self {
            gdk_backend: get("GDK_BACKEND"),
            xdg_session_type: get("XDG_SESSION_TYPE"),
            wayland_display: get("WAYLAND_DISPLAY"),
            wayland_socket: get("WAYLAND_SOCKET"),
            display: get("DISPLAY"),
            webkit_disable_dmabuf: get("WEBKIT_DISABLE_DMABUF_RENDERER"),
            prime_offload: get("__NV_PRIME_RENDER_OFFLOAD"),
            force: get(FORCE_VAR),
        }
    }
}

/// A GPU as `/sys/class/drm` describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Gpu {
    card: String,
    vendor: Option<u32>,
    driver: Option<String>,
    /// `boot_vga` or `boot_display`: this is the GPU driving the session.
    primary: bool,
}

impl Gpu {
    fn is_nvidia(&self) -> bool {
        self.vendor == Some(NVIDIA_VENDOR) && self.driver.as_deref() == Some("nvidia")
    }
}

/// What the quirk should do.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Decision {
    Apply {
        gpu: String,
        driver: String,
        session: SessionType,
    },
    NotAffected(&'static str),
    Overridden(String),
}

/// Parses `GDK_BACKEND` into the backend GDK will actually pick.
fn parse_gdk_backend(list: Option<&str>) -> Option<SessionType> {
    for item in list?.split(',') {
        match item.trim() {
            "wayland" => return Some(SessionType::Wayland),
            "x11" => return Some(SessionType::X11),
            _ => continue,
        }
    }
    None
}

/// `GDK_BACKEND` outranks everything, because it is what GDK and WebKitGTK act
/// on. `XDG_SESSION_TYPE` comes next, then the socket variables, which are all
/// that is left when the process inherited no session environment (a systemd
/// unit, `sudo`, a `.desktop` launch with a scrubbed environment).
fn session_type(env: &Env) -> SessionType {
    if let Some(session) = parse_gdk_backend(env.gdk_backend.as_deref()) {
        return session;
    }
    match env.xdg_session_type.as_deref() {
        Some("wayland") => return SessionType::Wayland,
        Some("x11") => return SessionType::X11,
        _ => {}
    }
    if env.wayland_display.is_some() || env.wayland_socket.is_some() {
        return SessionType::Wayland;
    }
    if env.display.is_some() {
        return SessionType::X11;
    }
    SessionType::Unknown
}

/// Reads a `/sys` file, trimming the trailing newline.
fn read_sysfs(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

/// The kernel driver bound to a card, from the `device/driver` symlink.
fn driver_name(card: &Path) -> Option<String> {
    std::fs::read_link(card.join("device/driver"))
        .ok()?
        .file_name()?
        .to_str()
        .map(str::to_string)
}

/// Enumerates GPUs under a `/sys/class/drm` style directory.
fn enumerate_gpus(drm_root: &Path) -> Vec<Gpu> {
    let Ok(entries) = std::fs::read_dir(drm_root) else {
        return Vec::new();
    };

    let mut gpus: Vec<Gpu> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            // `card0-DP-1` style entries are connectors, not devices
            if !name.starts_with("card") || name.contains('-') {
                return None;
            }
            let path: PathBuf = entry.path();
            let vendor = read_sysfs(&path.join("device/vendor"))
                .and_then(|v| u32::from_str_radix(v.trim_start_matches("0x"), 16).ok());
            let primary = read_sysfs(&path.join("device/boot_vga")).as_deref() == Some("1")
                || read_sysfs(&path.join("device/boot_display")).as_deref() == Some("1");
            Some(Gpu {
                card: name,
                vendor,
                driver: driver_name(&path),
                primary,
            })
        })
        .collect();

    gpus.sort_by(|a, b| a.card.cmp(&b.card));
    gpus
}

/// Picks the NVIDIA GPU that matters, if there is one.
fn nvidia_target(gpus: &[Gpu], prime_offload: bool) -> Option<&Gpu> {
    let no_primary_marked = !gpus.iter().any(|gpu| gpu.primary);
    if prime_offload || no_primary_marked {
        return gpus.iter().find(|gpu| gpu.is_nvidia());
    }
    gpus.iter().find(|gpu| gpu.primary && gpu.is_nvidia())
}

/// The whole decision.
fn decide(env: &Env, drm_root: &Path) -> Decision {
    match env.force.as_deref() {
        Some("0") => {
            return Decision::Overridden(format!("{FORCE_VAR}=0"));
        }
        Some("1") => {
            let gpus = enumerate_gpus(drm_root);
            let target = nvidia_target(&gpus, env.prime_offload.is_some());
            return Decision::Apply {
                gpu: target
                    .and_then(|gpu| gpu.vendor)
                    .map_or_else(|| "unknown".to_string(), |v| format!("{v:#06x}")),
                driver: target
                    .and_then(|gpu| gpu.driver.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                session: session_type(env),
            };
        }
        _ => {}
    }

    // Taking WebKit off the GL path already avoids the bad frame, and the two
    // workarounds together are more disruptive than either alone.
    if env.webkit_disable_dmabuf.as_deref() == Some("1") {
        return Decision::Overridden("WEBKIT_DISABLE_DMABUF_RENDERER=1".to_string());
    }

    let session = session_type(env);
    if session != SessionType::Wayland {
        return Decision::NotAffected(NOT_WAYLAND);
    }

    let gpus = enumerate_gpus(drm_root);
    match nvidia_target(&gpus, env.prime_offload.is_some()) {
        Some(gpu) => Decision::Apply {
            gpu: gpu
                .vendor
                .map_or_else(|| "unknown".to_string(), |vendor| format!("{vendor:#06x}")),
            driver: gpu.driver.clone().unwrap_or_else(|| "unknown".to_string()),
            session,
        },
        None => Decision::NotAffected(NOT_NVIDIA),
    }
}

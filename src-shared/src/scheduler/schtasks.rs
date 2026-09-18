//! Windows backend: Task Scheduler via schtasks.exe with full XML task definitions
//! (the /XML route has far better trigger fidelity than /SC flags).
//!
//! Missed fires are NOT replayed (`StartWhenAvailable` is false) — deliberate policy, matching
//! cron's no-catch-up semantics on Unix: a missed window is skipped, never run late.
//!
//! User-mode tasks (the default) register with the InteractiveToken logon type: they run only
//! while the user is logged on, inside that session, with mapped drives available. System-mode
//! tasks use S4U (Service-for-User) instead: they run as the registering user even while logged
//! out, with no password stored — matching cron semantics on Linux. The one S4U restriction: no
//! access to Windows-authenticated network resources (mapped drives, SMB with implicit auth);
//! rclone remotes with their own credentials are unaffected.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

use super::cronconv::{DayShape, SchtasksTrigger};
use super::storeread::DataDir;
use super::{InstallState, Registration, RenderedSchedule, SchedulerBackend};

const TASK_FOLDER: &str = "RcloneUI";
const TASK_PREFIX: &str = "task-";

pub struct SchtasksBackend {
    artifacts_dir: PathBuf,
    dirs: DataDir,
}

impl SchtasksBackend {
    pub fn new(dirs: &DataDir) -> Self {
        Self {
            artifacts_dir: dirs.root.join("scheduler").join("artifacts"),
            dirs: dirs.clone(),
        }
    }

    fn task_name(task_id: &str) -> String {
        format!("\\{}\\{}{}", TASK_FOLDER, TASK_PREFIX, task_id)
    }

    fn xml_path(&self, task_id: &str) -> PathBuf {
        self.artifacts_dir.join(format!("{}.xml", task_id))
    }

    fn schtasks(args: &[&str]) -> Result<std::process::Output, String> {
        let mut cmd = Command::new("schtasks");
        cmd.args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output()
            .map_err(|e| format!("failed to run schtasks: {}", e))
    }

    fn schtasks_checked(args: &[&str], verb: &str) -> Result<(), String> {
        let output = Self::schtasks(args)?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "schtasks {} failed: {}",
            verb,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }

    fn build_xml(task_id: &str, rendered: &RenderedSchedule) -> Result<String, String> {
        let triggers = super::cronconv::to_schtasks(&rendered.cron)?;

        let mut triggers_xml = String::new();
        for trigger in &triggers {
            triggers_xml.push_str(&render_trigger(trigger));
        }

        let args_joined = rendered
            .args
            .iter()
            .map(|arg| quote_windows_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");

        // User-mode tasks use the interactive token: they run only while the user is logged on,
        // inside that session (mapped drives and implicit-auth shares work). System tasks use
        // S4U (see module docs).
        let logon_type = if rendered.user_mode {
            "InteractiveToken"
        } else {
            "S4U"
        };

        // One hour above the runner's own deadline, so the runner always times the job out
        // gracefully (stop + history + webhook) before Task Scheduler hard-kills the process.
        let time_limit_hours = rendered.max_run_seconds.div_ceil(3600) + 1;

        Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Rclone UI scheduled task {name}</Description>
    <URI>{uri}</URI>
  </RegistrationInfo>
  <Triggers>
{triggers}  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>{logon_type}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>false</StartWhenAvailable>
    <Enabled>{enabled}</Enabled>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT{time_limit_hours}H</ExecutionTimeLimit>
    <Hidden>false</Hidden>
    <WakeToRun>false</WakeToRun>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"{program}"</Command>
      <Arguments>{args}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
            name = escape_xml(&rendered.display_name),
            uri = escape_xml(&Self::task_name(task_id)),
            triggers = triggers_xml,
            logon_type = logon_type,
            // Task-level Enabled (what /Change /ENABLE|/DISABLE flips): installing directly in
            // the target state means a disabled task is never briefly armed between a create and
            // a follow-up disable. is_installed keys off this same element.
            enabled = rendered.enabled,
            program = escape_xml(&rendered.program.to_string_lossy()),
            // Each arg is CommandLineToArgvW-quoted (data-dir paths can contain spaces).
            args = escape_xml(&args_joined),
        ))
    }

    fn write_utf16le(path: &PathBuf, content: &str) -> Result<(), String> {
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for unit in content.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(path, bytes).map_err(|e| format!("failed to write task XML: {}", e))
    }
}

fn render_trigger(trigger: &SchtasksTrigger) -> String {
    let start = format!(
        "2024-01-01T{:02}:{:02}:00",
        trigger.start_hour, trigger.start_minute
    );

    let repetition = match trigger.repetition {
        Some((interval, duration_minutes)) => {
            // Durations arrive one interval short of the hour/day window (cronconv): the
            // Duration is endpoint-inclusive, so a full-window duration would fire once more at
            // the top of the next window.
            format!(
                "      <Repetition>\n        <Interval>PT{}M</Interval>\n        <Duration>PT{}M</Duration>\n        <StopAtDurationEnd>false</StopAtDurationEnd>\n      </Repetition>\n",
                interval, duration_minutes
            )
        }
        None => String::new(),
    };

    let schedule = match &trigger.shape {
        DayShape::Daily => {
            "      <ScheduleByDay>\n        <DaysInterval>1</DaysInterval>\n      </ScheduleByDay>\n"
                .to_string()
        }
        DayShape::Weekly(days) => {
            let day_elements: String = days
                .iter()
                .map(|d| format!("          <{}/>\n", dow_element(*d)))
                .collect();
            format!(
                "      <ScheduleByWeek>\n        <WeeksInterval>1</WeeksInterval>\n        <DaysOfWeek>\n{}        </DaysOfWeek>\n      </ScheduleByWeek>\n",
                day_elements
            )
        }
        DayShape::Monthly { days, months } => {
            let day_elements: String = days
                .iter()
                .map(|d| format!("          <Day>{}</Day>\n", d))
                .collect();
            let month_elements: String = month_elements(months);
            format!(
                "      <ScheduleByMonth>\n        <DaysOfMonth>\n{}        </DaysOfMonth>\n        <Months>\n{}        </Months>\n      </ScheduleByMonth>\n",
                day_elements, month_elements
            )
        }
        DayShape::MonthlyDow { dows, months } => {
            // Every week of the month (1-4 + Last): cron weekday semantics have no week-of-month
            // notion. A day that is both the 4th and the last matching weekday still fires once —
            // the weeks are one trigger's calendar, not separate triggers.
            let day_elements: String = dows
                .iter()
                .map(|d| format!("          <{}/>\n", dow_element(*d)))
                .collect();
            let month_elements: String = month_elements(months);
            format!(
                "      <ScheduleByMonthDayOfWeek>\n        <Weeks>\n          <Week>1</Week>\n          <Week>2</Week>\n          <Week>3</Week>\n          <Week>4</Week>\n          <Week>Last</Week>\n        </Weeks>\n        <DaysOfWeek>\n{}        </DaysOfWeek>\n        <Months>\n{}        </Months>\n      </ScheduleByMonthDayOfWeek>\n",
                day_elements, month_elements
            )
        }
    };

    format!(
        "    <CalendarTrigger>\n      <StartBoundary>{}</StartBoundary>\n      <Enabled>true</Enabled>\n{}{}    </CalendarTrigger>\n",
        start, repetition, schedule
    )
}

fn dow_element(dow: u16) -> &'static str {
    match dow {
        0 => "Sunday",
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        _ => "Saturday",
    }
}

fn month_elements(months: &BTreeSet<u16>) -> String {
    const NAMES: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    months
        .iter()
        .filter(|m| (1..=12).contains(*m))
        .map(|m| format!("          <{}/>\n", NAMES[(*m - 1) as usize]))
        .collect()
}

impl SchedulerBackend for SchtasksBackend {
    fn install(&self, task_id: &str, rendered: &RenderedSchedule) -> Result<(), String> {
        let xml = Self::build_xml(task_id, rendered)?;
        std::fs::create_dir_all(&self.artifacts_dir)
            .map_err(|e| format!("failed to create artifacts dir: {}", e))?;
        let xml_path = self.xml_path(task_id);
        Self::write_utf16le(&xml_path, &xml)?;
        let task_name = Self::task_name(task_id);
        let xml_path_text = xml_path.to_string_lossy().into_owned();
        let mut args = vec![
            "/Create",
            "/F",
            "/TN",
            task_name.as_str(),
            "/XML",
            xml_path_text.as_str(),
        ];
        // /NP: no stored password (S4U principal only — interactive-token tasks don't store one).
        if !rendered.user_mode {
            args.push("/NP");
        }
        let create_result = Self::schtasks_checked(&args, "/Create");
        // S4U needs the user's SID resolved; service accounts on headless/CI machines can't.
        if let Err(error) = &create_result {
            if error.contains("No mapping between account names") {
                return Err(
                    "Could not register the task: this Windows account's identity (SID) cannot be resolved, which S4U scheduled tasks require. Run Rclone UI under a regular user account."
                        .to_string(),
                );
            }
        }
        create_result
    }

    fn uninstall(&self, task_id: &str) -> Result<(), String> {
        let delete = Self::schtasks(&["/Delete", "/F", "/TN", &Self::task_name(task_id)])?;
        let _ = std::fs::remove_file(self.xml_path(task_id));
        if delete.status.success() {
            return Ok(());
        }
        // /Delete's error text is localized, so "already absent" (benign) can't be matched by
        // string. Confirm via the locale-invariant XML query instead: still installed after a
        // failed delete (access denied, service trouble) is a REAL failure — swallowing it would
        // report an uninstall that never happened and leave the task firing forever.
        match self.is_installed(task_id)? {
            InstallState::NotInstalled => Ok(()),
            InstallState::Installed { .. } => Err(format!(
                "schtasks /Delete failed: {}",
                String::from_utf8_lossy(&delete.stderr).trim()
            )),
        }
    }

    fn set_enabled(&self, task_id: &str, enabled: bool) -> Result<(), String> {
        // /Change's failure text is LOCALIZED, so a missing task could never surface as the
        // NOT_REGISTERED sentinel the way it does on the other backends — and mod.rs's
        // disable-every-backend path relies on that sentinel to treat "no artifact" as benign.
        // Without it, disabling a task whose registration failed errors out, isEnabled stays
        // true, and the next startup reconcile re-arms a task the user tried to pause. Prove
        // absence first via the locale-invariant query.
        if matches!(self.is_installed(task_id)?, InstallState::NotInstalled) {
            return Err(super::NOT_REGISTERED.to_string());
        }
        let flag = if enabled { "/ENABLE" } else { "/DISABLE" };
        Self::schtasks_checked(
            &["/Change", "/TN", &Self::task_name(task_id), flag],
            "/Change",
        )
    }

    fn run_now(&self, task_id: &str) -> Result<(), String> {
        Self::schtasks_checked(&["/Run", "/TN", &Self::task_name(task_id)], "/Run")
    }

    fn is_installed(&self, task_id: &str) -> Result<InstallState, String> {
        // Query the task's XML definition rather than the CSV listing: the CSV Status column is
        // LOCALIZED ("Disabled" is "Deaktiviert"/"Désactivé"/… elsewhere), while the XML
        // <Enabled> element is locale-invariant. Install writes the Settings-level Enabled (the
        // flag /Change /ENABLE|/DISABLE flips) and trigger-level Enabled is always true, so any
        // 'false' in the document means the task is disabled.
        let output = Self::schtasks(&["/Query", "/TN", &Self::task_name(task_id), "/XML"])?;
        if output.status.success() {
            // Console output can be UTF-16 on some systems — drop NULs before matching.
            let mut bytes = output.stdout;
            bytes.retain(|&b| b != 0);
            let xml = String::from_utf8_lossy(&bytes).to_lowercase();
            let enabled = !xml.contains("<enabled>false</enabled>");
            return Ok(InstallState::Installed { enabled });
        }

        // A failed per-task query does NOT prove absence — access denial or a stopped Task
        // Scheduler service also exit non-zero (with LOCALIZED stderr, so no string matching).
        // Disambiguate via the full listing: if the service answers and our task name isn't in
        // it, the task is really gone; anything else is a real error that must not be reported
        // as "not installed" (the uninstall verification would turn it into a false success).
        let listing = Self::schtasks(&["/Query", "/FO", "CSV", "/NH"])?;
        if !listing.status.success() {
            return Err(format!(
                "schtasks /Query failed: {}",
                String::from_utf8_lossy(&listing.stderr).trim()
            ));
        }
        let mut bytes = listing.stdout;
        bytes.retain(|&b| b != 0);
        let stdout = String::from_utf8_lossy(&bytes);
        // Closing quote included so task-abc never matches task-abc2.
        let needle = format!("{}\"", Self::task_name(task_id));
        if stdout.contains(&needle) {
            return Err(format!(
                "schtasks /Query /TN failed although the task exists: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(InstallState::NotInstalled)
    }

    fn inventory(&self) -> Result<Vec<Registration>, String> {
        let listing = Self::schtasks(&["/Query", "/FO", "CSV", "/NH"])?;
        if !listing.status.success() {
            return Err(format!(
                "schtasks /Query failed: {}",
                String::from_utf8_lossy(&listing.stderr).trim()
            ));
        }
        // Console output can be UTF-16 on some systems — drop NULs before matching.
        let mut bytes = listing.stdout;
        bytes.retain(|&b| b != 0);
        let stdout = String::from_utf8_lossy(&bytes);
        let needle = format!("\\{}\\{}", TASK_FOLDER, TASK_PREFIX);
        let mut out = Vec::new();
        for line in stdout.lines() {
            let Some(start) = line.find(&needle) else {
                continue;
            };
            let task_id: String = line[start + needle.len()..]
                .chars()
                .take_while(|c| *c != '"')
                .collect();
            let enabled = match self.is_installed(&task_id)? {
                InstallState::Installed { enabled } => enabled,
                InstallState::NotInstalled => continue,
            };
            out.push(Registration {
                owned: owned_by_this_profile(&task_id, &self.dirs),
                task_id,
                enabled,
            });
        }
        Ok(out)
    }
}

/// Whether the task's definition references THIS profile's data dir. Task Scheduler's namespace
/// is machine-global: another Windows account running Rclone UI registers under the very same
/// `\RcloneUI\task-*` names, and an elevated sweep could see (and delete) those. Every task we
/// register bakes `--data-dir <this user's app_data>` into its arguments, so requiring it in
/// the XML scopes the sweep to tasks this profile actually owns. Unreadable definitions are NOT
/// ours to judge — skipped.
fn owned_by_this_profile(task_id: &str, dirs: &DataDir) -> bool {
    let Ok(output) = SchtasksBackend::schtasks(&[
        "/Query",
        "/TN",
        &SchtasksBackend::task_name(task_id),
        "/XML",
    ]) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let mut bytes = output.stdout;
    bytes.retain(|&b| b != 0);
    let xml = String::from_utf8_lossy(&bytes).to_lowercase();
    let needle = escape_xml(&dirs.root.to_string_lossy()).to_lowercase();
    xml.contains(&needle)
}

fn escape_xml(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// CommandLineToArgvW-style quoting for one argument of the task's <Arguments> string: quote when
/// needed, escape embedded quotes, and double backslash runs that precede a quote (including the
/// closing one). Data-dir paths contain spaces ("C:\Users\John Smith\AppData\…"), so this is
/// load-bearing, not defensive.
fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // The n backslashes already emitted must double to 2n, plus one to escape the quote.
                out.push_str(&"\\".repeat(backslashes + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                out.push(c);
            }
        }
    }
    // Trailing backslashes double so they don't escape the closing quote.
    out.push_str(&"\\".repeat(backslashes));
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_has_monthly_dow_enabled_state_and_quoted_args() {
        let rendered = RenderedSchedule {
            // Every Monday in June at 03:00 — the weekday+month combo that needs
            // ScheduleByMonthDayOfWeek.
            cron: super::super::cronconv::parse("0 3 * 6 1").unwrap(),
            program: PathBuf::from(r"C:\Program Files\Rclone UI\Rclone UI.exe"),
            args: vec![
                "run-task".into(),
                "abc".into(),
                "--host".into(),
                "local".into(),
                "--data-dir".into(),
                r"C:\Users\John Smith\AppData\Roaming\com.rclone.ui".into(),
            ],
            display_name: "nightly".into(),
            user_mode: true,
            enabled: false,
            max_run_seconds: 120 * 3600,
        };
        let xml = SchtasksBackend::build_xml("abc", &rendered).unwrap();
        assert!(xml.contains("<ScheduleByMonthDayOfWeek>"));
        assert!(xml.contains("<Week>Last</Week>"));
        assert!(xml.contains("<Monday/>"));
        assert!(xml.contains("<June/>"));
        // Installed directly in the disabled state (Settings-level Enabled).
        assert!(xml.contains("<Enabled>false</Enabled>"));
        // Time limit tracks the task's max run (120h) + 1h headroom for a graceful runner stop.
        assert!(xml.contains("<ExecutionTimeLimit>PT121H</ExecutionTimeLimit>"));
        // The space-containing path arrives quoted; plain args stay bare.
        assert!(xml.contains(
            r#"run-task abc --host local --data-dir &quot;C:\Users\John Smith\AppData\Roaming\com.rclone.ui&quot;"#
        ));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
    }

    #[test]
    fn windows_arg_quoting() {
        assert_eq!(quote_windows_arg("run-task"), "run-task");
        assert_eq!(quote_windows_arg("--data-dir"), "--data-dir");
        assert_eq!(
            quote_windows_arg(r"C:\Users\John Smith\AppData\Roaming\com.rclone.ui"),
            r#""C:\Users\John Smith\AppData\Roaming\com.rclone.ui""#
        );
        // Trailing backslash before the closing quote must double.
        assert_eq!(quote_windows_arg(r"C:\a dir\"), r#""C:\a dir\\""#);
        // Embedded quote: preceding backslashes double, quote gets its own escape.
        assert_eq!(quote_windows_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_windows_arg(""), "\"\"");
    }
}

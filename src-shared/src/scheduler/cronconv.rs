//! 5-field cron parsing and conversion to the native scheduler formats: crontab entries on
//! macOS/Linux and Task Scheduler triggers on Windows.
//!
//! Every field is normalized to either a wildcard or an explicit sorted value set — emitting
//! explicit values is more verbose than structural mapping (steps/ranges) but is correct by
//! construction on every backend. Cron's dom/dow OR semantics (when BOTH are restricted, a time
//! matches if EITHER matches) are native to crontab and reproduced for schtasks.
//!
//! Both converters compile on every platform (only one is reachable from production code per
//! target, but the unit tests exercise both everywhere).
#![allow(dead_code)]

use std::collections::BTreeSet;

/// Our self-imposed ceiling on the launchd StartCalendarInterval dicts a single cron expands
/// into (one per firing point, since launchd has no value lists). `launchd.plist(5)` documents no
/// hard maximum; this is purely a guard so a fragmented schedule can't produce an unwieldy plist.
/// Comfortably above any reasonable schedule.
const MAX_SCHEDULE_ENTRIES: usize = 128;

/// Task Scheduler's hard limit: the task XML schema allows at most 48 triggers per task
/// (Task Scheduler schema docs, triggerGroup maxOccurs=48). Exceeding it fails at /Create, so
/// reject at conversion/validation time with an actionable message instead.
const SCHTASKS_MAX_TRIGGERS: usize = 48;

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub wildcard: bool,
    /// The raw field text STARTS with '*' (a `*/n` step, or `*` itself). Load-bearing for the
    /// dom/dow rule: crontab(5) applies the either-field-matches OR only when BOTH day fields
    /// are restricted, and Vixie/cronie implement "restricted" as a first-character test (the
    /// DOM_STAR/DOW_STAR flags are set before parsing when the field begins with '*'). So `*/n`
    /// counts as UNRESTRICTED (its values still constrain matching; the day fields AND), while
    /// a mixed list like `1,*/5` counts as RESTRICTED (OR) — exactly as cron executes it.
    pub star: bool,
    pub values: BTreeSet<u16>,
    /// Verbatim (trimmed) field text. Star-origin fields are emitted unchanged into crontab
    /// entries — normalizing `*/5` to an explicit list would clear cron's own star flag and
    /// silently flip its dom/dow AND semantics to OR.
    pub raw: String,
}

impl Field {
    fn any() -> Self {
        Self {
            wildcard: true,
            star: true,
            values: BTreeSet::new(),
            raw: "*".to_string(),
        }
    }

    fn expanded(&self, min: u16, max: u16) -> Vec<u16> {
        if self.wildcard {
            (min..=max).collect()
        } else {
            self.values.iter().copied().collect()
        }
    }

    /// "Restricted" in the crontab(5) dom/dow sense: constrains days AND doesn't start with '*'.
    fn restricted(&self) -> bool {
        !self.wildcard && !self.star
    }
}

/// Whether cron's dom/dow OR rule applies (both day fields restricted per crontab(5)). When it
/// doesn't — and neither field is a pure wildcard — the day fields intersect (AND).
fn day_fields_use_or(spec: &CronSpec) -> bool {
    spec.dom.restricted() && spec.dow.restricted()
}

/// The day relationship a spec encodes, read once for the matcher, the preview and both
/// platform renderers. Cron ORs the two day fields when both are restricted; a star-origin
/// step on one of them with the other restricted is an AND, which launchd and Task Scheduler
/// cannot express in one task.
#[derive(Debug, Clone, PartialEq)]
pub enum DayConstraint {
    Any,
    MonthDays(Vec<u16>),
    /// 0 = Sunday.
    Weekdays(Vec<u16>),
    /// The day of month or the weekday matches (both fields restricted).
    Either {
        days: Vec<u16>,
        weekdays: Vec<u16>,
    },
    /// Both must match (a star-step day field with the other one restricted).
    Both {
        days: Vec<u16>,
        weekdays: Vec<u16>,
    },
}

impl DayConstraint {
    pub fn hits(&self, dom: u16, dow: u16) -> bool {
        match self {
            DayConstraint::Any => true,
            DayConstraint::MonthDays(days) => days.contains(&dom),
            DayConstraint::Weekdays(weekdays) => weekdays.contains(&dow),
            DayConstraint::Either { days, weekdays } => {
                days.contains(&dom) || weekdays.contains(&dow)
            }
            DayConstraint::Both { days, weekdays } => {
                days.contains(&dom) && weekdays.contains(&dow)
            }
        }
    }
}

pub fn day_constraint(spec: &CronSpec) -> DayConstraint {
    match (spec.dom.wildcard, spec.dow.wildcard) {
        (true, true) => DayConstraint::Any,
        (false, true) => DayConstraint::MonthDays(spec.dom.expanded(1, 31)),
        (true, false) => DayConstraint::Weekdays(spec.dow.expanded(0, 6)),
        (false, false) if day_fields_use_or(spec) => DayConstraint::Either {
            days: spec.dom.expanded(1, 31),
            weekdays: spec.dow.expanded(0, 6),
        },
        (false, false) => DayConstraint::Both {
            days: spec.dom.expanded(1, 31),
            weekdays: spec.dow.expanded(0, 6),
        },
    }
}

const DAY_AND_UNSUPPORTED: &str = "This schedule requires the day of month AND the weekday to match together (a '*/n' day step combined with a weekday restriction) — {platform} cannot express that in one scheduled task. Use explicit days of the month (e.g. 1,6,11) or drop one of the two day fields.";

#[derive(Debug, Clone)]
pub struct CronSpec {
    pub minute: Field,
    pub hour: Field,
    pub dom: Field,
    pub month: Field,
    /// 0-6, 0 = Sunday (cron's 7 is normalized to 0).
    pub dow: Field,
}

const MONTH_NAMES: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];
const DOW_NAMES: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

pub fn parse(expr: &str) -> Result<CronSpec, String> {
    let trimmed = expr.trim();
    if trimmed.starts_with('@') {
        let hint = match trimmed.to_ascii_lowercase().as_str() {
            "@hourly" => "0 * * * *",
            "@daily" | "@midnight" => "0 0 * * *",
            "@weekly" => "0 0 * * 0",
            "@monthly" => "0 0 1 * *",
            "@yearly" | "@annually" => "0 0 1 1 *",
            _ => {
                return Err(format!(
                    "'{}' is not supported — use a 5-field cron expression",
                    trimmed
                ))
            }
        };
        return Err(format!(
            "Nicknames are not supported — use the equivalent 5-field expression: {}",
            hint
        ));
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() == 6 {
        return Err("Seconds are not supported — use a 5-field cron expression".to_string());
    }
    if parts.len() != 5 {
        return Err(format!(
            "Expected 5 cron fields (minute hour day month weekday), got {}",
            parts.len()
        ));
    }

    let minute = parse_field(parts[0], 0, 59, None, "minute")?;
    let hour = parse_field(parts[1], 0, 23, None, "hour")?;
    let dom = parse_field(parts[2], 1, 31, None, "day of month")?;
    let month = parse_field(parts[3], 1, 12, Some(&MONTH_NAMES), "month")?;
    let mut dow = parse_field(parts[4], 0, 7, Some(&DOW_NAMES), "day of week")?;

    // Normalize dow 7 (also Sunday) to 0.
    if dow.values.remove(&7) {
        dow.values.insert(0);
    }

    Ok(CronSpec {
        minute,
        hour,
        dom,
        month,
        dow,
    })
}

fn parse_field(
    raw: &str,
    min: u16,
    max: u16,
    names: Option<&[&str]>,
    label: &str,
) -> Result<Field, String> {
    if raw == "*" {
        return Ok(Field::any());
    }

    let mut values = BTreeSet::new();

    for part in raw.split(',') {
        if part.is_empty() {
            return Err(format!("Empty list entry in {} field", label));
        }

        let (base, step) = match part.split_once('/') {
            Some((b, s)) => {
                let step: u16 = s
                    .parse()
                    .map_err(|_| format!("Invalid step '{}' in {} field", s, label))?;
                if step == 0 {
                    return Err(format!("Step of 0 in {} field", label));
                }
                (b, Some(step))
            }
            None => (part, None),
        };

        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            let a = parse_value(a, names, label)?;
            let b = parse_value(b, names, label)?;
            if a > b {
                return Err(format!(
                    "Range '{}' in {} field must be ascending — for wrap-around use two parts, e.g. '{}-{},{}-{}'",
                    base, label, a, max, min, b
                ));
            }
            (a, b)
        } else {
            let v = parse_value(base, names, label)?;
            // "a/n" means: starting at a, every n up to the field max.
            if step.is_some() {
                (v, max)
            } else {
                (v, v)
            }
        };

        if start < min || end > max {
            return Err(format!(
                "Value out of range in {} field (allowed {}-{})",
                label, min, max
            ));
        }

        let step = step.unwrap_or(1);
        let mut v = start;
        while v <= end {
            values.insert(v);
            match v.checked_add(step) {
                Some(next) => v = next,
                None => break,
            }
        }
    }

    if values.is_empty() {
        return Err(format!("No values in {} field", label));
    }

    Ok(Field {
        wildcard: false,
        star: raw.starts_with('*'),
        values,
        raw: raw.to_string(),
    })
}

fn parse_value(raw: &str, names: Option<&[&str]>, label: &str) -> Result<u16, String> {
    if let Ok(v) = raw.parse::<u16>() {
        return Ok(v);
    }
    if let Some(names) = names {
        let upper = raw.to_ascii_uppercase();
        if let Some(idx) = names.iter().position(|n| *n == upper) {
            // Month names are 1-based, dow names 0-based — the caller's names array is ordered
            // to match its numeric domain start.
            let offset = if names.len() == 12 { 1 } else { 0 };
            return Ok(idx as u16 + offset);
        }
    }
    Err(format!("Invalid value '{}' in {} field", raw, label))
}

pub fn validate_for_current_platform(expr: &str) -> Result<(), String> {
    let spec = parse(expr)?;
    #[cfg(unix)]
    {
        // crontab accepts every expression the parser accepts (to_crontab is infallible). On
        // macOS a user-mode task additionally goes through to_launchd, whose dict cap can reject
        // very complex schedules — that surfaces at register time via registrationError rather
        // than here (validation doesn't know the task's run mode).
        let _ = spec;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        to_schtasks(&spec).map(|_| ())
    }
}

/// Whether a given local wall-clock time matches the spec. Reproduces cron's dom/dow rule: when
/// BOTH day fields are restricted (Vixie's first-character star test — see `Field::star`) a time
/// matches if EITHER matches; otherwise both must match (a `*/n` day step therefore ANDs with
/// the other day field, as Vixie/cronie execute it). `dow` is 0-6, 0 = Sunday.
///
/// Used only by the macOS runner to suppress launchd's wake-catch-up: an on-time launchd fire
/// lands on a minute the schedule matches, a missed-while-asleep catch-up does not.
pub fn matches(spec: &CronSpec, minute: u16, hour: u16, dom: u16, month: u16, dow: u16) -> bool {
    fn hit(field: &Field, value: u16) -> bool {
        field.wildcard || field.values.contains(&value)
    }
    if !hit(&spec.minute, minute) || !hit(&spec.hour, hour) || !hit(&spec.month, month) {
        return false;
    }
    day_constraint(spec).hits(dom, dow)
}

/// The next `count` local wall-clock fire times after `from`, as RFC3339 strings with the local
/// offset. THE preview source of truth: it runs on the exact `matches()` the runner itself uses,
/// so the UI can never predict fires the native schedule won't perform (JS cron libraries
/// classify the dom/dow star flag differently from Vixie cron). Bounded at 5 years — a schedule
/// with no match in that window (e.g. `0 0 31 2 *`) returns what it found.
pub fn next_fires(
    spec: &CronSpec,
    from: chrono::DateTime<chrono::Local>,
    count: usize,
) -> Vec<String> {
    use chrono::{Datelike, Duration, SecondsFormat, Timelike};

    fn hit(field: &Field, value: u16) -> bool {
        field.wildcard || field.values.contains(&value)
    }

    let mut out = Vec::new();
    // Start at the next whole minute; days that can't match are skipped whole (and hours
    // likewise), so even a yearly schedule scans ~1800 day probes, not 2.6M minutes.
    let mut t = from
        .with_second(0)
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(from)
        + Duration::minutes(1);
    let horizon = from + Duration::days(5 * 366);
    let days = day_constraint(spec);
    while out.len() < count && t <= horizon {
        let day_ok = hit(&spec.month, t.month() as u16)
            && days.hits(t.day() as u16, t.weekday().num_days_from_sunday() as u16);
        if !day_ok {
            // Next CALENDAR day via succ_opt — never `t + 24h`: on a 25-hour fall-back day,
            // midnight + 24h is 23:00 of the SAME date, and deriving the "next" day from it
            // loops on that midnight forever. A DST gap at the next midnight (earliest() =
            // None) falls back to absolute +24h, which always progresses.
            t = t
                .date_naive()
                .succ_opt()
                .and_then(|day| day.and_hms_opt(0, 0, 0))
                .and_then(|naive| naive.and_local_timezone(chrono::Local).earliest())
                .unwrap_or_else(|| t + Duration::days(1));
            continue;
        }
        if !hit(&spec.hour, t.hour() as u16) {
            t = t
                .with_minute(0)
                .map(|t| t + Duration::hours(1))
                .unwrap_or(t + Duration::hours(1));
            continue;
        }
        if hit(&spec.minute, t.minute() as u16) {
            out.push(t.to_rfc3339_opts(SecondsFormat::Secs, false));
        }
        t += Duration::minutes(1);
    }
    out
}

// ---------------------------------------------------------------------------
// crontab (macOS + Linux)
// ---------------------------------------------------------------------------

/// 5-field string for a crontab entry. Star-origin fields (`*` or `*/n` — anything STARTING
/// with '*') are emitted VERBATIM: cron's dom/dow AND-vs-OR decision keys on the leading '*',
/// so normalizing `*/5` into an explicit list would change execution semantics. Everything else
/// is normalized to plain value lists (names/ranges expanded — equivalent on every cron; a
/// mixed `1,*/5` list is already restricted in cron's eyes, so its expansion is too).
pub fn to_crontab(spec: &CronSpec) -> String {
    fn plain(field: &Field) -> String {
        if field.wildcard {
            "*".to_string()
        } else if field.star {
            field.raw.clone()
        } else {
            field
                .values
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(",")
        }
    }
    format!(
        "{} {} {} {} {}",
        plain(&spec.minute),
        plain(&spec.hour),
        plain(&spec.dom),
        plain(&spec.month),
        plain(&spec.dow)
    )
}

// ---------------------------------------------------------------------------
// macOS launchd (StartCalendarInterval)
// ---------------------------------------------------------------------------

/// One `StartCalendarInterval` dict: each key is a single integer (launchd has no range/list
/// syntax), a `None` key means "any", the keys within a dict are ANDed, and multiple dicts are
/// ORed. `weekday` is 0-6, 0 = Sunday.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchdCalendar {
    pub minute: Option<u16>,
    pub hour: Option<u16>,
    pub day: Option<u16>,
    pub weekday: Option<u16>,
    pub month: Option<u16>,
}

pub fn to_launchd(spec: &CronSpec) -> Result<Vec<LaunchdCalendar>, String> {
    // Day dimension. When cron restricts BOTH dom and dow, a time matches if EITHER matches (OR).
    // launchd also ORs a dict's Day and Weekday, so we emit SEPARATE Day-only and Weekday-only
    // dicts — |days| + |weekdays| dicts whose union is exactly cron's OR, and the minimal form.
    // (Combined Day+Weekday dicts would ALSO reproduce the OR correctly, but only as a redundant
    // |days| x |weekdays| Cartesian product; launchd has no lists, so multiple dicts are required
    // either way. The one thing launchd cannot express is Day AND Weekday — an intersection cron
    // does not want here.)
    let day_constraints: Vec<(Option<u16>, Option<u16>)> = match day_constraint(spec) {
        DayConstraint::Any => vec![(None, None)],
        DayConstraint::MonthDays(days) => days.into_iter().map(|d| (Some(d), None)).collect(),
        DayConstraint::Weekdays(weekdays) => {
            weekdays.into_iter().map(|w| (None, Some(w))).collect()
        }
        DayConstraint::Either { days, weekdays } => days
            .into_iter()
            .map(|d| (Some(d), None))
            .chain(weekdays.into_iter().map(|w| (None, Some(w))))
            .collect(),
        // launchd ORs a dict's Day and Weekday: the intersection is inexpressible. Fail
        // clearly instead of silently over-firing.
        DayConstraint::Both { .. } => {
            return Err(DAY_AND_UNSUPPORTED.replace("{platform}", "macOS"));
        }
    };

    // A wildcard field contributes a single `None` (the key is omitted = "any").
    let opt = |field: &Field, min: u16, max: u16| -> Vec<Option<u16>> {
        if field.wildcard {
            vec![None]
        } else {
            field.expanded(min, max).into_iter().map(Some).collect()
        }
    };
    let months = opt(&spec.month, 1, 12);
    let hours = opt(&spec.hour, 0, 23);
    let minutes = opt(&spec.minute, 0, 59);

    let total = day_constraints.len() * months.len() * hours.len() * minutes.len();
    if total > MAX_SCHEDULE_ENTRIES {
        return Err(format!(
            "This schedule expands to {} calendar entries — more than Rclone UI will put in one scheduled task ({}). Simplify the cron expression (for example use an even interval like */15).",
            total, MAX_SCHEDULE_ENTRIES
        ));
    }

    let mut out = Vec::with_capacity(total);
    for (day, weekday) in &day_constraints {
        for month in &months {
            for hour in &hours {
                for minute in &minutes {
                    out.push(LaunchdCalendar {
                        minute: *minute,
                        hour: *hour,
                        day: *day,
                        weekday: *weekday,
                        month: *month,
                    });
                }
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Windows Task Scheduler
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum DayShape {
    Daily,
    /// 0 = Sunday.
    Weekly(BTreeSet<u16>),
    /// Days 1-31 plus months 1-12 (all twelve when the cron month field is a wildcard).
    Monthly {
        days: BTreeSet<u16>,
        months: BTreeSet<u16>,
    },
    /// Weekdays (0 = Sunday) in specific months, firing in EVERY week of the month
    /// (ScheduleByMonthDayOfWeek with weeks 1-4 + Last). This is how Task Scheduler expresses a
    /// cron weekday restriction combined with a month restriction — plain Weekly triggers cannot
    /// carry months.
    MonthlyDow {
        dows: BTreeSet<u16>,
        months: BTreeSet<u16>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SchtasksTrigger {
    pub shape: DayShape,
    pub start_hour: u16,
    pub start_minute: u16,
    /// Repetition interval in minutes with its duration in minutes.
    pub repetition: Option<(u16, u16)>,
}

/// (start_hour, start_minute, repetition) — a trigger's time dimension before it is crossed
/// with the day shapes.
type TriggerTime = (u16, u16, Option<(u16, u16)>);

pub fn to_schtasks(spec: &CronSpec) -> Result<Vec<SchtasksTrigger>, String> {
    // Day-shape dimension. dom+dow both restricted → both trigger families (triggers OR).
    // Day-shape dimension. Weekly triggers can't carry a month restriction, so weekdays in
    // specific months become ScheduleByMonthDayOfWeek (every week of the month); an Either
    // constraint (cron's OR) is both trigger families, which Task Scheduler ORs.
    let months: BTreeSet<u16> = spec.month.expanded(1, 12).into_iter().collect();
    let month_wild = spec.month.wildcard;
    let monthly = |days: Vec<u16>| DayShape::Monthly {
        days: days.into_iter().collect(),
        months: months.clone(),
    };
    let weekly = |weekdays: Vec<u16>| {
        let dows: BTreeSet<u16> = weekdays.into_iter().collect();
        if month_wild {
            DayShape::Weekly(dows)
        } else {
            DayShape::MonthlyDow {
                dows,
                months: months.clone(),
            }
        }
    };
    let shapes: Vec<DayShape> = match day_constraint(spec) {
        DayConstraint::Any if month_wild => vec![DayShape::Daily],
        DayConstraint::Any => vec![monthly(spec.dom.expanded(1, 31))],
        DayConstraint::MonthDays(days) => vec![monthly(days)],
        DayConstraint::Weekdays(weekdays) => vec![weekly(weekdays)],
        DayConstraint::Either { days, weekdays } => vec![weekly(weekdays), monthly(days)],
        // Task Scheduler triggers can only OR. Fail clearly.
        DayConstraint::Both { .. } => {
            return Err(DAY_AND_UNSUPPORTED.replace("{platform}", "Windows Task Scheduler"));
        }
    };

    // Time dimension: uniform minute intervals become a Repetition; otherwise one trigger per
    // (hour, minute) combination.
    //
    // The repetition Duration is endpoint-INCLUSIVE: per the RepetitionPattern docs, a duration
    // of 4 minutes with a 1-minute interval launches the task FIVE times. So the duration must
    // be one interval short of the window (60/1440 min), or the last repeat lands on the top of
    // the next hour/day — an extra fire outside the schedule.
    let mut times: Vec<TriggerTime> = Vec::new();
    if let Some(interval) = uniform_minute_interval(&spec.minute) {
        let first = if spec.minute.wildcard {
            0
        } else {
            *spec.minute.values.iter().next().unwrap()
        };
        if spec.hour.wildcard {
            // Repeat all day.
            times.push((0, first, Some((interval, 24 * 60 - interval))));
        } else {
            // One trigger per hour, repeating within that hour.
            for hour in spec.hour.expanded(0, 23) {
                times.push((hour, first, Some((interval, 60 - interval))));
            }
        }
    } else {
        let minutes = spec.minute.expanded(0, 59);
        if spec.hour.wildcard {
            // Irregular minutes repeated every hour: one daily trigger per minute value,
            // repeating hourly for the rest of the day. 23h duration = 23 intervals, which with
            // the inclusive endpoint gives exactly 24 fires (…:mm each hour) — a full 24h
            // duration would fire once more at the next midnight.
            for minute in &minutes {
                times.push((0, *minute, Some((60, 24 * 60 - 60))));
            }
        } else {
            for hour in spec.hour.expanded(0, 23) {
                for minute in &minutes {
                    times.push((hour, *minute, None));
                }
            }
        }
    }

    let total = shapes.len() * times.len();
    if total > SCHTASKS_MAX_TRIGGERS {
        return Err(format!(
            "This schedule expands to {} triggers — more than Windows Task Scheduler supports in one task ({}). Simplify the cron expression (for example use an even interval like */15).",
            total, SCHTASKS_MAX_TRIGGERS
        ));
    }

    let mut triggers = Vec::with_capacity(total);
    for shape in &shapes {
        for (hour, minute, repetition) in &times {
            triggers.push(SchtasksTrigger {
                shape: shape.clone(),
                start_hour: *hour,
                start_minute: *minute,
                repetition: *repetition,
            });
        }
    }
    Ok(triggers)
}

/// Some(n) when the minute field fires at a constant interval n that stays aligned across the
/// hour wrap (so a Task Scheduler Repetition every n minutes matches exactly).
fn uniform_minute_interval(minute: &Field) -> Option<u16> {
    if minute.wildcard {
        return Some(1);
    }
    let values: Vec<u16> = minute.values.iter().copied().collect();
    if values.len() < 2 {
        return None;
    }
    let interval = values[1] - values[0];
    if interval == 0 || 60 % interval != 0 {
        return None;
    }
    for pair in values.windows(2) {
        if pair[1] - pair[0] != interval {
            return None;
        }
    }
    // Must wrap evenly into the next hour.
    if (60 - values[values.len() - 1]) + values[0] != interval {
        return None;
    }
    Some(interval)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The day decision as the four call sites each spelled it before it was read once: the
    /// oracle for `DayConstraint`, over every dom/dow field shape and every day of the week and
    /// month.
    #[test]
    fn the_day_constraint_matches_the_old_decision_everywhere() {
        fn hit(field: &Field, value: u16) -> bool {
            field.wildcard || field.values.contains(&value)
        }
        let fields = ["*", "1,15", "*/5", "1-7", "31"];
        let weekdays = ["*", "1", "0,6", "*/2", "1-5"];
        for dom in fields {
            for dow in weekdays {
                let spec = parse(&format!("0 2 {} * {}", dom, dow)).unwrap();
                let constraint = day_constraint(&spec);
                for day in 1..=31u16 {
                    for weekday in 0..=6u16 {
                        let old = if day_fields_use_or(&spec) {
                            hit(&spec.dom, day) || hit(&spec.dow, weekday)
                        } else {
                            hit(&spec.dom, day) && hit(&spec.dow, weekday)
                        };
                        assert_eq!(
                            constraint.hits(day, weekday),
                            old,
                            "{} {} on day {} weekday {}",
                            dom,
                            dow,
                            day,
                            weekday
                        );
                    }
                }
            }
        }
    }

    fn set(values: &[u16]) -> BTreeSet<u16> {
        values.iter().copied().collect()
    }

    #[test]
    fn parses_presets() {
        let spec = parse("*/15 * * * *").unwrap();
        assert!(!spec.minute.wildcard);
        assert_eq!(spec.minute.values, set(&[0, 15, 30, 45]));
        assert!(spec.hour.wildcard);
    }

    #[test]
    fn parses_names_ranges_lists() {
        let spec = parse("0 9-17 1,15 JAN,jul MON-FRI").unwrap();
        assert_eq!(spec.hour.values, set(&[9, 10, 11, 12, 13, 14, 15, 16, 17]));
        assert_eq!(spec.dom.values, set(&[1, 15]));
        assert_eq!(spec.month.values, set(&[1, 7]));
        assert_eq!(spec.dow.values, set(&[1, 2, 3, 4, 5]));
    }

    #[test]
    fn normalizes_dow_seven() {
        let spec = parse("0 0 * * 7").unwrap();
        assert_eq!(spec.dow.values, set(&[0]));
    }

    #[test]
    fn rejects_six_fields_and_bad_values() {
        assert!(parse("0 0 0 * * *").is_err());
        assert!(parse("61 * * * *").is_err());
        assert!(parse("* * * * MOO").is_err());
        assert!(parse("5-1 * * * *").is_err());
    }

    #[test]
    fn rejects_nicknames_with_equivalent_hint() {
        let err = parse("@daily").unwrap_err();
        assert!(err.contains("0 0 * * *"));
        let err = parse("@hourly").unwrap_err();
        assert!(err.contains("0 * * * *"));
        assert!(parse("@bogus").is_err());
    }

    #[test]
    fn wraparound_error_suggests_split() {
        let err = parse("50-10 * * * *").unwrap_err();
        assert!(err.contains("50-59,0-10"));
    }

    #[test]
    fn schtasks_minute_repetition() {
        let spec = parse("*/10 * * * *").unwrap();
        let triggers = to_schtasks(&spec).unwrap();
        assert_eq!(triggers.len(), 1);
        // Duration is endpoint-inclusive, so it stops one interval short of the full day —
        // otherwise the last repeat would fire again at the next midnight.
        assert_eq!(triggers[0].repetition, Some((10, 24 * 60 - 10)));
        assert_eq!(triggers[0].shape, DayShape::Daily);
    }

    #[test]
    fn schtasks_hourly_window_repetition() {
        let spec = parse("*/15 9,10 * * *").unwrap();
        let triggers = to_schtasks(&spec).unwrap();
        assert_eq!(triggers.len(), 2);
        // 45, not 60: an inclusive 60-minute duration would add a 10:00 fire to the 9:xx window.
        assert_eq!(triggers[0].repetition, Some((15, 45)));
        assert_eq!(triggers[0].start_hour, 9);
    }

    #[test]
    fn schtasks_weekly_and_monthly_or() {
        let spec = parse("0 3 1 * 1").unwrap();
        let triggers = to_schtasks(&spec).unwrap();
        assert_eq!(triggers.len(), 2);
        assert!(matches!(triggers[0].shape, DayShape::Weekly(_)));
        assert!(matches!(triggers[1].shape, DayShape::Monthly { .. }));
    }

    #[test]
    fn schtasks_weekday_with_months_uses_monthly_dow() {
        // "every Monday in June" — representable via ScheduleByMonthDayOfWeek (all weeks).
        let triggers = to_schtasks(&parse("0 3 * 6 1").unwrap()).unwrap();
        assert_eq!(triggers.len(), 1);
        assert_eq!(
            triggers[0].shape,
            DayShape::MonthlyDow {
                dows: set(&[1]),
                months: set(&[6]),
            }
        );
    }

    #[test]
    fn schtasks_dom_dow_month_or_uses_both_families() {
        // "the 1st OR a Monday, in June, at 03:00" — Monthly + MonthlyDow triggers (cron OR).
        let triggers = to_schtasks(&parse("0 3 1 6 1").unwrap()).unwrap();
        assert_eq!(triggers.len(), 2);
        assert!(triggers
            .iter()
            .any(|t| matches!(t.shape, DayShape::MonthlyDow { .. })));
        assert!(triggers
            .iter()
            .any(|t| matches!(&t.shape, DayShape::Monthly { days, months } if days == &set(&[1]) && months == &set(&[6]))));
    }

    #[test]
    fn schtasks_irregular_minutes_with_wildcard_hours_use_hourly_repetition() {
        // Irregular minutes across every hour: one daily trigger per minute value, each
        // repeating hourly. 23h duration + inclusive endpoint = 24 fires/day per trigger.
        let triggers = to_schtasks(&parse("1,7,13 * * * *").unwrap()).unwrap();
        assert_eq!(triggers.len(), 3);
        assert!(triggers
            .iter()
            .all(|t| t.start_hour == 0 && t.repetition == Some((60, 24 * 60 - 60))));
        let starts: Vec<u16> = triggers.iter().map(|t| t.start_minute).collect();
        assert_eq!(starts, vec![1, 7, 13]);
        // The same shape keeps a 2-minute list at 2 triggers instead of the old 24x2 expansion.
        assert_eq!(
            to_schtasks(&parse("0,10 * * * *").unwrap()).unwrap().len(),
            2
        );
    }

    #[test]
    fn schtasks_cap_is_the_documented_48() {
        // 3 irregular minutes x 17 hours = 51 triggers — over the 48-trigger schema limit, so it
        // must fail validation instead of failing later at schtasks /Create.
        let err = to_schtasks(&parse("0,10,20 0-16 * * *").unwrap()).unwrap_err();
        assert!(err.contains("48"), "error should name the limit: {}", err);
        // 16 hours x 3 minutes = 48 exactly — allowed.
        assert!(to_schtasks(&parse("0,10,20 0-15 * * *").unwrap()).is_ok());
    }

    #[test]
    fn crontab_normalization() {
        // Star-origin fields stay verbatim — cron's dom/dow AND-vs-OR decision keys on the '*'
        // character, so `*/n` must never be expanded into an explicit list.
        assert_eq!(to_crontab(&parse("*/15 * * * *").unwrap()), "*/15 * * * *");
        assert_eq!(to_crontab(&parse("0 0 */5 * 1").unwrap()), "0 0 */5 * 1");
        // Non-star fields normalize to plain lists (semantically identical on every cron).
        assert_eq!(
            to_crontab(&parse("0 9-11 1 JAN MON").unwrap()),
            "0 9,10,11 1 1 1"
        );
        assert_eq!(to_crontab(&parse("* * * * *").unwrap()), "* * * * *");
    }

    #[test]
    fn star_step_day_fields_use_and_semantics() {
        // crontab(5): OR applies only when both day fields are "restricted (i.e., do not
        // contain the * character)" — `*/5` dom + `1` dow is therefore AND in Vixie/cronie.
        let and = parse("0 0 */5 * 1").unwrap();
        assert!(and.dom.star && !and.dom.restricted());
        // Monday the 6th: dom ∈ {1,6,11,...} AND Monday → runs.
        assert!(matches(&and, 0, 0, 6, 5, 1));
        // Monday the 3rd: dom misses → must NOT run (OR semantics would have run it).
        assert!(!matches(&and, 0, 0, 3, 5, 1));
        // Friday the 6th: dow misses → must NOT run.
        assert!(!matches(&and, 0, 0, 6, 5, 5));

        // Plain-restricted both sides keeps the OR rule.
        let or = parse("0 0 13 * 1").unwrap();
        assert!(matches(&or, 0, 0, 13, 5, 4));
        assert!(matches(&or, 0, 0, 20, 5, 1));

        // The AND intersection is inexpressible on launchd and schtasks — both must reject it
        // with an actionable error instead of silently over-firing as OR.
        assert!(to_launchd(&and).is_err());
        assert!(to_schtasks(&and).is_err());
        // Single-day-dimension star steps stay representable (no AND involved).
        assert!(to_launchd(&parse("0 0 */5 * *").unwrap()).is_ok());
        assert!(to_schtasks(&parse("0 0 * * */2").unwrap()).is_ok());

        // Vixie's star flag is a FIRST-CHARACTER test: a mixed list like `1,*/5` does not start
        // with '*', so cron treats it as restricted → OR with the other day field. It must also
        // stay representable (OR = separate trigger families / dicts).
        let mixed = parse("0 0 1,*/5 * 1").unwrap();
        assert!(!mixed.dom.star && mixed.dom.restricted());
        assert!(
            matches(&mixed, 0, 0, 3, 5, 1),
            "Monday the 3rd fires via the dow half (OR)"
        );
        assert!(
            matches(&mixed, 0, 0, 6, 5, 5),
            "Friday the 6th fires via the dom half (OR)"
        );
        assert!(
            !matches(&mixed, 0, 0, 3, 5, 5),
            "Friday the 3rd matches neither half"
        );
        assert!(to_launchd(&mixed).is_ok());
        assert!(to_schtasks(&mixed).is_ok());
        // Not star-origin → to_crontab normalizes it to an explicit (still restricted) list.
        assert_eq!(to_crontab(&mixed), "0 0 1,6,11,16,21,26,31 * 1");
    }

    #[test]
    fn next_fires_uses_the_runner_semantics() {
        let from = chrono::TimeZone::with_ymd_and_hms(&chrono::Local, 2026, 7, 1, 12, 0, 0)
            .single()
            .unwrap();

        // Plain interval: next quarter hours.
        let fires = next_fires(&parse("*/15 * * * *").unwrap(), from, 3);
        assert_eq!(fires.len(), 3);
        assert!(
            fires[0].starts_with("2026-07-01T12:15:00"),
            "got {}",
            fires[0]
        );
        assert!(fires[1].starts_with("2026-07-01T12:30:00"));
        assert!(fires[2].starts_with("2026-07-01T12:45:00"));

        // `*/5` dom + Monday is AND in cron (the JS preview library said OR — the whole reason
        // this exists): only Mondays landing on the 1,6,11,… grid fire.
        let fires = next_fires(&parse("0 0 */5 * 1").unwrap(), from, 3);
        assert!(
            fires[0].starts_with("2026-07-06T00:00:00"),
            "got {}",
            fires[0]
        );
        assert!(
            fires[1].starts_with("2026-08-31T00:00:00"),
            "got {}",
            fires[1]
        );
        assert!(
            fires[2].starts_with("2026-09-21T00:00:00"),
            "got {}",
            fires[2]
        );

        // Never-matching schedules terminate at the horizon with what they found. This walk
        // day-skips across five years of DST fall-back days — the case that once looped forever
        // on a 25-hour day (see the succ_opt comment in next_fires).
        assert!(next_fires(&parse("0 0 31 2 *").unwrap(), from, 1).is_empty());
    }

    #[test]
    fn uniform_interval_detection() {
        assert_eq!(
            uniform_minute_interval(&parse("*/15 * * * *").unwrap().minute),
            Some(15)
        );
        assert_eq!(
            uniform_minute_interval(&parse("5,20,35,50 * * * *").unwrap().minute),
            Some(15)
        );
        assert_eq!(
            uniform_minute_interval(&parse("0,10,30 * * * *").unwrap().minute),
            None
        );
        assert_eq!(
            uniform_minute_interval(&parse("30 * * * *").unwrap().minute),
            None
        );
    }

    #[test]
    fn launchd_every_minute_is_one_empty_dict() {
        let dicts = to_launchd(&parse("* * * * *").unwrap()).unwrap();
        assert_eq!(dicts.len(), 1);
        assert_eq!(
            dicts[0],
            LaunchdCalendar {
                minute: None,
                hour: None,
                day: None,
                weekday: None,
                month: None
            }
        );
    }

    #[test]
    fn launchd_minute_steps_omit_wildcards() {
        let dicts = to_launchd(&parse("*/15 * * * *").unwrap()).unwrap();
        assert_eq!(dicts.len(), 4);
        let minutes: Vec<Option<u16>> = dicts.iter().map(|d| d.minute).collect();
        assert_eq!(minutes, vec![Some(0), Some(15), Some(30), Some(45)]);
        assert!(dicts
            .iter()
            .all(|d| d.hour.is_none() && d.day.is_none() && d.weekday.is_none()));
    }

    #[test]
    fn launchd_hour_minute_product() {
        let dicts = to_launchd(&parse("0,30 9,17 * * *").unwrap()).unwrap();
        assert_eq!(dicts.len(), 4); // 2 minutes x 2 hours
        assert!(dicts.contains(&LaunchdCalendar {
            minute: Some(30),
            hour: Some(17),
            day: None,
            weekday: None,
            month: None,
        }));
    }

    #[test]
    fn launchd_dom_dow_or_splits_into_separate_dicts() {
        // "the 13th OR a Monday at 00:00" — 1 Day-only dict + 1 Weekday-only dict, never combined.
        let dicts = to_launchd(&parse("0 0 13 * 1").unwrap()).unwrap();
        assert_eq!(dicts.len(), 2);
        assert!(dicts.contains(&LaunchdCalendar {
            minute: Some(0),
            hour: Some(0),
            day: Some(13),
            weekday: None,
            month: None,
        }));
        assert!(dicts.contains(&LaunchdCalendar {
            minute: Some(0),
            hour: Some(0),
            day: None,
            weekday: Some(1),
            month: None,
        }));
        // Emitted as separate single-key dicts (the minimal union); we never combine Day+Weekday
        // into one dict, which would only be a redundant Cartesian product of the same OR.
        assert!(dicts
            .iter()
            .all(|d| !(d.day.is_some() && d.weekday.is_some())));
    }

    #[test]
    fn launchd_month_restriction() {
        let dicts = to_launchd(&parse("0 0 1 1,6 *").unwrap()).unwrap();
        assert_eq!(dicts.len(), 2); // 1 day x 2 months
        assert!(dicts.iter().all(|d| d.day == Some(1) && d.hour == Some(0)));
        let months: Vec<Option<u16>> = dicts.iter().map(|d| d.month).collect();
        assert!(months.contains(&Some(1)) && months.contains(&Some(6)));
    }

    #[test]
    fn launchd_cap_rejects_explosive_schedules() {
        // 30 explicit minutes x 31 explicit days = 930 dicts (wildcards would omit and not
        // explode, so both fields must be explicit lists).
        assert!(to_launchd(&parse("*/2 * 1-31 * *").unwrap()).is_err());
    }

    #[test]
    fn matches_reproduces_cron_semantics() {
        let spec = parse("*/15 * * * *").unwrap();
        assert!(matches(&spec, 0, 3, 10, 6, 2));
        assert!(matches(&spec, 45, 23, 31, 12, 0));
        assert!(!matches(&spec, 7, 3, 10, 6, 2));

        // dom+dow OR: the 13th (any weekday) OR a Friday (any date).
        let or = parse("0 0 13 * 5").unwrap();
        assert!(matches(&or, 0, 0, 13, 3, 2));
        assert!(matches(&or, 0, 0, 20, 3, 5));
        assert!(!matches(&or, 0, 0, 20, 3, 2));

        // Only dow restricted: dom must not OR in.
        let weekly = parse("0 0 * * 1").unwrap();
        assert!(matches(&weekly, 0, 0, 20, 3, 1));
        assert!(!matches(&weekly, 0, 0, 20, 3, 2));
    }
}

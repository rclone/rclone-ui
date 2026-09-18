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

/// Every expression the parser accepts can be fired by the ticker, so validation is the parse.
pub fn validate(expr: &str) -> Result<(), String> {
    parse(expr).map(|_| ())
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

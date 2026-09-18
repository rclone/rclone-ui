//! One reading of a version string for the whole app: rclone's (`v1.75.1`, `1.74.0-beta.x`),
//! the server's own releases (`3.0.1`), and whatever a release index hands back. A leading `v`
//! is ignored, a `-suffix` (pre-release, build) is dropped, and missing or unreadable
//! components count as 0, so a malformed string compares as `0.0.0` rather than failing.

/// The numeric core of a version: major, minor, patch.
pub fn parts(version: &str) -> (u64, u64, u64) {
    let core = version.trim().trim_start_matches('v');
    let core = core.split('-').next().unwrap_or(core);
    let mut it = core
        .split('.')
        .map(|n| n.trim().parse::<u64>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

pub fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    parts(a).cmp(&parts(b))
}

/// Whether `candidate` is strictly newer than `current`.
pub fn newer(candidate: &str, current: &str) -> bool {
    compare(candidate, current) == std::cmp::Ordering::Greater
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn prefixes_suffixes_and_missing_parts() {
        assert_eq!(compare("v1.75.1", "1.75.1"), Ordering::Equal);
        assert_eq!(compare("1.74.0-beta.2", "1.74.0"), Ordering::Equal);
        assert_eq!(compare("1.75", "1.75.0"), Ordering::Equal);
        assert_eq!(compare("1.75.1", "1.75.0"), Ordering::Greater);
        assert_eq!(compare("1.9.0", "1.10.0"), Ordering::Less);
        assert_eq!(compare(" v2.0.0 ", "1.99.99"), Ordering::Greater);
    }

    #[test]
    fn malformed_input_reads_as_zero() {
        assert_eq!(parts("nope"), (0, 0, 0));
        assert_eq!(parts("1.x.3"), (1, 0, 3));
        assert!(newer("0.0.1", "garbage"));
        assert!(!newer("garbage", "0.0.1"));
        assert!(!newer("1.75.1", "1.75.1"));
    }
}

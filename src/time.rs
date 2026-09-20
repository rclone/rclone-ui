//! One timestamp format for everything the server writes down: RFC 3339, UTC, milliseconds.

use chrono::{SecondsFormat, Utc};

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_shape_is_what_the_pages_parse() {
        let now = super::now_iso();
        // 2026-09-20T02:54:43.123Z
        assert_eq!(now.len(), 24, "{}", now);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[10..11], "T");
        assert_eq!(&now[19..20], ".");
    }
}

//! The program behind rclone's `--metadata-mapper`.
//!
//! rclone runs it once per file and directory copied (possibly several at a time), hands it one
//! JSON object on stdin and reads one back on stdout, of which only `Metadata` is used. That is
//! the only way to rename metadata between two backends, so the app's mapping editor points the
//! flag at this binary:
//!
//! ```text
//! metadata_mapper: ["<the app's own binary>", "metadata-map", "--map", "mtime=modified"]
//! ```
//!
//! An argv array, never a string: the macOS binary lives under `/Applications/Rclone UI.app/…`
//! and rclone would split that path on its space.
//!
//! Nothing here touches the data directory, the log or the network — it is spawned per object
//! and has to stay quick and silent.

use serde_json::{json, Map, Value};

/// What to do with the metadata of one object. Every rule reads the *input*, so none of them
/// cascade and their order in the command line is the order they were written in the editor.
#[derive(Debug, Default, PartialEq)]
pub struct Rules {
    /// `from` is renamed to `to`: the old name goes unless another rule brings it back.
    pub map: Vec<(String, String)>,
    /// A constant value, whatever the source had.
    pub set: Vec<(String, String)>,
    /// Removed from the output, whatever any other rule says.
    pub drop: Vec<String>,
    /// Keep only what the rules produced; by default everything else is passed through.
    pub only_mapped: bool,
}

const USAGE: &str = "usage: metadata-map [--only-mapped] [--map <from>=<to>]… [--set <key>=<value>]… [--drop <key>]…";

/// Splits `key=value` on its FIRST `=`, so a value may contain more of them.
fn split_pair(flag: &str, arg: &str) -> Result<(String, String), String> {
    match arg.split_once('=') {
        Some((key, value)) if !key.is_empty() => Ok((key.to_string(), value.to_string())),
        _ => Err(format!("{} expects <key>=<value>, got '{}'", flag, arg)),
    }
}

/// The rules of one `metadata-map` command line. Everything after the subcommand, in order.
pub fn parse_args(args: &[String]) -> Result<Rules, String> {
    let mut rules = Rules::default();
    let mut rest = args.iter();
    let missing = |flag: &str| format!("{} needs a value\n{}", flag, USAGE);
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--only-mapped" => rules.only_mapped = true,
            "--map" => {
                let next = rest.next().ok_or_else(|| missing("--map"))?;
                rules.map.push(split_pair("--map", next)?);
            }
            "--set" => {
                let next = rest.next().ok_or_else(|| missing("--set"))?;
                rules.set.push(split_pair("--set", next)?);
            }
            "--drop" => {
                rules
                    .drop
                    .push(rest.next().ok_or_else(|| missing("--drop"))?.clone());
            }
            other => return Err(format!("unknown argument '{}'\n{}", other, USAGE)),
        }
    }
    Ok(rules)
}

/// The metadata rclone should write, given what it read from the source. Order is what the
/// editor promises: a map renames, a set overwrites, and a drop always wins.
pub fn apply(rules: &Rules, input: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if !rules.only_mapped {
        for (key, value) in input {
            // A renamed field does not keep its old name as well.
            if rules.map.iter().any(|(from, _)| from == key) {
                continue;
            }
            out.insert(key.clone(), value.clone());
        }
    }
    for (from, to) in &rules.map {
        if let Some(value) = input.get(from) {
            out.insert(to.clone(), value.clone());
        }
    }
    for (key, value) in &rules.set {
        out.insert(key.clone(), Value::String(value.clone()));
    }
    for key in &rules.drop {
        out.remove(key);
    }
    out
}

/// One run of the program: rclone's object on stdin, the mapped metadata on stdout. The exit
/// code for `main`; anything that went wrong is on stderr, where rclone's log picks it up.
pub fn run(args: &[String]) -> i32 {
    let rules = match parse_args(args) {
        Ok(rules) => rules,
        Err(e) => {
            eprintln!("metadata-map: {}", e);
            return 2;
        }
    };
    let mut stdin = String::new();
    if let Err(e) = std::io::Read::read_to_string(&mut std::io::stdin(), &mut stdin) {
        eprintln!("metadata-map: could not read rclone's input: {}", e);
        return 3;
    }
    let object: Value = match serde_json::from_str(&stdin) {
        Ok(value) => value,
        Err(e) => {
            eprintln!("metadata-map: rclone's input is not JSON: {}", e);
            return 3;
        }
    };
    // A backend with no metadata at all still gets the rules: `--set` is how you give it some.
    let input = object
        .get("Metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mapped = apply(&rules, &input);
    println!("{}", json!({ "Metadata": mapped }));
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn metadata(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn the_three_kinds_together() {
        let rules = parse_args(&args(&[
            "--map",
            "mtime=modified",
            "--set",
            "owner=finance",
            "--drop",
            "btime",
        ]))
        .unwrap();
        let out = apply(
            &rules,
            &metadata(json!({"mtime": "2026-01-01", "btime": "2020-01-01", "mode": "100644"})),
        );
        // The mapped field is renamed (the old name is gone), the constant is added, the dropped
        // one is absent, and an unmentioned field rides along.
        assert_eq!(
            out,
            metadata(json!({"modified": "2026-01-01", "owner": "finance", "mode": "100644"}))
        );
    }

    #[test]
    fn a_missing_source_writes_nothing() {
        let rules = parse_args(&args(&["--map", "content-type=mime"])).unwrap();
        let out = apply(&rules, &metadata(json!({"mode": "100644"})));
        assert_eq!(out, metadata(json!({"mode": "100644"})));
    }

    #[test]
    fn only_mapped_keeps_nothing_else() {
        let rules = parse_args(&args(&["--only-mapped", "--map", "mtime=mtime"])).unwrap();
        let out = apply(
            &rules,
            &metadata(json!({"mtime": "2026-01-01", "uid": "501"})),
        );
        assert_eq!(out, metadata(json!({"mtime": "2026-01-01"})));
    }

    #[test]
    fn a_value_may_contain_equals_signs() {
        let rules = parse_args(&args(&["--set", "note=a=b=c"])).unwrap();
        assert_eq!(rules.set, vec![("note".to_string(), "a=b=c".to_string())]);
    }

    #[test]
    fn drop_beats_set() {
        let rules = parse_args(&args(&["--set", "tier=cold", "--drop", "tier"])).unwrap();
        assert_eq!(apply(&rules, &metadata(json!({}))), metadata(json!({})));
    }

    #[test]
    fn a_bad_argument_is_refused() {
        assert!(parse_args(&args(&["--map", "no-equals-sign"])).is_err());
        assert!(parse_args(&args(&["--nonsense"])).is_err());
        assert!(parse_args(&args(&["--map"])).is_err());
    }
}

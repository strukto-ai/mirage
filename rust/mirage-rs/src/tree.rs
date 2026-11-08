//! tree's typed `-L` and `--filelimit`. `-L` is C's `strtoul` at base 0,
//! whatever follows the number ignored, cast to an `int`, and refused
//! below 1 in tree 2.2.1's one sentence. Only the last `-L` is checked,
//! and `INT_MIN` is refused, where tree checks each one and takes
//! `INT_MIN`: divergences both hosts had, kept until they are pinned.
//! `--filelimit` is C's `atoi` cast to an `int`; one under 1 sets no
//! limit.

use serde_json::Value as Json;

use crate::StreamError;
use crate::number;
use crate::scan::{Typed, Values, last, unknown};

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    if let Some((name, _)) = options
        .iter()
        .find(|(name, _)| name != "L" && name != "filelimit")
    {
        return Err(unknown("tree", name));
    }
    let level = last(options, "L").map(level).transpose()?;
    let limit = last(options, "filelimit")
        .map(|raw| number::atoi(raw) as i32)
        .filter(|&limit| limit > 0);
    let mut values = Values::new();
    values.insert("L".to_owned(), level.map_or(Json::Null, Json::from));
    values.insert("filelimit".to_owned(), limit.map_or(Json::Null, Json::from));
    Ok(values)
}

fn level(raw: &[u8]) -> Result<i32, StreamError> {
    let level = strtoul(raw) as u32 as i32;
    if level < 1 {
        return Err(StreamError::refusal(
            b"tree: Invalid level, must be greater than 0.",
            1,
        ));
    }
    Ok(level)
}

/// `strtoul(raw, NULL, 0)`: a minus negates in unsigned arithmetic, and a
/// value past `unsigned long` is its largest, whatever the sign.
fn strtoul(raw: &[u8]) -> u64 {
    let parts = number::parts(raw, true);
    match u64::try_from(parts.saturating()) {
        Ok(value) if parts.negative() => value.wrapping_neg(),
        Ok(value) => value,
        Err(_) => u64::MAX,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    #[test]
    fn a_level_is_strtoul_cast_to_an_int() {
        for (raw, level) in [
            ("1", 1),
            ("0x10", 16),
            ("010", 8),
            (" 2", 2),
            ("2x", 2),
            ("+2", 2),
            ("2147483647", 2147483647),
            ("4294967297", 1),
            ("-4294967295", 1),
        ] {
            let values = scan("tree", &[("L", raw.as_bytes())]).expect(raw);
            assert_eq!(values["L"], json!(level), "{raw}");
        }
    }

    #[test]
    fn a_level_under_one_is_refused_in_one_sentence() {
        for raw in [
            "0",
            "-1",
            "abc",
            "",
            "-0",
            "0x",
            "4294967296",
            "2147483648",
            "18446744073709551615",
            "99999999999999999999999",
            "-99999999999999999999999",
        ] {
            let shown = "tree: Invalid level, must be greater than 0.".to_owned();
            assert_eq!(
                refusal("tree", &[("L", raw.as_bytes())]),
                (shown, 1),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn only_the_last_level_is_read() {
        let typed: &[(&str, &[u8])] = &[("L", b"0"), ("L", b"2")];
        assert_eq!(
            scan("tree", typed).expect("read"),
            json!({"L": 2, "filelimit": null})
        );
    }

    #[test]
    fn a_file_limit_is_atoi_and_none_below_one() {
        for (raw, limit) in [
            ("2", json!(2)),
            (" 7x", json!(7)),
            ("+3", json!(3)),
            ("0", json!(null)),
            ("-1", json!(null)),
            ("x", json!(null)),
            ("4294967298", json!(2)),
        ] {
            let values = scan("tree", &[("filelimit", raw.as_bytes())]).expect(raw);
            assert_eq!(values["filelimit"], limit, "{raw}");
        }
    }
}

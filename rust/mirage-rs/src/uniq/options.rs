use crate::{StreamError, latin1_bytes, number, quoted};

/// What the key leaves out and keeps: `-f`, `-s` and `-w`.
#[derive(Default)]
pub(super) struct Keys {
    pub(super) skip_fields: usize,
    pub(super) skip_chars: usize,
    pub(super) check_chars: Option<usize>,
}

/// `-f`, `-s` and `-w` and the operands as GNU uniq 9.7 reads them, in the
/// order typed: a count is a whole decimal past blanks, at most one sign,
/// refused below 0, a count past `usize` the largest, and the last of each
/// counts; a third operand is refused at its turn.
pub(super) fn keys(typed: &[(String, String)]) -> Result<Keys, StreamError> {
    let mut keys = Keys::default();
    let mut operands = 0;
    for (name, text) in typed {
        let raw = latin1_bytes(text)
            .ok_or_else(|| StreamError::new("a uniq word holds a character past U+00FF"))?;
        let what = match name.as_str() {
            "" => {
                operands += 1;
                if operands > 2 {
                    let refused = [
                        b"uniq: extra operand '".as_slice(),
                        quoted(&raw).as_bytes(),
                        b"'\nTry 'uniq --help' for more information.",
                    ]
                    .concat();
                    return Err(StreamError::refusal(&refused, 1));
                }
                continue;
            }
            "skip_fields" => "fields to skip",
            "skip_chars" => "bytes to skip",
            "check_chars" => "bytes to compare",
            _ => return Err(StreamError::new(format!("uniq reads no option {name}"))),
        };
        let Some(count) = number::signed_decimal(&raw).filter(|&count| count >= 0) else {
            let refused = [
                b"uniq: ".as_slice(),
                &raw,
                b": invalid number of ",
                what.as_bytes(),
            ]
            .concat();
            return Err(StreamError::refusal(&refused, 1));
        };
        let count = usize::try_from(count).unwrap_or(usize::MAX);
        match name.as_str() {
            "skip_fields" => keys.skip_fields = count,
            "skip_chars" => keys.skip_chars = count,
            _ => keys.check_chars = Some(count),
        }
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::keys;

    fn refused(typed: &[(&str, &str)]) -> Option<(String, i32)> {
        let typed: Vec<(String, String)> = typed
            .iter()
            .map(|&(name, text)| (name.to_owned(), text.to_owned()))
            .collect();
        keys(&typed).err().map(|e| (e.message, e.status))
    }

    #[test]
    fn each_word_typed_is_refused_in_its_turn() {
        let extra = |word: &str| {
            Some((
                format!("uniq: extra operand '{word}'\nTry 'uniq --help' for more information."),
                1,
            ))
        };
        let fields = Some(("uniq: x: invalid number of fields to skip".to_owned(), 1));
        assert_eq!(
            refused(&[("skip_fields", "x"), ("", "a"), ("", "b"), ("", "c")]),
            fields
        );
        assert_eq!(
            refused(&[("", "a"), ("", "b"), ("", "c"), ("skip_fields", "x")]),
            extra("c")
        );
        assert_eq!(
            refused(&[("", "a"), ("", "b"), ("skip_fields", "x"), ("", "c")]),
            fields
        );
        assert_eq!(
            refused(&[("", "a"), ("", "b"), ("", "c'd"), ("", "e")]),
            extra("c\\'d")
        );
        assert_eq!(
            refused(&[("", "a"), ("", "b"), ("", "x\u{1}y")]),
            extra("x\\001y")
        );
        assert_eq!(refused(&[("", "a"), ("", "-"), ("skip_chars", "2")]), None);
        assert_eq!(
            refused(&[("skip_chars", "y"), ("skip_fields", "x")]),
            Some(("uniq: y: invalid number of bytes to skip".to_owned(), 1))
        );
        assert_eq!(
            refused(&[("skip_fields", "3"), ("skip_fields", "5 ")]),
            Some(("uniq: 5 : invalid number of fields to skip".to_owned(), 1))
        );
        assert_eq!(
            refused(&[("check_chars", "-1")]),
            Some(("uniq: -1: invalid number of bytes to compare".to_owned(), 1))
        );
        assert_eq!(
            refused(&[
                ("skip_fields", "99999999999999999999999"),
                ("skip_chars", "-0")
            ]),
            None
        );
    }
}

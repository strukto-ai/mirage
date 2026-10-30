use crate::StreamError;

/// The prefix, as util-linux 2.41 look takes its operands: a prefix and at
/// most one file, any other count its usage refusal.
pub(super) fn prefix(operands: &[Vec<u8>]) -> Result<&[u8], StreamError> {
    match operands {
        [prefix] | [prefix, _] => Ok(prefix),
        _ => Err(StreamError::refusal(
            b"look: bad usage\nTry 'look --help' for more information.",
            1,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::prefix;

    #[test]
    fn a_prefix_and_at_most_one_file() {
        let words = |words: &[&str]| -> Vec<Vec<u8>> {
            words.iter().map(|w| w.as_bytes().to_vec()).collect()
        };
        assert_eq!(prefix(&words(&["a"])).ok(), Some(&b"a"[..]));
        assert_eq!(prefix(&words(&["a", "f"])).ok(), Some(&b"a"[..]));
        for refused in [&[][..], &["a", "f", "f"], &["a", "nosuch", "f", "g"]] {
            let error = prefix(&words(refused)).expect_err("bad usage");
            assert_eq!(
                (error.message.as_str(), error.status),
                (
                    "look: bad usage\nTry 'look --help' for more information.",
                    1
                )
            );
        }
    }
}

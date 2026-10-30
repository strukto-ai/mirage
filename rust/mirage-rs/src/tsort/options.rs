use crate::{StreamError, quoted};

/// The input's name as GNU tsort 9.7 takes its operands: at most one file,
/// `-` without one.
pub(super) fn name(operands: &[Vec<u8>]) -> Result<&[u8], StreamError> {
    match operands {
        [] => Ok(b"-"),
        [name] => Ok(name),
        [_, extra, ..] => Err(StreamError::refusal(
            &[
                b"tsort: extra operand '".as_slice(),
                quoted(extra).as_bytes(),
                b"'\nTry 'tsort --help' for more information.",
            ]
            .concat(),
            1,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::name;

    #[test]
    fn at_most_one_file_and_the_second_named() {
        let words = |words: &[&str]| -> Vec<Vec<u8>> {
            words.iter().map(|w| w.as_bytes().to_vec()).collect()
        };
        assert_eq!(name(&words(&[])).ok(), Some(&b"-"[..]));
        assert_eq!(name(&words(&["g"])).ok(), Some(&b"g"[..]));
        for (operands, extra) in [(&["a", "b"][..], "b"), (&["nosuch", "b'c", "d"], "b\\'c")] {
            let error = name(&words(operands)).expect_err("extra operand");
            assert_eq!(
                (error.message, error.status),
                (
                    format!(
                        "tsort: extra operand '{extra}'\nTry 'tsort --help' for more information."
                    ),
                    1
                )
            );
        }
    }
}

use crate::{StreamError, quoted};

const HINT: &[u8] = b"\nTry 'tr --help' for more information.";

/// STRING1 and STRING2 as GNU tr 9.7 takes them: translating, and
/// deleting while squeezing, need both; deleting alone takes one; and
/// squeezing alone takes one or two.
pub(super) fn sets(
    operands: &[Vec<u8>],
    delete: bool,
    squeeze: bool,
) -> Result<(&[u8], Option<&[u8]>), StreamError> {
    let Some(set1) = operands.first() else {
        return Err(StreamError::refusal(
            &[b"tr: missing operand".as_slice(), HINT].concat(),
            1,
        ));
    };
    let both = !delete && !squeeze || delete && squeeze;
    if both && operands.len() == 1 {
        let why: &[u8] = if delete {
            b"Two strings must be given when both deleting and squeezing repeats."
        } else {
            b"Two strings must be given when translating."
        };
        return Err(StreamError::refusal(
            &[
                b"tr: missing operand after '".as_slice(),
                quoted(set1).as_bytes(),
                b"'\n",
                why,
                HINT,
            ]
            .concat(),
            1,
        ));
    }
    let most = if delete && !squeeze { 1 } else { 2 };
    if let Some(extra) = operands.get(most) {
        let why: &[u8] = if most == 1 && operands.len() == 2 {
            b"\nOnly one string may be given when deleting without squeezing repeats."
        } else {
            b""
        };
        return Err(StreamError::refusal(
            &[
                b"tr: extra operand '".as_slice(),
                quoted(extra).as_bytes(),
                b"'",
                why,
                HINT,
            ]
            .concat(),
            1,
        ));
    }
    Ok((set1, operands.get(1).map(Vec::as_slice)))
}

#[cfg(test)]
mod tests {
    use super::sets;

    fn refused(operands: &[&str], delete: bool, squeeze: bool) -> (String, i32) {
        let operands: Vec<Vec<u8>> = operands.iter().map(|o| o.as_bytes().to_vec()).collect();
        let error = sets(&operands, delete, squeeze).expect_err("refuses");
        (error.message, error.status)
    }

    #[test]
    fn a_missing_operand_names_what_the_mode_needs() {
        let bare = "tr: missing operand\nTry 'tr --help' for more information.";
        for (delete, squeeze) in [(false, false), (true, false), (false, true), (true, true)] {
            assert_eq!(refused(&[], delete, squeeze), (bare.to_owned(), 1));
        }
        assert_eq!(
            refused(&["a'b"], false, false),
            (
                "tr: missing operand after 'a\\'b'\nTwo strings must be given when translating.\nTry 'tr --help' for more information.".to_owned(),
                1
            )
        );
        assert_eq!(
            refused(&["a"], true, true),
            (
                "tr: missing operand after 'a'\nTwo strings must be given when both deleting and squeezing repeats.\nTry 'tr --help' for more information.".to_owned(),
                1
            )
        );
    }

    #[test]
    fn an_extra_operand_is_quoted_and_deleting_alone_says_why() {
        assert_eq!(
            refused(&["a", ""], true, false),
            (
                "tr: extra operand ''\nOnly one string may be given when deleting without squeezing repeats.\nTry 'tr --help' for more information.".to_owned(),
                1
            )
        );
        assert_eq!(
            refused(&["a", "b'c", "d"], true, false),
            (
                "tr: extra operand 'b\\'c'\nTry 'tr --help' for more information.".to_owned(),
                1
            )
        );
        for (delete, squeeze) in [(false, false), (false, true), (true, true)] {
            assert_eq!(
                refused(&["a", "b", "x\u{1}y"], delete, squeeze),
                (
                    "tr: extra operand 'x\\001y'\nTry 'tr --help' for more information.".to_owned(),
                    1
                )
            );
        }
    }

    #[test]
    fn each_mode_takes_its_sets() {
        let operands = |words: &[&str]| -> Vec<Vec<u8>> {
            words.iter().map(|w| w.as_bytes().to_vec()).collect()
        };
        let one = operands(&["a"]);
        let two = operands(&["a", "b"]);
        assert_eq!(sets(&one, true, false).ok(), Some((&b"a"[..], None)));
        assert_eq!(sets(&one, false, true).ok(), Some((&b"a"[..], None)));
        for (delete, squeeze) in [(false, false), (false, true), (true, true)] {
            assert_eq!(
                sets(&two, delete, squeeze).ok(),
                Some((&b"a"[..], Some(&b"b"[..])))
            );
        }
    }
}

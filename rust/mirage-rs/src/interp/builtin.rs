use super::declare::{Declared, denied, text};
use super::expand::{Host, subscript_of};
use super::shell::Shell;
use super::write::{Element, Fault, Writer, element_reference};
use super::{Diagnostic, Signal, arith_line, voiced};
use crate::arith;
use crate::vars::BASH_LINENO;

/// One operand of an `unset`, and what only the host knows about it.
pub struct Unsetting {
    /// Its option letters, of `-f`, `-n` and `-v`.
    pub letters: Vec<u8>,
    pub word: Vec<u8>,
    /// The word names a function.
    pub function: bool,
    /// The word names a readonly function.
    pub frozen: bool,
    /// A policy is deciding: a write refuses.
    pub deciding: bool,
}

/// What an `unset` of one operand came to, and what is left for the host.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Unset {
    pub said: Declared,
    /// The word's function is to go.
    pub remove_function: bool,
    /// The name it dropped, when the host keeps state about that name too.
    pub tracked: Option<String>,
}

fn writer<'a>(
    shell: &'a mut Shell,
    diagnostics: &'a mut Vec<Diagnostic>,
    deciding: bool,
) -> Writer<'a> {
    Writer {
        deciding,
        ..Writer::of(shell, Some(diagnostics))
    }
}

/// `unset`'s refusal of `name`, in bash's words.
fn refusal(voice: &[u8], name: &[u8], rest: &str) -> Vec<u8> {
    [voice, b"unset: ", name, b": ", rest.as_bytes(), b"\n"].concat()
}

/// Whether a name holds a value a reader of the session can see.
fn holds_value(shell: &Shell, name: &str) -> bool {
    let target = shell.vars.deref(name);
    !shell.vars.hidden(&target)
        && shell
            .vars
            .record(&target)
            .is_some_and(|var| var.value.is_some())
}

/// Take the word's function away, unless it is readonly or a policy is
/// deciding, either of which answers with the line that refuses it.
fn drop_function(voice: &[u8], unsetting: &Unsetting, out: &mut Unset) -> Option<Vec<u8>> {
    if unsetting.frozen {
        return Some(refusal(
            voice,
            &unsetting.word,
            "cannot unset: readonly function",
        ));
    }
    if unsetting.deciding {
        return Some(denied(&text(&unsetting.word)));
    }
    out.remove_function = true;
    None
}

/// Unset one word, answering the line that refuses it: `-v` a variable
/// only, refusing a word that names none; `-f` a function only; `-n` the
/// reference itself; and a bare word a variable if one exists, else a
/// function. `NAME[SUB]` clears one element, keeping the indexes after it.
async fn unset_word<H: Host>(
    shell: &mut Shell,
    host: &mut H,
    diagnostics: &mut Vec<Diagnostic>,
    unsetting: &Unsetting,
    out: &mut Unset,
) -> Result<Option<Vec<u8>>, Fault> {
    let voice = shell.vars.voice().to_vec();
    let deciding = unsetting.deciding;
    let letters = &unsetting.letters;
    let word = &unsetting.word;
    let mode = b"fnv".iter().copied().find(|m| letters.contains(m));
    let target = element_reference(word)
        .filter(|(_, subscript)| !subscript.is_some_and(|sub| sub.contains(&b'\n')));
    if letters.contains(&b'v') && target.is_none() {
        let quoted = [b"unset: `", word.as_slice(), b"': not a valid identifier\n"].concat();
        return Ok(Some([voice.as_slice(), &quoted].concat()));
    }
    let name = text(word);
    if mode == Some(b'n') {
        if shell.vars.is_readonly(&name, false) {
            return Ok(Some(refusal(
                &voice,
                word,
                "cannot unset: readonly variable",
            )));
        }
        if name == BASH_LINENO {
            return Ok(Some(refusal(&voice, word, "cannot unset")));
        }
        return match writer(shell, diagnostics, deciding).unset(&name, false) {
            Err(Fault::Hidden(hidden)) => Ok(Some(denied(&hidden))),
            other => other.map(|()| None),
        };
    }
    if mode == Some(b'f') {
        return Ok(drop_function(&voice, unsetting, out));
    }
    let (base, subscript) = target.map_or((name.clone(), None), |(base, subscript)| {
        (base.to_owned(), subscript)
    });
    if shell.vars.is_readonly(&base, true) {
        let held = shell.vars.deref(&base);
        return Ok(Some(refusal(
            &voice,
            held.as_bytes(),
            "cannot unset: readonly variable",
        )));
    }
    if subscript.is_none() && shell.vars.deref(&base) == BASH_LINENO {
        return Ok(Some(refusal(&voice, word, "cannot unset")));
    }
    let existed = subscript.is_some() || holds_value(shell, &name);
    let status = match subscript {
        Some(subscript) => {
            let every = subscript == b"@" || subscript == b"*";
            subscript_of(shell, host, subscript)
                .await
                .and_then(|expanded| {
                    writer(shell, diagnostics, deciding).unset_element(&base, &expanded, every)
                })
        }
        None => writer(shell, diagnostics, deciding)
            .unset(&name, true)
            .map(|()| Element::Landed),
    };
    match status {
        Ok(Element::Landed) => {}
        Ok(Element::NotArray) => {
            return Ok(Some(refusal(
                &voice,
                base.as_bytes(),
                "not an array variable",
            )));
        }
        Ok(_) => {
            return Ok(Some(refusal(
                &voice,
                &word[base.len()..],
                "bad array subscript",
            )));
        }
        Err(Fault::Hidden(hidden)) => return Ok(Some(denied(&hidden))),
        Err(Fault::Arith(error)) => return Err(Signal::arith(&voice, &error, "", true).into()),
        Err(fault) => return Err(fault),
    }
    if subscript.is_none() {
        let landed = shell.vars.deref(&name);
        if matches!(landed.as_str(), "OPTIND" | "FUNCNAME") {
            out.tracked = Some(landed);
        }
    }
    if mode.is_none() && !existed && unsetting.function {
        return Ok(drop_function(&voice, unsetting, out));
    }
    Ok(None)
}

/// Run `unset` on one operand. The host runs one at a time, so what each
/// leaves it to do lands before the next starts, whatever becomes of that.
pub async fn run_unset<H: Host>(
    shell: &mut Shell,
    host: &mut H,
    diagnostics: &mut Vec<Diagnostic>,
    unsetting: &Unsetting,
) -> Result<Unset, Fault> {
    let mut out = Unset::default();
    if let Some(line) = unset_word(shell, host, diagnostics, unsetting, &mut out).await? {
        out.said = Declared::failed(line, 1);
    }
    Ok(out)
}

/// Run `let`: every word one expression, its writes landed in order, the
/// status 1 when the last came to 0. A malformed word stops it there, the
/// words before it having landed, as does a write to a readonly name; one
/// inside a subscript ends the shell.
pub fn run_let(
    shell: &mut Shell,
    diagnostics: &mut Vec<Diagnostic>,
    words: &[Vec<u8>],
    deciding: bool,
) -> Result<Declared, Fault> {
    let voice = shell.vars.voice().to_vec();
    if words.is_empty() {
        return Ok(Declared::failed(
            voiced(&voice, "let: expression expected\n"),
            1,
        ));
    }
    let mut value = 0;
    for word in words {
        match writer(shell, diagnostics, deciding).arith(word, true) {
            Ok(result) => value = result,
            Err(Fault::Hidden(name)) => return Ok(Declared::failed(denied(&name), 1)),
            Err(Fault::Readonly {
                name,
                subscript: false,
            }) => {
                let line = voiced(&voice, &format!("{name}: readonly variable\n"));
                return Ok(Declared::failed(line, 1));
            }
            Err(Fault::Readonly {
                name,
                subscript: true,
            }) => return Err(Signal::readonly(&voice, &name, true).into()),
            Err(Fault::Arith(
                error @ arith::Error::Arith {
                    subscript: true, ..
                },
            )) => return Err(Signal::arith(&voice, &error, "", false).into()),
            Err(Fault::Arith(error)) => {
                let mut line = voiced(&voice, "let: ");
                line.extend_from_slice(&arith_line(&error));
                line.push(b'\n');
                return Ok(Declared::failed(line, 1));
            }
            Err(fault) => return Err(fault),
        }
    }
    Ok(Declared {
        pieces: Vec::new(),
        status: i32::from(value == 0),
    })
}

/// `text` as the hosts count it: one piece per character, each byte that
/// is no character one apiece.
fn characters(text: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::with_capacity(text.len());
    for chunk in text.utf8_chunks() {
        let valid = chunk.valid();
        out.extend(
            valid
                .char_indices()
                .map(|(at, c)| &valid.as_bytes()[at..at + c.len_utf8()]),
        );
        out.extend(chunk.invalid().chunks(1));
    }
    out
}

/// The characters `read` splits, each with whether a backslash quoted it.
/// Without `raw` a backslash quotes the next character, a backslash-newline
/// is a line continuation and a backslash at the end goes.
fn read_chars(text: &[u8], raw: bool) -> Vec<(&[u8], bool)> {
    let chars = characters(text);
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        if chars[at] == b"\\" && !raw {
            if let Some(next) = chars.get(at + 1).filter(|next| **next != b"\n") {
                out.push((*next, true));
            }
            at += 2;
            continue;
        }
        out.push((chars[at], false));
        at += 1;
    }
    out
}

/// A line as `read` takes it, backslashes processed unless `raw`.
pub fn read_text(text: &[u8], raw: bool) -> Vec<u8> {
    read_chars(text, raw)
        .into_iter()
        .flat_map(|(ch, _)| ch.iter().copied())
        .collect()
}

/// Split one `read` line into at most `slots` fields on `ifs`, as bash
/// does. Leading IFS whitespace goes; a delimiter is one other IFS
/// character with the IFS whitespace around it, or a run of IFS whitespace,
/// and a quoted character never splits. The last field takes the rest of
/// the line, its trailing IFS whitespace dropped, and the delimiter ending
/// it too when it holds one field only (`x:y:` reads `y` into the second
/// of two). No slots (`read -a`) means every field, a delimiter at the end
/// opening none.
pub fn read_fields(text: &[u8], ifs: &[u8], slots: usize, raw: bool) -> Vec<Vec<u8>> {
    let chars = read_chars(text, raw);
    let ifs = characters(ifs);
    let n = chars.len();
    let splits = |k: usize| !chars[k].1 && ifs.contains(&chars[k].0);
    let white = |k: usize| splits(k) && matches!(chars[k].0, b" " | b"\t" | b"\n");
    let joined = |from: usize, to: usize| -> Vec<u8> {
        chars[from..to]
            .iter()
            .flat_map(|(ch, _)| ch.iter().copied())
            .collect()
    };
    let skip_white = |mut k: usize| {
        while k < n && white(k) {
            k += 1;
        }
        k
    };
    let past_delimiter = |k: usize| {
        let other = !white(k);
        let mut k = skip_white(k + 1);
        if !other && k < n && splits(k) {
            k = skip_white(k + 1);
        }
        k
    };
    let mut k = skip_white(0);
    let mut fields = Vec::new();
    while k < n && (slots == 0 || fields.len() < slots - 1) {
        let start = k;
        while k < n && !splits(k) {
            k += 1;
        }
        fields.push(joined(start, k));
        if k < n {
            k = past_delimiter(k);
        }
    }
    if slots == 0 || k >= n {
        return fields;
    }
    let mut end = n;
    while end > k && white(end - 1) {
        end -= 1;
    }
    if splits(end - 1) {
        let mut cut = end - 1;
        while cut > k && white(cut - 1) {
            cut -= 1;
        }
        if !(k..cut).any(splits) {
            end = cut;
        }
    }
    fields.push(joined(k, end));
    fields
}

/// How many characters `piece` leaves once backslashes are processed, and
/// whether a backslash ends it, quoting what follows; `escaped` is whether
/// one before it quotes its first character.
pub fn read_counted(piece: &[u8], escaped: bool) -> (usize, bool) {
    let mut count = 0;
    let mut escaped = escaped;
    for ch in characters(piece) {
        if escaped {
            count += usize::from(ch != b"\n");
            escaped = false;
        } else if ch == b"\\" {
            escaped = true;
        } else {
            count += 1;
        }
    }
    (count, escaped)
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::Arc;

    use super::super::declare::tests::NoHost;
    use super::*;
    use crate::vars::{READONLY, Store, Value};

    fn shell() -> Shell {
        Shell::new(Store::new(Arc::new(|| 1)))
    }

    fn unsetting(letters: &[u8], word: &[u8]) -> Unsetting {
        Unsetting {
            letters: letters.to_vec(),
            word: word.to_vec(),
            function: false,
            frozen: false,
            deciding: false,
        }
    }

    fn unset(shell: &mut Shell, unsetting: &Unsetting) -> Result<Unset, Fault> {
        let mut host = NoHost;
        let mut diagnostics = Vec::new();
        let mut future = std::pin::pin!(run_unset(shell, &mut host, &mut diagnostics, unsetting));
        let waker = std::task::Waker::noop();
        match future
            .as_mut()
            .poll(&mut std::task::Context::from_waker(waker))
        {
            std::task::Poll::Ready(result) => result,
            std::task::Poll::Pending => panic!("a plain subscript does not wait"),
        }
    }

    fn lines(said: &Declared) -> Vec<String> {
        said.pieces
            .iter()
            .map(|(_, line)| String::from_utf8_lossy(line).into_owned())
            .collect()
    }

    fn fields(text: &str, ifs: &str, slots: usize, raw: bool) -> Vec<String> {
        read_fields(text.as_bytes(), ifs.as_bytes(), slots, raw)
            .into_iter()
            .map(|field| String::from_utf8(field).unwrap())
            .collect()
    }

    #[test]
    fn a_bare_word_falls_back_to_the_function_only_without_a_variable() {
        let mut shell = shell();
        shell.vars.seed("a", Value::Scalar(b"v".to_vec()));
        let held = Unsetting {
            function: true,
            ..unsetting(b"", b"a")
        };
        assert!(!unset(&mut shell, &held).unwrap().remove_function);
        assert_eq!(shell.vars.scalar("a"), None);
        let bare = Unsetting {
            function: true,
            ..unsetting(b"", b"b")
        };
        let done = unset(&mut shell, &bare).unwrap();
        assert!(done.remove_function);
        assert_eq!(done.said.status, 0);
    }

    #[test]
    fn a_readonly_name_refuses() {
        let mut shell = shell();
        shell.vars.seed("R", Value::Scalar(b"1".to_vec()));
        shell.vars.set_attr("R", Some(READONLY), true);
        let done = unset(&mut shell, &unsetting(b"", b"R")).unwrap();
        assert_eq!(done.said.status, 1);
        assert_eq!(
            lines(&done.said),
            vec!["bash: unset: R: cannot unset: readonly variable\n"]
        );
    }

    #[test]
    fn dash_v_refuses_a_word_that_names_no_variable() {
        let mut shell = shell();
        let done = unset(&mut shell, &unsetting(b"v", b"1x")).unwrap();
        assert_eq!(
            lines(&done.said),
            vec!["bash: unset: `1x': not a valid identifier\n"]
        );
    }

    #[test]
    fn a_deciding_policy_cannot_unset() {
        let mut shell = shell();
        shell.vars.seed("X", Value::Scalar(b"1".to_vec()));
        for word in [&b"X"[..], b"X[0]"] {
            let words = Unsetting {
                deciding: true,
                ..unsetting(b"", word)
            };
            let done = unset(&mut shell, &words).unwrap();
            assert_eq!(lines(&done.said), vec!["X: permission denied\n"]);
        }
        assert_eq!(shell.vars.scalar("X"), Some(&b"1"[..]));
        let function = Unsetting {
            deciding: true,
            function: true,
            ..unsetting(b"f", b"g")
        };
        let done = unset(&mut shell, &function).unwrap();
        assert!(!done.remove_function);
        assert_eq!(lines(&done.said), vec!["g: permission denied\n"]);
    }

    #[test]
    fn let_answers_for_its_last_word() {
        let mut shell = shell();
        let mut said = Vec::new();
        let done = run_let(
            &mut shell,
            &mut said,
            &[b"a=1".to_vec(), b"b=0".to_vec()],
            false,
        );
        assert_eq!(done.unwrap().status, 1);
        let done = run_let(
            &mut shell,
            &mut said,
            &[b"b=0".to_vec(), b"a=1".to_vec()],
            false,
        );
        assert_eq!(done.unwrap().status, 0);
        let done = run_let(&mut shell, &mut said, &[], false).unwrap();
        assert_eq!(lines(&done), vec!["bash: let: expression expected\n"]);
    }

    #[test]
    fn a_deciding_policy_cannot_let() {
        let mut shell = shell();
        let mut said = Vec::new();
        let done = run_let(&mut shell, &mut said, &[b"a=1".to_vec()], true).unwrap();
        assert_eq!(lines(&done), vec!["a: permission denied\n"]);
        assert_eq!(shell.vars.scalar("a"), None);
    }

    #[test]
    fn read_splits_on_ifs_as_bash_does() {
        assert_eq!(fields("  a  b  ", " \t\n", 2, false), ["a", "b"]);
        assert_eq!(fields("x:y:", ":", 2, false), ["x", "y"]);
        assert_eq!(fields("x:y:z:", ":", 2, false), ["x", "y:z:"]);
        assert_eq!(fields("a:b:", ":", 0, false), ["a", "b"]);
        assert_eq!(fields(r"a\ b c", " ", 2, false), ["a b", "c"]);
        assert_eq!(fields(r"a\ b c", " ", 2, true), [r"a\", "b c"]);
    }

    #[test]
    fn read_counts_and_takes_text_by_character() {
        assert_eq!(read_counted("é\\".as_bytes(), false), (1, true));
        assert_eq!(read_counted(b"\nb", true), (1, false));
        assert_eq!(read_text(b"a\\\nb\\c\\", false), b"abc");
        assert_eq!(read_text(b"a\\b", true), b"a\\b");
        assert_eq!(read_text(b"\xff\\\xfe", false), b"\xff\xfe");
    }
}

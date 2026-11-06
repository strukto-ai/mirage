use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use super::patterns::regex_text;
use super::*;
use crate::interp::write::{Denied, Verb};
use crate::vars::{Assoc, Indexed, Store, Value};

struct Fake;

impl Gate for Fake {
    fn listens(&self) -> bool {
        false
    }

    async fn pre(&mut self, _: Verb, _: &str, _: Option<&[u8]>, _: &Store) -> Result<(), Denied> {
        Ok(())
    }

    async fn post(
        &mut self,
        _: Verb,
        _: &str,
        _: Option<&[u8]>,
        _: Option<&[u8]>,
        _: &Store,
    ) -> Result<(), Denied> {
        Ok(())
    }
}

impl Host for Fake {
    async fn process_substitution(&mut self, _: &mut Shell, node: usize) -> Result<Vec<u8>, Fault> {
        Ok(format!("/dev/fd/{node}").into_bytes())
    }

    async fn substitute(
        &mut self,
        _: &mut Shell,
        body: &[u8],
        _: usize,
        _: Option<(usize, usize)>,
    ) -> Result<Substitution, Fault> {
        Ok(Substitution {
            stdout: [body, b"\n\n"].concat(),
            stderr: Vec::new(),
            status: 3,
        })
    }
}

fn run<T>(future: impl Future<Output = T>) -> T {
    let mut future = pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the fake host answers at once"),
    }
}

fn shell() -> Shell {
    let mut shell = Shell::new(Store::new(Arc::new(|| 1)));
    shell.vars.seed("x", Value::Scalar(b"a b".to_vec()));
    shell.vars.seed("HOME", Value::Scalar(b"/h".to_vec()));
    shell.vars.seed("PWD", Value::Scalar(b"/w".to_vec()));
    shell
}

/// The fields of every argument of the line's first command, or the
/// stderr it stopped with.
fn words(shell: &mut Shell, line: &str) -> Result<Vec<String>, String> {
    let tree = crate::shell::parse(line.as_bytes());
    let command = (0..tree.nodes.len())
        .find(|&n| tree.kind(n) == "command")
        .expect("a command");
    let arguments: Vec<usize> = tree
        .children(command)
        .filter(|&n| tree.nodes[n].field == crate::shell::field_id("argument").unwrap())
        .collect();
    let mut host = Fake;
    let mut diagnostics = Vec::new();
    let room = shell.memory_room;
    let mut expander = Expander {
        shell,
        host: &mut host,
        tree: &tree,
        diagnostics: &mut diagnostics,
        room,
    };
    let mut out = Vec::new();
    for argument in arguments {
        match run(expander.fields(argument)) {
            Ok(fields) => out.extend(
                fields
                    .iter()
                    .map(|f| String::from_utf8_lossy(&f.text()).into_owned()),
            ),
            Err(Fault::Signal(Signal::Exit { stderr, .. } | Signal::Discard { stderr, .. })) => {
                return Err(String::from_utf8_lossy(&stderr).into_owned());
            }
            Err(Fault::Bad { text, .. }) => {
                return Err(format!(
                    "{}: bad substitution",
                    String::from_utf8_lossy(&text)
                ));
            }
            Err(other) => return Err(format!("{other:?}")),
        }
    }
    Ok(out)
}

/// The status a subshell around `line`'s first argument ends with,
/// once its expansion discards the line.
fn contained(shell: &mut Shell, line: &str) -> Option<i32> {
    let tree = crate::shell::parse(line.as_bytes());
    let argument = (0..tree.nodes.len())
        .find(|&n| tree.nodes[n].field == crate::shell::field_id("argument").unwrap())
        .expect("an argument");
    let mut host = Fake;
    let mut diagnostics = Vec::new();
    let room = shell.memory_room;
    let mut expander = Expander {
        shell,
        host: &mut host,
        tree: &tree,
        diagnostics: &mut diagnostics,
        room,
    };
    match run(expander.fields(argument)) {
        Err(Fault::Signal(Signal::Discard { contained, .. })) => Some(contained),
        _ => None,
    }
}

fn ok(shell: &mut Shell, line: &str) -> Vec<String> {
    words(shell, line).unwrap_or_else(|e| panic!("{line}: {e}"))
}

#[test]
fn an_input_substitution_expands_its_file_in_this_shell() {
    let mut shell = shell();
    let out = words(&mut shell, r#"echo "$(< ${f:=a\'b}*)" "$(<"$x")""#).unwrap();
    assert_eq!(out, [r"< 'a'\''b'*", "< 'a b'"]);
    assert_eq!(shell.vars.scalar("f"), Some(&b"a'b"[..]));
    // A here-string folds into a `<` too, and stays the body it is.
    let out = words(&mut shell, r#"echo "$(<<<'body')""#).unwrap();
    assert_eq!(out, ["<<<'body'"]);
}

#[test]
fn quoting_and_splitting() {
    let mut sh = shell();
    assert_eq!(
        ok(&mut sh, "echo $x \"$x\" '' $none"),
        ["a", "b", "a b", ""]
    );
    assert_eq!(ok(&mut sh, "echo a\"b\"'c'$'\\t'd"), ["abc\td"]);
    sh.vars.seed("IFS", Value::Scalar(b",".to_vec()));
    sh.vars.seed("v", Value::Scalar(b"a,,b,".to_vec()));
    assert_eq!(ok(&mut sh, "echo $v"), ["a", "", "b"]);
}

#[test]
fn positional_splats() {
    let mut sh = shell();
    sh.positional = vec![b"1 2".to_vec(), Vec::new()];
    assert_eq!(
        ok(&mut sh, "echo \"$@\" $# \"$*\""),
        ["1 2", "", "2", "1 2 "]
    );
    assert_eq!(ok(&mut sh, "echo $@"), ["1", "2"]);
    sh.positional.clear();
    assert_eq!(ok(&mut sh, "echo \"$@\" \"${@}\" \"$*\""), [""]);
}

#[test]
fn defaults_alternates_and_assignments() {
    let mut sh = shell();
    assert_eq!(
        ok(&mut sh, "echo ${u:-a b} \"${u:-a b}\" ${x:+set}"),
        ["a", "b", "a b", "set"]
    );
    assert_eq!(ok(&mut sh, "echo ${u:=v} $u"), ["v", "v"]);
    assert_eq!(ok(&mut sh, "echo ${e-unset} ${#x}"), ["unset", "3"]);
    assert_eq!(
        words(&mut sh, "echo ${zz:?gone missing}"),
        Err("bash: zz: gone missing\n".to_owned())
    );
    assert_eq!(
        words(&mut sh, "echo ${a b}"),
        Err("${a b}: bad substitution".to_owned())
    );
}

#[test]
fn length_follows_the_locale() {
    let mut sh = shell();
    sh.vars.seed("w", Value::Scalar("héllo".into()));
    assert_eq!(ok(&mut sh, "echo ${#w}"), ["6"]);
    sh.vars.seed("LANG", Value::Scalar(b"en_US.UTF-8".to_vec()));
    assert_eq!(ok(&mut sh, "echo ${#w}"), ["5"]);
    sh.vars.seed("LC_ALL", Value::Scalar(b"C".to_vec()));
    assert_eq!(ok(&mut sh, "echo ${#w}"), ["6"]);
}

#[test]
fn arrays_and_maps() {
    let mut sh = shell();
    sh.vars.seed(
        "a",
        Value::Indexed(Indexed::dense([b"p".to_vec(), b"q r".to_vec()])),
    );
    let map: Assoc = [
        (b"k".to_vec(), b"v".to_vec()),
        (b"b".to_vec(), b"w".to_vec()),
    ]
    .into_iter()
    .collect();
    sh.vars.seed("m", Value::Assoc(Box::new(map)));
    assert_eq!(
        ok(&mut sh, "echo ${a[1]} \"${a[@]}\" ${#a[@]} ${!a[@]}"),
        ["q", "r", "p", "q r", "2", "0", "1"]
    );
    assert_eq!(
        ok(
            &mut sh,
            "echo ${a[-1]} ${a[i=0]} $i ${m[k]} ${m[@]} ${!m[@]}"
        ),
        ["q", "r", "p", "0", "v", "w", "v", "b", "k"]
    );
}

#[test]
fn arithmetic_and_substitution() {
    let mut sh = shell();
    sh.vars.seed("n", Value::Scalar(b"2".to_vec()));
    assert_eq!(
        ok(&mut sh, "echo $((n + 1)) $((y = n * 5)) $y $(( $n * 2 ))"),
        ["3", "10", "10", "4"]
    );
    assert_eq!(ok(&mut sh, "echo $(hi there) $?"), ["hi", "there", "3"]);
    assert_eq!(ok(&mut sh, "echo `a \\$b` x`c`y"), ["a", "$b", "xcy"]);
    assert_eq!(ok(&mut sh, "echo <(true)x"), ["/dev/fd/5x"]);
    assert_eq!(
        words(&mut sh, "echo $((1/0))"),
        Err("bash: 1/0: division by 0 (error token is \"0\")\n".to_owned())
    );
}

#[test]
fn pattern_operators() {
    let mut sh = shell();
    sh.vars.seed("f", Value::Scalar(b"f.tar.gz".to_vec()));
    assert_eq!(
        ok(&mut sh, "echo ${f%.*} ${f%%.*} ${f#*.} ${f##*.}"),
        ["f.tar", "f", "tar.gz", "gz"]
    );
    sh.vars.seed("s", Value::Scalar(b"*x".to_vec()));
    assert_eq!(
        ok(&mut sh, "echo ${s#\"*\"} ${s#'*'} ${s#\\*} \"${s#*}\""),
        ["x", "x", "x", "*x"]
    );
    sh.vars.seed("o", Value::Scalar(b"foo".to_vec()));
    assert_eq!(
        ok(&mut sh, "echo ${o//o/0} ${o/#f/F} ${o/%o/O} ${o/o}"),
        ["f00", "Foo", "foO", "fo"]
    );
    assert_eq!(
        ok(&mut sh, "echo ${o^^} ${o^} ${o^^[of]} ${o,,}"),
        ["FOO", "Foo", "FOO", "foo"]
    );
    sh.vars.seed("p", Value::Scalar(b"o".to_vec()));
    assert_eq!(
        ok(&mut sh, "echo ${o//$p/x} ${o//\"$p\"/y}"),
        ["fxx", "fyy"]
    );
    sh.vars.seed("x", Value::Scalar(b"abc".to_vec()));
    sh.vars.seed("r", Value::Scalar(b"<&>".to_vec()));
    assert_eq!(
        ok(
            &mut sh,
            r#"echo ${x/b/[&]} ${x//[ac]/<&>} ${x/b/\&} ${x/b/"&"} ${x/b/$r} "${x/b/"$r"}""#
        ),
        ["a[b]c", "<a>b<c>", "a&c", "a&c", "a<b>c", "a<&>c"]
    );
}

#[test]
fn a_refused_default_ends_a_paren_subshell_with_two() {
    let mut sh = shell();
    sh.vars.seed("q", Value::Scalar(Vec::new()));
    sh.vars.set_attr("q", Some(crate::vars::READONLY), true);
    assert_eq!(contained(&mut sh, ": ${q:=x}"), Some(1));
    sh.paren = true;
    assert_eq!(contained(&mut sh, ": ${q:=x}"), Some(2));
    assert_eq!(contained(&mut sh, ": $((q=3))"), Some(1));
    sh.options.insert("errexit".to_owned(), true);
    assert_eq!(contained(&mut sh, ": ${q:=x}"), Some(1));
}

#[test]
fn an_expansion_fits_in_the_memory_left() {
    let mut sh = shell();
    sh.memory_room = Some(64);
    assert_eq!(ok(&mut sh, "echo {1..5}"), ["1", "2", "3", "4", "5"]);
    assert_eq!(
        words(&mut sh, "echo {1..10000000}"),
        Err("Memory".to_owned())
    );
    assert_eq!(
        words(&mut sh, "echo {a,b}{1..40}"),
        Err("Memory".to_owned())
    );
    sh.vars.seed("big", Value::Scalar(vec![b'x'; 100]));
    assert_eq!(words(&mut sh, "echo $big"), Err("Memory".to_owned()));
    sh.vars.seed("v", Value::Scalar(b"aaaa".to_vec()));
    assert_eq!(
        words(&mut sh, "echo ${v//a/0123456789abcdefg}"),
        Err("Memory".to_owned())
    );
    sh.memory_room = None;
    assert_eq!(ok(&mut sh, "echo ${#big}"), ["100"]);
}

#[test]
fn substrings_and_slices() {
    let mut sh = shell();
    sh.vars.seed("v", Value::Scalar(b"abcdef".to_vec()));
    assert_eq!(
        ok(
            &mut sh,
            "echo ${v:1:2} ${v: -2} ${v:2} ${v:1:-1} \"${v:10}\" ${v:i=1:i+1} $i"
        ),
        ["bc", "ef", "cdef", "bcde", "", "bc", "1"]
    );
    sh.vars.seed(
        "a",
        Value::Indexed(Indexed::dense([
            b"a".to_vec(),
            b"b".to_vec(),
            b"c".to_vec(),
            b"d".to_vec(),
        ])),
    );
    assert_eq!(ok(&mut sh, "echo ${a[@]:1:2} ${a[@]: -1}"), ["b", "c", "d"]);
    sh.positional = vec![b"x".to_vec(), b"y".to_vec()];
    assert_eq!(ok(&mut sh, "echo ${@:0:1} ${@:2}"), ["mirage", "y"]);
    assert_eq!(
        words(&mut sh, "echo ${v:1/0}"),
        Err("bash: v: 1/0: division by 0 (error token is \"0\")\n".to_owned())
    );
    assert_eq!(
        words(&mut sh, "echo ${v:1: -9 }"),
        Err("bash:  -9 : substring expression < 0\n".to_owned())
    );
    assert_eq!(
        words(&mut sh, "echo ${a[@]:1:-1}"),
        Err("bash: -1: substring expression < 0\n".to_owned())
    );
    assert_eq!(
        ok(&mut sh, "echo [${v:1:-5}] [${v:6}] [${v:7}]"),
        ["[]", "[]", "[]"]
    );
    // The length expands only once the offset has evaluated.
    assert!(words(&mut sh, "echo ${v:(1/0):${len:=2}}").is_err());
    assert!(sh.vars.scalar("len").is_none());
}

#[test]
fn transformations() {
    let mut sh = shell();
    sh.vars.seed("q", Value::Scalar(b"it's".to_vec()));
    sh.vars.seed("t", Value::Scalar(b"a\tb\x01".to_vec()));
    sh.vars.seed("x", Value::Scalar(b"ab".to_vec()));
    sh.vars.set_attr("x", Some(crate::vars::EXPORT), true);
    sh.vars.seed(
        "a",
        Value::Indexed(Indexed::dense([b"1".to_vec(), b"b c".to_vec()])),
    );
    let map: Assoc = [(b"k".to_vec(), b"v".to_vec())].into_iter().collect();
    sh.vars.seed("m", Value::Assoc(Box::new(map)));
    assert_eq!(
        ok(&mut sh, "echo \"${q@Q}\" \"${t@Q}\" \"${zz@Q}\""),
        ["'it'\\''s'", "$'a\\tb\\001'", ""]
    );
    assert_eq!(
        ok(
            &mut sh,
            "echo \"${x@A}\" \"${a[@]@A}\" \"${m[*]@A}\" \"${a@A}\" \"${x[@]@A}\""
        ),
        [
            "declare -x x='ab'",
            "declare",
            "-a",
            "a=([0]=\"1\" [1]=\"b c\")",
            "declare -A m=([k]=\"v\" )",
            "declare -a a='1'",
            "declare -x x='ab'",
        ]
    );
    sh.vars.seed("s", Value::Indexed(Indexed::default()));
    sh.vars.seed("r", Value::Scalar(b"x".to_vec()));
    sh.vars.set_attr("r", Some(crate::vars::NAMEREF), true);
    assert_eq!(
        ok(
            &mut sh,
            "echo \"${m@A}\" \"${m[zz]@A}\" \"${a[5]@A}\" \"${s@A}\" [${zz@A}] \"${q@A}\" \"${r@A}\" ${s-unset}"
        ),
        [
            "declare -A m",
            "declare -A m",
            "declare -a a",
            "declare -a s",
            "[]",
            "q='it'\\''s'",
            "declare -x x='ab'",
            "unset",
        ]
    );
    assert_eq!(
        ok(&mut sh, "echo \"${a[@]@K}\" \"${m[@]@K}\" \"${x@K}\""),
        ["0 \"1\" 1 \"b c\"", "k \"v\" ", "'ab'"]
    );
    assert_eq!(ok(&mut sh, "echo \"${a[@]@k}\""), ["0", "1", "1", "b c"]);
    assert_eq!(
        ok(&mut sh, "echo [${x@a}] [${a@a}] [${m@a}] [${q@a}]"),
        ["[x]", "[a]", "[A]", "[]"]
    );
    sh.vars.seed("w", Value::Scalar(b"a\\tb".to_vec()));
    assert_eq!(
        ok(
            &mut sh,
            "echo \"${w@E}\" ${x@U} ${x@u} ${q@L} \"${a[@]@U}\""
        ),
        ["a\tb", "AB", "Ab", "it's", "1", "B C"]
    );
}

#[test]
fn names_by_prefix() {
    let mut sh = shell();
    sh.vars.seed("ab", Value::Scalar(b"1".to_vec()));
    sh.vars.seed("ac", Value::Scalar(b"2".to_vec()));
    sh.vars.seed("a", Value::Scalar(b"0".to_vec()));
    assert_eq!(
        ok(&mut sh, "echo \"${!a@}\" \"${!a*}\""),
        ["a", "ab", "ac", "a ab ac"]
    );
}

#[test]
fn assignments_patterns_and_regexes() {
    let mut sh = shell();
    let tree = crate::shell::parse(b"x=/a:~/b:~+:'~'/c y=~ z=a~; case ~/'*'$v\\? in esac");
    let mut host = Fake;
    let mut diagnostics = Vec::new();
    sh.vars.seed("v", Value::Scalar(b"[q]".to_vec()));
    let mut expander = Expander {
        shell: &mut sh,
        host: &mut host,
        tree: &tree,
        diagnostics: &mut diagnostics,
        room: None,
    };
    let values: Vec<usize> = (0..tree.nodes.len())
        .filter(|&n| tree.kind(n) == "variable_assignment")
        .filter_map(|n| tree.field(n, "value"))
        .collect();
    let texts: Vec<Vec<u8>> = values
        .iter()
        .map(|&v| run(expander.assignment(v)).unwrap())
        .collect();
    assert_eq!(
        texts,
        vec![b"/a:/h/b:/w:~/c".to_vec(), b"/h".to_vec(), b"a~".to_vec()]
    );
    let case = (0..tree.nodes.len())
        .find(|&n| tree.kind(n) == "case_statement")
        .unwrap();
    let word = tree.field(case, "value").unwrap();
    let runs = run(expander.pattern_runs(word)).unwrap();
    let joined: Vec<(String, bool)> = runs
        .iter()
        .map(|(t, q)| (String::from_utf8_lossy(t).into_owned(), *q))
        .collect();
    assert_eq!(joined[0], ("/h".to_owned(), true));
    assert!(joined.contains(&("*".to_owned(), true)));
    assert!(joined.contains(&("[q]".to_owned(), false)));
    assert_eq!(
        regex_text(&[
            (b"a.".to_vec(), false),
            (b".*".to_vec(), true),
            (b"['^'b]".to_vec(), false)
        ]),
        b"a.\\.\\*['^'b]"
    );
    assert_eq!(
        regex_text(&[
            (b"[".to_vec(), false),
            (b"^".to_vec(), true),
            (b"a]".to_vec(), false)
        ]),
        b"[^a]"
    );
}

#[test]
fn option_letters() {
    let mut sh = shell();
    assert_eq!(ok(&mut sh, "echo $-"), ["hBc"]);
    sh.options.insert("errexit".to_owned(), true);
    sh.options.insert("nounset".to_owned(), true);
    assert_eq!(ok(&mut sh, "echo $- ${-}"), ["ehuBc", "ehuBc"]);
}

#[test]
fn an_array_without_element_zero_is_unset() {
    let mut sh = shell();
    sh.vars.seed("s", Value::Indexed(Indexed::default()));
    let map: Assoc = [(b"k".to_vec(), b"v".to_vec())].into_iter().collect();
    sh.vars.seed("m", Value::Assoc(Box::new(map)));
    assert_eq!(
        ok(&mut sh, "echo ${s-unset} ${m-unset} [$s]"),
        ["unset", "unset", "[]"]
    );
    sh.options.insert("nounset".to_owned(), true);
    assert!(words(&mut sh, "echo $s").is_err());
    assert!(words(&mut sh, "echo ${m}").is_err());
}

#[test]
fn brace_words() {
    let mut sh = shell();
    sh.vars.seed("v", Value::Scalar(b"p q".to_vec()));
    assert_eq!(
        ok(
            &mut sh,
            "echo a{b,c}d {1..3} {a,$v} pre{x,y}$v ~/{a,b} {,z} '{a,b}'"
        ),
        [
            "abd", "acd", "1", "2", "3", "a", "p", "q", "prexp", "q", "preyp", "q", "/h/a", "/h/b",
            "z", "{a,b}",
        ]
    );
    sh.options.insert("braceexpand".to_owned(), false);
    assert_eq!(ok(&mut sh, "echo a{b,c}"), ["a{b,c}"]);
}

#[test]
fn tilde_prefixes() {
    let mut sh = shell();
    assert_eq!(
        ok(&mut sh, r#"echo ~ ~/x \~ ~"/x" ~+ a~ ~nobody"#),
        ["/h", "/h/x", "~", "~/x", "/w", "a~", "~nobody"]
    );
    sh.vars.seed("HOME", Value::Scalar(b"/".to_vec()));
    assert_eq!(ok(&mut sh, "echo ~/x ${u:-~/y}"), ["//x", "//y"]);
}

#[test]
fn what_bash_spells_differently() {
    let mut sh = shell();
    sh.vars.seed("v", Value::Scalar(b"aBc".to_vec()));
    sh.vars.seed("e", Value::Scalar(Vec::new()));
    sh.vars.seed("one", Value::Scalar(b"1".to_vec()));
    sh.vars.seed(
        "a",
        Value::Indexed(Indexed::dense([b"e0".to_vec(), b"e1".to_vec()])),
    );
    sh.vars.seed("r1", Value::Scalar(b"a[1]".to_vec()));
    sh.vars.seed("rall", Value::Scalar(b"a[@]".to_vec()));
    sh.vars.seed("nope", Value::Scalar(b"missing".to_vec()));
    assert_eq!(
        ok(
            &mut sh,
            "echo [${u/*/x}] ${v~} ${v~~} ${v~~[aB]} ${e/#/P} ${v/%/S}"
        ),
        ["[]", "ABc", "AbC", "Abc", "P", "aBcS"]
    );
    assert_eq!(
        ok(
            &mut sh,
            "echo ${!r1} \"${!rall}\" ${!nope:-d} {Z..a} $one{,}"
        ),
        [
            "e1", "e0", "e1", "d", "Z", "[", "", "]", "^", "_", "`", "a", "1", "1"
        ]
    );
    assert_eq!(
        words(&mut sh, "echo $(('1'))"),
        Err("bash: '1': syntax error: operand expected (error token is \"'1'\")\n".to_owned())
    );
    assert!(words(&mut sh, "echo ${e@Z}").is_err());
    assert_eq!(ok(&mut sh, "echo [${u@Z}]"), ["[]"]);
    assert!(words(&mut sh, "echo ${1:=x}").is_err());
    assert!(words(&mut sh, "echo ${!u}").is_err());
    assert!(words(&mut sh, "echo ${!e}").is_err());
    sh.vars.seed("HOME", Value::Scalar(b"/hh".to_vec()));
    assert_eq!(
        ok(&mut sh, "echo a=~ b=~/x:~ c+=~ --d=~ e=x~ f={~,y}"),
        [
            "a=/hh",
            "b=/hh/x:/hh",
            "c+=/hh",
            "--d=~",
            "e=x~",
            "f=~",
            "f=y"
        ]
    );
    sh.vars.seed("e", Value::Scalar(b"=".to_vec()));
    assert_eq!(
        ok(
            &mut sh,
            "echo c[1]=x:~ c[$e]=~ c[a[1]]=~ x=$e:~ c[a=b]=~ c[]]=~ x++=~ $e=~ c[1]+=~:~"
        ),
        [
            "c[1]=x:/hh",
            "c[=]=/hh",
            "c[a[1]]=/hh",
            "x==:/hh",
            "c[a=b]=~",
            "c[]]=~",
            "x++=~",
            "==~",
            "c[1]+=/hh:/hh"
        ]
    );
}

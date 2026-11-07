use super::{FIELDS, KINDS, Options, Refusal, Tree, parse, parse_with};

/// The tree as an s-expression: named nodes with their fields, a leaf's
/// text after `=`.
fn sexp(tree: &Tree) -> String {
    fn walk(tree: &Tree, index: usize, out: &mut String) {
        let node = &tree.nodes[index];
        if node.field != 0 {
            out.push_str(FIELDS[usize::from(node.field) - 1]);
            out.push_str(": ");
        }
        out.push('(');
        out.push_str(KINDS[usize::from(node.kind)].0);
        let children = node.first_child..node.first_child + node.child_count;
        let named: Vec<u32> = children
            .filter(|child| tree.nodes[*child as usize].named)
            .collect();
        if named.is_empty() {
            let text = &tree.source[node.start as usize..node.end as usize];
            out.push('=');
            out.push_str(&String::from_utf8_lossy(text));
        }
        for child in named {
            out.push(' ');
            walk(tree, child as usize, out);
        }
        out.push(')');
    }
    let mut out = String::new();
    walk(tree, 0, &mut out);
    out
}

fn read(source: &str) -> String {
    let tree = parse(source.as_bytes());
    assert_eq!(tree.error, None, "{source:?}");
    sexp(&tree)
}

/// The text the tree reads, and each heredoc's delimiter, body and
/// whether its delimiter line ended it.
fn lowered(source: &str) -> (String, Vec<(String, String, bool)>) {
    let tree = parse(source.as_bytes());
    assert_eq!(tree.error, None, "{source:?}");
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    let heredocs = tree
        .heredocs
        .iter()
        .map(|heredoc| {
            (
                text(&heredoc.delimiter),
                text(&heredoc.body),
                heredoc.terminated,
            )
        })
        .collect();
    (text(&tree.source), heredocs)
}

fn aliased(source: &[u8], aliases: &[Vec<u8>]) -> Tree {
    parse_with(
        source,
        &Options {
            aliases: aliases.to_vec(),
            ..Options::default()
        },
    )
}

fn heredoc(delimiter: &str, body: &str, terminated: bool) -> (String, String, bool) {
    (delimiter.into(), body.into(), terminated)
}

fn refused(source: &str) -> Refusal {
    parse(source.as_bytes()).error.expect("a refusal")
}

/// A refusal as `bash -c` prints it.
fn words(refusal: &Refusal) -> String {
    String::from_utf8_lossy(&refusal.worded(b"bash: -c: ", 1, true)).into_owned()
}

/// A tree's heredoc warnings as `bash -c` prints them.
fn warned(tree: &Tree) -> String {
    String::from_utf8_lossy(&tree.warnings(b"bash: ", 1)).into_owned()
}

#[test]
fn a_redirect_wraps_everything_before_it() {
    assert_eq!(
        read("a && b > f"),
        "(program (redirected_statement body: (list (command name: (command_name (word=a))) \
         (command name: (command_name (word=b)))) redirect: (file_redirect destination: (word=f))))"
    );
}

#[test]
fn bash_reads_these_as_it_reads_its_words() {
    // A `$` before a backtick is a literal `$`, the token before the
    // substitution.
    assert_eq!(
        read("echo $`echo hi`"),
        "(program (command name: (command_name (word=echo)) argument: (concatenation \
         (command_substitution (command name: (command_name (word=echo)) argument: (word=hi))))))"
    );
    assert!(read("echo \"$`echo q`\"").contains("(string (command_substitution"));
    // A redirect before a declaration builtin leaves it a declaration.
    assert_eq!(
        read("> f declare a=1"),
        "(program (redirected_statement body: (declaration_command redirect: (file_redirect \
         destination: (word=f)) (variable_assignment name: (variable_name=a) value: (number=1)))))"
    );
    // `[` is a command: a `<` or `>` among its words redirects.
    assert_eq!(
        read("[ -n a > f ]"),
        "(program (command name: (command_name (word=[)) argument: (word=-n) argument: (word=a) \
         redirect: (file_redirect destination: (word=f)) argument: (word=])))"
    );
}

#[test]
fn a_replacement_takes_operator_bytes_literally() {
    // `&`, `<`, `>` and the rest are text inside the braces, not the end
    // of the parse: bash reads `${x/b/[&]}` as a replacement of `b`.
    assert_eq!(
        read("echo ${x/b/[&]}"),
        "(program (command name: (command_name (word=echo)) argument: (expansion (variable_name=x) \
         (regex=b) (concatenation (word=[) (word=&) (word=])))))"
    );
    assert!(read("echo ${x//[ac]/<&>}").contains("(variable_name=x)"));
}

#[test]
fn a_redirect_takes_one_word() {
    // The words after it are the command's; redirects that end it wrap it.
    assert_eq!(
        read("echo a > f b 2>&1 c > g"),
        "(program (redirected_statement body: (command name: (command_name (word=echo)) \
         argument: (word=a) redirect: (file_redirect destination: (word=f)) argument: (word=b) \
         redirect: (file_redirect descriptor: (file_descriptor=2) destination: (number=1)) \
         argument: (word=c)) redirect: (file_redirect destination: (word=g))))"
    );
    assert_eq!(lowered("cat <<E -n\nx\nE").0, "cat <\"x\n\" -n\n");
    assert_eq!(
        read("cat <<E -n\nx\nE"),
        "(program (command name: (command_name (word=cat)) redirect: (file_redirect \
         destination: (string (string_content=x))) argument: (word=-n)))"
    );
    assert_eq!(
        read("echo a >&- b"),
        "(program (command name: (command_name (word=echo)) argument: (word=a) \
         redirect: (file_redirect=>&-) argument: (word=b)))"
    );
    // A declaration's redirects apply in the order written, so the ones
    // after its words join the ones among them.
    assert_eq!(
        read("unset a > f b 2> g"),
        "(program (redirected_statement body: (unset_command (variable_name=a) \
         redirect: (file_redirect destination: (word=f)) (variable_name=b)) \
         redirect: (file_redirect descriptor: (file_descriptor=2) destination: (word=g))))"
    );
    assert!(read("[ a ] > f ]").starts_with("(program (command name: (command_name (word=[))"));
    assert!(read("echo $(< f g)").contains(
        "(command redirect: (file_redirect destination: (word=f)) name: (command_name (word=g)))"
    ));
    assert!(read("declare a=1 <<< x b=2").contains(
        "redirect: (herestring_redirect (word=x)) (variable_assignment name: (variable_name=b)"
    ));
    assert!(read("[ a ] <<< x b").starts_with("(program (command name: (command_name (word=[))"));
    // Each target is read once, however deep its substitutions nest.
    let mut nested = String::from(":");
    for _ in 0..20 {
        nested = format!(": >x$({nested})");
    }
    read(&nested);
    // A `$(< f cmd)` that is no file read queues its heredoc once.
    let (text, heredocs) = lowered("echo $(< \"$(cat <<E)\" cat)\n/dev/null\nE\necho after");
    assert!(text.ends_with(")\necho after"), "{text:?}");
    assert_eq!(heredocs, vec![heredoc("E", "/dev/null\n", true)]);
    // After a compound command, or before an array value, bash refuses a
    // word.
    for (line, near) in [
        ("{ echo a; } > f b", "b"),
        ("(echo a) > f b", "b"),
        ("if a; then b; fi > f c", "c"),
        ("[[ a ]] > f b", "b"),
        ("time { a; } > f b", "b"),
        ("declare a=1 > f b=(1)", "("),
    ] {
        let refusal = refused(line);
        assert_eq!(
            (words(&refusal), refusal.status),
            (
                format!(
                    "bash: -c: line 1: syntax error near unexpected token `{near}'\nbash: -c: line 1: `{line}'\n"
                ),
                2
            ),
            "{line}"
        );
    }
}

#[test]
fn spans_and_points_count_bytes() {
    let tree = parse("echo é\n  ls".as_bytes());
    let word = tree
        .nodes
        .iter()
        .find(|node| KINDS[usize::from(node.kind)].0 == "word" && node.start == 5)
        .expect("é");
    assert_eq!((word.start, word.end), (5, 7));
    let ls = tree
        .nodes
        .iter()
        .rev()
        .find(|node| node.start == 10)
        .expect("ls");
    assert_eq!((ls.start_row, ls.start_column), (1, 2));
    assert_eq!((tree.nodes[0].start, tree.nodes[0].end), (0, 12));
}

#[test]
fn blanks_join_the_token_after_them_in_a_string() {
    let tree = parse(br#"echo "$x $y" "$x ""#);
    let dollars: Vec<(u32, u32)> = tree
        .nodes
        .iter()
        .filter(|node| matches!(KINDS[usize::from(node.kind)].0, "$" | "\""))
        .map(|node| (node.start, node.end))
        .collect();
    assert!(dollars.contains(&(8, 10)), "{dollars:?}");
    assert!(dollars.contains(&(16, 18)), "{dollars:?}");
}

#[test]
fn a_comment_sits_between_the_children_around_it() {
    assert_eq!(
        read("if a # x\nthen b; fi # y"),
        "(program (if_statement condition: (command name: (command_name (word=a))) (comment=# x) \
         (command name: (command_name (word=b)))) (comment=# y))"
    );
}

#[test]
fn a_heredoc_body_folds_into_its_line() {
    assert_eq!(
        lowered("cat <<EOF | wc\na $x\nEOF\necho"),
        (
            "cat <\"a $x\n\" | wc\necho".into(),
            vec![heredoc("EOF", "a $x\n", true)]
        )
    );
    assert_eq!(
        read("cat <<EOF | wc\na $x\nEOF\necho"),
        "(program (pipeline (redirected_statement body: (command name: (command_name (word=cat))) \
         redirect: (file_redirect destination: (string (string_content=a ) (simple_expansion \
         (variable_name=x))))) (command name: (command_name (word=wc)))) \
         (command name: (command_name (word=echo))))"
    );
    let tree = parse(b"cat <<E \\\nx\nbody\nE\n");
    assert_eq!(tree.source, b"cat <\"body\n\" x\n");
    assert_eq!(tree.offsets[5], 12);
    assert_eq!(tree.offsets[tree.source.len()], 19);
}

#[test]
fn heredocs_after_a_line_are_read_in_order() {
    assert_eq!(
        lowered("cat <<A; cat <<B\na\nA\nb\nB").1,
        vec![heredoc("A", "a\n", true), heredoc("B", "b\n", true)]
    );
    // A substitution's heredocs come first.
    assert_eq!(
        lowered("cat <<A; echo \"$(cat <<B)\"\nb\nB\na\nA"),
        (
            "cat <\"a\n\"; echo \"$(cat <\"b\n\")\"\n".into(),
            vec![heredoc("A", "a\n", true), heredoc("B", "b\n", true)]
        )
    );
    // A newline inside a substitution reads only the heredocs opened in it.
    assert_eq!(
        lowered("cat <<A; echo $(echo b\necho c)\na\nA").1,
        vec![heredoc("A", "a\n", true)]
    );
    // An unquoted body joins continued lines; a quoted one keeps them.
    assert_eq!(
        lowered("cat <<E\na\\\nE\nE").1,
        vec![heredoc("E", "aE\n", true)]
    );
    assert_eq!(
        lowered("cat <<'E'\na\\\nE").1,
        vec![heredoc("E", "a\\\n", true)]
    );
    // bash reads a backtick's text first: a heredoc left open in it ends
    // with it, and the lines after are commands.
    for line in [
        "echo `cat <<A`\nA",
        "echo `cat <<A;`\nA",
        "echo $`cat <<A`\nA",
    ] {
        let tree = read(line);
        assert!(
            tree.ends_with("(command name: (command_name (word=A))))"),
            "{tree}"
        );
    }
    // Nor does a newline in it read a heredoc opened before it.
    assert_eq!(
        lowered("cat <<A; echo `echo\nA\ncat <<B`\nB\nA"),
        (
            "cat <\"B\n\"; echo `echo\nA\ncat <<B`\n".into(),
            vec![heredoc("A", "B\n", true)]
        )
    );
}

#[test]
fn bash_reads_what_the_grammar_misreads() {
    assert_eq!(
        read("exec 0>f"),
        "(program (redirected_statement body: (command name: (command_name (word=exec))) \
         redirect: (file_redirect descriptor: (file_descriptor=0) destination: (word=f))))"
    );
    assert_eq!(
        read("time a | b"),
        "(program (timed_statement (pipeline (command name: (command_name (word=a))) \
         (command name: (command_name (word=b))))))"
    );
    assert_eq!(
        read("echo $10"),
        "(program (command name: (command_name (word=echo)) argument: (concatenation \
         (simple_expansion (variable_name=1)) (number=0))))"
    );
    assert_eq!(
        read("echo $\"x\""),
        "(program (command name: (command_name (word=echo)) argument: (translated_string \
         (string (string_content=x)))))"
    );
    assert_eq!(
        read("((echo a); echo b)"),
        "(program (subshell (subshell (command name: (command_name (word=echo)) argument: (word=a))) \
         (command name: (command_name (word=echo)) argument: (word=b))))"
    );
    assert_eq!(
        read("((echo a))"),
        "(program (compound_statement (word=echo a)))"
    );
}

#[test]
fn a_continuation_joins_the_halves_of_a_word() {
    assert_eq!(
        read("ec\\\nho a"),
        "(program (command name: (command_name (word=echo)) argument: (word=a)))"
    );
    assert_eq!(parse(b"ec\\\nho a").offsets, [0, 1, 4, 5, 6, 7, 8]);
    assert_eq!(
        read("echo 'a\\\nb' # c\\\n"),
        "(program (command name: (command_name (word=echo)) argument: (raw_string='a\\\nb')) (comment=# c\\))"
    );
    // A backslash ending the input continues onto nothing.
    assert_eq!(parse(b"echo a\\").source, b"echo a");
}

#[test]
fn bash_parses_these_only_when_it_runs_them() {
    assert_eq!(
        read("echo $(( a # )) ${x:.2f} `fi`"),
        "(program (command name: (command_name (word=echo)) argument: (arithmetic_expansion (word=a #)) \
         argument: (expansion (variable_name=x) (word=.2f)) argument: (command_substitution (word=fi))))"
    );
    assert_eq!(
        read("[ a"),
        "(program (command name: (command_name (word=[)) argument: (word=a)))"
    );
}

#[test]
fn refusals_are_in_bash_words() {
    let said = |source: &str| {
        let refusal = refused(source);
        (words(&refusal), refusal.status)
    };
    assert_eq!(refused("if a; then").at, 10);
    assert_eq!(
        said("if a; then"),
        (
            "bash: -c: line 2: syntax error: unexpected end of file\n".into(),
            2
        )
    );
    assert_eq!(
        said("echo a; fi").0,
        "bash: -c: line 1: syntax error near unexpected token `fi'\nbash: -c: line 1: `echo a; fi'\n"
    );
    // A redirect with no word is refused at the newline bash supposes
    // at the end of the input.
    assert_eq!(
        said("echo >").0,
        "bash: -c: line 1: syntax error near unexpected token `newline'\nbash: -c: line 1: `echo >'\n"
    );
    // A substitution bash cannot parse is refused with 127, an array
    // with 1, and after an array's refusal bash reads on from the next
    // line.
    assert_eq!(
        said("echo $(fi)"),
        (
            "bash: -c: line 1: syntax error near unexpected token `fi'\nbash: -c: line 1: `echo $(fi)'\n"
                .into(),
            127
        )
    );
    assert_eq!(
        said("x=(1 ;)\necho ${a"),
        (
            "bash: -c: line 1: syntax error near unexpected token `;'\nbash: -c: line 1: `x=(1 ;)'\n\
             bash: -c: line 2: unexpected EOF while looking for matching `}'\n"
                .into(),
            1
        )
    );
    assert_eq!(
        said("x=1 > f y=(b)").0,
        "bash: -c: line 1: syntax error near unexpected token `('\nbash: -c: line 1: `x=1 > f y=(b)'\n"
    );
    // `[[` words its own refusals before the text it stopped at.
    assert_eq!(
        said("[[ a -a b ]]").0,
        "bash: -c: line 1: conditional binary operator expected\nbash: -c: line 1: syntax error near `-a'\n\
         bash: -c: line 1: `[[ a -a b ]]'\n"
    );
    assert_eq!(
        said("for ((a b)); do :; done").0,
        "bash: -c: line 1: syntax error: arithmetic expression required\n\
         bash: -c: line 1: syntax error: `((a b))'\n"
    );
    refused("( ! )");
    refused("echo | ! a");
}

#[test]
fn refusals_stand_on_the_lines_bash_names() {
    // Pinned on bash -c: the end of the input is the line past the last,
    // an unclosed quote or pair the line it opened on, and a token's line
    // is quoted back as typed, from the line it ends on; a conditional
    // names its `[[` and `(` lines, a `((` bash rereads is quoted from its
    // second `(`, and where the line's list could end bash first reads
    // the heredoc bodies the line opened.
    for (source, said) in [
        (
            "(echo a\n",
            "bash: -c: line 2: syntax error: unexpected end of file\n",
        ),
        (
            "echo a\nif true; then\necho b",
            "bash: -c: line 4: syntax error: unexpected end of file\n",
        ),
        (
            "echo a\necho $(\necho b",
            "bash: -c: line 4: unexpected EOF while looking for matching `)'\n",
        ),
        (
            "echo a\necho 'x\ny\nz",
            "bash: -c: line 2: unexpected EOF while looking for matching `''\n",
        ),
        (
            "echo a\nx=(1\n2",
            "bash: -c: line 2: unexpected EOF while looking for matching `)'\n",
        ),
        (
            "echo a\nfor x in a; do\ndone",
            "bash: -c: line 3: syntax error near unexpected token `done'\nbash: -c: line 3: `done'\n",
        ),
        (
            "cat <<E\nx\nE\necho (",
            "bash: -c: line 4: syntax error near unexpected token `newline'\nbash: -c: line 4: `echo ('\n",
        ),
        (
            "echo a \\\nb; fi",
            "bash: -c: line 2: syntax error near unexpected token `fi'\nbash: -c: line 2: `b; fi'\n",
        ),
        (
            "echo a\n[[ a -bogus b ]]",
            "bash: -c: line 2: conditional binary operator expected\nbash: -c: line 2: syntax error near `-bogus'\n\
             bash: -c: line 2: `[[ a -bogus b ]]'\n",
        ),
        (
            "[[ a =~ ^(a|b$ ]]",
            "bash: -c: line 1: unexpected EOF while looking for matching `)'\n\
             bash: -c: line 2: unexpected argument to conditional binary operator\n",
        ),
        (
            "f\\\ni",
            "bash: -c: line 2: syntax error near unexpected token `fi'\nbash: -c: line 2: `i'\n",
        ),
        (
            "x\n[[ -f a",
            "bash: -c: line 2: unexpected EOF while looking for `]]'\n\
             bash: -c: line 3: syntax error: unexpected end of file\n",
        ),
        (
            "[[ (\na\n-x b ]]",
            "bash: -c: line 2: unexpected token `newline', conditional binary operator expected\n\
             bash: -c: line 1: expected `)'\nbash: -c: line 2: syntax error near `a'\n\
             bash: -c: line 2: `a'\n",
        ),
        (
            "x; (( (a)b)",
            "bash: -c: line 1: syntax error near unexpected token `b'\nbash: -c: line 1: `( (a)b)'\n",
        ),
        (
            "((a)b)",
            "bash: -c: line 1: syntax error near unexpected token `b'\nbash: -c: line 1: `((a)b)'\n",
        ),
        (
            "cat <<A <<B; )\na\nA\nb\nB",
            "bash: -c: line 5: syntax error near unexpected token `)'\n\
             bash: -c: line 5: `cat <<A <<B; )'\n",
        ),
        (
            "cat <<A <<\na\n",
            "bash: -c: line 2: syntax error near unexpected token `newline'\n\
             bash: -c: line 2: `cat <<A <<'\n",
        ),
        (
            "cat <<A; if )\nx\nA",
            "bash: -c: line 1: syntax error near unexpected token `)'\n\
             bash: -c: line 1: `cat <<A; if )'\n",
        ),
        (
            "echo $(cat <<A\nx\nA ;)",
            "bash: -c: line 3: syntax error near unexpected token `;'\nbash: -c: line 3: ` ;)'\n",
        ),
    ] {
        assert_eq!(words(&refused(source)), said, "{source:?}");
    }
    // `eval` numbers on from the line it runs on.
    assert_eq!(
        String::from_utf8_lossy(&refused("echo a\necho (").worded(b"bash: eval: ", 2, true)),
        "bash: eval: line 3: syntax error near unexpected token `newline'\nbash: eval: line 3: `echo ('\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&parse(b"cat <<Q\ny").warnings(b"bash: ", 4)),
        "bash: line 5: warning: here-document at line 4 delimited by end-of-file (wanted `Q')\n"
    );
}

#[test]
fn an_unexpected_token_is_named_as_bash_reads_it() {
    // Pinned on bash -c under C.UTF-8 and C: a `$'...'` read as a word as
    // its value in single quotes, bare in a quoted `${ }` that takes no
    // pattern or `$[ ]`, as typed in double quotes and backticks; a
    // `$"..."` as `"..."`, a `\001` before each `\001` and `\177` no
    // backslash escapes, and the whole in `$'...'` when it does not show.
    for (source, utf8, token) in [
        ("echo ($'a'", true, "'a'"),
        ("echo ($'a\\'b'", true, "'a'\\''b'"),
        ("echo ($'\\''", true, "\\'"),
        ("echo ($\"a$x\"", true, "\"a$x\""),
        ("echo (\"$'a'\"", true, "\"$'a'\""),
        ("echo (x$'a\\tb'y", true, "$'x\\'a\\tb\\'y'"),
        ("echo ($'\\x01\\x7f'", true, "$'\\'\\001\\001\\001\\177\\''"),
        ("echo (a\x01b", true, "$'a\\001\\001b'"),
        ("echo (\\\x01", true, "$'\\\\\\001'"),
        ("echo ($'\\0a'", true, "''"),
        ("echo (é", true, "é"),
        ("echo (é", false, "$'\\303\\251'"),
        ("echo (\"$(echo $'a')\"", true, "\"$(echo 'a')\""),
        ("echo ($(echo $'a')", true, "$(echo 'a')"),
        ("echo (<(echo $'a')", true, "<(echo 'a')"),
        ("echo (>(a)b", true, ">(a)b"),
        ("echo (<<(a)", true, "<<"),
        ("f() <(a)", true, "<(a)"),
        ("echo (\"$((1+$'a'))\"", true, "\"$((1+'a'))\""),
        ("echo (\"$(echo \\\"$'a')\"", true, "\"$(echo \\\"'a')\""),
        ("echo (`echo $'a'`", true, "`echo $'a'`"),
        ("echo (\"`echo $'a'`\"", true, "\"`echo $'a'`\""),
        ("echo (${x:-$'a'}", true, "${x:-'a'}"),
        ("echo (\"${x:-$'a'}\"", true, "\"${x:-a}\""),
        ("echo (\"${x[$'a']}\"", true, "\"${x[a]}\""),
        ("echo (\"${x/$'a'/b}\"", true, "\"${x/'a'/b}\""),
        ("echo (\"${x^^$'a'}\"", true, "\"${x^^'a'}\""),
        ("echo (\"${x#${y:-$'a'}}\"", true, "\"${x#${y:-a}}\""),
        ("echo (\"${x:-${y#$'a'}}\"", true, "\"${x:-${y#'a'}}\""),
        ("echo (\"${x:-\"$'a'\"}\"", true, "\"${x:-\"$'a'\"}\""),
        ("echo (\"$[$'a']\"", true, "\"$[a]\""),
        ("echo (\u{2028}", true, "$'\\342\\200\\250'"),
        ("echo (é\u{2028}", true, "$'é\\342\\200\\250'"),
        ("echo (\u{200b}", true, "\u{200b}"),
    ] {
        let said = String::from_utf8_lossy(&refused(source).worded(b"", 1, utf8)).into_owned();
        let near = format!("line 1: syntax error near unexpected token `{token}'");
        assert_eq!(said.lines().next(), Some(near.as_str()), "{source:?}");
    }
}

#[test]
fn reserved_words_follow_a_compound_command_bare() {
    read("if (true) then echo; fi");
    read("{ (a) }");
    read("! ;");
    read("time");
    refused("{echo a;}");
}

#[test]
fn deep_nesting_is_refused_not_overflowed() {
    let deep = format!("{}a{}", "! ".repeat(5000), ")".repeat(5000));
    assert_eq!(
        words(&refused(&deep)),
        "bash: -c: line 1: syntax error: nesting too deep\n"
    );
    let wide = format!("a{}", " && a".repeat(100_000));
    assert_eq!(parse(wide.as_bytes()).error, None);
}

#[test]
fn a_bracket_is_a_command_whose_words_reach_test_whole() {
    assert_eq!(
        read("[ --x = -1 ]"),
        "(program (command name: (command_name (word=[)) argument: (word=--x) \
         argument: (word==) argument: (number=-1) argument: (word=])))"
    );
    assert_eq!(
        read("[ ]"),
        "(program (command name: (command_name (word=[)) argument: (word=])))"
    );
    // A blank ends every word but an array literal's lone brackets.
    assert_eq!(
        read("echo { } [ ]"),
        "(program (command name: (command_name (word=echo)) argument: (word={) \
         argument: (word=}) argument: (word=[) argument: (word=])))"
    );
    assert_eq!(
        read("x=( [ ] )"),
        "(program (variable_assignment name: (variable_name=x) value: (array (word=[ ]))))"
    );
}

#[test]
fn nested_bracket_commands_read_once() {
    // `[` is a command whose words need no `]` to parse, so a nest of
    // them reads straight through, as bash reads it.
    let nested = format!("{}a{}", "[ $(".repeat(40), ")".repeat(40));
    assert_eq!(parse(nested.as_bytes()).error, None);
}

#[test]
fn backtick_pairs_are_read_once() {
    let line = format!("echo{}", " `date`".repeat(50_000));
    assert_eq!(parse(line.as_bytes()).error, None);
    let lines = "echo a `date` b\n".repeat(50_000);
    assert_eq!(parse(lines.as_bytes()).error, None);
}

#[test]
fn an_empty_regex_comes_before_and_and() {
    assert_eq!(
        read("[[ a =~ && b ]]"),
        "(program (test_command (binary_expression left: (binary_expression left: (word=a) \
         right: (regex=)) right: (word=b))))"
    );
    assert_eq!(
        read("[[ a =~ x.&&y ]]"),
        "(program (test_command (binary_expression left: (binary_expression left: (word=a) \
         right: (regex=x.)) right: (word=y))))"
    );
    read("[[ a =~ || ]]");
    refused("[[ a =~ || b ]]");
    refused("[[ a =~ x&y ]]");
}

#[test]
fn a_conditional_reads_words_and_only_its_own_operators() {
    assert_eq!(
        read("[[ -lt -nt b ]]"),
        "(program (test_command (binary_expression left: (word=-lt) operator: (test_operator=-nt) \
         right: (word=b))))"
    );
    assert_eq!(
        read("[[ ! -- && -n ! ]]"),
        "(program (test_command (binary_expression left: (unary_expression (word=--)) \
         right: (unary_expression operator: (test_operator=-n) (word=!)))))"
    );
    assert_eq!(
        read("[[ ~/x == -1 ]]"),
        "(program (test_command (binary_expression left: (word=~/x) right: (number=-1))))"
    );
    read("[[ -zz = -zz ]]");
    read("[[ a == ! ]]");
    refused("[[ -f = -f ]]");
}

#[test]
fn a_regex_keeps_its_quotes_and_expansions_apart() {
    assert_eq!(
        read("[[ a =~ ^'a'\"$b\"(c d)$ ]]"),
        "(program (test_command (binary_expression left: (word=a) right: (concatenation (regex=^) \
         (raw_string='a') (string (simple_expansion (variable_name=b))) (regex=(c d)$)))))"
    );
    read("[[ a =~ a`echo .`c ]]");
    refused("[[ a =~ ^(a|b$ ]]");
}

#[test]
fn a_dollar_double_paren_substitution_ends_at_the_paren_closing_its_first() {
    refused("echo $((case x in x) echo y;; esac))");
    refused("echo $((echo a #)\n))");
    refused("echo $((echo a # (\n) )");
    read("echo $((echo \"$(echo \")\")\") ) $((echo a)|cat)");
}

#[test]
fn an_extglob_group_takes_blanks_quotes_and_expansions() {
    assert_eq!(
        read("[[ $a == @(x\ny) ]]"),
        "(program (test_command (binary_expression left: (simple_expansion (variable_name=a)) \
         right: (extglob_pattern=@(x\ny)))))"
    );
    assert_eq!(
        read("[[ $a != \"q\"@(x $(echo y)) ]]"),
        "(program (test_command (binary_expression left: (simple_expansion (variable_name=a)) \
         right: (concatenation (string (string_content=q)) (extglob_pattern=@(x ) \
         (command_substitution (command name: (command_name (word=echo)) argument: (word=y))) \
         (extglob_pattern=))))))"
    );
    refused("[[ $a == x(y z) ]]");
    refused("[[ -n @(x\ny) ]]");
}

#[test]
fn a_process_substitution_opening_a_subshell_is_read_when_it_runs() {
    assert_eq!(
        read("cat <((a) b)"),
        "(program (command name: (command_name (word=cat)) argument: (process_substitution (word=(a) b))))"
    );
    refused("cat <((echo a) # )\n)");
    refused("cat <(( $(if) ))");
}

#[test]
fn a_heredoc_pending_across_an_array_is_read_again() {
    // The body read at the array's newline becomes the delimiter of a
    // second read, which ends only at the end of the input; the redirect
    // gets that one...
    let tree = parse(b"cat <<EOF; x=(1\nbody\nEOF\n2)\nfi");
    assert_eq!(tree.source, b"cat <\"fi\n\"; x=(1\n2)\n");
    assert_eq!(
        warned(&tree),
        "bash: line 5: warning: here-document at line 4 delimited by end-of-file (wanted `body\n')\n"
    );
    // ...unless that body was empty.
    assert_eq!(
        lowered("cat <<EOF; x=(1\nEOF\n2)\necho a\n\necho b"),
        (
            "cat <\"echo a\n\"; x=(1\n2)\necho b".into(),
            vec![heredoc("", "echo a\n", true)]
        )
    );
    // An empty delimiter ends the body at the first empty line.
    assert_eq!(
        lowered("cat <<''\n\necho x"),
        ("cat <\"\"\necho x".into(), vec![heredoc("", "", true)])
    );
}

#[test]
fn an_array_element_opens_a_subscript_only_at_its_start() {
    read("a=(\"[\" '[7' \\[ x[)");
    refused("a=(x [)");
    // After a redirect bash reads a first assignment's elements as words
    // that may assign, so `name[` opens one too.
    refused("2>f x=(a[)");
    read("2>f x=($a[)");
    read("2>f x=1 a=(x[)");
}

#[test]
fn heredoc_delimiters_read_as_bash_reads_them() {
    assert_eq!(
        lowered("cat <<$'\\x41'\nb\nA\necho").1,
        vec![heredoc("A", "b\n", true)]
    );
    assert_eq!(
        lowered("cat <<$'\\''\nb\n'\necho").1,
        vec![heredoc("'", "b\n", true)]
    );
    // A substitution's quotes stay in the delimiter and quote nothing.
    let (source, heredocs) = lowered("cat <<$(echo 'a')\n$x\n$(echo 'a')");
    assert_eq!(source, "cat <\"$x\n\"\n");
    assert_eq!(heredocs, vec![heredoc("$(echo 'a')", "$x\n", true)]);
    // A continuation inside the word is gone before the word is read.
    assert_eq!(
        lowered("cat <<$\\\n\"END\"\nx\nEND\n").1,
        vec![heredoc("END", "x\n", true)]
    );
    // A quoted body keeps its continuations, its `$` and backticks
    // escaped in the word it becomes.
    assert_eq!(
        lowered("cat <<'E'; :\na\\\n$x`\nE\necho").0,
        "cat <\"a\\\\\n\\$x\\`\n\"; :\necho"
    );
}

#[test]
fn bash_readings_from_review() {
    assert_eq!(
        read("x=#$y"),
        "(program (variable_assignment name: (variable_name=x) value: (concatenation (word=#) \
         (simple_expansion (variable_name=y)))))"
    );
    read("cat <((echo $'\\''))");
    read("[[ a == @($'\\'') ]]");
    refused("[[ a == \\@(x) ]]");
    refused("for i in a & do :; done");
    refused("select i & do :; done");
    let bangs = format!("{}a", "! ".repeat(200));
    assert_eq!(
        words(&refused(&bangs)),
        "bash: -c: line 1: syntax error: nesting too deep\n"
    );
    // Too deep to read, a loop header is raw text bash reads when it runs.
    let chain = format!("for (({}1;;)); do :; done", "a=".repeat(200));
    assert!(read(&chain).contains("(word=a=a=a="));
}

#[test]
fn a_failed_read_puts_back_every_heredoc_it_took() {
    // The expansion's word fails to parse after reading B's body, and is
    // read raw: A is pending again with its own delimiter.
    let (source, heredocs) =
        lowered("cat <<A; echo ${x:-$(cat <<B\nb\nB\n)(a\na\nA\n|)}\nafter\nA\necho done");
    assert!(source.ends_with("\necho done"), "{source:?}");
    assert_eq!(heredocs, vec![heredoc("A", "after\n", true)]);
}

#[test]
fn an_alias_is_a_command_where_a_reserved_word_would_start() {
    let aliases = [b"fi".to_vec(), b"in".to_vec()];
    let tree = aliased(b"fi; for i in a; do :; done", &aliases);
    assert_eq!(tree.error, None);
    assert!(
        sexp(&tree).starts_with("(program (command name: (command_name (word=fi))) (for_statement"),
        "{}",
        sexp(&tree)
    );
    assert!(parse(b"fi").error.is_some());
}

#[test]
fn words_the_executor_reads_as_words() {
    assert_eq!(
        read("echo ${x:1:2} == =~"),
        "(program (command name: (command_name (word=echo)) argument: (expansion (variable_name=x) \
         (word=1:2)) argument: (word===) argument: (word==~)))"
    );
    assert_eq!(
        read("echo @(a|b) x!(c)"),
        "(program (command name: (command_name (word=echo)) argument: (word=@(a|b)) argument: (word=x!(c))))"
    );
    assert_eq!(
        read("[ a && b ]"),
        "(program (list (command name: (command_name (word=[)) argument: (word=a)) \
         (command name: (command_name (word=b)) argument: (word=]))))"
    );
    assert_eq!(
        read("[[ $x == [a\"$x\"] ]]"),
        "(program (test_command (binary_expression left: (simple_expansion (variable_name=x)) \
         right: (concatenation (extglob_pattern=[a) (string (simple_expansion (variable_name=x))) \
         (extglob_pattern=])))))"
    );
    assert!(read("case $x in [a\"$x\"]) :;; esac").contains(
        "(case_item value: (concatenation (extglob_pattern=[a) (string (simple_expansion (variable_name=x))) \
         (extglob_pattern=]))"
    ));
}

#[test]
fn a_raw_arithmetic_body_keeps_what_bash_expands_first() {
    assert_eq!(
        read("echo $(( $10 + ${x}0 ))"),
        "(program (command name: (command_name (word=echo)) argument: (arithmetic_expansion (concatenation \
         (simple_expansion (variable_name=1)) (word=0 + ) (expansion (variable_name=x)) (word=0)))))"
    );
    assert_eq!(
        read("for (( i=$10; i<${n}0; )) do :; done"),
        "(program (c_style_for_statement initializer: (concatenation (word=i=) (simple_expansion (variable_name=1)) \
         (word=0)) condition: (concatenation (word=i<) (expansion (variable_name=n)) (word=0)) \
         body: (do_group (command name: (command_name (word=:))))))"
    );
    assert_eq!(
        read("echo $(( a # ))"),
        "(program (command name: (command_name (word=echo)) argument: (arithmetic_expansion (word=a #))))"
    );
}

#[test]
fn a_pattern_keeps_the_expansions_in_it() {
    assert_eq!(
        read("[[ a == [b$x] ]]"),
        "(program (test_command (binary_expression left: (word=a) right: (concatenation \
         (extglob_pattern=[b) (simple_expansion (variable_name=x)) (extglob_pattern=])))))"
    );
    assert!(read("case a in *$x) :;; esac").contains(
        "value: (concatenation (extglob_pattern=*) (simple_expansion (variable_name=x)))"
    ));
}

#[test]
fn a_raw_c_style_header_splits_at_its_outer_semicolons() {
    let tree = read("for (( i=${x}0; i<$(echo 11; :); i++ )) do :; done");
    assert!(
        tree.contains("condition: (concatenation (word=i<) (command_substitution"),
        "{tree}"
    );
    assert!(tree.contains("update: (word=i++)"), "{tree}");
    refused("for (( a; b; c; d )) do :; done");
}

#[test]
fn an_in_alias_is_a_command_only_where_one_starts() {
    let aliases = [b"in".to_vec()];
    assert_eq!(
        sexp(&aliased(b"in", &aliases)),
        "(program (command name: (command_name (word=in))))"
    );
    for header in [
        &b"for v in a; do :; done"[..],
        b"case x in x) :;; esac",
        b"select s in; do :; done",
    ] {
        assert_eq!(aliased(header, &aliases).error, None);
    }
}

#[test]
fn tokens_the_executor_reads_by_kind() {
    let kinds = |source: &str| {
        let tree = parse(source.as_bytes());
        tree.nodes
            .iter()
            .map(|node| KINDS[usize::from(node.kind)].0)
            .collect::<Vec<_>>()
    };
    assert!(!kinds("for f do :; done").contains(&"in"));
    assert!(kinds("for f in; do :; done").contains(&"in"));
    assert!(kinds("cat <>f").contains(&"<>"));
}

#[test]
fn heredoc_warnings_name_the_lines_bash_names() {
    // The heredoc is named by the line its body starts after.
    let tree = parse(b"cat <<E \\\nx\nbody");
    assert_eq!(
        warned(&tree),
        "bash: line 3: warning: here-document at line 2 delimited by end-of-file (wanted `E')\n"
    );
    // A substitution closing with a body still to read.
    let tree = parse(b"echo $(cat <<E)\nx\nE\n");
    assert_eq!(
        warned(&tree),
        "bash: line 1: warning: command substitution: 1 unterminated here-document\n"
    );
    let substitution = (0..tree.nodes.len())
        .find(|index| KINDS[usize::from(tree.nodes[*index].kind)].0 == "command_substitution")
        .expect("a substitution");
    assert_eq!(tree.inlined(substitution), b"$(cat <<E\nx\nE\n)");
}

#[test]
fn a_line_nested_past_the_reader_is_refused_at_the_next_opener() {
    let braces = |n: usize| format!("{}a; {}", "{ ".repeat(n), "} ".repeat(n));
    assert_eq!(parse(braces(64).as_bytes()).error, None);
    assert_eq!(
        refused(&braces(65)).lines[0].text,
        b"syntax error near unexpected token `{'"
    );
    let substitutions = format!("echo {}x{}; fi", "$(echo ".repeat(4096), ")".repeat(4096));
    assert_eq!(
        refused(&substitutions).lines[0].text,
        b"syntax error near unexpected token `$('"
    );
    // A `!` chain or quotes nested past what the reader takes are refused,
    // not read on a stack they would overflow.
    let bangs = format!("[[ {}x ]]", "! ".repeat(5000));
    assert_eq!(
        words(&refused(&bangs)),
        "bash: -c: line 1: syntax error: nesting too deep\n"
    );
    let quotes = format!("echo \"{}", "$(\"".repeat(100_000));
    refused(&quotes);
    let expansions = format!("echo {}", "${x:-".repeat(100_000));
    refused(&expansions);
}

#[test]
fn substitutions_nested_in_expansions_are_scanned_once() {
    // Each `${` scans the `$(` inside it; read again at every level, the
    // work doubled per level and a short line ran out of budget.
    for depth in [12, 24] {
        let line = format!(
            "echo {}ok{}",
            "${x:-$(echo ".repeat(depth),
            ")}".repeat(depth)
        );
        assert_eq!(parse(line.as_bytes()).error, None, "{depth}");
    }
}

#[test]
fn only_a_substitution_carries_its_heredoc_bodies_inlined() {
    // Each list around the substitution would copy the whole body again.
    let tree = parse(b"echo $(cat <<E) && true && true\nx\nE\n");
    let carriers: Vec<&str> = (0..tree.nodes.len())
        .filter(|index| !tree.inlined(*index).is_empty())
        .map(|index| KINDS[usize::from(tree.nodes[index].kind)].0)
        .collect();
    assert_eq!(carriers, ["command_substitution"]);
}

#[test]
fn heredocs_read_as_bash_orders_and_keeps_them() {
    let bodies = |source: &[u8]| {
        parse(source)
            .heredocs
            .iter()
            .map(|heredoc| String::from_utf8_lossy(&heredoc.body).into_owned())
            .collect::<Vec<_>>()
    };
    // A quoted body the joined line brings to light keeps its continuation.
    assert_eq!(
        bodies(b"i\\\nf true; then cat <<'E'\na\\\nb\nE\nfi"),
        ["a\\\nb\n"]
    );
    // Siblings hand their heredocs out in the order they close, however
    // deep each sits; a substitution's come before the line's own.
    assert_eq!(
        bodies(b"echo \"$(cat <<A)\" \"$(echo $(cat <<B))\"\na\nA\nb\nB"),
        ["a\n", "b\n"]
    );
    assert_eq!(
        bodies(b"cat <<OUT; echo \"$(cat <<IN)\"\nin\nIN\nout\nOUT"),
        ["out\n", "in\n"]
    );
}

#[test]
fn a_case_pattern_takes_an_extglob_group_only_with_extglob_on() {
    let line = b"case a in @(a)) echo yes;; esac";
    let off = Options {
        extglob: false,
        ..Options::default()
    };
    let refusal = parse_with(line, &off).error.expect("a refusal");
    assert_eq!(
        words(&refusal),
        "bash: -c: line 1: syntax error near unexpected token `('\n\
         bash: -c: line 1: `case a in @(a)) echo yes;; esac'\n"
    );
    assert_eq!(parse(line).error, None);
    assert_eq!(parse_with(b"[[ a == @(a) ]]", &off).error, None);
}

#[test]
fn a_subscript_holds_its_blanks() {
    // bash reads an element's subscript to its `]`, blanks and all, when
    // the element assigns.
    assert_eq!(
        read("a=([x y]=z [k]=v)"),
        "(program (variable_assignment name: (variable_name=a) value: (array \
         (concatenation (word=[) (word=x) (word= ) (word=y) (word=]) (word==z)) \
         (concatenation (word=[) (word=k) (word=]) (word==v)))))"
    );
    assert_eq!(parse(b"a=([$k x]=v)").error, None);
}

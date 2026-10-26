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

#[test]
fn a_redirect_wraps_everything_before_it() {
    assert_eq!(
        read("a && b > f"),
        "(program (redirected_statement body: (list (command name: (command_name (word=a))) \
         (command name: (command_name (word=b)))) redirect: (file_redirect destination: (word=f))))"
    );
    assert_eq!(
        read("echo a > f b"),
        "(program (redirected_statement body: (command name: (command_name (word=echo)) \
         argument: (word=a)) redirect: (file_redirect destination: (word=f) destination: (word=b))))"
    );
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
        (
            String::from_utf8_lossy(&refusal.message).into_owned(),
            refusal.status,
        )
    };
    assert_eq!(refused("if a; then").at, 10);
    assert_eq!(
        said("if a; then"),
        ("mirage: syntax error: unexpected end of file\n".into(), 2)
    );
    assert_eq!(said("echo a; fi").0, "mirage: syntax error near 'fi'\n");
    // A redirect with no word is refused at the newline bash supposes
    // at the end of the input.
    assert_eq!(said("echo >").0, "mirage: syntax error near 'newline'\n");
    // A substitution bash cannot parse is refused with 127, an array
    // with 1, and after an array's refusal bash reads on from the next
    // line.
    assert_eq!(
        said("echo $(fi)"),
        ("mirage: syntax error near 'fi'\n".into(), 127)
    );
    assert_eq!(
        said("x=(1 ;)\necho ${a"),
        (
            "mirage: syntax error near ';'\nmirage: unexpected EOF while looking for matching `}'\n"
                .into(),
            1
        )
    );
    assert_eq!(said("x=1 > f y=(b)").0, "mirage: syntax error near '('\n");
    // `[[` words its own refusals before the text it stopped at.
    assert_eq!(
        said("[[ a -a b ]]").0,
        "mirage: conditional binary operator expected\nmirage: syntax error near '-a'\n"
    );
    assert_eq!(
        said("for ((a b)); do :; done").0,
        "mirage: syntax error: arithmetic expression required\nmirage: syntax error: `((a b))'\n"
    );
    refused("( ! )");
    refused("echo | ! a");
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
        refused(&deep).message,
        b"mirage: syntax error: nesting too deep\n"
    );
    let wide = format!("a{}", " && a".repeat(100_000));
    assert_eq!(parse(wide.as_bytes()).error, None);
}

#[test]
fn backtracking_over_nested_input_is_bounded() {
    let nested = format!("{}a{}", "[ $(".repeat(40), ")".repeat(40));
    let tree = parse(nested.as_bytes());
    assert!(tree.error.is_some());
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
        String::from_utf8_lossy(&tree.warnings()),
        "mirage: line 5: warning: here-document at line 4 delimited by end-of-file (wanted `body\n')\n"
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
        refused(&bangs).message,
        b"mirage: syntax error: nesting too deep\n"
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
        String::from_utf8_lossy(&tree.warnings()),
        "mirage: line 3: warning: here-document at line 2 delimited by end-of-file (wanted `E')\n"
    );
    // A substitution closing with a body still to read.
    let tree = parse(b"echo $(cat <<E)\nx\nE\n");
    assert_eq!(
        String::from_utf8_lossy(&tree.warnings()),
        "mirage: line 1: warning: command substitution: 1 unterminated here-document\n"
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
        refused(&braces(65)).message,
        b"mirage: syntax error near '{'\n"
    );
    let substitutions = format!("echo {}x{}; fi", "$(echo ".repeat(4096), ")".repeat(4096));
    assert_eq!(
        refused(&substitutions).message,
        b"mirage: syntax error near '$('\n"
    );
    // A `!` chain or quotes nested past what the reader takes are refused,
    // not read on a stack they would overflow.
    let bangs = format!("[[ {}x ]]", "! ".repeat(5000));
    assert_eq!(
        refused(&bangs).message,
        b"mirage: syntax error: nesting too deep\n"
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
    assert_eq!(refusal.message, b"mirage: syntax error near '('\n");
    assert_eq!(parse(line).error, None);
    assert_eq!(parse_with(b"[[ a == @(a) ]]", &off).error, None);
}

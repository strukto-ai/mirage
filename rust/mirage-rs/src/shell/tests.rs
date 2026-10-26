use super::{FIELDS, KINDS, Tree, parse};

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

fn refused(source: &str) -> (usize, String) {
    let tree = parse(source.as_bytes());
    assert!(tree.nodes[0].has_error, "{source:?}");
    tree.error.expect("a refusal")
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
fn a_heredoc_body_follows_its_line() {
    assert_eq!(
        read("cat <<EOF | wc\na $x\nEOF\necho"),
        "(program (redirected_statement body: (command name: (command_name (word=cat))) \
         redirect: (heredoc_redirect (heredoc_start=EOF) (pipeline (command name: (command_name (word=wc)))) \
         (heredoc_body (simple_expansion (variable_name=x)) (heredoc_content=)) (heredoc_end=EOF))) \
         (command name: (command_name (word=echo))))"
    );
}

#[test]
fn heredocs_after_a_line_are_read_in_order() {
    let tree = read("cat <<A; cat <<B\na\nA\nb\nB");
    assert!(
        tree.contains("(heredoc_body=a\n) (heredoc_end=A) (heredoc_body=b\n) (heredoc_end=B)"),
        "{tree}"
    );
    // A substitution's heredocs come first.
    let tree = read("cat <<A; echo \"$(cat <<B)\"\nb\nB\na\nA");
    assert!(
        tree.contains("(heredoc_body=b\n) (heredoc_end=B) (heredoc_body=a\n) (heredoc_end=A)"),
        "{tree}"
    );
    // A newline inside a substitution reads only the heredocs opened in it.
    let tree = read("cat <<A; echo $(echo b\necho c)\na\nA");
    assert!(
        tree.ends_with("(heredoc_body=a\n) (heredoc_end=A))"),
        "{tree}"
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
        "(program (command name: (command_name (word=ec\\\nho)) argument: (word=a)))"
    );
    assert_eq!(
        read("echo 'a\\\nb' # c\\\n"),
        "(program (command name: (command_name (word=echo)) argument: (raw_string='a\\\nb')) (comment=# c\\))"
    );
}

#[test]
fn bash_parses_these_only_when_it_runs_them() {
    assert_eq!(
        read("echo $(( a # )) ${x:.2f} `fi`"),
        "(program (command name: (command_name (word=echo)) argument: (arithmetic_expansion (word=a #)) \
         argument: (expansion (word=x:.2f)) argument: (command_substitution (word=fi))))"
    );
    assert_eq!(
        read("[ a"),
        "(program (command name: (command_name (word=[)) argument: (word=a)))"
    );
}

#[test]
fn refusals_are_in_bash_words() {
    assert_eq!(
        refused("if a; then"),
        (10, "syntax error: unexpected end of file".into())
    );
    assert_eq!(
        refused("echo a; fi"),
        (8, "syntax error near unexpected token `fi'".into())
    );
    assert_eq!(
        refused("echo $(fi)").1,
        "syntax error near unexpected token `fi'"
    );
    assert_eq!(
        refused("x=1 > f y=(b)").1,
        "syntax error near unexpected token `('"
    );
    assert!(refused("[[ a -o b ]]").1.contains("conditional"));
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
    let deep = format!("{}a{}", "$(".repeat(5000), ")".repeat(5000));
    assert_eq!(refused(&deep).1, "syntax error: nesting too deep");
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
    // second read, which ends only at the end of the input...
    assert_eq!(
        read("cat <<EOF; x=(1\nbody\nEOF\n2)\nfi"),
        "(program (redirected_statement body: (command name: (command_name (word=cat))) \
         redirect: (heredoc_redirect (heredoc_start=EOF))) (variable_assignment name: (variable_name=x) \
         value: (array (number=1) (number=2))) (heredoc_body=fi))"
    );
    // ...unless that body was empty.
    assert_eq!(
        read("cat <<EOF; x=(1\nEOF\n2)\necho a\n\necho b"),
        "(program (redirected_statement body: (command name: (command_name (word=cat))) \
         redirect: (heredoc_redirect (heredoc_start=EOF))) (variable_assignment name: (variable_name=x) \
         value: (array (number=1) (number=2))) (heredoc_body=echo a\n) (heredoc_end=) \
         (command name: (command_name (word=echo)) argument: (word=b)))"
    );
    // An empty delimiter ends the body at the first empty line.
    assert_eq!(
        read("cat <<''\n\necho x"),
        "(program (redirected_statement body: (command name: (command_name (word=cat))) \
         redirect: (heredoc_redirect (heredoc_start='') (heredoc_body=) (heredoc_end=))) \
         (command name: (command_name (word=echo)) argument: (word=x)))"
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
    assert!(read("cat <<$'\\x41'\nb\nA\necho").contains("(heredoc_end=A)"));
    assert!(read("cat <<$'\\''\nb\n'\necho").contains("(heredoc_end=')"));
    // A substitution's quotes stay in the delimiter and quote nothing.
    let tree = read("cat <<$(echo 'a')\n$x\n$(echo 'a')");
    assert!(tree.contains("(heredoc_body (simple_expansion"), "{tree}");
    // A quoted body keeps its continuations, read after its line too.
    let tree = read("cat <<'E'; :\na\\\nE\necho");
    assert!(
        tree.contains("(heredoc_body=a\\\n) (heredoc_end=E)"),
        "{tree}"
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
    assert_eq!(refused(&bangs).1, "syntax error: nesting too deep");
    // Too deep to read, a loop header is raw text bash reads when it runs.
    let chain = format!("for (({}1;;)); do :; done", "a=".repeat(200));
    assert!(read(&chain).contains("(word=a=a=a="));
}

#[test]
fn a_failed_read_puts_back_every_heredoc_it_took() {
    // The expansion's word fails to parse after reading B's body, and is
    // read raw: A is pending again with its own delimiter.
    let tree = read("cat <<A; echo ${x:-$(cat <<B\nb\nB\n)(a\na\nA\n|)}\nafter\nA\necho done");
    assert!(
        tree.ends_with(
            "(heredoc_body=after\n) (heredoc_end=A) (command name: (command_name (word=echo)) \
             argument: (word=done)))"
        ),
        "{tree}"
    );
}

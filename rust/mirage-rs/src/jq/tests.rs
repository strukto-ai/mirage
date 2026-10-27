use std::collections::HashMap;
use std::sync::Arc;

use super::compile::compile;
use super::eval::{DEBUG, ERROR, HALT, OUTPUT, STDERR};
use super::value::parse_json;
use super::vm::{Limits, Next, Vm};
use crate::Stream;

const LIMITS: Limits = Limits {
    blocks: 1 << 20,
    items: 1 << 24,
    bytes: 1 << 28,
};

#[derive(Debug, PartialEq)]
enum Frame {
    Out(String),
    Err(String),
    Halt(String),
}

fn frames(mut wire: &[u8]) -> Vec<Frame> {
    let mut out = Vec::new();
    while !wire.is_empty() {
        let tag = wire[0];
        let len = u32::from_le_bytes(wire[1..5].try_into().unwrap()) as usize;
        let payload = String::from_utf8_lossy(&wire[5..5 + len]).into_owned();
        if matches!(tag, DEBUG | STDERR) {
            wire = &wire[5 + len..];
            continue;
        }
        out.push(match tag {
            OUTPUT => Frame::Out(payload),
            ERROR => Frame::Err(payload[1..].to_string()),
            HALT => Frame::Halt(payload),
            _ => panic!("unknown frame {tag}"),
        });
        wire = &wire[5 + len..];
    }
    out
}

fn open(program: &str, steps: u64) -> Box<dyn Stream> {
    let config = serde_json::json!({ "program": program, "steps": steps });
    super::eval::open(config.to_string().as_bytes()).expect("compiles")
}

/// Run `program` over `input` with `steps` VM steps per drain.
fn run(program: &str, input: &str, steps: u64) -> Vec<Frame> {
    let mut stream = open(program, steps);
    let mut wire = Vec::new();
    stream.feed(input.as_bytes(), &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    settle(&mut *stream, &mut wire);
    frames(&wire)
}

/// Drain `stream` to the end of its run, answering each `input` with the
/// end of the stream, as for a run over one document.
fn settle(stream: &mut dyn Stream, wire: &mut Vec<u8>) {
    loop {
        while stream.busy() {
            stream.drain(wire).unwrap();
        }
        if stream.request(&mut Vec::new()).is_none() {
            break;
        }
        stream.respond(br#"{"kind":"end"}"#, b"", wire).unwrap();
    }
}

fn outputs(program: &str, input: &str) -> Vec<String> {
    run(program, input, 1 << 16)
        .into_iter()
        .map(|f| match f {
            Frame::Out(text) => text,
            Frame::Err(text) => format!("error: {text}"),
            Frame::Halt(text) => format!("halt: {text}"),
        })
        .collect()
}

/// Outputs jq 1.8.2 printed for each, `jq -c`.
const CASES: &[(&str, &str, &[&str])] = &[
    (".", r#"{"a":1,"b":[2,3]}"#, &[r#"{"a":1,"b":[2,3]}"#]),
    (".a", r#"{"a":7}"#, &["7"]),
    (".[]", "[1,2,3]", &["1", "2", "3"]),
    (
        ".rows[] | .value",
        r#"{"rows":[{"value":1},{"value":2}]}"#,
        &["1", "2"],
    ),
    ("map(.value)", r#"[{"value":1},{"value":2}]"#, &["[1,2]"]),
    ("1, 2", "null", &["1", "2"]),
    ("[.[] | select(. > 1)]", "[1,2,3]", &["[2,3]"]),
    ("[limit(3; range(10))]", "null", &["[0,1,2]"]),
    ("first(range(10; 0; -1))", "null", &["10"]),
    ("[range(5)] | add", "null", &["10"]),
    ("reduce range(5) as $x (0; . + $x)", "null", &["10"]),
    ("[foreach (1,2,3) as $x (0; . + $x)]", "null", &["[1,3,6]"]),
    (
        "[foreach (1,2,3) as $x (0; . + $x; [$x, .])]",
        "null",
        &["[[1,1],[2,3],[3,6]]"],
    ),
    ("until(. >= 5; . + 1)", "0", &["5"]),
    (
        "[recurse(if . < 3 then . + 1 else empty end)]",
        "0",
        &["[0,1,2,3]"],
    ),
    ("def f(g): [g, g]; f(1, 2)", "null", &["[1,2,1,2]"]),
    ("def f($a; $b): $a + $b; f(1; 2)", "null", &["3"]),
    (
        "def fac: if . <= 1 then 1 else . * (. - 1 | fac) end; fac",
        "10",
        &["3628800"],
    ),
    (
        r#""\(1,2) \(3,4)""#,
        "null",
        &[r#""1 3""#, r#""2 3""#, r#""1 4""#, r#""2 4""#],
    ),
    ("{a:1} | .a += (1,2)", "null", &[r#"{"a":2}"#, r#"{"a":3}"#]),
    ("{} | .a.b |= 3", "null", &[r#"{"a":{"b":3}}"#]),
    ("[1,2,3] | .[1:] = [\"x\"]", "null", &["[1,\"x\"]"]),
    (
        r#"[paths]"#,
        r#"{"a":[1,{"b":2}]}"#,
        &[r#"[["a"],["a",0],["a",1],["a",1,"b"]]"#],
    ),
    ("to_entries", r#"{"a":1}"#, &[r#"[{"key":"a","value":1}]"#]),
    (
        "with_entries(.value += 1)",
        r#"{"a":1,"b":2}"#,
        &[r#"{"a":2,"b":3}"#],
    ),
    ("del(.a, .c)", r#"{"a":1,"b":2,"c":3}"#, &[r#"{"b":2}"#]),
    ("[3,1,2] | sort_by(-.)", "null", &["[3,2,1]"]),
    (
        "group_by(.a) | map(length)",
        r#"[{"a":1},{"a":2},{"a":1}]"#,
        &["[2,1]"],
    ),
    ("unique_by(length)", r#"["a","bb","c"]"#, &[r#"["a","bb"]"#]),
    ("try error(\"x\") catch .", "null", &[r#""x""#]),
    (
        "[.[] | try (if . == 2 then error(\"no\") else . end) catch \"caught\"]",
        "[1,2,3]",
        &[r#"[1,"caught",3]"#],
    ),
    ("label $f | 1, break $f, 2", "null", &["1"]),
    ("[.[]?]", "3", &["[]"]),
    (".a // \"d\"", "{}", &[r#""d""#]),
    ("(.a, .b) // 9", r#"{"a":false,"b":2}"#, &["2"]),
    (
        "[1,2] as [$a, $b] | {$a, $b}",
        "null",
        &[r#"{"a":1,"b":2}"#],
    ),
    (
        ". as {a: $x, $b} | [$x, $b]",
        r#"{"a":1,"b":2}"#,
        &["[1,2]"],
    ),
    (
        "[.[] | tostring]",
        r#"[1,"a",[2]]"#,
        &[r#"["1","a","[2]"]"#],
    ),
    (
        "[1.000, 1E2, 1e1000, 0.1 + 0.2, 1e-7]",
        "null",
        &["[1.000,1E+2,1E+1000,0.30000000000000004,1E-7]"],
    ),
    (
        "[1e16 * 10, 0.00001 * 1, 1 / 3]",
        "null",
        &["[1e+17,1e-05,0.3333333333333333]"],
    ),
    ("-1.50", "null", &["-1.50"]),
    (".[1.7], .[-1.2]", "[1,2,3]", &["2", "3"]),
    (".[2:4.5]", "[0,1,2,3,4,5]", &["[2,3,4]"]),
    (".[1:]", r#""abc""#, &[r#""bc""#]),
    ("@base64 \"x\\(1)\"", "null", &[r#""xMQ==""#]),
    ("@csv", r#"[1,"a,b",null]"#, &[r#""1,\"a,b\",""#]),
    ("ascii_downcase", r#""AbC""#, &[r#""abc""#]),
    ("join(\"-\")", r#"["a",1,null]"#, &[r#""a-1-""#]),
    ("[.[] | numbers]", r#"[1,"a",null,2]"#, &["[1,2]"]),
    (
        "tojson, (tojson | fromjson)",
        r#"{"a":[1,2]}"#,
        &[r#""{\"a\":[1,2]}""#, r#"{"a":[1,2]}"#],
    ),
    (
        "walk(if type == \"number\" then . + 1 else . end)",
        r#"[1,{"a":2}]"#,
        &[r#"[2,{"a":3}]"#],
    ),
    (
        "[combinations]",
        "[[1,2],[3,4]]",
        &["[[1,3],[1,4],[2,3],[2,4]]"],
    ),
    ("getpath([\"a\",\"b\"])", "null", &["null"]),
    (
        "[tostream]",
        r#"{"a":[1]}"#,
        &[r#"[[["a",0],1],[["a",0]],[["a"]]]"#],
    ),
    (
        "fromstream(tostream)",
        r#"{"a":[1,{"b":2}]}"#,
        &[r#"{"a":[1,{"b":2}]}"#],
    ),
    ("$__loc__", "null", &[r#"{"file":"<top-level>","line":1}"#]),
    (
        "{a, \"b\": 2, \"c\\(1)\": 3}",
        r#"{"a":1}"#,
        &[r#"{"a":1,"b":2,"c1":3}"#],
    ),
    (
        "[.[] | {(.k): .v}] | add",
        r#"[{"k":"x","v":1},{"k":"y","v":2}]"#,
        &[r#"{"x":1,"y":2}"#],
    ),
    ("[range(0; 10; 3)]", "null", &["[0,3,6,9]"]),
    ("indices(1)", "[0,1,2,1]", &["[1,3]"]),
    ("index(\",\"), rindex(\",\")", r#""a,b,c""#, &["1", "3"]),
    (
        "[.[] | ltrimstr(\"a\")]",
        r#"["ab","b"]"#,
        &[r#"["b","b"]"#],
    ),
    ("map(has(\"a\"))", r#"[{"a":1},{}]"#, &["[true,false]"]),
    ("[.[] | in({\"a\":1})]", r#"["a","b"]"#, &["[true,false]"]),
    ("contains({a:[1]})", r#"{"a":[1,2],"b":3}"#, &["true"]),
    (
        "min_by(.x), max_by(.x)",
        r#"[{"x":2},{"x":1}]"#,
        &[r#"{"x":1}"#, r#"{"x":2}"#],
    ),
    ("flatten", "[1,[2,[3]]]", &["[1,2,3]"]),
    ("transpose", "[[1,2],[3]]", &["[[1,3],[2,null]]"]),
    ("[.[] | floor, sqrt]", "[4.5]", &["[4,2.1213203435596424]"]),
    (
        "pick(.a.b)",
        r#"{"a":{"b":1,"c":2},"d":3}"#,
        &[r#"{"a":{"b":1}}"#],
    ),
    ("any, all", "[true,false]", &["true", "false"]),
    ("isempty(empty), isempty(1)", "null", &["true", "false"]),
    ("[.[] | not]", "[true,null,1]", &["[false,true,false]"]),
    ("to_entries | from_entries", r#"{"a":1}"#, &[r#"{"a":1}"#]),
    (
        "[paths(type == \"number\")]",
        r#"{"a":1,"b":[2]}"#,
        &[r#"[["a"],["b",0]]"#],
    ),
    ("[.[] as [$a] | $a]", "[[1],[2]]", &["[1,2]"]),
    (
        "{} * {a:{b:1}} * {a:{c:2}}",
        "null",
        &[r#"{"a":{"b":1,"c":2}}"#],
    ),
    ("[10 % 3, -10 % 3, 5 % -2]", "null", &["[1,-1,1]"]),
    ("[1,2] - [2], \"x\" * 3", "null", &["[1]", r#""xxx""#]),
    ("tostring", "[3,1]", &[r#""[3,1]""#]),
    (
        "infinite, -infinite, nan | tostring",
        "null",
        &[
            r#""1.7976931348623157e+308""#,
            r#""-1.7976931348623157e+308""#,
            r#""null""#,
        ],
    ),
    ("[nan, 1, null] | sort", "null", &["[null,null,1]"]),
    ("\"\\u007f\\u0001\"", "null", &[r#""\u007f\u0001""#]),
    (".[] as [$a] ?// $a | $a", "[[1],2,[3,4]]", &["1", "2", "3"]),
    (
        "[.[] as [$a, $b] ?// {a: $a} ?// $a | [$a, $b]]",
        r#"[[1,2],{"a":3},4]"#,
        &["[[1,2],[3,null],[4,null]]"],
    ),
    (
        ".[] | . as {$a, b: [$c, {$d}]} ?// [$a, {$b}, $e] ?// $f | [$a, $b, $c, $d, $e, $f]",
        r#"[{"a":1,"b":[2,{"d":3}]},[4,{"b":5,"c":6},7,8,9],"foo"]"#,
        &[
            "[1,null,2,3,null,null]",
            "[4,5,null,null,7,null]",
            r#"[null,null,null,null,null,"foo"]"#,
        ],
    ),
    (
        r#".[] as [$a] ?// $a | if $a == 3 then error("x") else $a end"#,
        "[[3],[4]]",
        &["[3]", "4"],
    ),
    (
        r#"(.[] as [$a] ?// $a | $a) | if . == 3 then error("x") else . end"#,
        "[[3],[4]]",
        &["[3]", "4"],
    ),
    (
        ". as [$a] ?// $a | $a, ($a | error)",
        "[1]",
        &["1", "[1]", "error: [1]"],
    ),
    (
        ".[] as {a:$a} ?// {a:$a} ?// {a:$a} | $a",
        "[[3]]",
        &[r#"error: Cannot index array with string ("a")"#],
    ),
    (
        ". as [$a] ?// [$b] | [$a, $b]",
        "{}",
        &["error: Cannot index object with number (0)"],
    ),
    (
        "reduce .[] as [$a] ?// $a (0; . + $a)",
        "[[3],4,[5]]",
        &["12"],
    ),
    (
        "[foreach .[] as {a:$a} ?// [$a] ?// $a (0; . + $a; [$a, .])]",
        r#"[{"a":1},[2],3]"#,
        &["[[1,1],[2,3],[3,6]]"],
    ),
    (
        r#"[.[] | try (. as [$a] ?// $a | error("e\($a)")) catch .]"#,
        "[[1],2]",
        &[r#"["e[1]","e2"]"#],
    ),
    (
        r#". as [$a] ?// $a | try error("x") catch ."#,
        "[1]",
        &[r#""x""#],
    ),
    ("[. as [$a] ?// $a | ($a, $a + 1)]", "[1]", &["[1,2]"]),
    (
        r#". as [$a] ?// {(reduce (1,2) as $i (""; . + "a")): $x} ?// $x | [$a, $x]"#,
        r#"{"aa":5}"#,
        &[r#"[null,{"aa":5}]"#],
    ),
    (
        r#". as [$a] ?// {("a" + (reduce (1,2) as $i (""; . + "a"))): $x} ?// $x | [$a, $x]"#,
        r#"{"aaa":5}"#,
        &["[null,5]"],
    ),
    (
        ". as [$a] ?// {(last(1,2) | tostring): $x} ?// $x | [$a, $x]",
        r#"{"2":5}"#,
        &["[null,5]"],
    ),
    (
        "[.[] as [$a] ?// $a | . as [$b] ?// $b | [$a, $b]]",
        "[[1],2]",
        &["[[1,[1]],[2,[1]]]"],
    ),
    (
        "[.[] as {$a} ?// [$a] | $a]",
        r#"[{"a":1},[2]]"#,
        &["[1,2]"],
    ),
    (
        r#"[.[] as [$a] ?// $a | first($a, error("x"))]"#,
        "[[1],2]",
        &["[1,2]"],
    ),
    (
        "[label $out | .[] as [$a] ?// $a | if $a == 2 then break $out else $a end]",
        "[[1],2,3]",
        &["[1]"],
    ),
    (
        "[.[] | . as [$a] ?// $b | [$a, $b]]",
        "[[1],2]",
        &["[[1,null],[null,2]]"],
    ),
    (
        r#"(try (. as [$a] ?// $a | $a)) | if . == 1 then error("x") else . end"#,
        "[1]",
        &["[1]"],
    ),
    (
        r#"[.[] as [$a] ?// $a | [range($a; 3)]]"#,
        "[[1],0]",
        &["[[1,2],[0,1,2]]"],
    ),
    (
        r#"[match("(a)|b"; "g") | .captures]"#,
        r#""ab""#,
        &[
            r#"[[{"offset":0,"length":1,"string":"a","name":null}],[{"offset":-1,"string":null,"length":0,"name":null}]]"#,
        ],
    ),
    (
        r#"capture("(?<y>\\d{4})-(?<m>\\d{2})")"#,
        r#""2023-01""#,
        &[r#"{"y":"2023","m":"01"}"#],
    ),
    (
        r#"[match("."; "g") | [.offset, .length]]"#,
        r#""x😀é""#,
        &[r#"[[0,1],[1,1],[2,1]]"#],
    ),
    (
        r#"[match("^|."; "g") | [.offset, .length, .string]]"#,
        r#""éa""#,
        &[r#"[[0,0,""],[0,1,"�"],[1,1,"a"]]"#],
    ),
    (
        r#"[match(""; "g") | .offset]"#,
        r#""éé""#,
        &[r#"[0,1,1,2,2]"#],
    ),
    (
        r#"gsub("(?<x>[A-Z])"; "_\(.x | ascii_downcase)")"#,
        r#""CamelCaseString""#,
        &[r#""_camel_case_string""#],
    ),
    (
        r#"[splits(", *"; null)]"#,
        r#""a, b,c""#,
        &[r#"["a","b","c"]"#],
    ),
    (r#"[scan("b+"; "i")]"#, r#""abBbcB""#, &[r#"["bBb","B"]"#]),
    (
        r#"[match("ab|abcd"; "gl") | .string]"#,
        r#""abcd ab abcd""#,
        &[r#"["abcd","abcd"]"#],
    ),
    (
        r#"[match("b*"; "gn") | .offset]"#,
        r#""abbcb""#,
        &[r#"[1,4]"#],
    ),
    (
        r#"[match("(?<=a+)b"; "g") | .offset]"#,
        r#""aab b ab""#,
        &[r#"[2,7]"#],
    ),
    (
        r#"[match("(?i)k"; "g") | .string]"#,
        r#""kKK""#,
        &["[\"k\",\"K\",\"\u{212a}\"]"],
    ),
    (
        r#"[match("(?:()|())*\\1\\2") | .captures[] | .offset]"#,
        r#""""#,
        &[r#"[0,0]"#],
    ),
    (
        r#"[match("\\bbar\\b|o\\B"; "g") | .offset]"#,
        r#""foo bar""#,
        &[r#"[1,4]"#],
    ),
    (
        r#"[match("$"; "g") | .offset], [match("(?m)^"; "g") | .offset]"#,
        r#""a\nb\n""#,
        &[r#"[3,4]"#, r#"[0,2]"#],
    ),
    (
        r#"try test("(") catch ."#,
        r#""x""#,
        &[r#""Regex failure: end pattern with unmatched parenthesis""#],
    ),
    (
        r#"try test("a"; "gq") catch ."#,
        r#""x""#,
        &[r#""gq is not a valid modifier string""#],
    ),
    (
        r#"try (1 | test("a")) catch ."#,
        "null",
        &[r#""number (1) cannot be matched, as it is not a string""#],
    ),
    (
        r#"try test("a"; 1) catch ."#,
        r#""x""#,
        &[r#""number (1) is not a string""#],
    ),
    (
        r#"try test("(?<=a|bc)b") catch ."#,
        r#""x""#,
        &[r#""Regex failure: invalid pattern in look-behind""#],
    ),
];

#[test]
fn programs_match_jq() {
    let mut failures = Vec::new();
    for (program, input, expected) in CASES {
        let got = outputs(program, input);
        if got != *expected {
            failures.push(format!(
                "{program} on {input}: got {got:?}, want {expected:?}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_budget_gives_the_same_frames() {
    for (program, input, _) in CASES {
        let whole = run(program, input, 1 << 16);
        for steps in [1, 7, 128] {
            assert_eq!(
                run(program, input, steps),
                whole,
                "{program} at {steps} steps"
            );
        }
    }
}

/// Exponential backtracking stops at Oniguruma's retry limit, as jq's
/// does, and the search behind it pauses at every drain on the way.
#[test]
fn a_runaway_regex_pauses_every_drain_until_the_retry_limit() {
    let mut stream = open(r#"test("^(a+)+$")"#, 1 << 16);
    let mut wire = Vec::new();
    stream
        .feed(format!("\"{}!\"", "a".repeat(30)).as_bytes(), &mut wire)
        .unwrap();
    stream.finish(&mut wire).unwrap();
    let mut drains = 0;
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
        drains += 1;
    }
    assert!(drains > 100, "{drains} drains");
    assert_eq!(
        frames(&wire),
        vec![Frame::Err(
            "Regex failure: retry-limit-in-match over".into()
        )]
    );
}

#[test]
fn errors_end_the_run_with_jq_wording() {
    let cases: &[(&str, &str, &str)] = &[
        (".a", "3", r#"Cannot index number with string ("a")"#),
        (".[0]", r#""x""#, "Cannot index string with number (0)"),
        (".[]", "3", "Cannot iterate over number (3)"),
        (
            "{} | has(1)",
            "null",
            "Cannot check whether object has a number key",
        ),
        (
            "1 / 0",
            "null",
            "number (1) and number (0) cannot be divided because the divisor is zero",
        ),
        (
            "{} + 1",
            "null",
            "object ({}) and number (1) cannot be added",
        ),
        (
            "[1,[2]] | implode",
            "null",
            "array ([2]) can't be imploded, unicode codepoint needs to be numeric",
        ),
        ("error", r#"{"a":1}"#, r#"{"a":1}"#),
        (
            ".[\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"]",
            "[]",
            r#"Cannot index array with string ("aaaaaaaaaaaaaaaaaaaaaaaa...")"#,
        ),
    ];
    for (program, input, message) in cases {
        let got = run(program, input, 1 << 16);
        assert_eq!(
            got.last(),
            Some(&Frame::Err(message.to_string())),
            "{program}"
        );
    }
}

#[test]
fn halt_error_reports_its_message_and_code() {
    assert_eq!(
        run("\"bye\\n\" | halt_error(3)", "null", 64),
        vec![Frame::Halt(
            r#"{"code":3.0,"message":"bye\n","string":true}"#.into()
        )]
    );
    assert_eq!(
        run("1, halt, 2", "null", 64),
        vec![
            Frame::Out("1".into()),
            Frame::Halt(r#"{"code":null,"message":null,"string":false}"#.into())
        ]
    );
}

#[test]
fn runaway_programs_pause_every_drain_and_hold_little_stack() {
    for program in [
        "until(false; .)",
        "def f: f; f",
        "repeat(empty)",
        "last(range(1e18))",
    ] {
        let program = Arc::new(compile(program, &HashMap::new()).unwrap());
        let mut vm = Vm::start(Arc::clone(&program), parse_json("0").unwrap(), LIMITS);
        for round in 1..=100u64 {
            let mut budget = 1000;
            assert!(matches!(vm.next(&mut budget), Next::Paused));
            assert_eq!(vm.steps, round * 1000);
            assert!(vm.blocks() < 32, "{} blocks", vm.blocks());
        }
    }
}

#[test]
fn cancel_retires_the_stack_in_bounded_slices() {
    let mut stream = open("def f: [f]; f", 1 << 16);
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    for _ in 0..8 {
        stream.drain(&mut wire).unwrap();
    }
    assert!(stream.busy());
    assert!(stream.cancel());
    let mut drains = 0;
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
        drains += 1;
    }
    assert!(drains > 1, "retired in {drains} drains");
    assert!(wire.is_empty());
    stream.begin(b"{}").unwrap();
    stream.feed(b"41", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    drop(stream);
}

#[test]
fn a_block_cap_ends_unbounded_recursion() {
    let config = serde_json::json!({ "program": "def f: [f]; f", "blocks": 100_000 });
    let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert_eq!(
        frames(&wire),
        vec![Frame::Err(
            "jq stack limit of 100000 blocks exceeded".into()
        )]
    );
}

#[test]
fn an_array_cap_ends_unbounded_collection() {
    let config = serde_json::json!({ "program": "[range(1e9)]", "items": 1000 });
    let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert_eq!(
        frames(&wire),
        vec![Frame::Err(
            "jq array limit of 1000 elements exceeded".into()
        )]
    );
}

#[test]
fn deep_values_drop_and_print_without_recursion() {
    let got = run(
        "reduce range(1000000) as $i (null; [.]) | tojson | length",
        "null",
        1 << 16,
    );
    assert_eq!(
        got,
        vec![Frame::Out("20021".into())],
        "jq prints <skipped: too deep> past 10000"
    );
}

#[test]
fn unsupported_builtins_refuse_to_compile() {
    for program in ["builtins", "modulemeta", "@base32", "@urid"] {
        assert!(compile(program, &HashMap::new()).is_err(), "{program}");
    }
}

#[test]
fn named_arguments_and_args_bind_as_constants() {
    let config = serde_json::json!({
        "program": "[$x, $ARGS.named.x]",
        "named": { "x": "\"v\"" },
        "args": r#"{"positional":[],"named":{"x":"v"}}"#,
    });
    let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert_eq!(frames(&wire), vec![Frame::Out(r#"["v","v"]"#.into())]);
}

/// Cases whose output differs from jq 1.8.2's, each with the reason.
const DIVERGENT: &[(&str, &str)] = &[
    (
        ".[] | try (fromjson | isnan) catch .",
        "fromjson words its parse errors its own way, not as jv_parse does",
    ),
    (
        "try fromjson catch .",
        "fromjson words its parse errors its own way, not as jv_parse does",
    ),
];

/// jq 1.8.2's tests/jq.test, each case's outputs as a jq 1.8.2 binary
/// printed them (scripts/gen_jq_corpus.py), at a budget that pauses the
/// VM every few steps. A case may be refused at compile, which sends the
/// program to libjq; any other difference fails unless DIVERGENT names it.
#[test]
fn jq_test_corpus() {
    let (pass, refused) = run_corpus(include_str!("corpus.json"));
    assert!(
        pass >= 506 && refused <= 13,
        "pass {pass}, refused {refused}"
    );
}

/// jq 1.8.2's tests/onig.test, its regex cases, run as the corpus above.
#[test]
fn onig_test_corpus() {
    let (pass, refused) = run_corpus(include_str!("onig.json"));
    assert!(pass >= 47 && refused == 0, "pass {pass}, refused {refused}");
}

/// Runs a corpus: how many cases passed and how many were refused.
fn run_corpus(corpus: &str) -> (usize, usize) {
    let cases: Vec<serde_json::Value> = serde_json::from_str(corpus).unwrap();
    let (mut pass, mut refused, mut mismatch) = (0, 0, Vec::new());
    for case in &cases {
        let program = case["program"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        if parse_json(input).is_err() {
            continue;
        }
        let config = serde_json::json!({
            "program": program,
            "steps": 7,
            "now": 0,
            "zone": "UTC",
        });
        let Ok(mut stream) = super::eval::open(config.to_string().as_bytes()) else {
            refused += 1;
            continue;
        };
        let mut wire = Vec::new();
        stream.feed(input.as_bytes(), &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        settle(&mut *stream, &mut wire);
        let (mut got, mut error) = (Vec::new(), None);
        for f in frames(&wire) {
            match f {
                Frame::Out(text) => got.push(text),
                Frame::Err(text) => error = Some(text),
                Frame::Halt(_) => {}
            }
        }
        let want: Vec<String> = case["outputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let want_error = case["stderr"].as_str().unwrap().lines().find_map(|l| {
            let (_, rest) = l.strip_prefix("jq: error (at <stdin>:")?.split_once(')')?;
            rest.strip_prefix(": ")
                .or_else(|| rest.strip_prefix(" (not a string): "))
                .map(str::to_string)
        });
        if got == want && error == want_error {
            pass += 1;
        } else if !DIVERGENT.iter().any(|(p, _)| *p == program) {
            mismatch.push(format!(
                "{program}\n  got  {got:?} {error:?}\n  want {want:?} {want_error:?}"
            ));
        }
    }
    assert!(mismatch.is_empty(), "{}", mismatch.join("\n"));
    (pass, refused)
}

#[test]
fn numbers_strings_and_parsing_match_jq() {
    let cases: &[(&str, &str, &[&str])] = &[
        (
            "[13911860366432393] == [13911860366432392]",
            "null",
            &["false"],
        ),
        (
            "[13911860366432393] < [13911860366432392], [13911860366432392] < [13911860366432393], [100000000000000000001] < [1E20]",
            "null",
            &["false", "true", "false"],
        ),
        ("[-1e-400, -0.0, -0]", "null", &["[-1E-400,0.0,0]"]),
        (
            "ldexp(0.5; 1024), ldexp(1; -1074)",
            "null",
            &["8.98846567431158e+307", "5e-324"],
        ),
        (
            r#""aaaa" | indices("aa"), ("aéaéa" | indices("a"))"#,
            "null",
            &["[0,1,2]", "[0,2,4]"],
        ),
        (
            "reduce range(600) as $_ ([]; [.]) as $x | $x | contains($x)",
            "null",
            &["true"],
        ),
        (
            r#""{\"a\":1,}", "[1,]", "\"\\ud800x\"", "\"a\tb\"" | try fromjson catch ."#,
            "null",
            &[
                r#""Expected another key-value pair at line 1, column 8 (while parsing '{\"a\":1,}')""#,
                r#""Expected another array element at line 1, column 4 (while parsing '[1,]')""#,
                r#""Invalid \\uXXXX\\uXXXX surrogate pair escape at line 1, column 9 (while parsing '\"\\ud800x\"')""#,
                r#""Invalid string: control characters from U+0000 through U+001F must be escaped at line 1, column 5 (while parsing '\"a\tb\"')""#,
            ],
        ),
        (
            r#""\"\\udc00\"" | fromjson | explode"#,
            "null",
            &["[65533]"],
        ),
        (". # c \\\n| . + 1", "1", &["1"]),
        (". # c \\\\\n| . + 1", "1", &["2"]),
    ];
    for (program, input, expected) in cases {
        assert_eq!(outputs(program, input), *expected, "{program}");
    }
}

#[test]
fn constant_folding_builds_no_large_string() {
    let got = run(r#""abc" * 1000000000"#, "null", 1 << 16);
    assert_eq!(
        got,
        vec![Frame::Err("Repeat string result too long".into())]
    );
}

#[test]
fn growing_arrays_respect_the_element_cap() {
    for program in [
        ".[100000] = 0",
        r#""a" * 2000 | explode"#,
        r#""a" * 2000 | split("")"#,
    ] {
        let config = serde_json::json!({ "program": program, "items": 1000 });
        let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
        let mut wire = Vec::new();
        stream.feed(b"[]", &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
        }
        assert_eq!(
            frames(&wire),
            vec![Frame::Err(
                "jq array limit of 1000 elements exceeded".into()
            )],
            "{program}"
        );
    }
}

#[test]
fn a_format_named_at_run_time_falls_back() {
    let globals = HashMap::from([("f".to_string(), parse_json("\"urid\"").unwrap())]);
    assert!(compile("format($f)", &globals).is_err());
    assert!(compile("@text, @base64d", &HashMap::new()).is_ok());
}

#[test]
fn cancel_frees_a_deep_value_across_drains() {
    let mut stream = open(
        "reduce range(200000) as $i (null; [.]) | until(false; .)",
        1 << 16,
    );
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    for _ in 0..40 {
        stream.drain(&mut wire).unwrap();
    }
    assert!(stream.cancel());
    let mut drains = 0;
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
        drains += 1;
    }
    assert!(drains >= 10, "freed in {drains} drains");
}

const TIME_CASES: &[(&str, &str, &str)] = &[
    (r"UTC", r"-1.5|gmtime", r"[1969,11,31,23,59,59.5,3,364]"),
    (r"UTC", r"nan|gmtime", r"[1970,0,1,0,0,null,4,0]"),
    (r"UTC", r"1e12|gmtime", r"[33658,8,27,1,46,40,5,269]"),
    (
        r"UTC",
        r"1e17|gmtime",
        r"!error converting number of seconds since epoch to datetime",
    ),
    (
        r"UTC",
        r#""a"|gmtime"#,
        r"!gmtime() requires numeric inputs",
    ),
    (
        r"UTC",
        r"1425599507.25|gmtime",
        r"[2015,2,5,23,51,47.25,4,63]",
    ),
    (r"UTC", r"[2024,12,32,25,61,61]|mktime", r"1738461721"),
    (r"UTC", r"[2024,-1,0,-1,-1,-1]|mktime", r"1701298739"),
    (
        r"UTC",
        r"[1970,0,1,0,0,-1.9]|mktime",
        r"!invalid gmtime representation",
    ),
    (
        r"UTC",
        r"[1969,11,31,23,59,58]|mktime",
        r"!mktime not supported on this platform",
    ),
    (
        r"UTC",
        r#"[1970,0,1,0,0,0,"x"]|mktime"#,
        r"!mktime requires parsed datetime inputs",
    ),
    (r"UTC", r"1|mktime", r"!mktime requires array inputs"),
    (r"UTC", r#"[1970,0,1,0,0,1,2,3,4,"x"]|mktime"#, r"1"),
    (r"UTC", r"[1970,0]|mktime", r"-86400"),
    (r"UTC", r"[100000,0,1]|mktime", r"3093527980800"),
    (
        r"UTC",
        r#"[2024,12,32,25,61,61]|strftime("%c")"#,
        r#""Sun Feb  2 02:02:01 2025""#,
    ),
    (
        r"UTC",
        r#"[2024,1,29,0,0,0,9,999]|strftime("%a %j")"#,
        r#""Thu 060""#,
    ),
    (
        r"UTC",
        r#"1425599507|strftime("%a %A %b %B %c %C %d %D %e %F %g %G")"#,
        r#""Thu Thursday Mar March Thu Mar  5 23:51:47 2015 20 05 03/05/15  5 2015-03-05 15 2015""#,
    ),
    (
        r"UTC",
        r#"1425599507|strftime("%h %H %I %j %k %l %m %M %p %r %R %s %S %T")"#,
        r#""Mar 23 11 064 23 11 03 51 PM 11:51:47 PM 23:51 1425599507 47 23:51:47""#,
    ),
    (
        r"UTC",
        r#"1425599507|strftime("%u %U %V %v %w %W %x %X %y %Y %z %Z %% %+")"#,
        r#""4 09 10  5-Mar-2015 4 09 03/05/15 23:51:47 15 2015 +0000 UTC % Thu Mar  5 23:51:47 UTC 2015""#,
    ),
    (
        r"UTC",
        r#"[1970,0,3,4,5,6]|strftime("%-e|%_e|%0e|%-k|%0k|%_k|%0l|%-l|%_l|%_I|%-I|%_S|%-S|%_U|%-V|%-j|%_j|%0j|%-m|%_M|%-s|%-D|%-p|%-P|%-z|%-Z")"#,
        r#""3| 3|03|4|04| 4|04|4| 4| 4|4| 6|6| 0|1|3|  3|003|1| 5|187506|01/03/70|AM|P|+0|UTC""#,
    ),
    (
        r"UTC",
        r#"[2005,0,1,1,2,3]|strftime("%-y|%_y|%-C|%0C|%-Y|%_Y|%0y|%0u|%-u")"#,
        r#""05|05|20|20|2005|2005|05|6|6""#,
    ),
    (
        r"UTC",
        r#"[1970,0,3,4,5,6]|strftime("%E|%O|%Ez|%EY|%Od|%EE|%E%E|%-|%_|%")"#,
        r#""||+0000|1970|03|E|%E|||%""#,
    ),
    (
        r"UTC",
        r#"[1970,0,3,4,5,6]|strftime("%f%q%i%o|%3d|%10Y|%^a|%#a|%_10d|%010Y|é%Y|%é")"#,
        r#""fqio|3d|10Y|^a|#a|10d|10Y|é1970|é""#,
    ),
    (
        r"UTC",
        r#"[2020,11,31,4,5,6]|strftime("%G %g %V %U %W %u %w %j")"#,
        r#""2020 20 53 52 52 4 4 366""#,
    ),
    (
        r"UTC",
        r#"[2021,0,1,4,5,6]|strftime("%G %g %V %U %W %u %w %j")"#,
        r#""2020 20 53 00 00 5 5 001""#,
    ),
    (
        r"UTC",
        r#"[2021,0,3,4,5,6]|strftime("%G %g %V %U %W %u %w %j")"#,
        r#""2020 20 53 01 00 7 0 003""#,
    ),
    (
        r"UTC",
        r#"[2019,11,30,4,5,6]|strftime("%G %g %V %U %W %u %w %j %C %y")"#,
        r#""2020 20 01 52 52 1 1 364 20 19""#,
    ),
    (
        r"UTC",
        r#"[12345,0,1,0,0,0]|strftime("%Y %C %y %G %g %F")"#,
        r#""12345 123 45 12345 45 12345-01-01""#,
    ),
    (
        r"UTC",
        r#"[1970,0,1,0,0,0]|strftime("%I %l %p %r %k")"#,
        r#""12 12 AM 12:00:00 AM  0""#,
    ),
    (
        r"UTC",
        r#"[1970,0,1,12,0,0]|strftime("%I %l %p %r %k")"#,
        r#""12 12 PM 12:00:00 PM 12""#,
    ),
    (
        r"UTC",
        r#"[1970,0,1,13,0,0]|strftime("%I %l %p %r %k")"#,
        r#""01  1 PM 01:00:00 PM 13""#,
    ),
    (
        r"UTC",
        r#"[1970,0,1,23,59,60]|strftime("%I %l %p %r %k %S %s")"#,
        r#""12 12 AM 12:00:00 AM  0 00 86400""#,
    ),
    (r"UTC", r#"[1970,0,1,0,0,0]|strftime("")"#, r#""""#),
    (r"UTC", r#"[1970,0,1,0,0,0]|strftime("a\u0000b")"#, r#""a""#),
    (
        r"UTC",
        r#"[1970,0,1,0,0,0]|strftime("%A%A%A%A%A%A%A%A%A%A%A%A%A%A%A%A%A%A")"#,
        r"!strftime/1: unknown system failure",
    ),
    (
        r"UTC",
        r#"[1970,0,1,0,0,0]|strftime("%c%c%c%c")"#,
        r#""Thu Jan  1 00:00:00 1970Thu Jan  1 00:00:00 1970Thu Jan  1 00:00:00 1970Thu Jan  1 00:00:00 1970""#,
    ),
    (
        r"UTC",
        r#"[1970,0,1,0,0,0]|strftime("%c%c%c%c%c")"#,
        r"!strftime/1: unknown system failure",
    ),
    (
        r"UTC",
        r#""x"|strftime("%Y")"#,
        r"!strftime/1 requires parsed datetime inputs",
    ),
    (
        r"UTC",
        r"[1970]|strftime(1)",
        r"!strftime/1 requires a string format",
    ),
    (
        r"UTC",
        r"1|strftime(null)",
        r"!strftime/1 requires a string format",
    ),
    (
        r"UTC",
        r#"[1970,0,1,0,0,0,"x"]|strftime("%Y")"#,
        r"!strftime/1 requires parsed datetime inputs",
    ),
    (r"UTC", r#"[]|strftime("%Y-%m")|length"#, r"7"),
    (
        r"UTC",
        r#""x"|strptime(1)"#,
        r"!strptime/1 requires string inputs and arguments",
    ),
    (
        r"UTC",
        r#"1|strptime("x")"#,
        r"!strptime/1 requires string inputs and arguments",
    ),
    (
        r"UTC",
        r#""x"|fromdate"#,
        r#"!date "x" does not match format "%Y-%m-%dT%H:%M:%SZ""#,
    ),
    (r"UTC", r#""2015-03-05T23:51:47Z"|fromdate"#, r"1425599507"),
    (r"UTC", r"1425599507.9|todate", r#""2015-03-05T23:51:47Z""#),
    (r"UTC", r"-1.5|todate", r#""1969-12-31T23:59:59Z""#),
    (
        r"UTC",
        r#""1969-12-31T23:59:59Z"|fromdate"#,
        r"!invalid gmtime representation",
    ),
    (
        r"UTC",
        r#""1969-12-31T23:59:58Z"|fromdate"#,
        r"!mktime not supported on this platform",
    ),
    (
        r"UTC",
        r#""2015-03-05T23:51:47Z"|strptime("%Y-%m-%dT%H:%M:%SZ")"#,
        r"[2015,2,5,23,51,47,4,63]",
    ),
    (
        r"UTC",
        r#""Thursday, March 05, 2015"|strptime("%A, %B %d, %Y")"#,
        r"[2015,2,5,0,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""thu, mar 5, 2015"|strptime("%a, %b %e, %Y")"#,
        r"[2015,2,5,0,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""10:20"|strptime("%H:%M")"#,
        r"[1900,0,0,10,20,0,6,-1]",
    ),
    (
        r"UTC",
        r#""03/05/15"|strptime("%D")"#,
        r"[2015,2,5,0,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""Thu Mar  5 23:51:47 2015"|strptime("%c")"#,
        r"[2015,2,5,23,51,47,4,63]",
    ),
    (
        r"UTC",
        r#""11:51:47 PM"|strptime("%r")"#,
        r"[1900,0,0,23,51,47,6,-1]",
    ),
    (
        r"UTC",
        r#""12 AM"|strptime("%I %p")"#,
        r"[1900,0,0,0,0,0,6,-1]",
    ),
    (
        r"UTC",
        r#""12 PM"|strptime("%I %p")"#,
        r"[1900,0,0,12,0,0,6,-1]",
    ),
    (
        r"UTC",
        r#""22 PM"|strptime("%H %p")"#,
        r#"!date "22 PM" does not match format "%H %p""#,
    ),
    (r"UTC", r#""68"|strptime("%y")"#, r"[2068,0,0,0,0,0,6,-1]"),
    (r"UTC", r#""69"|strptime("%y")"#, r"[1969,0,0,0,0,0,2,-1]"),
    (
        r"UTC",
        r#""19 15"|strptime("%C %y")"#,
        r"[1915,0,0,0,0,0,4,-1]",
    ),
    (
        r"UTC",
        r#""2015 064"|strptime("%Y %j")"#,
        r"[2015,2,5,0,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""2015 366"|strptime("%Y %j")"#,
        r"[2016,0,1,0,0,0,5,0]",
    ),
    (
        r"UTC",
        r#""2015 000"|strptime("%Y %j")"#,
        r#"!date "2015 000" does not match format "%Y %j""#,
    ),
    (
        r"UTC",
        r#""1425599507"|strptime("%s")"#,
        r"[2015,2,5,23,51,47,4,63]",
    ),
    (
        r"UTC",
        r#""-5"|strptime("%s")"#,
        r"[1969,11,31,23,59,55,3,364]",
    ),
    (
        r"UTC",
        r#""2015-03-05T23:51:47+0100"|strptime("%Y-%m-%dT%H:%M:%S%z")"#,
        r"[2015,2,5,22,51,47,4,63]",
    ),
    (
        r"UTC",
        r#""2015-03-05T23:51:47-0530"|strptime("%Y-%m-%dT%H:%M:%S%z")"#,
        r"[2015,2,6,5,21,47,5,64]",
    ),
    (
        r"UTC",
        r#""2015-03-05T23:51:47+01:00"|strptime("%Y-%m-%dT%H:%M:%S%z")"#,
        r#"!date "2015-03-05T23:51:47+01:00" does not match format "%Y-%m-%dT%H:%M:%S%z""#,
    ),
    (
        r"UTC",
        r#""2015-03-05T23:51:47 UTC"|strptime("%Y-%m-%dT%H:%M:%S %Z")"#,
        r"[2015,2,5,23,51,47,4,63]",
    ),
    (
        r"UTC",
        r#""2015-03-05T23:51:47 PST"|strptime("%Y-%m-%dT%H:%M:%S %Z")"#,
        r#"!date "2015-03-05T23:51:47 PST" does not match format "%Y-%m-%dT%H:%M:%S %Z""#,
    ),
    (
        r"UTC",
        r#""2015-03-05 extra"|strptime("%Y-%m-%d")"#,
        r#"[2015,2,5,0,0,0,4,63," extra"]"#,
    ),
    (
        r"UTC",
        r#""2015-03-05   "|strptime("%Y-%m-%d")"#,
        r#"[2015,2,5,0,0,0,4,63,"   "]"#,
    ),
    (
        r"UTC",
        r#""2015-03-05x"|strptime("%Y-%m-%d")"#,
        r#"!date "2015-03-05x" does not match format "%Y-%m-%d""#,
    ),
    (
        r"UTC",
        r#""  2015-03-05"|strptime("%Y-%m-%d")"#,
        r#"!date "  2015-03-05" does not match format "%Y-%m-%d""#,
    ),
    (
        r"UTC",
        r#""2015-3-5T3:5:7Z"|strptime("%Y-%m-%dT%H:%M:%SZ")"#,
        r"[2015,2,5,3,5,7,4,63]",
    ),
    (
        r"UTC",
        r#""20150305"|strptime("%Y%m%d")"#,
        r"[2015,2,5,0,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""201503051"|strptime("%Y%m%d%H")"#,
        r"[2015,2,5,1,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""99999"|strptime("%Y")"#,
        r#"!date "99999" does not match format "%Y""#,
    ),
    (r"UTC", r#""-123"|strptime("%Y")"#, r"[-123,0,0,0,0,0,6,-1]"),
    (r"UTC", r#""+5"|strptime("%Y")"#, r"[5,0,0,0,0,0,5,-1]"),
    (r"UTC", r#"""|strptime("%Y")"#, r"[1900,0,0,0,0,0,6,-1]"),
    (
        r"UTC",
        r#""Sept"|strptime("%b")"#,
        r#"!date "Sept" does not match format "%b""#,
    ),
    (r"UTC", r#""Sep"|strptime("%b")"#, r"[1900,8,0,0,0,0,5,242]"),
    (
        r"UTC",
        r#""JANUARY"|strptime("%B")"#,
        r"[1900,0,0,0,0,0,6,-1]",
    ),
    (
        r"UTC",
        r#""a b"|strptime("ab")"#,
        r#"!date "a b" does not match format "ab""#,
    ),
    (r"UTC", r#""ab"|strptime("a b")"#, r"[1900,0,0,0,0,0,6,-1]"),
    (
        r"UTC",
        r#""2015-03-05"|strptime("%Y-%m-%d%n")"#,
        r#"!date "2015-03-05" does not match format "%Y-%m-%d%n""#,
    ),
    (
        r"UTC",
        r#""5"|strptime("5%")"#,
        r#"!date "5" does not match format "5%""#,
    ),
    (
        r"UTC",
        r#""5"|strptime("%q")"#,
        r#"!date "5" does not match format "%q""#,
    ),
    (r"UTC", r#""5"|strptime("%Ey")"#, r"[2005,0,0,0,0,0,5,-1]"),
    (
        r"UTC",
        r#""2015-02-30"|strptime("%Y-%m-%d")"#,
        r"[2015,1,30,0,0,0,1,60]",
    ),
    (
        r"UTC",
        r#""2015-13-01"|strptime("%Y-%m-%d")"#,
        r#"!date "2015-13-01" does not match format "%Y-%m-%d""#,
    ),
    (
        r"UTC",
        r#""1900-03-01"|strptime("%Y-%m-%d")"#,
        r"[1900,2,1,0,0,0,4,59]",
    ),
    (
        r"UTC",
        r#""1900-01-01"|strptime("%Y-%m-%d")"#,
        r"[1900,0,1,0,0,0,0,0]",
    ),
    (
        r"UTC",
        r#""0000-01-01"|strptime("%Y-%m-%d")"#,
        r"[0,0,1,0,0,0,6,0]",
    ),
    (
        r"UTC",
        r#""Sun 2015-03-05"|strptime("%a %Y-%m-%d")"#,
        r"[2015,2,5,0,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""2015 10 4"|strptime("%Y %U %w")"#,
        r"[2015,2,12,0,0,0,4,70]",
    ),
    (
        r"UTC",
        r#""2015 10 1"|strptime("%Y %W %w")"#,
        r"[2015,2,9,0,0,0,1,67]",
    ),
    (
        r"UTC",
        r#""2015 53 6"|strptime("%Y %U %w")"#,
        r"[2016,0,9,0,0,0,6,8]",
    ),
    (
        r"UTC",
        r#""2015 0 5"|strptime("%Y %U %w")"#,
        r"[2015,0,2,0,0,0,5,1]",
    ),
    (
        r"UTC",
        r#""2015 0 0"|strptime("%Y %U %w")"#,
        r#"!date "2015 0 0" does not match format "%Y %U %w""#,
    ),
    (
        r"UTC",
        r#""2023 0 6"|strptime("%Y %U %w")"#,
        r#"!date "2023 0 6" does not match format "%Y %U %w""#,
    ),
    (
        r"UTC",
        r#""2015 10"|strptime("%Y %V")"#,
        r"[2015,2,2,0,0,0,1,60]",
    ),
    (
        r"UTC",
        r#""2015 1 4"|strptime("%Y %V %u")"#,
        r"[2015,0,1,0,0,0,4,0]",
    ),
    (
        r"UTC",
        r#""2015 1 1"|strptime("%Y %V %u")"#,
        r#"!date "2015 1 1" does not match format "%Y %V %u""#,
    ),
    (
        r"UTC",
        r#""2015 53 7"|strptime("%Y %V %u")"#,
        r"[2016,0,3,0,0,0,0,2]",
    ),
    (
        r"UTC",
        r#""2015 10 Thu"|strptime("%Y %U %a")"#,
        r"[2015,2,12,0,0,0,4,70]",
    ),
    (
        r"UTC",
        r#""15 10 4"|strptime("%y %U %w")"#,
        r"[2015,2,12,0,0,0,4,70]",
    ),
    (
        r"UTC",
        r#""1425599507"|strptime("%s")|mktime"#,
        r"1425599507",
    ),
    (
        r"UTC",
        r#""2015-03-05T23:51:47Z"|strptime("%Y-%m-%dT%H:%M:%SZ")|mktime"#,
        r"1425599507",
    ),
    (
        r"UTC",
        r"1425599507|gmtime|todate",
        r#""2015-03-05T23:51:47Z""#,
    ),
    (r"UTC", r"1425599507.75|gmtime|mktime", r"1425599507"),
    (
        r"UTC",
        r"[1425599507|gmtime|todate]",
        r#"["2015-03-05T23:51:47Z"]"#,
    ),
    (
        r"UTC",
        r#""15 22"|strptime("%y %C")"#,
        r"[2215,0,0,0,0,0,6,-1]",
    ),
    (
        r"UTC",
        r#""22 15"|strptime("%C %y")"#,
        r"[2215,0,0,0,0,0,6,-1]",
    ),
    (
        r"UTC",
        r#""22 03/05/15"|strptime("%C %x")"#,
        r"[2015,2,5,0,0,0,4,63]",
    ),
    (
        r"UTC",
        r#""03/05/15 22"|strptime("%x %C")"#,
        r"[2200,2,5,0,0,0,3,63]",
    ),
    (
        r"UTC",
        r#""2015 22"|strptime("%Y %C")"#,
        r"[2200,0,0,0,0,0,1,-1]",
    ),
    (
        r"UTC",
        r#""2015-03 10 4"|strptime("%Y-%m %U %w")"#,
        r"[2015,2,12,0,0,0,4,70]",
    ),
    (
        r"UTC",
        r#""2015-02-30 GMT"|strptime("%Y-%m-%d %Z")"#,
        r"[2015,2,2,0,0,0,1,60]",
    ),
    (
        r"UTC",
        r#""2015-02-30 UTC"|strptime("%Y-%m-%d %Z")"#,
        r"[2015,1,30,0,0,0,1,60]",
    ),
    (
        r"UTC",
        r#""1425599507 x"|strptime("%s x")"#,
        r"[2015,2,5,23,51,47,4,63]",
    ),
    (
        r"UTC",
        r#""now"|try strptime("%s") catch ."#,
        r#""date \"now\" does not match format \"%s\"""#,
    ),
    (r"UTC", r"now|type", r#""number""#),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r"1425599507|localtime",
        r"[2015,2,5,18,51,47,4,63]",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r"1425599507.5|localtime",
        r"[2015,2,5,18,51,47.5,4,63]",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"1425599507|strflocaltime("%c %Z %z")"#,
        r#""Thu Mar  5 18:51:47 2015 EST -0500""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,10,1,0,59,59]|strflocaltime("%c %Z %z")"#,
        r#""Sun Nov  1 00:59:59 2015 EDT -0400""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,10,1,2,0,0]|strflocaltime("%c %Z %z")"#,
        r#""Sun Nov  1 02:00:00 2015 EST -0500""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,2,8,2,30,0]|strflocaltime("%c %Z %z")"#,
        r#""Sun Mar  8 03:30:00 2015 EDT -0400""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,2,8,1,59,59]|strflocaltime("%c %Z %z")"#,
        r#""Sun Mar  8 01:59:59 2015 EST -0500""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,2,8,3,0,0]|strflocaltime("%c %Z %z")"#,
        r#""Sun Mar  8 03:00:00 2015 EDT -0400""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r"1446354600|localtime",
        r"[2015,10,1,1,10,0,0,304]",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"1446361800|strflocaltime("%c %Z %z")"#,
        r#""Sun Nov  1 02:10:00 2015 EST -0500""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"1425801000|strflocaltime("%c %Z %z")"#,
        r#""Sun Mar  8 03:50:00 2015 EDT -0400""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,6,1,12,0,0]|strflocaltime("%c %Z %z")"#,
        r#""Wed Jul  1 12:00:00 2015 EDT -0400""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r"[2015,6,1,12,0,0]|mktime",
        r"1435752000",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,0,0,0,0,0]|strflocaltime("%c %Z %z")"#,
        r#""Wed Dec 31 00:00:00 2014 EST -0500""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"[2015,0,32,25,61,61]|strflocaltime("%c %Z %z")"#,
        r#""Mon Feb  2 02:02:01 2015 EST -0500""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#"-1|strflocaltime("%c %Z %z")"#,
        r#""Wed Dec 31 18:59:59 1969 EST -0500""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#""x"|localtime"#,
        r"!localtime() requires numeric inputs",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#""x"|strflocaltime("%Y")"#,
        r"!strflocaltime/1 requires parsed datetime inputs",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r"1|strflocaltime(1)",
        r"!strflocaltime/1 requires a string format",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#""2015-03-05 18:51:47 EST"|strptime("%Y-%m-%d %H:%M:%S %Z")"#,
        r"[2015,2,5,18,51,47,4,63]",
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#""2015-03-05 18:51:47 PST"|strptime("%Y-%m-%d %H:%M:%S %Z")"#,
        r#"!date "2015-03-05 18:51:47 PST" does not match format "%Y-%m-%d %H:%M:%S %Z""#,
    ),
    (
        r"EST5EDT,M3.2.0,M11.1.0",
        r#""1425599507"|strptime("%s")"#,
        r"[2015,2,5,18,51,47,4,63]",
    ),
    (
        r"<+07>-7",
        r"1425599507|localtime",
        r"[2015,2,6,6,51,47,5,64]",
    ),
    (
        r"<+07>-7",
        r#"1425599507|strflocaltime("%H:%M %Z %z")"#,
        r#""06:51 +07 +0700""#,
    ),
    (
        r"AEST-10AEDT,M10.1.0,M4.1.0/3",
        r#"[range(1420070400;1451692800;86400*15)|strflocaltime("%F %H:%M %Z")]|join(",")"#,
        r#""2015-01-01 11:00 AEDT,2015-01-16 11:00 AEDT,2015-01-31 11:00 AEDT,2015-02-15 11:00 AEDT,2015-03-02 11:00 AEDT,2015-03-17 11:00 AEDT,2015-04-01 11:00 AEDT,2015-04-16 10:00 AEST,2015-05-01 10:00 AEST,2015-05-16 10:00 AEST,2015-05-31 10:00 AEST,2015-06-15 10:00 AEST,2015-06-30 10:00 AEST,2015-07-15 10:00 AEST,2015-07-30 10:00 AEST,2015-08-14 10:00 AEST,2015-08-29 10:00 AEST,2015-09-13 10:00 AEST,2015-09-28 10:00 AEST,2015-10-13 11:00 AEDT,2015-10-28 11:00 AEDT,2015-11-12 11:00 AEDT,2015-11-27 11:00 AEDT,2015-12-12 11:00 AEDT,2015-12-27 11:00 AEDT""#,
    ),
    (
        r"CET-1CEST,M3.5.0,M10.5.0/3",
        r#"[range(1427590000;1427800000;21600)|strflocaltime("%F %H:%M %Z")]|join(",")"#,
        r#""2015-03-29 01:46 CET,2015-03-29 08:46 CEST,2015-03-29 14:46 CEST,2015-03-29 20:46 CEST,2015-03-30 02:46 CEST,2015-03-30 08:46 CEST,2015-03-30 14:46 CEST,2015-03-30 20:46 CEST,2015-03-31 02:46 CEST,2015-03-31 08:46 CEST""#,
    ),
    (
        r"CET-1CEST,M3.5.0,M10.5.0/3",
        r#"[range(1445700000;1445900000;21600)|strflocaltime("%F %H:%M %Z")]|join(",")"#,
        r#""2015-10-24 17:20 CEST,2015-10-24 23:20 CEST,2015-10-25 04:20 CET,2015-10-25 10:20 CET,2015-10-25 16:20 CET,2015-10-25 22:20 CET,2015-10-26 04:20 CET,2015-10-26 10:20 CET,2015-10-26 16:20 CET,2015-10-26 22:20 CET""#,
    ),
    (
        r"NST3:30NDT,M3.2.0,M11.1.0",
        r#"1425599507|strflocaltime("%c %Z %z")"#,
        r#""Thu Mar  5 20:21:47 2015 NST -0330""#,
    ),
    (
        r"NST3:30NDT,M3.2.0,M11.1.0",
        r#"1435752000|strflocaltime("%c %Z %z")"#,
        r#""Wed Jul  1 09:30:00 2015 NDT -0230""#,
    ),
    (
        r"IST-1GMT0,M10.5.0,M3.5.0/1",
        r#"1425599507|strflocaltime("%c %Z %z")"#,
        r#""Thu Mar  5 23:51:47 2015 GMT +0000""#,
    ),
    (
        r"IST-1GMT0,M10.5.0,M3.5.0/1",
        r#"1435752000|strflocaltime("%c %Z %z")"#,
        r#""Wed Jul  1 13:00:00 2015 IST +0100""#,
    ),
    (
        r"EST5EDT,J60,J300",
        r#"[range(1420070400;1451692800;86400*20)|strflocaltime("%F %H:%M %Z")]|join(",")"#,
        r#""2014-12-31 19:00 EST,2015-01-20 19:00 EST,2015-02-09 19:00 EST,2015-03-01 20:00 EDT,2015-03-21 20:00 EDT,2015-04-10 20:00 EDT,2015-04-30 20:00 EDT,2015-05-20 20:00 EDT,2015-06-09 20:00 EDT,2015-06-29 20:00 EDT,2015-07-19 20:00 EDT,2015-08-08 20:00 EDT,2015-08-28 20:00 EDT,2015-09-17 20:00 EDT,2015-10-07 20:00 EDT,2015-10-27 19:00 EST,2015-11-16 19:00 EST,2015-12-06 19:00 EST,2015-12-26 19:00 EST""#,
    ),
];

fn host_run(program: &str, zone: &str) -> Vec<Frame> {
    let config = serde_json::json!({ "program": program, "now": 1700000000.5, "zone": zone });
    let mut stream = super::eval::open(config.to_string().as_bytes()).expect("compiles");
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    frames(&wire)
}

#[test]
fn date_builtins_print_what_jq_prints() {
    let mut mismatch = Vec::new();
    for (zone, program, want) in TIME_CASES {
        let mut got = Vec::new();
        for frame in host_run(program, zone) {
            match frame {
                Frame::Out(text) => got.push(text),
                Frame::Err(text) => got = vec![format!("!{text}")],
                Frame::Halt(_) => {}
            }
        }
        if got.join("\n") != *want {
            mismatch.push(format!(
                "{program} under {zone}\n  got  {got:?}\n  want {want:?}"
            ));
        }
    }
    assert!(mismatch.is_empty(), "{}", mismatch.join("\n"));
}

#[test]
fn now_and_local_time_need_the_host() {
    for program in ["now", "localtime", "strflocaltime(\"%Y\")", "def f: now; f"] {
        let config = serde_json::json!({ "program": program });
        assert!(
            super::eval::open(config.to_string().as_bytes()).is_err(),
            "{program}"
        );
    }
    for zone in ["America/New_York", "EST", "EST5EDT,M3.2.0", "x"] {
        let config = serde_json::json!({ "program": "localtime", "now": 0, "zone": zone });
        assert!(
            super::eval::open(config.to_string().as_bytes()).is_err(),
            "{zone}"
        );
    }
    let config = serde_json::json!({ "program": "mktime, gmtime, todate, fromdate" });
    assert!(super::eval::open(config.to_string().as_bytes()).is_ok());
}

#[test]
fn now_is_the_clock_each_document_began_with() {
    let config = serde_json::json!({ "program": "now", "now": 1.5 });
    let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
    let mut seen = Vec::new();
    for begin in [None, Some(2.5)] {
        if let Some(now) = begin {
            stream
                .begin(serde_json::json!({ "now": now }).to_string().as_bytes())
                .unwrap();
        }
        let mut wire = Vec::new();
        stream.feed(b"null", &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
        }
        seen.extend(frames(&wire));
    }
    assert_eq!(
        seen,
        vec![Frame::Out("1.5".into()), Frame::Out("2.5".into())]
    );
}

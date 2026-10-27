use std::collections::HashMap;
use std::sync::Arc;

use super::compile::compile;
use super::eval::{ERROR, HALT, OUTPUT};
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
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    frames(&wire)
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
];

#[test]
fn programs_match_jq() {
    let mut failures = Vec::new();
    for (program, input, expected) in CASES {
        if program.contains("splits") {
            continue;
        }
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
        if program.contains("splits") {
            continue;
        }
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
    for program in ["input", "test(\"a\")", "now", "$ENV", "@base32"] {
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
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("corpus.json")).unwrap();
    let (mut pass, mut refused, mut mismatch) = (0, 0, Vec::new());
    for case in &cases {
        let program = case["program"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        if parse_json(input).is_err() {
            continue;
        }
        let config = serde_json::json!({ "program": program, "steps": 7 });
        let Ok(mut stream) = super::eval::open(config.to_string().as_bytes()) else {
            refused += 1;
            continue;
        };
        let mut wire = Vec::new();
        stream.feed(input.as_bytes(), &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
        }
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
    assert!(
        pass >= 490 && refused <= 29,
        "pass {pass}, refused {refused}"
    );
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

use std::collections::HashMap;
use std::sync::Arc;

use super::compile::{Refusal, compile};
use super::eval::{DEBUG, ERROR, HALT, OUTPUT, STDERR};
use super::meter::{self, Meter};
use super::value::{Value, parse_json};
use super::vm::{Limits, Next, Vm};
use crate::Stream;

const LIMITS: Limits = Limits {
    blocks: 1 << 20,
    items: 1 << 24,
    bytes: 1 << 28,
    memory: 1 << 30,
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

/// The time the tests' host answers `now` with.
const CLOCK: f64 = 1700000000.5;

/// Drain a run to its end, answering `now` with CLOCK and `input` with
/// the end of the stream.
fn settle(stream: &mut dyn Stream, wire: &mut Vec<u8>) {
    loop {
        while stream.busy() {
            stream.drain(wire).unwrap();
        }
        let Some(header) = stream.request(&mut Vec::new()) else {
            break;
        };
        let reply = if header == br#"{"op":"now"}"# {
            serde_json::json!({ "kind": "now", "now": CLOCK })
        } else {
            serde_json::json!({ "kind": "end" })
        };
        stream
            .respond(reply.to_string().as_bytes(), b"", wire)
            .unwrap();
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
        "[range(300) | 300 - .] | sort | [.[0], .[-1], length]",
        "null",
        &["[1,300,300]"],
    ),
    (
        "[range(300) | 300 - .] | group_by(. % 7) | map(length)",
        "null",
        &["[42,43,43,43,43,43,43]"],
    ),
    (
        "[range(300) | 300 - .] | unique_by(. % 5)",
        "null",
        &["[300,296,297,298,299]"],
    ),
    (
        "[range(300) | 300 - .] | [min, max, min_by(-.), max_by(-.)]",
        "null",
        &["[1,300,300,1]"],
    ),
    (
        r#"sort_by(.k) | map(.v) | join("")"#,
        r#"[{"k":1,"v":"a"},{"k":0,"v":"b"},{"k":1,"v":"c"},{"k":0,"v":"d"}]"#,
        &[r#""bdac""#],
    ),
    ("[range(500)] | tojson | length", "null", &["1891"]),
    ("[range(50)] | tostring | length", "null", &["141"]),
    ("[range(50)] | @json | length", "null", &["141"]),
    (r#""a\"b" | @text"#, "null", &[r#""a\"b""#]),
    (
        r#""[" + ([range(500)] | map(tostring) | join(",")) + "]" | fromjson | length"#,
        "null",
        &["500"],
    ),
    (
        r#""{\"a\":{\"b\":[1,{\"c\":null}]},\"d\":\"e\"}" | fromjson"#,
        "null",
        &[r#"{"a":{"b":[1,{"c":null}]},"d":"e"}"#],
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

const SLICED: &[&str] = &[
    "[range(300) | 300 - .] | sort",
    "[range(300) | 300 - .] | group_by(. % 7)",
    "[range(500)] | tojson",
    "[range(50)] | tostring",
    "[range(50)] | @json",
    "[range(2000)]",
];

#[test]
fn every_budget_gives_the_same_frames() {
    let cases = CASES
        .iter()
        .map(|(program, input, _)| (*program, *input))
        .chain(SLICED.iter().map(|program| (*program, "null")));
    for (program, input) in cases {
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

fn drains(program: &str, input: &str, steps: u64) -> (usize, Vec<Frame>) {
    let mut stream = open(program, steps);
    let mut wire = Vec::new();
    stream.feed(input.as_bytes(), &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    let mut drains = 0;
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
        drains += 1;
    }
    (drains, frames(&wire))
}

#[test]
fn large_sorts_dumps_parses_and_outputs_pause_every_drain() {
    let descending: Vec<String> = (0..200000).rev().map(|n| n.to_string()).collect();
    let descending = format!("[{}]", descending.join(","));
    let (count, got) = drains("sort | length", &descending, 1000);
    assert!(count > 10, "{count} drains");
    assert_eq!(got, vec![Frame::Out("200000".into())]);
    let ascending: Vec<String> = (0..100000).map(|n| n.to_string()).collect();
    let ascending = format!("[{}]", ascending.join(","));
    let (count, got) = drains("tojson | length", &ascending, 1000);
    assert!(count > 10, "{count} drains");
    assert_eq!(got, vec![Frame::Out("588891".into())]);
    let (count, got) = drains("tojson | fromjson | length", &ascending, 1000);
    assert!(count > 10, "{count} drains");
    assert_eq!(got, vec![Frame::Out("100000".into())]);
    let (count, got) = drains(".", &ascending, 1000);
    assert!(count > 10, "{count} drains");
    assert_eq!(got, vec![Frame::Out(ascending)]);
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
        let mut vm = Vm::start(
            Arc::clone(&program),
            parse_json("0").unwrap(),
            LIMITS,
            Arc::new(Meter::default()),
        );
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

/// A cancelled run frees the arrays a paused subtraction holds in the
/// same slices as its stack.
#[test]
fn cancel_frees_a_paused_subtraction_across_drains() {
    let program = "[range(100000) | [.]] - [range(3000) | [.]] | length";
    let mut stream = open(program, 1 << 10);
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    for _ in 0..2000 {
        stream.drain(&mut wire).unwrap();
    }
    assert!(stream.busy());
    assert!(stream.cancel());
    let mut drains = 0;
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
        drains += 1;
    }
    assert!(drains > 8, "freed in {drains} drains");
    assert!(wire.is_empty());
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

fn limited(config: serde_json::Value) -> Vec<Frame> {
    let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    frames(&wire)
}

#[test]
fn a_memory_cap_ends_a_run_holding_too_many_values() {
    let program = r#"[range(100000) | "x" * 100]"#;
    assert_eq!(
        limited(serde_json::json!({ "program": program, "memory": 1_000_000 })),
        vec![Frame::Err(
            "jq memory limit of 1000000 bytes exceeded".into()
        )]
    );
    assert_eq!(
        limited(serde_json::json!({ "program": format!("{program} | length") })),
        vec![Frame::Out("100000".into())]
    );
}

#[test]
fn the_memory_cap_counts_live_values_not_cumulative_ones() {
    let program = r#"reduce range(2000) as $i (0; ("x" * 100000 | length) + .)"#;
    assert_eq!(
        limited(serde_json::json!({ "program": program, "memory": 1_000_000 })),
        vec![Frame::Out("200000000".into())]
    );
}

#[test]
fn the_memory_cap_charges_a_shared_value_once() {
    let program = "[range(1000)] as $a | [range(1000) | $a] | length";
    assert_eq!(
        limited(serde_json::json!({ "program": program, "memory": 100_000 })),
        vec![Frame::Out("1000".into())]
    );
}

#[test]
fn the_memory_cap_charges_shared_object_keys_once() {
    for item in ["$a + {}", "$a * {}", "{($k): .}"] {
        let program =
            format!(r#"("x" * 90000) as $k | {{($k): 0}} as $a | [range(10) | {item}] | length"#);
        assert_eq!(
            limited(serde_json::json!({"program":program,"memory":300000,"steps":7})),
            vec![Frame::Out("10".into())],
            "{item}"
        );
    }
}

#[test]
fn numeric_conversion_buffers_cannot_bypass_the_memory_cap() {
    let config = serde_json::json!({"program":"tonumber | empty","memory":140000,"steps":7});
    let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
    let mut wire = Vec::new();
    stream
        .feed(format!("\"{}\"", "1".repeat(60000)).as_bytes(), &mut wire)
        .unwrap();
    stream.finish(&mut wire).unwrap();
    settle(&mut *stream, &mut wire);
    assert_eq!(
        frames(&wire),
        vec![Frame::Err(
            "jq memory limit of 140000 bytes exceeded".into()
        )]
    );
}

#[test]
fn the_meter_returns_to_zero_once_every_value_drops() {
    let meter = Arc::new(Meter::default());
    let installed = meter::install(&meter);
    let array = Value::array((0..10).map(|i| Value::string(i.to_string())).collect());
    let charged = meter.live();
    assert!(charged > 0, "{charged} bytes");
    let mut copy = array.clone();
    assert_eq!(meter.live(), charged, "an Arc clone shares the value");
    if let Value::Array(items) = &mut copy {
        Arc::make_mut(items).push(Value::string("pushed"));
    }
    assert!(meter.live() > charged, "{} bytes", meter.live());
    drop(copy);
    assert_eq!(meter.live(), charged);
    drop(array);
    assert_eq!(meter.live(), 0);
    drop(installed);
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

const BUILTINS_SORTED: &str = r#"["IN/1","IN/2","INDEX/1","INDEX/2","JOIN/2","JOIN/3","JOIN/4","abs/0","acos/0","acosh/0","add/0","add/1","all/0","all/1","all/2","any/0","any/1","any/2","arrays/0","ascii_downcase/0","ascii_upcase/0","asin/0","asinh/0","atan/0","atan2/2","atanh/0","booleans/0","bsearch/1","builtins/0","capture/1","capture/2","cbrt/0","ceil/0","combinations/0","combinations/1","contains/1","copysign/2","cos/0","cosh/0","debug/0","debug/1","del/1","delpaths/1","drem/2","empty/0","endswith/1","env/0","erf/0","erfc/0","error/0","error/1","exp/0","exp10/0","exp2/0","explode/0","expm1/0","fabs/0","fdim/2","finites/0","first/0","first/1","flatten/0","flatten/1","floor/0","fma/3","fmax/2","fmin/2","fmod/2","format/1","frexp/0","from_entries/0","fromdate/0","fromdateiso8601/0","fromjson/0","fromstream/1","gamma/0","get_jq_origin/0","get_prog_origin/0","get_search_list/0","getpath/1","gmtime/0","group_by/1","gsub/2","gsub/3","halt/0","halt_error/0","halt_error/1","has/1","have_decnum/0","have_literal_numbers/0","hypot/2","implode/0","in/1","index/1","indices/1","infinite/0","input/0","input_filename/0","input_line_number/0","inputs/0","inside/1","isempty/1","isfinite/0","isinfinite/0","isnan/0","isnormal/0","iterables/0","j0/0","j1/0","jn/2","join/1","keys/0","keys_unsorted/0","last/0","last/1","ldexp/2","length/0","lgamma/0","lgamma_r/0","limit/2","localtime/0","log/0","log10/0","log1p/0","log2/0","logb/0","ltrim/0","ltrimstr/1","map/1","map_values/1","match/1","match/2","max/0","max_by/1","min/0","min_by/1","mktime/0","modf/0","modulemeta/0","nan/0","nearbyint/0","nextafter/2","nexttoward/2","normals/0","not/0","now/0","nth/1","nth/2","nulls/0","numbers/0","objects/0","path/1","paths/0","paths/1","pick/1","pow/2","range/1","range/2","range/3","recurse/0","recurse/1","recurse/2","remainder/2","repeat/1","reverse/0","rindex/1","rint/0","round/0","rtrim/0","rtrimstr/1","scalars/0","scalb/2","scalbln/2","scan/1","scan/2","select/1","setpath/2","significand/0","sin/0","sinh/0","skip/2","sort/0","sort_by/1","split/1","split/2","splits/1","splits/2","sqrt/0","startswith/1","stderr/0","strflocaltime/1","strftime/1","strings/0","strptime/1","sub/2","sub/3","tan/0","tanh/0","test/1","test/2","tgamma/0","to_entries/0","toboolean/0","todate/0","todateiso8601/0","tojson/0","tonumber/0","tostream/0","tostring/0","transpose/0","trim/0","trimstr/1","trunc/0","truncate_stream/1","type/0","unique/0","unique_by/1","until/2","utf8bytelength/0","values/0","walk/1","while/2","with_entries/1","y0/0","y1/0","yn/2"]"#;

#[test]
fn builtins_lists_jqs_names_in_jqs_order() {
    assert_eq!(outputs("builtins | length", "null"), vec!["226"]);
    assert_eq!(
        outputs("[builtins | .[0:12], .[-6:]]", "null"),
        vec![
            r#"[["have_literal_numbers/0","have_decnum/0","input_line_number/0","input_filename/0","now/0","localtime/0","gmtime/0","mktime/0","strflocaltime/1","strftime/1","strptime/1","stderr/0"],["JOIN/2","JOIN/3","JOIN/4","IN/1","IN/2","builtins/0"]]"#
        ]
    );
    assert_eq!(outputs("builtins | sort", "null"), vec![BUILTINS_SORTED]);
    for name in [
        "builtins/0",
        "modulemeta/0",
        "get_search_list/0",
        "gamma/0",
        "jn/2",
    ] {
        let (name, arity) = name.split_once('/').unwrap();
        let args = (0..arity.parse::<usize>().unwrap())
            .map(|_| "1")
            .collect::<Vec<_>>()
            .join(";");
        let call = if args.is_empty() {
            name.to_string()
        } else {
            format!("{name}({args})")
        };
        let compiled = compile(&call, &HashMap::new());
        if matches!(name, "gamma" | "jn") {
            assert!(matches!(compiled, Err(Refusal::Unsupported(_))), "{call}");
        } else {
            assert!(compiled.is_ok(), "{call}");
        }
    }
}

#[test]
fn module_builtins_answer_without_a_module_path() {
    assert_eq!(
        outputs("\"x\" | modulemeta", "null"),
        vec!["error: module not found: x"]
    );
    assert_eq!(
        outputs("1 | modulemeta", "null"),
        vec!["error: modulemeta input module name must be a string"]
    );
    assert_eq!(
        outputs("get_search_list", "null"),
        vec![r#"["~/.jq","$ORIGIN/../lib/jq","$ORIGIN/../lib"]"#]
    );
}

#[test]
fn modulemeta_and_imports_validate_paths_with_the_same_diagnostics() {
    for (path, message) in [
        (
            "../x",
            "Relative paths to modules may not traverse to parent directories (../x)",
        ),
        (
            "x/x",
            "module names must not have equal consecutive components: x/x",
        ),
        (
            "x\\x",
            "Modules must be named by relative paths using '/', not '\\' (x\\x)",
        ),
        ("x\0y", "Module path contains a NUL byte"),
        ("x", "module not found: x"),
        ("a//b", "module not found: a//b"),
        ("/x", "module not found: /x"),
    ] {
        let input = serde_json::to_string(path).unwrap();
        assert_eq!(
            run("try modulemeta catch .", &input, 1),
            vec![Frame::Out(serde_json::to_string(message).unwrap())],
            "{path}"
        );
        assert_eq!(
            invalid_report(&format!("import {input} as x; missing")),
            format!("jq: error: {message}\n\njq: 1 compile error"),
            "{path}"
        );
    }
}

#[test]
fn the_grammar_builds_as_bison_builds_jqs() {
    let tables = super::syntax::tables();
    assert_eq!(tables.states(), 312);
    assert_eq!(tables.rules.len(), 168);
    assert_eq!(tables.conflicts, 0);
}

fn refusal(program: &str) -> Refusal {
    match compile(program, &HashMap::new()) {
        Ok(_) => panic!("{program:.40} compiles"),
        Err(refusal) => refusal,
    }
}

fn invalid_report(program: &str) -> String {
    match refusal(program) {
        Refusal::Invalid(report) => report,
        Refusal::Unsupported(why) => panic!("unexpected fallback: {why}"),
    }
}

#[test]
fn programs_compile_or_get_jqs_report() {
    assert!(invalid_report("if").ends_with("jq: 1 compile error"));
    assert!(invalid_report("$x").ends_with("jq: 1 compile error"));
    assert_eq!(
        invalid_report("import \"a\" as a; ."),
        "jq: error: module not found: a\n\njq: 1 compile error"
    );
    assert_eq!(
        invalid_report("include \"a\"; $x"),
        "jq: error: module not found: a\n\njq: 1 compile error"
    );
    assert_eq!(
        invalid_report("import \"a\" as a; import \"../b\" as b; ."),
        "jq: error: Relative paths to modules may not traverse to parent directories (../b)\n\njq: 1 compile error"
    );
    assert_eq!(
        invalid_report("$$$$x + $$$$y"),
        "jq: error: x/-1 is not defined at <top-level>, line 1, column 1:\n    $$$$x + $$$$y\n    ^^^^^\njq: error: y/-1 is not defined at <top-level>, line 1, column 9:\n    $$$$x + $$$$y\n            ^^^^^\njq: 2 compile errors"
    );
    assert_eq!(
        invalid_report("\"\\\u{e9}\""),
        "jq: error: Invalid escape at line 1, column 6 (while parsing '\"\\\u{fffd}\"') at <top-level>, line 1, column 2:\n    \"\\\u{e9}\"\n     ^^\njq: 1 compile error"
    );
    assert_eq!(
        invalid_report("\"\\\u{20ac}x\""),
        "jq: error: Unfinished string at EOF at line 1, column 5 (while parsing '\"\\\u{fffd}') at <top-level>, line 1, column 2:\n    \"\\\u{20ac}x\"\n     ^^\njq: 1 compile error"
    );
    for program in [
        "import \"a\" as a {optional: true}; .",
        "1 as $x | $$$$x",
        &format!("{}.{}", "[".repeat(600), "]".repeat(600)),
        &".a".repeat(600),
    ] {
        assert!(compile(program, &HashMap::new()).is_ok(), "{program:.40}");
    }
}

/// jq folds `[1,2] - [2]` while it parses; this parser leaves that to
/// run time, so metadata that needs it goes to libjq, and metadata that
/// is not constant gets jq's error.
#[test]
fn module_metadata_jq_folds_is_left_to_libjq() {
    assert!(compile("module {a: [1,2], b: {c: 3}}; .", &HashMap::new()).is_ok());
    for program in [
        "module {a: ([1,2] - [2])}; .",
        r#"module {a: ("ab" * 2)}; ."#,
        "module {a: [([1] - [1])]}; .",
    ] {
        assert!(
            matches!(refusal(program), Refusal::Unsupported(_)),
            "{program}"
        );
    }
    let Refusal::Invalid(report) = refusal("module {a: .}; .") else {
        panic!("jq refuses it");
    };
    assert!(
        report.starts_with("jq: error: Module metadata must be constant at <top-level>, line 1"),
        "{report}"
    );
}

#[test]
fn a_program_deeper_than_bisons_stack_exhausts_its_memory() {
    let program = format!("{}1{}", "(".repeat(9995), ")".repeat(9995));
    let Refusal::Invalid(report) = refusal(&program) else {
        panic!("jq refuses it");
    };
    let want = format!(
        "jq: error: memory exhausted at <top-level>, line 1, column 9997:\n    {program}\n    {}^\njq: 1 compile error",
        " ".repeat(9996)
    );
    assert_eq!(report, want);
    let program = format!("{}1{}", "(".repeat(9994), ")".repeat(9994));
    assert!(compile(&program, &HashMap::new()).is_ok());
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
const DIVERGENT: &[(&str, &str)] = &[];

/// Whether an open's refusal is jq's report of a program it refuses,
/// which ends in its count of compile errors.
fn compile_report(message: &str) -> bool {
    let last = message.lines().last().unwrap_or_default();
    last.strip_prefix("jq: ")
        .and_then(|rest| rest.split_once(' '))
        .is_some_and(|(n, noun)| {
            n.parse::<usize>().is_ok() && matches!(noun, "compile error" | "compile errors")
        })
}

/// jq 1.8.2's tests/jq.test and the generator's probes, each case's
/// outputs as a jq 1.8.2 binary printed them (scripts/gen_jq_corpus.py),
/// at a budget that pauses the VM every few steps. A program jq refuses
/// must be refused with jq's report, byte for byte, or left to libjq; one
/// jq runs may be left to libjq at compile; any other difference fails
/// unless DIVERGENT names it.
#[test]
fn jq_test_corpus() {
    let (pass, refused, reported, left) = run_corpus(include_str!("corpus.json"));
    assert!(
        pass >= 506 && refused <= 13 && reported >= 161 && left <= 13,
        "pass {pass}, refused {refused}, reported {reported}, left {left}"
    );
}

/// jq 1.8.2's tests/onig.test, its regex cases, run as the corpus above.
#[test]
fn onig_test_corpus() {
    let (pass, refused, _, _) = run_corpus(include_str!("onig.json"));
    assert!(pass >= 47 && refused == 0, "pass {pass}, refused {refused}");
}

/// Runs a corpus: how many cases passed and how many were refused.
fn run_corpus(corpus: &str) -> (usize, usize, usize, usize) {
    let cases: Vec<serde_json::Value> = serde_json::from_str(corpus).unwrap();
    let (mut pass, mut refused, mut mismatch) = (0, 0, Vec::new());
    let (mut reported, mut left) = (0, 0);
    for case in &cases {
        let program = case["program"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let stderr = case["stderr"].as_str().unwrap();
        let config = serde_json::json!({
            "program": program,
            "steps": 7,
            "zone": "UTC",
        });
        let opened = super::eval::open(config.to_string().as_bytes());
        if case["exit"] == 3 {
            match opened {
                Err(e) if !compile_report(&e.message) => left += 1,
                Err(e) if e.message == stderr.trim_end_matches('\n') => reported += 1,
                Err(e) => mismatch.push(format!(
                    "{program:?}\n  got  {:?}\n  want {stderr:?}",
                    e.message
                )),
                Ok(_) => mismatch.push(format!("{program:?} compiles; jq refuses it:\n{stderr}")),
            }
            continue;
        }
        if parse_json(input).is_err() {
            continue;
        }
        let mut stream = match opened {
            Ok(stream) => stream,
            Err(e) if compile_report(&e.message) => {
                mismatch.push(format!("{program:?} refused; jq runs it:\n{}", e.message));
                continue;
            }
            Err(_) => {
                refused += 1;
                continue;
            }
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
        let want_error = stderr.lines().find_map(|l| {
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
    (pass, refused, reported, left)
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
fn formats_named_at_run_time_run() {
    for (program, input, expected) in [
        (
            r#""foo" as $f | format($f)"#,
            "null",
            "error: foo is not a valid format",
        ),
        (
            "format(\"foo\")",
            "null",
            "error: foo is not a valid format",
        ),
        ("@foo", "null", "error: foo is not a valid format"),
        ("@base32", r#""abc""#, "error: base32 is not a valid format"),
        ("format(.f)", r#"{"f":"text"}"#, r#""{\"f\":\"text\"}""#),
        (r#""a%20b" | @urid"#, "null", r#""a b""#),
        (
            r#""%zz" | @urid"#,
            "null",
            r#"error: string ("%zz") is not a valid uri encoding"#,
        ),
        (r#""a%20b" | format("urid")"#, "null", r#""a b""#),
    ] {
        assert_eq!(
            outputs(program, input),
            vec![expected.to_string()],
            "{program}"
        );
    }
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
    let config = serde_json::json!({ "program": program, "zone": zone });
    let mut stream = super::eval::open(config.to_string().as_bytes()).expect("compiles");
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    settle(&mut *stream, &mut wire);
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
fn now_asks_the_hosts_clock_at_each_call() {
    let mut stream = open("[now, now]", 1 << 16);
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    for seconds in [1.5, 2.5] {
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
        }
        assert_eq!(stream.request(&mut Vec::new()).unwrap(), br#"{"op":"now"}"#);
        let reply = serde_json::json!({ "kind": "now", "now": seconds });
        stream
            .respond(reply.to_string().as_bytes(), b"", &mut wire)
            .unwrap();
    }
    settle(&mut *stream, &mut wire);
    assert_eq!(frames(&wire), vec![Frame::Out("[1.5,2.5]".into())]);
}

#[test]
fn regex_the_matcher_cannot_run_exactly_never_answers_wrong() {
    assert_eq!(
        outputs(
            r#"[test("strasse"; "i"), test("(?i)STRASSE")]"#,
            r#""Strasse""#
        ),
        vec!["[true,true]"]
    );
    for program in [r#"test("(?~ab)")"#, r#"sub("\\X"; "y")"#] {
        assert!(compile(program, &HashMap::new()).is_err(), "{program}");
    }
    for program in [
        r#"test("ß")"#,
        r#"test("ß"; "i")"#,
        r#"test("(?i)ß")"#,
        r#"test("\\x{df}"; "i")"#,
        r#"test("(?i)\\x{df}")"#,
        r#"test("[\\x{c0}-\\x{ff}]"; "i")"#,
        r#"test("[[:alpha:]]"; "i")"#,
        r#"test("[^\\x{df}]"; "i")"#,
        r#"test("[a-z]"; "i")"#,
    ] {
        assert!(compile(program, &HashMap::new()).is_ok(), "{program}");
    }
}

/// Oniguruma folds some characters to several (`ß` to `ss`) in a run of
/// literals, in a bracket class and in a backreference; jq 1.8.2's
/// answers, offsets in characters.
#[test]
fn regex_case_folding_to_several_characters_matches_as_jq_does() {
    let cases: &[(&str, &str, &str)] = &[
        (r#"test("STRASSE"; "i")"#, r#""Straße""#, "true"),
        (
            r#"[match("ss"; "gi") | [.offset, .length, .string]]"#,
            r#""ß""#,
            r#"[[0,1,"ß"]]"#,
        ),
        (
            r#"[match("ß"; "gi") | [.offset, .length, .string]]"#,
            r#""ss""#,
            r#"[[0,2,"ss"]]"#,
        ),
        (
            r#"[test("sss"; "i"), test("ss|x"; "i")]"#,
            r#""sß""#,
            "[false,true]",
        ),
        (r#"test("sss"; "i")"#, r#""ßs""#, "true"),
        (
            r#"[test("^ffi$"; "i"), test("^ﬀi$"; "i")]"#,
            r#""ﬃ""#,
            "[true,false]",
        ),
        (r#"test("^ffi$"; "i")"#, r#""ﬀi""#, "false"),
        (
            r#"[test("^i̇$"; "i"), test("^i$"; "i")]"#,
            r#""İ""#,
            "[true,false]",
        ),
        (r#"test("^İ$"; "i")"#, r#""i̇""#, "true"),
        (r#"test("ʼn"; "i")"#, r#""ŉ""#, "true"),
        (
            r#"[test("s."; "i"), test("s\\w"; "i"), test("\\p{Lower}\\p{Lower}"; "i")]"#,
            r#""ß""#,
            "[false,false,false]",
        ),
        (
            r#"[match("[ß]"; "gi") | [.offset, .length]]"#,
            r#""ssß""#,
            "[[0,2],[2,1]]",
        ),
        (
            r#"[match("[ß]"; "gi") | [.offset, .length]]"#,
            r#""ssx""#,
            "[[0,2]]",
        ),
        (r#"[match("[ﬀﬃ]"; "i") | .length]"#, r#""ffi""#, "[2]"),
        (
            r#"[test("^[\\p{Lu}]$"; "i"), test("^\\p{Lu}$"; "i"), test("^[[:upper:]]$"; "i")]"#,
            r#""ss""#,
            "[true,false,true]",
        ),
        (
            r#"[test("^[^ß]$"; "i"), test("^[ß]$"; "i")]"#,
            r#""ẞ""#,
            "[false,true]",
        ),
        (
            r#"[match("(ẞ)\\1"; "i") | [.offset, .length]]"#,
            r#""ẞßx""#,
            "[[0,2]]",
        ),
        (r#"test("(ss)\\1"; "i")"#, r#""ßß""#, "true"),
        (
            r#"[test("(ss)\\1"; "i"), test("^(ß)\\1$"; "i")]"#,
            r#""ßss""#,
            "[false,false]",
        ),
        (
            r#"[test("^(K)\\1$"; "i"), test("^(\u212a)\\1$"; "i")]"#,
            r#""K\u212a""#,
            "[false,false]",
        ),
        (r#"test("^(K)\\1$"; "i")"#, r#""\u212a\u212a""#, "true"),
        (
            r#"try test("(?<=[ß])"; "i") catch ."#,
            r#""x""#,
            r#""Regex failure: invalid pattern in look-behind""#,
        ),
        (
            r#"[match("ss|ß"; "gil") | [.offset, .length]]"#,
            r#""ßss""#,
            "[[0,1],[1,2]]",
        ),
    ];
    for (program, input, want) in cases {
        assert_eq!(outputs(program, input), vec![want.to_string()], "{program}");
    }
}

/// A pattern the compiler cannot read is refused rather than fall over
/// at run time: a literal, a `[pattern, flags]` pair and a global are
/// read; anything else is left to libjq.
#[test]
fn regex_fallback_is_decided_at_compile_time() {
    let mut globals = HashMap::new();
    globals.insert("re".to_string(), Value::string("\\X"));
    globals.insert("ok".to_string(), Value::string("a+"));
    for program in [
        r#"test(.p)"#,
        r#"test("a"; .f)"#,
        r#"test($re)"#,
        r#"sub(.p; "y")"#,
        r#"["a"] as $p | test($p[0])"#,
    ] {
        assert!(
            matches!(compile(program, &globals), Err(Refusal::Unsupported(_))),
            "{program}"
        );
    }
    for program in [
        r#"test($ok)"#,
        r#"test(["a+", "x"])"#,
        r#"test(["ß", "i"])"#,
        r#"test("a"; null)"#,
    ] {
        assert!(compile(program, &globals).is_ok(), "{program}");
    }
}

/// Subtracting two long arrays scans one for each item of the other, so
/// the scan pauses with the budget rather than run in one step.
#[test]
fn array_subtraction_pauses_with_the_budget() {
    let program = "[range(3000)] - [range(3000; 6000)] | length";
    let mut stream = open(program, 1 << 10);
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    let mut drains = 0;
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
        drains += 1;
    }
    assert!(drains > 100, "{drains} drains");
    assert_eq!(frames(&wire), vec![Frame::Out("3000".into())]);
    assert_eq!(outputs("[1,2,3,2,[4]] - [2,[4]]", "null"), vec!["[1,3]"]);
}

/// A drain hands back once it holds a piece of output, `debug` and
/// `stderr` lines included, however few steps wrote it.
#[test]
fn a_drain_writes_about_a_piece_of_output() {
    let doc = format!("\"{}\"", "a".repeat(100_000));
    for program in [
        ". as $x | range(100) | $x",
        ". as $x | range(100) | [$x] | debug | empty",
        ". as $x | range(100) | [$x] | stderr | empty",
    ] {
        let mut stream = open(program, 1 << 16);
        let mut wire = Vec::new();
        stream.feed(doc.as_bytes(), &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        let mut drains = 0;
        while stream.busy() {
            let before = wire.len();
            stream.drain(&mut wire).unwrap();
            assert!(wire.len() - before < 2 * doc.len(), "{program}");
            drains += 1;
        }
        assert!(drains >= 100, "{program}: {drains} drains");
    }
}

/// Deleting at the end of a path as long as jq accepts walks the value
/// without recursion.
#[test]
fn delpaths_walks_a_deep_path_without_recursion() {
    assert_eq!(
        outputs(
            "[range(10000) | 0] as $p | null | setpath($p; 1) | delpaths([$p]) | getpath($p[:-1])",
            "null"
        ),
        vec!["[]"]
    );
    assert_eq!(
        outputs(
            r#"delpaths([["a", 0], ["a", 2], ["b"]])"#,
            r#"{"a":[1,2,3],"b":4,"c":5}"#
        ),
        vec![r#"{"a":[2],"c":5}"#]
    );
}

/// Every unit of a repeat, a control-escape chain and a backreference
/// compare is charged, so one step never does unbounded work.
#[test]
fn regex_edge_cases_match_as_oniguruma_does() {
    assert_eq!(
        outputs(r#"[test("\\c\\c?"), test("\\cA")]"#, r#""\u001f""#),
        vec!["[true,false]"]
    );
    assert_eq!(
        outputs(r#"match("(?=a\\K)") | [.offset, .length]"#, r#""a""#),
        vec!["[0,0]"]
    );
    assert_eq!(outputs(r#"test("(.*)x\\1")"#, r#""axbb""#), vec!["true"]);
    assert_eq!(outputs(r#"test("^(.*)\\1$")"#, r#""abab""#), vec!["true"]);
}

#[test]
fn a_long_repeat_pauses_with_the_budget() {
    let hay = format!("\"{}\"", "a".repeat(100_000));
    for program in [r#"test("^a*$")"#, r#"test("^(a{50000})\\1$")"#] {
        let mut stream = open(program, 1 << 10);
        let mut wire = Vec::new();
        stream.feed(hay.as_bytes(), &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        let mut drains = 0;
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
            drains += 1;
        }
        assert!(drains > 50, "{program}: {drains} drains");
        assert_eq!(frames(&wire), vec![Frame::Out("true".into())], "{program}");
    }
}

#[test]
fn sorting_mixed_literal_and_computed_numbers_never_panics() {
    let got = outputs(
        "[9007199254740993, (9007199254740992 + 0), 9007199254740992, 9007199254740993] | sort | length",
        "null",
    );
    assert_eq!(got, vec!["4"]);
}

#[test]
fn input_reads_every_number_spelling_the_reader_accepts() {
    for text in ["nan00", "nan", "-nan", "NaN"] {
        assert!(parse_json(text).is_ok(), "{text}");
    }
}

#[test]
fn memory_errors_cover_sort_dump_parse_and_program_constants() {
    for program in [
        "[range(2000)] | sort | length",
        "[range(2000)] | tojson | length",
        "[range(2000)]",
        r#"("[" + ("0," * 2000) + "0]") | fromjson | length"#,
        r#""xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx""#,
    ] {
        let memory = if program.starts_with('"') { 16 } else { 60_000 };
        let got = limited(serde_json::json!({"program":program,"memory":memory,"steps":7}));
        assert!(
            matches!(&got[..], [Frame::Err(error)] if error==&format!("jq memory limit of {memory} bytes exceeded")),
            "{program}: {got:?}"
        );
    }
}

#[test]
fn key_reads_share_large_text_through_arrays_and_paths() {
    let input = format!("{{\"{}\":1}}", "x".repeat(90000));
    for steps in [7, u64::MAX] {
        for operation in ["keys[]", "keys_unsorted[]", "path(.[])[]"] {
            let program = format!(
                ". as $o | [range(10) | $o | {operation}] as $keys | input | $keys | length"
            );
            let config = serde_json::json!({"program":program,"steps":steps,"memory":300000});
            let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
            for cancel in [false, true, false] {
                let mut wire = Vec::new();
                stream.begin(b"{}").unwrap();
                stream.feed(input.as_bytes(), &mut wire).unwrap();
                stream.finish(&mut wire).unwrap();
                while stream.busy() {
                    stream.drain(&mut wire).unwrap();
                }
                assert!(stream.request(&mut Vec::new()).is_some());
                if cancel {
                    assert!(stream.cancel());
                } else {
                    stream
                        .respond(br#"{"kind":"value"}"#, b"0", &mut wire)
                        .unwrap();
                }
                settle(&mut *stream, &mut wire);
                assert_eq!(
                    frames(&wire),
                    if cancel {
                        vec![]
                    } else {
                        vec![Frame::Out("10".into())]
                    },
                    "{operation}, {steps} steps"
                );
            }
        }
    }
}

#[test]
fn nul_dump_format_names_keep_sliced_progress_and_output() {
    for (name, input) in [
        ("json", Value::string("é".repeat(100000))),
        ("json", Value::array(vec![Value::Null; 20000])),
        ("text", Value::array(vec![Value::Null; 20000])),
    ] {
        let expected = input.dump();
        for suffix in ["", "\\u0000tail"] {
            let source = format!("format(\"{name}{suffix}\")");
            let program = Arc::new(compile(&source, &HashMap::new()).unwrap());
            let meter = Arc::new(Meter::default());
            let _installed = meter::install(&meter);
            let mut vm = Vm::start(program, input.clone(), LIMITS, Arc::clone(&meter));
            for _ in 0..100 {
                assert!(
                    matches!(vm.next(&mut 7), Next::Paused),
                    "{source} yielded early"
                );
            }
            while !vm.retire(7) {}
            drop(vm);
            assert_eq!(meter.live(), 0);
            for steps in [7, u64::MAX] {
                assert_eq!(
                    run(&source, &expected, steps),
                    vec![Frame::Out(serde_json::to_string(&expected).unwrap())]
                );
            }
        }
    }
}

#[test]
fn extrema_keep_only_the_input_and_key_collections() {
    for steps in [7, u64::MAX] {
        for (operation, memory, expected) in [
            ("min", 1_000_000, "0"),
            ("max", 1_000_000, "19999"),
            ("min_by(.)", 4_000_000, "0"),
            ("max_by(.)", 4_000_000, "19999"),
        ] {
            let program = format!("[range(20000)] | {operation}");
            assert_eq!(
                limited(serde_json::json!({"program":program,"memory":memory,"steps":steps})),
                vec![Frame::Out(expected.into())],
                "{operation}, {steps} steps"
            );
        }
    }
    for (program, expected) in [
        (
            "[] | [min,max,min_by(.),max_by(.)]",
            "[null,null,null,null]",
        ),
        (
            r#"[{k:1,v:"a"},{k:1,v:"b"}] | [min_by(.k),max_by(.k)]"#,
            r#"[{"k":1,"v":"a"},{"k":1,"v":"b"}]"#,
        ),
        (
            "[nan,1,nan,2] | [min,max,min_by(.),max_by(.)]",
            "[null,2,null,2]",
        ),
        (
            "[[1,2],[1,1],[1,2]] | [min,max,min_by(.),max_by(.)]",
            "[[1,1],[1,2],[1,1],[1,2]]",
        ),
        (
            "[9007199254740993,(9007199254740992+0),9007199254740992] | [min,max,min_by(.),max_by(.)]",
            "[9007199254740992,9007199254740992,9007199254740992,9007199254740992]",
        ),
    ] {
        for steps in [7, u64::MAX] {
            assert_eq!(
                run(program, "null", steps),
                vec![Frame::Out(expected.into())]
            );
        }
    }
}

#[test]
fn pending_formats_and_extrema_cancel_and_reuse_the_stream() {
    let array = format!("[{}null]", "null,".repeat(19999));
    let string = serde_json::to_string(&"é".repeat(100000)).unwrap();
    for (operation, input, expected) in [
        (
            r#"format("json\u0000tail") | length"#,
            string.as_str(),
            "100002",
        ),
        (
            r#"format("json\u0000tail") | length"#,
            array.as_str(),
            "100001",
        ),
        (
            r#"format("text\u0000tail") | length"#,
            array.as_str(),
            "100001",
        ),
        ("min", array.as_str(), "null"),
        ("max", array.as_str(), "null"),
        ("min_by(.)", array.as_str(), "null"),
        ("max_by(.)", array.as_str(), "null"),
    ] {
        for steps in [7, u64::MAX] {
            let program = format!(". as $x | input | $x | {operation}");
            let mut stream = open(&program, steps);
            for cancel in [false, true, false] {
                let mut wire = Vec::new();
                stream.begin(b"{}").unwrap();
                stream.feed(input.as_bytes(), &mut wire).unwrap();
                stream.finish(&mut wire).unwrap();
                while stream.busy() {
                    stream.drain(&mut wire).unwrap();
                }
                assert!(stream.request(&mut Vec::new()).is_some());
                stream
                    .respond(br#"{"kind":"value"}"#, b"0", &mut wire)
                    .unwrap();
                if cancel {
                    if steps == 7 {
                        for _ in 0..100 {
                            assert!(stream.busy());
                            stream.drain(&mut wire).unwrap();
                        }
                        assert!(wire.is_empty(), "{operation} emitted before completion");
                    }
                    assert!(stream.cancel());
                }
                settle(&mut *stream, &mut wire);
                assert_eq!(
                    frames(&wire),
                    if cancel {
                        vec![]
                    } else {
                        vec![Frame::Out(expected.into())]
                    },
                    "{operation}, {steps} steps"
                );
            }
        }
    }
}

#[test]
fn long_number_scratch_limits_are_terminal_and_reset_between_runs() {
    let number = format!("1{}", "0".repeat(4999));
    let invalid = format!("{number}e");
    for steps in [7, u64::MAX] {
        for memory in [16000, 20000] {
            let config = serde_json::json!({
                "program":"try input catch empty | empty", "memory":memory, "steps":steps,
            });
            let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
            for (source, cancel) in [
                (number.as_str(), false),
                ("1", false),
                (number.as_str(), true),
                (invalid.as_str(), false),
                ("1", false),
            ] {
                let mut wire = Vec::new();
                stream.begin(b"{}").unwrap();
                stream.feed(b"null", &mut wire).unwrap();
                stream.finish(&mut wire).unwrap();
                while stream.busy() {
                    stream.drain(&mut wire).unwrap();
                }
                assert!(stream.request(&mut Vec::new()).is_some());
                stream
                    .respond(br#"{"kind":"value"}"#, source.as_bytes(), &mut wire)
                    .unwrap();
                if cancel {
                    if steps == 7 {
                        for _ in 0..100 {
                            assert!(stream.busy());
                            stream.drain(&mut wire).unwrap();
                        }
                    }
                    assert!(stream.cancel());
                }
                settle(&mut *stream, &mut wire);
                let expected = if !cancel && source == number && memory == 16000 {
                    vec![Frame::Err("jq memory limit of 16000 bytes exceeded".into())]
                } else {
                    vec![]
                };
                assert_eq!(frames(&wire), expected, "{memory} bytes, {steps} steps");
            }
        }
    }
}

#[test]
fn retirement_releases_cancelled_and_completed_pending_tasks() {
    for (program, input, drains) in [
        (
            "sort | length",
            Value::array(
                (0..20000)
                    .rev()
                    .map(|i| Value::number(f64::from(i)))
                    .collect(),
            ),
            100,
        ),
        (
            "tojson | length",
            Value::array(vec![Value::Null; 20000]),
            100,
        ),
        (
            "fromjson | length",
            Value::string(format!("[{}]", vec!["null"; 20000].join(","))),
            100,
        ),
        (
            r#"match(".";"g") | length"#,
            Value::string("x".repeat(20000)),
            100,
        ),
    ] {
        let program = Arc::new(compile(program, &HashMap::new()).unwrap());
        let meter = Arc::new(Meter::default());
        let _installed = meter::install(&meter);
        let mut vm = Vm::start(program, input, LIMITS, Arc::clone(&meter));
        for _ in 0..drains {
            assert!(matches!(vm.next(&mut 7), Next::Paused));
        }
        let mut steps = 0;
        while !vm.retire(1) {
            steps += 1;
            assert!(steps < 1_000_000);
        }
        assert!(steps > 1, "{steps} retirement steps");
        drop(vm);
        assert_eq!(meter.live(), 0);
    }
    let program = Arc::new(
        compile(
            "[range(2000)] | sort | tojson | fromjson | length",
            &HashMap::new(),
        )
        .unwrap(),
    );
    let meter = Arc::new(Meter::default());
    let _installed = meter::install(&meter);
    let mut vm = Vm::start(program, Value::Null, LIMITS, Arc::clone(&meter));
    loop {
        match vm.next(&mut 7) {
            Next::Paused => {}
            Next::Output(value) => assert_eq!(value.as_f64(), Some(2000.0)),
            Next::Done => break,
            _ => panic!("unexpected result"),
        }
    }
    while !vm.retire(1) {}
    drop(vm);
    assert_eq!(meter.live(), 0);
}

#[test]
fn subtraction_keeps_nan_equality_and_shared_container_behavior() {
    for (program, expected) in [
        ("[nan,nan,1]-[nan]", "[null,null,1]"),
        ("[[nan],[nan],[1]]-[[nan]]", "[[null],[null],[1]]"),
        ("[{a:nan},{a:1}]-[{a:nan}]", r#"[{"a":null},{"a":1}]"#),
        ("[1,nan,nan]|group_by(.)|map(length)", "[1,1,1]"),
        ("[nan] as $a | [$a]-[$a]", "[]"),
        ("[nan] == [nan]", "false"),
        ("[nan] as $a | $a == $a", "true"),
        ("[[nan],[nan]] | unique", "[[null],[null]]"),
        ("[nan] as $a | [$a,$a] | unique", "[[null]]"),
    ] {
        assert_eq!(run(program, "null", 1), vec![Frame::Out(expected.into())]);
    }
}

#[test]
fn deep_programs_compile_and_run_on_a_small_stack() {
    type Shape = (
        fn(usize) -> String,
        usize,
        usize,
        usize,
        usize,
        &'static str,
    );
    let shapes: &[Shape] = &[
        (|n| ".a".repeat(n), 20000, 0, 0, 0, "null"),
        (
            |n| format!("1{}", " | .".repeat(n)),
            4997,
            4998,
            19993,
            1,
            "1",
        ),
        (
            |n| format!("{}0{}", "reduce 1 as $x (".repeat(n), "; .)".repeat(n)),
            1998,
            1999,
            31986,
            1,
            "0",
        ),
        (
            |n| format!("{}0{}", "if true then ".repeat(n), " else 0 end".repeat(n)),
            3330,
            3331,
            43313,
            3,
            "0",
        ),
        (
            |n| format!("{}1", "try ".repeat(n)),
            9995,
            9996,
            39985,
            1,
            "1",
        ),
        (
            |n| format!("{}1{}", "[".repeat(n), "]".repeat(n)),
            9994,
            9995,
            9997,
            1,
            "",
        ),
        (
            |n| format!("{}1{}", "(".repeat(n), ")".repeat(n)),
            9994,
            9995,
            9997,
            1,
            "1",
        ),
        (
            |n| format!("{}1{}", "(-".repeat(n), ")".repeat(n)),
            4997,
            4998,
            9997,
            1,
            "-1",
        ),
        (
            |n| format!("{}1", "1 as $x | ".repeat(n)),
            2498,
            2499,
            24991,
            1,
            "1",
        ),
    ];
    let worker = std::thread::Builder::new().stack_size(1 << 20);
    let handle = worker
        .spawn(move || {
            for (make, deepest, refused, column, carets, want) in shapes {
                let program = make(*deepest);
                let got = outputs(&program, "{}");
                if want.is_empty() {
                    assert_eq!(got.len(), 1, "{deepest} brackets");
                    assert_eq!(got[0].len(), 2 * deepest + 1, "{deepest} brackets");
                } else {
                    assert_eq!(got, vec![want.to_string()], "{program:.40}");
                }
                if *refused == 0 {
                    continue;
                }
                let program = make(*refused);
                let report = format!(
                    "jq: error: memory exhausted at <top-level>, line 1, column {column}:\n    {program}\n    {}{}\njq: 1 compile error",
                    " ".repeat(column - 1),
                    "^".repeat(*carets)
                );
                assert_eq!(invalid_report(&program), report, "{program:.40}");
            }
        })
        .unwrap();
    handle.join().unwrap();
}

#[test]
fn loadvn_and_interpolated_keys_run_as_jq_runs_them() {
    let cases: &[(&str, &str, &[&str])] = &[
        ("1 as $x | [$$$$x, $x]", "null", &["[1,null]"]),
        ("def f($x): $$$$x; f(1)", "null", &["1"]),
        (
            "1 as $x | def g($y): $$$$y + $$$$x; [g(2), $x]",
            "null",
            &["[3,null]"],
        ),
        ("reduce (1,2) as $x (0; . + $$$$x)", "null", &["3"]),
        (r#"{"\(1,2)"}"#, "null", &[r#"{"1":null}"#, r#"{"2":null}"#]),
        (
            r#"{"\("a","b")"}"#,
            r#"{"a":1,"b":2}"#,
            &[r#"{"a":1}"#, r#"{"b":2}"#],
        ),
        (
            r#"{a, "b", "\("c")": 3}"#,
            r#"{"a":1}"#,
            &[r#"{"a":1,"b":null,"c":3}"#],
        ),
    ];
    for (program, input, want) in cases {
        assert_eq!(outputs(program, input), *want, "{program}");
    }
}

#[test]
fn platform_paths_and_build_configuration_keep_the_pre_execution_fallback() {
    for program in [
        "get_jq_origin",
        "get_prog_origin",
        "$JQ_BUILD_CONFIGURATION",
    ] {
        assert!(
            matches!(refusal(program), Refusal::Unsupported(_)),
            "{program}"
        );
    }
    let globals = HashMap::from([("JQ_BUILD_CONFIGURATION".into(), Value::string("provided"))]);
    assert!(compile("$JQ_BUILD_CONFIGURATION", &globals).is_ok());
}

#[test]
fn unsupported_local_zones_refuse_before_effects_or_dynamic_arguments() {
    for zone in [
        None,
        Some("Europe/Paris"),
        Some("America/New_York"),
        Some("GB-Eire"),
        Some("Unknown/1868"),
        Some("/usr/share/zoneinfo/Europe/Paris"),
        Some(":/usr/share/zoneinfo/Europe/Paris"),
        Some("posix/Europe/Paris"),
        Some("right/Europe/Paris"),
    ] {
        for program in [
            "localtime",
            "strflocaltime(\"%Z %z\")",
            "strptime(\"%s\")",
            "debug | localtime",
            "input | localtime",
            "def alias: localtime; alias",
            "debug | strflocaltime(\"%Z\")",
            "input | strptime(.)",
            "def alias: strflocaltime(.); alias",
            "\"%Z\" as $format | strflocaltime($format)",
            "def invoke(f): f; invoke(strptime(.))",
        ] {
            let config = serde_json::json!({"program": program, "zone": zone});
            let error = super::eval::open(config.to_string().as_bytes())
                .err()
                .unwrap();
            assert_eq!(
                error.message, "jq_eval: no time zone for local time",
                "{program}"
            );
        }
        for program in [
            ".",
            "gmtime",
            "mktime",
            "strftime(\"%Z\")",
            "def localtime: 42; localtime",
            "def strptime($format): 42; strptime(\"%s\")",
            "def strflocaltime($format): 42; strflocaltime(\"%Z\")",
            "def unused: localtime; .",
        ] {
            let config = serde_json::json!({"program": program, "zone": zone});
            assert!(
                super::eval::open(config.to_string().as_bytes()).is_ok(),
                "{program}"
            );
        }
    }
    for zone in ["UTC", "UTC0", "EST5EDT,M3.2.0,M11.1.0", "<+07>-7"] {
        for program in ["localtime", "strflocaltime(\"%Z %z\")", "strptime(\"%s\")"] {
            let config = serde_json::json!({"program": program, "zone": zone});
            assert!(
                super::eval::open(config.to_string().as_bytes()).is_ok(),
                "{zone} {program}"
            );
        }
    }
}

#[test]
fn nonexact_libm_builtins_keep_the_pre_execution_fallback() {
    for (name, arity) in [
        ("erf", 0),
        ("erfc", 0),
        ("gamma", 0),
        ("lgamma", 0),
        ("lgamma_r", 0),
        ("tgamma", 0),
        ("j0", 0),
        ("j1", 0),
        ("jn", 2),
        ("y0", 0),
        ("y1", 0),
        ("yn", 2),
        ("remainder", 2),
        ("drem", 2),
    ] {
        let program = if arity == 0 {
            name.to_string()
        } else {
            format!("{name}(1;2)")
        };
        assert!(
            matches!(refusal(&program), Refusal::Unsupported(_)),
            "{program}"
        );
    }
    assert_eq!(
        run("def erf: 42; erf", "null", 1),
        vec![Frame::Out("42".into())]
    );
}

#[test]
fn remainder_aliases_keep_the_pre_execution_fallback_at_extremes() {
    for name in ["remainder", "drem"] {
        for args in ["1.7976931348623157e308;1e308", "5e-324;5e-324", "5;2"] {
            let call = format!("{name}({args})");
            for program in [
                call.clone(),
                format!("def alias: {call}; alias"),
                format!("debug | {call}"),
                format!("input | {call}"),
                format!("try {call} catch ."),
            ] {
                assert!(
                    matches!(refusal(&program), Refusal::Unsupported(_)),
                    "{program}"
                );
            }
        }
        assert_eq!(
            run(
                &format!("def {name}($a; $b): $a + $b; {name}(2;3)"),
                "null",
                1
            ),
            vec![Frame::Out("5".into())],
            "{name}"
        );
    }
    assert_eq!(
        outputs("[fmod(5;2), fmod(-5;2), 5 % 2, -5 % 2]", "null"),
        vec!["[1,-1,1,-1]"]
    );
}

#[test]
fn rendered_diagnostics_cannot_bypass_the_memory_cap() {
    for program in [
        r#""\u0001" * 50000 | debug | empty"#,
        r#"["\u0001" * 50000] | stderr | empty"#,
        r#"["\u0001" * 50000] | error"#,
        r#""\u0001" * 20000 | halt_error(9)"#,
        r#"["\u0001" * 20000] | halt_error(9)"#,
        r#""\u0001" * 20000 | tojson | length"#,
    ] {
        let got = limited(serde_json::json!({"program":program,"memory":100000,"steps":7}));
        assert_eq!(
            got,
            vec![Frame::Err(
                "jq memory limit of 100000 bytes exceeded".into()
            )],
            "{program}"
        );
    }
}

#[test]
fn diagnostics_keep_their_frames_at_every_budget() {
    for program in [
        r#"["é\u007f\u0001"] | debug | stderr | error"#,
        r#"["é\u007f\u0001"] | halt_error(9)"#,
        r#""é\u007f\u0001" | halt_error(9)"#,
        "halt",
        "null | halt_error(3)",
    ] {
        let expected = run(program, "null", 65536);
        for budget in [1, 7, 128] {
            assert_eq!(run(program, "null", budget), expected, "{program}");
        }
    }
}

#[test]
fn initial_document_refusals_are_deferred_before_vm_execution() {
    for (data, expected) in [
        (&b"["[..], "Unfinished JSON term"),
        (&b"\"\xff\""[..], "jq_eval: document is not UTF-8"),
    ] {
        let mut stream = open(".", 1);
        let mut wire = Vec::new();
        stream.feed(data, &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        assert!(stream.busy());
        let error = loop {
            match stream.drain(&mut wire) {
                Ok(()) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(error.message, expected);
        assert!(wire.is_empty());
        assert!(stream.request(&mut Vec::new()).is_none());
        assert!(stream.cancel());
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
        }
        stream.begin(b"{}").unwrap();
        stream.feed(b"1", &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        settle(&mut *stream, &mut wire);
        assert_eq!(frames(&wire), vec![Frame::Out("1".into())]);
    }
}

#[test]
fn input_reply_json_errors_remain_catchable_and_utf8_remains_a_refusal() {
    let mut stream = open("try input catch .", 7);
    let mut wire = Vec::new();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert_eq!(
        stream.request(&mut Vec::new()).unwrap(),
        br#"{"op":"input"}"#
    );
    stream
        .respond(br#"{"kind":"value"}"#, b"[", &mut wire)
        .unwrap();
    settle(&mut *stream, &mut wire);
    assert_eq!(
        frames(&wire),
        vec![Frame::Out("\"Unfinished JSON term\"".into())]
    );
    wire.clear();
    stream.begin(b"{}").unwrap();
    stream.feed(b"null", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert!(stream.request(&mut Vec::new()).is_some());
    stream
        .respond(br#"{"kind":"value"}"#, b"\"\xff\"", &mut wire)
        .unwrap();
    let error = loop {
        match stream.drain(&mut wire) {
            Ok(()) => {}
            Err(error) => break error,
        }
    };
    assert_eq!(error.message, "jq_eval: document is not UTF-8");
    assert!(wire.is_empty());
    assert!(stream.cancel());
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
}

#[test]
fn rejected_timezone_format_buffers_still_latch_the_memory_limit() {
    let config = serde_json::json!({
        "program": "try strflocaltime(\"%Z\") catch \"caught\"",
        "memory": 100000,
        "steps": 7,
        "zone": format!("<{}>0", "x".repeat(90000)),
    });
    let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
    let mut wire = Vec::new();
    stream.feed(b"0", &mut wire).unwrap();
    stream.finish(&mut wire).unwrap();
    while stream.busy() {
        stream.drain(&mut wire).unwrap();
    }
    assert_eq!(
        frames(&wire),
        vec![Frame::Err(
            "jq memory limit of 100000 bytes exceeded".into()
        )]
    );
}

#[test]
fn over_limit_documents_retire_with_an_unlimited_step_budget() {
    let data = format!("[{}null]", "null,".repeat(40000));
    let memory = data.len() + 30000 * std::mem::size_of::<Value>();
    for program in [".", "input"] {
        let config = serde_json::json!({"program":program,"memory":memory,"steps":u64::MAX});
        let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
        let mut wire = Vec::new();
        if program == "input" {
            stream.feed(b"null", &mut wire).unwrap();
            stream.finish(&mut wire).unwrap();
            while stream.busy() {
                stream.drain(&mut wire).unwrap();
            }
            assert!(stream.request(&mut Vec::new()).is_some());
            stream
                .respond(br#"{"kind":"value"}"#, data.as_bytes(), &mut wire)
                .unwrap();
        } else {
            stream.feed(data.as_bytes(), &mut wire).unwrap();
            stream.finish(&mut wire).unwrap();
        }
        stream.drain(&mut wire).unwrap();
        assert_eq!(
            frames(&wire),
            vec![Frame::Err(format!(
                "jq memory limit of {memory} bytes exceeded"
            ))],
            "{program}"
        );
        let mut retired = 0;
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
            retired += 1;
        }
        assert!(retired > 1, "{program}: {retired} retirement drains");
    }
}

#[test]
fn low_caps_during_compilation_become_terminal_frames_without_panicking() {
    for steps in [1000, u64::MAX] {
        for program in [r#""\n" * 2000"#, r#""\n" * 2000 | tojson"#] {
            let config = serde_json::json!({"program":program,"memory":6000,"steps":steps});
            let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
            for begin in [false, true] {
                let mut wire = Vec::new();
                if begin {
                    stream.begin(b"{}").unwrap();
                }
                stream.feed(b"null", &mut wire).unwrap();
                stream.finish(&mut wire).unwrap();
                settle(&mut *stream, &mut wire);
                assert_eq!(
                    frames(&wire),
                    vec![Frame::Err("jq memory limit of 6000 bytes exceeded".into())],
                    "{program} steps={steps} begin={begin}"
                );
            }
        }
    }
}

#[test]
fn compilation_limits_cannot_become_availability_refusals() {
    for (program, zone, memory) in [
        ("remainder(1;2)", "UTC", 0),
        (r#""\n" | strflocaltime("%Z")"#, "Europe/Paris", 6000),
        ("localtime", "/usr/share/zoneinfo/Europe/Paris", 0),
    ] {
        let config = serde_json::json!({"program":program,"zone":zone,"memory":memory});
        let mut stream = super::eval::open(config.to_string().as_bytes()).unwrap();
        let mut wire = Vec::new();
        stream.begin(b"{}").unwrap();
        stream.feed(b"0", &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        settle(&mut *stream, &mut wire);
        assert_eq!(
            frames(&wire),
            vec![Frame::Err(format!(
                "jq memory limit of {memory} bytes exceeded"
            ))]
        );
    }
}

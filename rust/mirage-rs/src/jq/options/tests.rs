use serde_json::{Value as Json, json};

use crate::open;

const HINT: &str = "Use jq --help for help with command-line options,\n\
or see the jq manpage, or online docs at https://jqlang.org";

const FILES: [(&str, &[u8]); 6] = [
    ("four.json", b"1\n2\n3\n4\n"),
    ("one.json", b"1"),
    ("two.json", b" 2\n"),
    ("bad.json", b"{\"a\":1}\n{\"a\":2}\n["),
    ("spelled.json", b"{\"b\":1.000,\"1\":2}"),
    ("raw.txt", b"a\xffb\n"),
];

/// What the loop makes of `words`, served the way a host serves it,
/// with every file it asked for: its plan, or its stderr and status.
fn walk(words: &[(&str, &str)]) -> (Result<Json, (String, i32)>, Vec<String>) {
    let mut asked = Vec::new();
    let result = drive(words, &mut asked);
    (result, asked)
}

fn drive(words: &[(&str, &str)], asked: &mut Vec<String>) -> Result<Json, (String, i32)> {
    let refused = |error: crate::StreamError| {
        (
            String::from_utf8_lossy(&error.stderr()).into_owned(),
            error.status,
        )
    };
    let options: Vec<(&str, String)> = words
        .iter()
        .map(|(name, text)| (*name, text.bytes().map(char::from).collect()))
        .collect();
    let config = json!({ "options": options }).to_string();
    let mut stream = open("jq_options", config.as_bytes()).map_err(refused)?;
    let mut out = Vec::new();
    loop {
        while stream.busy() {
            stream.drain(&mut out).map_err(refused)?;
        }
        let mut data = Vec::new();
        let Some(header) = stream.request(&mut data) else {
            break;
        };
        let header: Json = serde_json::from_slice(&header).expect("json");
        let at = header["at"].as_u64().expect("an index") as usize;
        let word = words[at].1;
        asked.push(word.to_owned());
        let (reply, data): (Json, &[u8]) = match FILES.iter().find(|(name, _)| *name == word) {
            Some((_, bytes)) => (json!({"kind": "data"}), bytes),
            None if word == "dir" => (json!({"kind": "error", "directory": true}), b""),
            None => (
                json!({"kind": "error", "message": "No such file or directory"}),
                b"",
            ),
        };
        stream
            .respond(reply.to_string().as_bytes(), data, &mut out)
            .map_err(refused)?;
    }
    stream.finish(&mut out).map_err(refused)?;
    Ok(serde_json::from_slice(&out).expect("a plan"))
}

fn config(words: &[(&str, &str)]) -> Json {
    let (plan, _) = walk(words);
    plan.expect("read")["config"].clone()
}

fn refusal(words: &[(&str, &str)]) -> (String, i32) {
    walk(words).0.expect_err("refused")
}

fn hinted(line: &str) -> (String, i32) {
    (format!("jq: {line}\n{HINT}"), 2)
}

fn layout(config: &Json) -> Json {
    if config["compact"] == json!(true) {
        json!("compact")
    } else if config["tab"] == json!(true) {
        json!("tab")
    } else {
        config["indent"].clone()
    }
}

#[test]
fn indent_reads_its_word_as_jqs_strtol_does() {
    let zeros = "0".repeat(5000);
    for (word, width) in [
        ("3".to_owned(), 3),
        ("+3".to_owned(), 3),
        ("07".to_owned(), 7),
        ("-0".to_owned(), 0),
        ("0".to_owned(), 0),
        (format!("{zeros}7"), 7),
        (format!("+{zeros}3"), 3),
        (format!("-{zeros}0"), 0),
    ] {
        let config = config(&[("indent", &word)]);
        assert_eq!(config["indent"], json!(width), "{word}");
        assert_eq!(config["tab"], json!(false), "{word}");
    }
    let config = config(&[("indent", &format!("-{zeros}1"))]);
    assert_eq!(
        (&config["tab"], &config["indent"]),
        (&json!(true), &json!(2))
    );
}

#[test]
fn indent_refuses_any_other_word_in_jqs_words() {
    let nines = "9".repeat(5000);
    let zeros = "0".repeat(5000);
    for word in [
        "x".to_owned(),
        "2x".to_owned(),
        String::new(),
        " 3".to_owned(),
        "3 ".to_owned(),
        "3\n".to_owned(),
        "1.5".to_owned(),
        "0x3".to_owned(),
        "08".to_owned(),
        "-2".to_owned(),
        "+".to_owned(),
        "99999999999999999999".to_owned(),
        format!("{nines}8"),
        format!("-{nines}8"),
        format!("{zeros}8"),
    ] {
        assert_eq!(
            refusal(&[("indent", &word)]),
            hinted("--indent takes a number between -1 and 7"),
            "{word:?}"
        );
    }
}

#[test]
fn the_last_layout_option_typed_wins() {
    let c = ("compact_output", "");
    let tab = ("tab", "");
    let r = ("raw_output", "");
    for (words, expected) in [
        (vec![c, tab], json!("tab")),
        (vec![tab, c], json!("compact")),
        (vec![("indent", "3"), c], json!("compact")),
        (vec![c, ("indent", "3")], json!(3)),
        (vec![tab, ("indent", "3")], json!(3)),
        (vec![("indent", "3"), tab], json!("tab")),
        (vec![("indent", "-1"), c], json!("compact")),
        (vec![c, ("indent", "-1")], json!("tab")),
        (vec![c, r, tab], json!("tab")),
        (vec![tab, r, c], json!("compact")),
        (vec![("indent", "2"), ("indent", "5")], json!(5)),
        (vec![], json!(2)),
    ] {
        assert_eq!(layout(&config(&words)), expected, "{words:?}");
    }
    assert_eq!(
        refusal(&[("indent", "2"), ("indent", "x")]),
        hinted("--indent takes a number between -1 and 7")
    );
}

#[test]
fn join_and_nul_output_imply_raw() {
    for switch in ["join_output", "raw_output0", "raw_output"] {
        let config = config(&[(switch, "")]);
        assert_eq!(config["raw_output"], json!(true), "{switch}");
        assert_eq!(config["nul_output"], json!(switch == "raw_output0"));
    }
    let config = config(&[
        ("null_input", ""),
        ("monochrome_output", ""),
        ("unbuffered", ""),
    ]);
    assert_eq!(
        (
            &config["null_input"],
            &config["raw_output"],
            &config["slurp"]
        ),
        (&json!(true), &json!(false), &json!(false))
    );
    assert!(config.get("monochrome_output").is_none());
}

#[test]
fn the_program_is_the_first_operand_else_dot_unless_a_file_holds_it() {
    let plan = |words: &[(&str, &str)]| walk(words).0.expect("read");
    assert_eq!(
        plan(&[]),
        json!({"config": config(&[]), "program_file": null})
    );
    assert_eq!(config(&[])["program"], json!("."));
    assert_eq!(
        config(&[("", ".a"), ("", "f.json")])["program"],
        json!(".a")
    );
    let typed = [
        ("", "f.json"),
        ("from_file", "p.jq"),
        ("args", ""),
        ("", "x"),
    ];
    assert_eq!(plan(&typed)["program_file"], json!(1));
    assert_eq!(config(&typed)["positional"], json!(["\"x\""]));
}

#[test]
fn the_plan_is_the_run_config_jq_opens_with() {
    let config = config(&[("indent", "3"), ("join_output", "")]);
    let opened = crate::open("jq", config.to_string().as_bytes());
    assert!(opened.is_ok());
    for absent in ["env", "zone", "prog_origin", "memory", "steps"] {
        assert!(config.get(absent).is_none(), "{absent}");
    }
}

#[test]
fn arg_binds_a_string_and_argjson_the_text_jq_reads() {
    let named = config(&[
        ("arg", "a"),
        ("arg", "1"),
        ("arg", "b"),
        ("arg", "x\"y\u{e9}"),
        ("argjson", "c"),
        ("argjson", " {\"b\":1.000,\"1\":2} "),
        ("argjson", "d"),
        ("argjson", "nan"),
    ])["named"]
        .clone();
    assert_eq!(
        named,
        json!([
            ["a", "\"1\""],
            ["b", "\"x\\\"y\u{e9}\""],
            ["c", "{\"b\":1.000,\"1\":2}"],
            ["d", "nan"]
        ])
    );
    for value in ["nope", "1 2", "", "[1,", "1 ["] {
        assert_eq!(
            refusal(&[("argjson", "v"), ("argjson", value)]),
            hinted("invalid JSON text passed to --argjson"),
            "{value:?}"
        );
    }
}

#[test]
fn bindings_keep_the_order_they_were_typed_in() {
    let named = config(&[
        ("slurpfile", "s"),
        ("slurpfile", "four.json"),
        ("arg", "a"),
        ("arg", "1"),
        ("rawfile", "r"),
        ("rawfile", "raw.txt"),
        ("argjson", "b"),
        ("argjson", "2"),
        ("slurpfile", "t"),
        ("slurpfile", "spelled.json"),
    ])["named"]
        .clone();
    assert_eq!(
        named,
        json!([
            ["s", "[1,2,3,4]"],
            ["a", "\"1\""],
            ["r", "\"a\u{fffd}b\\n\""],
            ["b", "2"],
            ["t", "[{\"b\":1.000,\"1\":2}]"]
        ])
    );
}

#[test]
fn the_first_binding_of_a_name_wins_and_a_later_one_is_never_read() {
    for (words, text) in [
        (
            vec![
                ("argjson", "v"),
                ("argjson", "1"),
                ("argjson", "v"),
                ("argjson", "2"),
            ],
            "1",
        ),
        (
            vec![
                ("arg", "v"),
                ("arg", "1"),
                ("argjson", "v"),
                ("argjson", "nope"),
            ],
            "\"1\"",
        ),
        (
            vec![
                ("rawfile", "v"),
                ("rawfile", "one.json"),
                ("arg", "v"),
                ("arg", "2"),
            ],
            "\"1\"",
        ),
        (
            vec![
                ("slurpfile", "v"),
                ("slurpfile", "two.json"),
                ("rawfile", "v"),
                ("rawfile", "missing"),
            ],
            "[2]",
        ),
        (
            vec![
                ("arg", "v"),
                ("arg", "1"),
                ("slurpfile", "v"),
                ("slurpfile", "bad.json"),
            ],
            "\"1\"",
        ),
    ] {
        let (plan, asked) = walk(&words);
        assert_eq!(plan.expect("read")["config"]["named"], json!([["v", text]]));
        assert!(asked.len() <= 1, "{asked:?}");
    }
}

#[test]
fn a_flag_file_is_refused_in_jqs_words() {
    assert_eq!(
        refusal(&[("slurpfile", "x"), ("slurpfile", "bad.json")]),
        (
            "jq: Bad JSON in --slurpfile x bad.json: Unfinished JSON term at EOF at line 3, column 1"
                .to_owned(),
            2
        )
    );
    for option in ["rawfile", "slurpfile"] {
        for (file, reason) in [
            ("missing", "No such file or directory"),
            ("dir", "It's a directory"),
        ] {
            assert_eq!(
                refusal(&[(option, "x"), (option, file)]),
                (
                    format!("jq: Bad JSON in --{option} x {file}: Could not open {file}: {reason}"),
                    2
                )
            );
        }
    }
}

#[test]
fn each_operand_takes_the_mode_typed_last_before_it() {
    let args = ("args", "");
    let json = ("jsonargs", "");
    for (words, positional) in [
        (
            vec![args, ("", "a"), json, ("", "1"), args, ("", "b")],
            json!(["\"a\"", "1", "\"b\""]),
        ),
        (
            vec![json, ("", "1"), args, ("", "a")],
            json!(["1", "\"a\""]),
        ),
        (vec![args, json, ("", "1")], json!(["1"])),
        (
            vec![args, ("", "{"), json, ("", "1")],
            json!(["\"{\"", "1"]),
        ),
        (
            vec![("", "a.json"), args, ("", "x"), ("", "b.json")],
            json!(["\"x\"", "\"b.json\""]),
        ),
        (
            vec![json, ("", "1"), ("arg", "x"), ("arg", "y"), ("", "2")],
            json!(["1", "2"]),
        ),
        (
            vec![json, ("", " {\"b\":1,\"1\":2.50} ")],
            json!(["{\"b\":1,\"1\":2.50}"]),
        ),
        (vec![("", "a.json")], json!([])),
    ] {
        let mut typed = vec![("", ".")];
        typed.extend(words);
        assert_eq!(config(&typed)["positional"], positional, "{typed:?}");
    }
    let config = config(&[json, ("", "."), ("", "1"), args, ("", "2"), json, ("", "3")]);
    assert_eq!(config["program"], json!("."));
    assert_eq!(config["positional"], json!(["1", "\"2\"", "3"]));
    let typed = [
        ("from_file", "p.jq"),
        ("", "a.json"),
        args,
        ("", "b"),
        json,
        ("", "2"),
    ];
    assert_eq!(
        super::tests::config(&typed)["positional"],
        json!(["\"b\"", "2"])
    );
    assert_eq!(
        refusal(&[("", "."), json, ("", "nope")]),
        hinted("invalid JSON text passed to --jsonargs")
    );
}

#[test]
fn a_refused_option_is_worded_as_jq_words_it() {
    for (word, line) in [
        ("-x", "Unknown option -x"),
        ("--indent=3", "Unknown option --indent=3"),
        (
            "--arg",
            "--arg takes two parameters (e.g. --arg varname value)",
        ),
        (
            "--argjson",
            "--argjson takes two parameters (e.g. --argjson varname text)",
        ),
        (
            "--rawfile",
            "--rawfile takes two parameters (e.g. --rawfile varname filename)",
        ),
        (
            "--slurpfile",
            "--slurpfile takes two parameters (e.g. --slurpfile varname filename)",
        ),
        ("--indent", "--indent takes one parameter"),
    ] {
        assert_eq!(refusal(&[("?", word)]), hinted(line));
    }
    for word in ["-f", "--from-file"] {
        let (usage, status) = refusal(&[("?", word)]);
        assert!(usage.starts_with("jq - commandline JSON processor [version 1.8.2]\n"));
        assert!(usage.ends_with("For listing the command options, use jq --help."));
        assert_eq!(status, 2);
    }
}

#[test]
fn the_first_refusal_typed_is_the_one_reported() {
    let indent = "jq: --indent takes a number between -1 and 7";
    let argjson = "jq: invalid JSON text passed to --argjson";
    let jsonargs = "jq: invalid JSON text passed to --jsonargs";
    let missing = "jq: Bad JSON in --slurpfile b missing";
    let bad = "jq: Bad JSON in --slurpfile b bad.json";
    let bogus = "jq: Unknown option --bogus";
    let x = ("indent", "x");
    let nope = [("argjson", "a"), ("argjson", "nope")];
    let slurp = [("slurpfile", "b"), ("slurpfile", "missing")];
    let json = [("jsonargs", ""), ("", "nope")];
    let cat = |parts: &[&[(&'static str, &'static str)]]| -> Vec<(&'static str, &'static str)> {
        let mut words = vec![("", ".")];
        for part in parts {
            words.extend_from_slice(part);
        }
        words
    };
    for (words, reported) in [
        (cat(&[&[x], &nope]), indent),
        (cat(&[&nope, &[x]]), argjson),
        (cat(&[&nope, &slurp]), argjson),
        (cat(&[&slurp, &nope]), missing),
        (cat(&[&slurp, &[x]]), missing),
        (cat(&[&[x], &slurp]), indent),
        (
            cat(&[&[("slurpfile", "b"), ("slurpfile", "bad.json")], &[x]]),
            bad,
        ),
        (cat(&[&json, &[x]]), jsonargs),
        (cat(&[&[x], &json]), indent),
        (cat(&[&json, &nope]), jsonargs),
        (cat(&[&nope, &json]), argjson),
        (cat(&[&json, &slurp]), jsonargs),
        (cat(&[&slurp, &json]), missing),
        (
            cat(&[&[("jsonargs", ""), ("", "{"), ("?", "--bogus")]]),
            jsonargs,
        ),
        (
            cat(&[&[("?", "--bogus"), ("jsonargs", ""), ("", "{")]]),
            bogus,
        ),
        (cat(&[&[("indent", "9"), ("?", "--bogus")]]), indent),
        (cat(&[&[("?", "--bogus"), ("indent", "9")]]), bogus),
        (
            cat(&[&[("argjson", "x"), ("argjson", "{"), ("?", "-Z")]]),
            argjson,
        ),
        (
            cat(&[&[
                ("?", "--bogus"),
                ("slurpfile", "b"),
                ("slurpfile", "missing"),
            ]]),
            bogus,
        ),
    ] {
        let (stderr, status) = refusal(&words);
        assert!(stderr.starts_with(reported), "{words:?}: {stderr}");
        assert_eq!(status, 2);
    }
    let (_, asked) = walk(&cat(&[&[x], &slurp]));
    assert!(asked.is_empty());
}

#[test]
fn help_and_version_answer_where_the_loop_reaches_them() {
    let answer = |words: &[(&str, &str)]| walk(words).0.map(|plan| plan["answer"].clone());
    assert_eq!(answer(&[("help", ""), ("?", "--bogus")]), Ok(json!("help")));
    assert_eq!(
        answer(&[("null_input", ""), ("help", ""), ("?", "-x")]),
        Ok(json!("help"))
    );
    assert_eq!(
        answer(&[("", "."), ("version", ""), ("jsonargs", ""), ("", "{")]),
        Ok(json!("version"))
    );
    assert!(answer(&[("?", "--bogus"), ("help", "")]).is_err());
    assert!(answer(&[("", "."), ("jsonargs", ""), ("", "{"), ("version", "")]).is_err());
    let (plan, asked) = walk(&[("slurpfile", "b"), ("slurpfile", "four.json"), ("help", "")]);
    assert_eq!(plan.expect("help")["answer"], json!("help"));
    assert_eq!(asked, ["four.json"]);
}

#[test]
fn a_word_the_loop_does_not_know_is_the_hosts_mistake() {
    let (stderr, status) = refusal(&[("nope", "")]);
    assert_eq!(
        (stderr.as_str(), status),
        ("scan: jq reads no option nope", 1)
    );
    let (stderr, _) = refusal(&[("arg", "a")]);
    assert_eq!(stderr, "jq: arg holds no value");
}

use mirage_rs::{Stream, open};
use serde::Deserialize;

const MAX_DRAIN_STEPS: usize = 100_000;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    command: String,
    expect: Expected,
}

#[derive(Deserialize)]
struct Expected {
    stdout: String,
    stderr: String,
    exit: i32,
}

struct Invocation {
    input: Vec<u8>,
    math_mode: bool,
    line_length: Option<String>,
    discard_stderr: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: i32,
}

fn corpus() -> Vec<Case> {
    [
        include_str!("../../../integ/unix/bc/basic.json"),
        include_str!("../../../integ/unix/bc/precision.json"),
    ]
    .into_iter()
    .flat_map(|text| {
        serde_json::from_str::<Corpus>(text)
            .expect("valid bc corpus")
            .cases
    })
    .collect()
}

fn shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut started = false;
    for character in command.chars() {
        match character {
            '\'' => {
                quoted = !quoted;
                started = true;
            }
            character if character.is_whitespace() && !quoted => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            '"' | '\\' | ';' | '&' | '$' if !quoted => {
                panic!("unsupported shell syntax in bc fixture: {command}");
            }
            character => {
                word.push(character);
                started = true;
            }
        }
    }
    assert!(!quoted, "unclosed single quote in bc fixture: {command}");
    if started {
        words.push(word);
    }
    words
}

fn printf_bytes(format: &str) -> Vec<u8> {
    let mut bytes = format.bytes();
    let mut input = Vec::new();
    while let Some(byte) = bytes.next() {
        input.push(match byte {
            b'\\' => match bytes.next().expect("complete printf escape") {
                b'n' => b'\n',
                b'\\' => b'\\',
                escape => panic!("unsupported printf escape in bc fixture: {escape}"),
            },
            b'%' => {
                assert_eq!(
                    bytes.next(),
                    Some(b'%'),
                    "only literal printf %% is supported"
                );
                b'%'
            }
            byte => byte,
        });
    }
    input
}

fn invocation(command: &str) -> Invocation {
    let words = shell_words(command);
    let mut invocation = Invocation {
        input: Vec::new(),
        math_mode: false,
        line_length: None,
        discard_stderr: false,
    };
    if words.as_slice() == ["bc"] {
        return invocation;
    }
    assert_eq!(words.get(2).map(String::as_str), Some("|"), "{command}");
    let source = words.get(1).expect("one producer argument");
    invocation.input = match words[0].as_str() {
        "echo" => [source.as_bytes(), b"\n"].concat(),
        "printf" => printf_bytes(source),
        producer => panic!("unsupported bc fixture producer: {producer}"),
    };
    let mut arguments = words[3..].iter().map(String::as_str);
    let mut command_word = arguments.next().expect("bc command");
    if let Some(raw) = command_word.strip_prefix("BC_LINE_LENGTH=") {
        invocation.line_length = Some(raw.to_owned());
        command_word = arguments.next().expect("bc after environment assignment");
    }
    assert_eq!(command_word, "bc", "{command}");
    for argument in arguments {
        match argument {
            "-l" => invocation.math_mode = true,
            "2>/dev/null" => invocation.discard_stderr = true,
            argument => panic!("unsupported bc fixture argument: {argument}"),
        }
    }
    invocation
}

fn stream(math_mode: bool, line_length: usize) -> Box<dyn Stream> {
    configured_stream(math_mode, Some(&line_length.to_string()))
}

fn configured_stream(math_mode: bool, line_length: Option<&str>) -> Box<dyn Stream> {
    let config = serde_json::json!({"math_mode": math_mode, "line_length": line_length});
    open("bc", config.to_string().as_bytes()).expect("bc stream opens")
}

fn drain(stream: &mut dyn Stream, out: &mut Vec<u8>, remaining: &mut usize) {
    while stream.busy() {
        assert!(*remaining > 0, "bc exceeded its drain-call budget");
        *remaining -= 1;
        stream.drain(out).expect("bc drain succeeds");
    }
}

fn run(math_mode: bool, line_length: usize, chunks: &[&[u8]]) -> Output {
    run_configured(math_mode, Some(&line_length.to_string()), chunks)
}

fn run_configured(math_mode: bool, line_length: Option<&str>, chunks: &[&[u8]]) -> Output {
    let mut stream = configured_stream(math_mode, line_length);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut remaining = MAX_DRAIN_STEPS;
    for chunk in chunks {
        if stream.done() {
            break;
        }
        stream.feed(chunk, &mut stdout).expect("bc feed succeeds");
        drain(stream.as_mut(), &mut stdout, &mut remaining);
        stream.take_stderr(&mut stderr);
    }
    stream.finish(&mut stdout).expect("bc finish succeeds");
    drain(stream.as_mut(), &mut stdout, &mut remaining);
    stream.take_stderr(&mut stderr);
    Output {
        stdout,
        stderr,
        status: stream.status(),
    }
}

fn assert_output(output: Output, stdout: &[u8], stderr: &[u8], status: i32) {
    assert_eq!(
        output,
        Output {
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
            status
        }
    );
}

#[test]
fn corpus_commands_decode_without_a_shell() {
    let cases = corpus();
    assert!(!cases.is_empty(), "bc corpus must have behavior cases");
    for case in &cases {
        let _ = invocation(&case.command);
    }
    assert_eq!(invocation("echo '1+1' | bc").input, b"1+1\n");
    assert_eq!(invocation("printf '1%%2\\n' | bc -l").input, b"1%2\n");
    assert!(invocation("echo '1' | bc -l").math_mode);
    assert_eq!(
        invocation("echo '1' | BC_LINE_LENGTH=abc bc").line_length,
        Some("abc".into())
    );
    assert_eq!(
        invocation("echo '1' | BC_LINE_LENGTH=2 bc").line_length,
        Some("2".into())
    );
    assert_eq!(
        invocation("echo '1' | BC_LINE_LENGTH=10 bc").line_length,
        Some("10".into())
    );
    assert!(invocation("printf '1/0\\n' | bc 2>/dev/null").discard_stderr);
}

#[test]
fn shared_corpus_matches_stdout_stderr_and_status() {
    for case in corpus() {
        let invocation = invocation(&case.command);
        let mut output = run_configured(
            invocation.math_mode,
            invocation.line_length.as_deref(),
            &[&invocation.input],
        );
        if invocation.discard_stderr {
            output.stderr.clear();
        }
        assert_eq!(
            output,
            Output {
                stdout: case.expect.stdout.into_bytes(),
                stderr: case.expect.stderr.into_bytes(),
                status: case.expect.exit,
            },
            "{}: {}",
            case.id,
            case.command,
        );
    }
}

#[test]
fn chunk_boundaries_preserve_program_behavior() {
    let programs: &[(&[u8], &[u8])] = &[
        (b"a=9007199254740993\n(a+1)\n", b"9007199254740994\n"),
        (b"1+/* across\n boundary */2\n", b"3\n"),
        ("print \"é🌍\\n\"\n2+2\n".as_bytes(), "é🌍\n4\n".as_bytes()),
        (b"print \"a\nb\"\n3+3\n", b"a\nb6\n"),
        (b"scale=3;1/8", b".125\n"),
    ];
    for &(program, expected) in programs {
        for split in 0..=program.len() {
            let chunks = [&program[..split], &program[split..]];
            assert_output(run(false, 70, &chunks), expected, b"", 0);
        }
        let chunks = program.chunks(1).collect::<Vec<_>>();
        assert_output(run(false, 70, &chunks), expected, b"", 0);
    }
}

#[test]
fn quit_and_halt_stop_input_before_eof() {
    for (program, expected) in [
        (&b"1+1\n2+2;quit;9+9\n"[..], &b"2\n"[..]),
        (&b"1+1\n2+2;halt;9+9\n"[..], &b"2\n4\n"[..]),
    ] {
        let mut stream = stream(false, 70);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut remaining = MAX_DRAIN_STEPS;
        stream.feed(program, &mut stdout).expect("bc feed succeeds");
        drain(stream.as_mut(), &mut stdout, &mut remaining);
        assert!(
            stream.done(),
            "quit or halt stops input without waiting for EOF"
        );
        stream.finish(&mut stdout).expect("bc finish succeeds");
        drain(stream.as_mut(), &mut stdout, &mut remaining);
        stream.take_stderr(&mut stderr);
        assert_output(
            Output {
                stdout,
                stderr,
                status: stream.status(),
            },
            expected,
            b"",
            0,
        );
    }
}

#[test]
fn separate_invocations_isolate_variables_registers_and_diagnostics() {
    let first = run(false, 70, &[b"x=5;scale=3;ibase=16;obase=16\n1/0\n"]);
    assert_output(
        first,
        b"",
        b"Runtime error (func=(main), adr=3): Divide by zero\n",
        0,
    );
    assert_output(
        run(false, 70, &[b"x;scale;ibase;obase;last\n"]),
        b"0\n0\n10\n10\n10\n",
        b"",
        0,
    );
    assert_output(run(true, 70, &[b"scale\n"]), b"20\n", b"", 0);
    assert_output(run(false, 70, &[b"scale\n"]), b"0\n", b"", 0);
}

#[test]
fn syntax_errors_precede_runtime_errors_and_discard_line_effects() {
    let program = b"x=5;print 7;1/0;1 2\nx;last\n1/0;halt;3 4\n2+2\n";
    assert_output(
        run(false, 70, &[program]),
        b"0\n0\n4\n",
        b"(standard_in) 1: syntax error\n(standard_in) 3: syntax error\n",
        0,
    );
}

#[test]
fn arithmetic_limits_keep_prior_effects_and_recover_on_the_next_line() {
    for (program, math_mode) in [
        (&b"x=5;print 7;2^1000000000000;x=9\nx;last;2+2\n"[..], false),
        (&b"x=5;print 7;e(10000000000);x=9\nx;last;2+2\n"[..], true),
    ] {
        assert_output(
            run(math_mode, 70, &[program]),
            b"75\n5\n4\n",
            b"Runtime error (func=(main), adr=3): Arithmetic limit exceeded\n",
            0,
        );
    }
}

#[test]
fn taking_diagnostics_consumes_them_without_changing_status() {
    let mut stream = stream(false, 70);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut remaining = MAX_DRAIN_STEPS;
    stream
        .feed(b"1/0\n", &mut stdout)
        .expect("bc feed succeeds");
    drain(stream.as_mut(), &mut stdout, &mut remaining);
    stream.take_stderr(&mut stderr);
    assert_eq!(
        stderr,
        b"Runtime error (func=(main), adr=3): Divide by zero\n"
    );
    stderr.clear();
    stream.take_stderr(&mut stderr);
    assert!(stderr.is_empty());
    stream
        .feed(b"2+2\n", &mut stdout)
        .expect("bc feed succeeds");
    drain(stream.as_mut(), &mut stdout, &mut remaining);
    stream.finish(&mut stdout).expect("bc finish succeeds");
    drain(stream.as_mut(), &mut stdout, &mut remaining);
    stream.take_stderr(&mut stderr);
    assert_output(
        Output {
            stdout,
            stderr,
            status: stream.status(),
        },
        b"4\n",
        b"",
        0,
    );
}

#[test]
fn every_arithmetic_growth_refusal_recovers_on_the_next_line() {
    let huge_exponent = format!("1{}", "0".repeat(100));
    let programs = [
        "2^1000000".to_owned(),
        "2^-1000000".to_owned(),
        format!("2^{huge_exponent}"),
        format!("2^-{huge_exponent}"),
        ".1^-10000000000000000000000000000000000".to_owned(),
        "2^32768*2^32768".to_owned(),
        "1".repeat(16_001),
        format!(".{}1", "0".repeat(16_000)),
    ];
    for program in programs {
        let input = format!("{program};99\n2+2\n");
        assert_output(
            run(false, 0, &[input.as_bytes()]),
            b"4\n",
            b"Runtime error (func=(main), adr=3): Arithmetic limit exceeded\n",
            0,
        );
    }
}

#[test]
fn eof_preserves_work_already_queued_by_feed() {
    let input = format!("{}a\n", "a=1;".repeat(2_000));
    let mut stream = stream(false, 0);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut remaining = MAX_DRAIN_STEPS;
    stream.feed(input.as_bytes(), &mut stdout).expect("feed");
    stream.finish(&mut stdout).expect("finish while busy");
    drain(stream.as_mut(), &mut stdout, &mut remaining);
    stream.take_stderr(&mut stderr);
    assert_output(
        Output {
            stdout,
            stderr,
            status: stream.status(),
        },
        b"1\n",
        b"",
        0,
    );
}

#[test]
fn nesting_does_not_depend_on_the_native_or_wasm_call_stack() {
    let input = format!("{}2{}\n", "(".repeat(4_096), ")".repeat(4_096));
    assert_output(run(false, 0, &[input.as_bytes()]), b"2\n", b"", 0);
}

#[test]
fn malformed_utf8_matches_host_replacement_across_chunks() {
    for program in [
        &b"print \"\xf4\x90\x80\x80\"\n"[..],
        &b"print \"\xed\xa0\x80\"\n"[..],
        &b"print \"\xc3(\"\n"[..],
    ] {
        let content = &program[7..program.len() - 2];
        let expected = String::from_utf8_lossy(content);
        for split in 0..=program.len() {
            assert_output(
                run(false, 0, &[&program[..split], &program[split..]]),
                expected.as_bytes(),
                b"",
                0,
            );
        }
    }
}

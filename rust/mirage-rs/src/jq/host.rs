// Adapted from jq 1.8.2 (MIT), src/builtin.c, src/main.c and src/util.c. See licenses/third_party/jq.txt.

use super::builtin::Cfunc;
use super::value::{Object, Value};

/// What the host answered the `input` builtin with: the next document,
/// the end of the stream, or the reader's parse error.
pub(crate) enum Reply {
    Value(Value),
    End,
    Error(String),
}

/// A line `debug` or `stderr` writes to the host's stderr.
pub(crate) enum Message {
    Debug(Value),
    Stderr(Value),
}

/// What a host builtin answers: a value, an error, or a pause until the
/// host replies, which hands the input back to the stack.
pub(crate) enum Answer {
    Value(Value),
    Raise(Value),
    Wait(Value),
}

/// What jq's host keeps for a run behind its callbacks (main.c, util.c):
/// the environment `env` reads, where the input reader stands, the reply
/// `input` waits on, and what `debug` and `stderr` wrote since the host
/// last took it.
pub(crate) struct Host {
    pub(crate) env: Value,
    pub(crate) filename: Value,
    pub(crate) line: f64,
    pub(crate) reply: Option<Reply>,
    pub(crate) messages: Vec<Message>,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            env: Value::object(Object::default()),
            filename: Value::Null,
            line: 0.0,
            reply: None,
            messages: Vec::new(),
        }
    }
}

/// Whether `f` reaches the host rather than its operands alone.
pub(crate) fn is_host(f: Cfunc) -> bool {
    matches!(
        f,
        Cfunc::Input
            | Cfunc::Debug
            | Cfunc::Stderr
            | Cfunc::Env
            | Cfunc::InputFilename
            | Cfunc::InputLineNumber
    )
}

impl Host {
    /// Run host builtin `f` on `input`. `input` with no reply waiting
    /// pauses the run; the end of the stream is jq's `break` error.
    pub(crate) fn call(&mut self, f: Cfunc, input: Value) -> Answer {
        match f {
            Cfunc::Input => match self.reply.take() {
                None => Answer::Wait(input),
                Some(Reply::Value(value)) => Answer::Value(value),
                Some(Reply::End) => Answer::Raise(Value::string("break")),
                Some(Reply::Error(message)) => Answer::Raise(Value::string(message)),
            },
            Cfunc::Debug => {
                self.messages.push(Message::Debug(input.clone()));
                Answer::Value(input)
            }
            Cfunc::Stderr => {
                self.messages.push(Message::Stderr(input.clone()));
                Answer::Value(input)
            }
            Cfunc::Env => Answer::Value(self.env.clone()),
            Cfunc::InputFilename => Answer::Value(self.filename.clone()),
            Cfunc::InputLineNumber => Answer::Value(Value::number(self.line)),
            _ => unreachable!("not a host builtin"),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::Stream;

    use super::super::eval::{DEBUG, ERROR, HALT, OUTPUT, STDERR};

    /// A run's frames as `kind: text`, and the requests it made.
    struct Run {
        frames: Vec<String>,
        asked: usize,
    }

    fn open(config: serde_json::Value) -> Box<dyn Stream> {
        super::super::eval::open(config.to_string().as_bytes()).expect("compiles")
    }

    fn read(mut wire: &[u8]) -> Vec<String> {
        let mut frames = Vec::new();
        while !wire.is_empty() {
            let len = u32::from_le_bytes(wire[1..5].try_into().unwrap()) as usize;
            let payload = String::from_utf8_lossy(&wire[5..5 + len]).into_owned();
            frames.push(match wire[0] {
                OUTPUT => payload,
                ERROR => format!("error: {}", &payload[1..]),
                HALT => format!("halt: {payload}"),
                DEBUG => format!("debug: {payload}"),
                STDERR => format!("stderr: {payload}"),
                tag => panic!("unknown frame {tag}"),
            });
            wire = &wire[5 + len..];
        }
        frames
    }

    /// Run `stream` on `doc` from `position`, answering each `input` with
    /// the next of `replies` (a reply header and its text), then the end.
    fn run(stream: &mut dyn Stream, position: &str, doc: &str, replies: &[(&str, &str)]) -> Run {
        let mut wire = Vec::new();
        stream.begin(position.as_bytes()).unwrap();
        stream.feed(doc.as_bytes(), &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        let mut replies = replies.iter();
        let mut asked = 0;
        loop {
            while stream.busy() {
                stream.drain(&mut wire).unwrap();
            }
            let Some(header) = stream.request(&mut Vec::new()) else {
                break;
            };
            assert_eq!(header, br#"{"op":"input"}"#);
            asked += 1;
            let (reply, text) = replies.next().copied().unwrap_or((r#"{"kind":"end"}"#, ""));
            stream
                .respond(reply.as_bytes(), text.as_bytes(), &mut wire)
                .unwrap();
        }
        Run {
            frames: read(&wire),
            asked,
        }
    }

    fn program(program: &str, steps: u64) -> Box<dyn Stream> {
        open(serde_json::json!({ "program": program, "steps": steps }))
    }

    const VALUE: &str = r#"{"kind":"value"}"#;
    const ERROR_REPLY: &str = r#"{"kind":"error"}"#;

    #[test]
    fn input_takes_only_the_documents_it_asks_for() {
        for steps in [1, 3, 1 << 16] {
            let mut stream = program("[., input]", steps);
            let got = run(&mut *stream, "{}", "1", &[(VALUE, "2")]);
            assert_eq!((got.frames, got.asked), (vec!["[1,2]".to_string()], 1));

            let mut stream = program("[., inputs]", steps);
            let got = run(&mut *stream, "{}", "1", &[(VALUE, "2"), (VALUE, "3")]);
            assert_eq!((got.frames, got.asked), (vec!["[1,2,3]".to_string()], 3));

            let mut stream = program("first(inputs)", steps);
            let got = run(&mut *stream, "{}", "1", &[(VALUE, "2"), (VALUE, "3")]);
            assert_eq!((got.frames, got.asked), (vec!["2".to_string()], 1));

            let mut stream = program("if . == 1 then [., input] else . end", steps);
            let got = run(&mut *stream, "{}", "3", &[]);
            assert_eq!((got.frames, got.asked), (vec!["3".to_string()], 0));
        }
    }

    /// A program, the replies its `input` calls get, and its frames.
    type Case = (
        &'static str,
        &'static [(&'static str, &'static str)],
        &'static [&'static str],
    );

    #[test]
    fn the_end_of_the_stream_is_break_and_a_parse_error_its_message() {
        let cases: &[Case] = &[
            ("[., input]", &[], &["error: break"]),
            ("try input catch .", &[], &["\"break\""]),
            ("[inputs]", &[], &["[]"]),
            (
                "[., input]",
                &[(ERROR_REPLY, "Unmatched '}' at line 1, column 3")],
                &["error: Unmatched '}' at line 1, column 3"],
            ),
            (
                "[., inputs]",
                &[(VALUE, "2"), (ERROR_REPLY, "Unfinished JSON term")],
                &["error: Unfinished JSON term"],
            ),
            ("try input catch .", &[(ERROR_REPLY, "bad")], &["\"bad\""]),
        ];
        for (text, replies, want) in cases {
            let mut stream = program(text, 1 << 16);
            assert_eq!(
                run(&mut *stream, "{}", "1", replies).frames,
                *want,
                "{text}"
            );
        }
    }

    #[test]
    fn the_reader_position_follows_each_document() {
        let mut stream = program(
            "[input_filename, input_line_number, input, input_filename, input_line_number]",
            1 << 16,
        );
        let got = run(
            &mut *stream,
            r#"{"filename":"a.json","line":1}"#,
            "1",
            &[(r#"{"kind":"value","filename":"b.json","line":0}"#, "3")],
        );
        assert_eq!(got.frames, [r#"["a.json",1,3,"b.json",0]"#]);
        assert_eq!(
            run(&mut *stream, "{}", "null", &[]).frames,
            ["error: break"]
        );
        let mut stream = program("[input_filename, input_line_number]", 1 << 16);
        assert_eq!(run(&mut *stream, "{}", "null", &[]).frames, ["[null,0]"]);
    }

    #[test]
    fn env_and_dollar_env_read_the_hosts_environment() {
        let mut stream = open(serde_json::json!({
            "program": "[$ENV.HOME, env.HOME, ($ENV | keys)]",
            "env": r#"{"HOME":"/home/a","A":"1"}"#,
        }));
        let got = run(&mut *stream, "{}", "null", &[]);
        assert_eq!(got.frames, [r#"["/home/a","/home/a",["A","HOME"]]"#]);
        let mut stream = open(serde_json::json!({
            "program": "[$ENV, env.HOME, (1 as $ENV | $ENV)]",
            "named": { "ENV": "\"x\"" },
            "env": r#"{"HOME":"/home/a"}"#,
        }));
        let got = run(&mut *stream, "{}", "null", &[]);
        assert_eq!(got.frames, [r#"[{"HOME":"/home/a"},"/home/a",1]"#]);
        let mut stream = program("env", 1 << 16);
        assert_eq!(run(&mut *stream, "{}", "null", &[]).frames, ["{}"]);
    }

    #[test]
    fn debug_and_stderr_write_their_messages_in_order() {
        let mut stream = program(
            r#"debug, debug("m", 2), ("a\u0000b" | stderr), ({"b":1} | stderr) | empty"#,
            1,
        );
        let got = run(&mut *stream, "{}", r#"{"a":1}"#, &[]);
        assert_eq!(
            got.frames,
            [
                r#"debug: ["DEBUG:",{"a":1}]"#,
                r#"debug: ["DEBUG:","m"]"#,
                r#"debug: ["DEBUG:",2]"#,
                "stderr: a\0b",
                r#"stderr: {"b":1}"#,
            ]
        );
        let mut stream = program("[., input] | debug | error", 1 << 16);
        let got = run(&mut *stream, "{}", "1", &[(VALUE, "2")]);
        assert_eq!(got.frames, [r#"debug: ["DEBUG:",[1,2]]"#, "error: [1,2]"]);
    }

    #[test]
    fn a_run_waiting_on_input_cancels_and_takes_no_reply() {
        let mut stream = program("input", 1 << 16);
        let mut wire = Vec::new();
        stream.begin(b"{}").unwrap();
        stream.feed(b"1", &mut wire).unwrap();
        stream.finish(&mut wire).unwrap();
        stream.drain(&mut wire).unwrap();
        assert!(!stream.busy());
        assert!(stream.request(&mut Vec::new()).is_some());
        assert!(stream.request(&mut Vec::new()).is_none());
        assert!(stream.cancel());
        assert!(
            stream
                .respond(br#"{"kind":"end"}"#, b"", &mut wire)
                .is_err()
        );
        while stream.busy() {
            stream.drain(&mut wire).unwrap();
        }
        stream.begin(b"{}").unwrap();
    }
}

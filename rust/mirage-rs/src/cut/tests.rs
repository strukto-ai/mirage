use super::*;
use serde_json::{Value, json};

const TRY: &str = "Try 'cut --help' for more information.";

fn typed(name: &str, text: &[u8]) -> Value {
    json!([name, crate::byte_text(text)])
}

fn switch(name: &str) -> Value {
    json!([name, ""])
}

fn config(list: &str, mode: &str) -> Vec<Value> {
    vec![typed(mode, list.as_bytes())]
}

fn execute(options: &[Value], input: &[u8], split: usize) -> Vec<u8> {
    let config = json!({ "options": options });
    let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
    let mut output = Vec::new();
    for chunk in input.chunks(split.max(1)) {
        let mut step = Vec::new();
        stream.feed(chunk, &mut step).unwrap();
        assert!(step.len() <= WORK);
        output.extend(step);
        while stream.busy() {
            let mut step = Vec::new();
            stream.drain(&mut step).unwrap();
            assert!(step.len() <= WORK);
            output.extend(step);
        }
    }
    let mut step = Vec::new();
    stream.finish(&mut step).unwrap();
    assert!(step.len() <= WORK);
    output.extend(step);
    while stream.busy() {
        let mut step = Vec::new();
        stream.drain(&mut step).unwrap();
        assert!(step.len() <= WORK);
        output.extend(step);
    }
    output
}

#[test]
fn merges_sorted_intervals_once() {
    assert_eq!(
        intervals(b"3,1-2,2-4,8,6-7,12-", Mode::Bytes, "cut").unwrap(),
        [
            Interval { first: 1, last: 4 },
            Interval { first: 6, last: 8 },
            Interval {
                first: 12,
                last: u64::MAX
            },
        ]
    );
    assert_eq!(
        intervals(b"4294967296-", Mode::Characters, "cut").unwrap(),
        [Interval {
            first: 4294967296,
            last: u64::MAX
        },]
    );
}

#[test]
fn list_refusals_preserve_scan_precedence() {
    let cases = [
        ("2-3x", "invalid field value 'x'"),
        ("abc", "invalid field value 'abc'"),
        ("0", "fields are numbered from 1"),
        ("3-1", "invalid decreasing range"),
        ("", "fields are numbered from 1"),
        ("1,2x", "invalid field value 'x'"),
        ("2 ", "fields are numbered from 1"),
        ("1-2-3", "invalid field range"),
        ("1,", "fields are numbered from 1"),
        (",1", "fields are numbered from 1"),
        ("1,,2", "fields are numbered from 1"),
        ("-", "invalid range with no endpoint: -"),
        ("- 1", "invalid range with no endpoint: -"),
        ("-,x", "invalid range with no endpoint: -"),
        (
            "1-0018446744073709551615",
            "field number '0018446744073709551615' is too large",
        ),
        ("0-x", "fields are numbered from 1"),
        ("0x", "invalid field value 'x'"),
        ("0,x", "fields are numbered from 1"),
        ("-0", "invalid decreasing range"),
        ("3-1-2", "invalid field range"),
        ("3-1 x", "invalid decreasing range"),
        ("1\r", "invalid field value '\\r'"),
    ];
    for (spec, expected) in cases {
        let error = intervals(spec.as_bytes(), Mode::Fields, "cut").unwrap_err();
        assert_eq!(error.message, format!("cut: {expected}\n{TRY}"), "{spec:?}");
    }
    for mode in [Mode::Bytes, Mode::Characters] {
        for (spec, expected) in [
            ("0", "byte/character positions are numbered from 1"),
            ("1-2-3", "invalid byte or character range"),
            ("2-3x", "invalid byte/character position 'x'"),
            (
                "99999999999999999999x",
                "byte/character offset '99999999999999999999' is too large",
            ),
        ] {
            assert_eq!(
                intervals(spec.as_bytes(), mode, "cut").unwrap_err().message,
                format!("cut: {expected}\n{TRY}")
            );
        }
    }
}

#[test]
fn quotes_raw_list_bytes_and_accepts_unlimited_leading_zeros() {
    for (spec, expected) in [
        ("2-3é", "\\303\\251"),
        ("1,é", "\\303\\251"),
        ("xé", "x\\303\\251"),
        ("1,2\\x", "\\\\x"),
        ("1,2'x", "\\'x"),
        ("1,2\tx", "x"),
        ("1,2\nx", "\\nx"),
        ("x\x01y", "x\\001y"),
        ("😀", "\\360\\237\\230\\200"),
    ] {
        assert_eq!(
            intervals(spec.as_bytes(), Mode::Fields, "cut")
                .unwrap_err()
                .message,
            format!("cut: invalid field value '{expected}'\n{TRY}")
        );
    }
    assert_eq!(
        intervals(b"2\xff", Mode::Fields, "cut")
            .unwrap_err()
            .message,
        format!("cut: invalid field value '\\377'\n{TRY}")
    );
    let zeros = "0".repeat(5000);
    assert_eq!(
        execute(
            &config(&format!("{zeros}2-{zeros}3"), "fields"),
            b"a\tb\tc\n",
            1
        ),
        b"b\tc\n"
    );
    let nines = "9".repeat(5000);
    assert_eq!(
        intervals(format!("1-{nines}").as_bytes(), Mode::Fields, "cut")
            .unwrap_err()
            .message,
        format!("cut: field number '{nines}' is too large\n{TRY}")
    );
    assert!(intervals(b"18446744073709551614", Mode::Fields, "cut").is_ok());
}

#[test]
fn selections_follow_input_order_with_complement_and_separators() {
    for mode in ["bytes", "characters"] {
        for (list, expected) in [
            ("2-5", b"bcde\n".as_slice()),
            ("1-3,2-4", b"abcd\n"),
            ("3-", b"cdef\n"),
            ("3,1", b"ac\n"),
        ] {
            assert_eq!(execute(&config(list, mode), b"abcdef", 1), expected);
        }
        let mut options = config("2-3", mode);
        options.push(switch("complement"));
        options.push(typed("output_delimiter", b":"));
        assert_eq!(execute(&options, b"abcde\n\n", 2), b"a:de\n\n");
    }
    let mut options = config("3,1", "fields");
    assert_eq!(execute(&options, b"a\tb\tc\nraw\n", 1), b"a\tc\nraw\n");
    options.push(switch("complement"));
    assert_eq!(execute(&options, b"a\tb\tc\td\n", 2), b"b\td\n");
}

#[test]
fn replacement_decoding_and_no_partial_offsets_survive_every_split() {
    let cases: &[&[u8]] = &[
        b"\xff\xfeabc",
        b"\xe2\x82x",
        b"\xed\xa0\x80x",
        b"\xf4\x90\x80\x80x",
        b"\xef\xbb\xbfhi",
        "aé😀z".as_bytes(),
        b"\xe6\x95",
    ];
    for &input in cases {
        let expected = [String::from_utf8_lossy(input).as_bytes(), b"\n"].concat();
        for split in 1..=input.len() {
            assert_eq!(execute(&config("1-", "characters"), input, split), expected);
        }
    }
    let mut options = config("3", "bytes");
    options.push(switch("no_partial"));
    assert_eq!(execute(&options, b"\xffabc\n", 1), b"\xffab\n");
    options.push(typed("bytes", b"4"));
    assert_eq!(execute(&options, b"\xffabc\n", 2), b"c\n");
    options.push(typed("bytes", b"2,5"));
    options.push(typed("output_delimiter", b":"));
    assert_eq!(execute(&options, "éxé".as_bytes(), 1), "é:é\n".as_bytes());
}

#[test]
fn fields_preserve_raw_passthrough_and_empty_fields() {
    let mut options = config("2", "fields");
    assert_eq!(
        execute(&options, b"\xffabc\nx\t\xffz\na\t\n\t\n", 1),
        b"\xffabc\n\xef\xbf\xbdz\n\n\n"
    );
    options.push(switch("only_delimited"));
    assert_eq!(execute(&options, b"raw\na\tb\n", 1), b"b\n");
    options.push(typed("delimiter", "é".as_bytes()));
    options.push(typed("output_delimiter", b"|"));
    options.push(typed("fields", b"1,3"));
    assert_eq!(execute(&options, "aébéc".as_bytes(), 1), b"a|c\n");
}

#[test]
fn whitespace_extensions_keep_trimmed_and_boundary_fields() {
    let mut options = config("1,2,3", "fields");
    options.push(switch("w"));
    assert_eq!(execute(&options, b" \ta  b\t \n\t \n", 1), b"\ta\tb\n\t\n");
    options = vec![
        typed("fields", b"1,2,3"),
        typed("whitespace_delimited", b"trim"),
    ];
    assert_eq!(
        execute(&options, b" \ta  b\t \n\t \nraw\n", 1),
        b"a\tb\n\nraw\n"
    );
    options.push(switch("only_delimited"));
    assert_eq!(execute(&options, b"\t \nraw\n a b \n", 2), b"a\tb\n");
}

#[test]
fn zero_records_and_unterminated_records_keep_terminators() {
    let mut options = config("2", "fields");
    options.push(typed("delimiter", b","));
    options.push(switch("zero_terminated"));
    assert_eq!(execute(&options, b"a,b\0c,d\0e,f", 1), b"b\0d\0f\0");
    assert!(execute(&options, b"", 1).is_empty());
    assert_eq!(execute(&options, b"\0", 1), b"\0");
}

#[test]
fn raw_delimiter_sentinels_never_match_replacement_decoding() {
    let mut options = config("1", "fields");
    options.push(typed("delimiter", b"\xff"));
    for input in [b"a\xffb\n".as_slice(), "a\u{fffd}b\n".as_bytes()] {
        assert_eq!(execute(&options, input, 1), input);
    }
    options.push(switch("only_delimited"));
    assert!(execute(&options, b"a\xffb\n", 1).is_empty());
    options[0] = typed("bytes", b"1");
    assert_eq!(execute(&options, b"a\xffb\n", 1), b"a\n");
    options[0] = typed("characters", b"1");
    assert_eq!(execute(&options, b"a\xffb\n", 1), b"a\n");
    options[0] = typed("fields", b"1");
    options.push(typed("delimiter", "\u{fffd}".as_bytes()));
    assert_eq!(execute(&options, b"a\xffb\n", 1), b"a\n");
}

#[test]
fn a_raw_output_delimiter_byte_is_written_as_typed() {
    let mut options = config("1,3", "characters");
    options.push(typed("output_delimiter", b"\xff"));
    assert_eq!(execute(&options, b"abc\n", 1), b"a\xffc\n");
    let mut options = config("1,2", "fields");
    options.push(typed("delimiter", b":"));
    options.push(typed("output_delimiter", b""));
    assert_eq!(execute(&options, b"a:b:c\n", 1), b"a\0b\n");
}

fn long_line(len: usize) -> Vec<u8> {
    (0..len).map(|at| b"abcdefghij"[at % 10]).collect()
}

#[test]
fn long_records_stream_byte_at_a_time_in_every_mode() {
    let line = long_line(3 * MAX_HELD);
    let input = [line.as_slice(), b"\n"].concat();
    for mode in ["bytes", "characters"] {
        let mut options = config("2,5-6,100000-", mode);
        options.push(typed("output_delimiter", b":"));
        let expected = [b"b:ef:", &line[99_999..], b"\n"].concat();
        assert_eq!(execute(&options, &input, 1), expected);
    }
    let mut options = config("2,5-6", "bytes");
    options.push(switch("no_partial"));
    let wide = "é".repeat(2 * MAX_HELD);
    assert_eq!(
        execute(&options, format!("{wide}\n").as_bytes(), 1),
        "éé\n".as_bytes()
    );
    let tabbed = [line.as_slice(), b"\t", &line, b"\t", &line, b"\n"].concat();
    let options = config("1,3", "fields");
    let expected = [line.as_slice(), b"\t", &line, b"\n"].concat();
    assert_eq!(execute(&options, &tabbed, 1), expected);
    let mut options = config("1", "fields");
    options.push(switch("w"));
    let spaced = [b"  ".as_slice(), &line, b" \t "].concat();
    assert_eq!(execute(&options, &spaced, 3), b"\n");
    options[1] = typed("whitespace_delimited", b"t");
    assert_eq!(
        execute(&options, &spaced, 3),
        [line.as_slice(), b"\n"].concat()
    );
}

#[test]
fn an_undecided_first_field_is_held_and_streams_once_decided() {
    let line = long_line(MAX_HELD / 4);
    let raw = [line.as_slice(), b"\xff", &line, b"\n"].concat();
    let delimited = [line.as_slice(), b"\xff", &line, b"\tz\n"].concat();
    let lossy = [line.as_slice(), "\u{fffd}".as_bytes(), &line, b"\n"].concat();
    let mut options = config("1", "fields");
    assert_eq!(execute(&options, &raw, 1), raw);
    assert_eq!(execute(&options, &delimited, 1000), lossy);
    options.push(switch("only_delimited"));
    assert!(execute(&options, &raw, 1000).is_empty());
    assert_eq!(execute(&options, &delimited, 1), lossy);
    let options = config("2", "fields");
    assert_eq!(execute(&options, &raw, 1000), raw);
    assert_eq!(execute(&options, &delimited, 1), b"z\n");
}

#[test]
fn a_held_field_replays_characters_across_the_blocks_it_set_aside() {
    let wide = "é".repeat(MAX_HELD / 8);
    let input = format!("{wide}\tééé\n");
    for split in [1, 999, 4096] {
        assert_eq!(
            execute(&config("2", "fields"), input.as_bytes(), split),
            "ééé\n".as_bytes()
        );
        let mut options = config("1", "fields");
        options.push(switch("only_delimited"));
        assert_eq!(
            execute(&options, input.as_bytes(), split),
            format!("{wide}\n").as_bytes()
        );
    }
}

#[test]
fn a_first_field_past_the_cap_is_refused_after_the_output_before_it() {
    let input = [b"a\tb\n".as_slice(), &long_line(MAX_HELD + 1), b"\n"].concat();
    for (list, only_delimited, refused) in [
        ("2", false, true),
        ("1", true, true),
        ("1", false, false),
        ("2", true, false),
    ] {
        let mut options = config(list, "fields");
        if only_delimited {
            options.push(switch("only_delimited"));
        }
        let config = json!({ "options": options });
        let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
        let mut output = Vec::new();
        let mut result = Ok(());
        for chunk in input.chunks(4096) {
            result = stream.feed(chunk, &mut output);
            while result.is_ok() && stream.busy() {
                result = stream.drain(&mut output);
            }
            if result.is_err() {
                break;
            }
        }
        let first = if list == "1" { b"a\n" } else { b"b\n" };
        assert!(output.starts_with(first), "{list} {only_delimited}");
        let error = result.err();
        assert_eq!(error.is_some(), refused, "{list} {only_delimited}");
        if let Some(error) = error {
            assert_eq!(
                (error.message.as_str(), error.status),
                ("cut: memory exhausted", 1)
            );
        }
    }
}

#[test]
fn cancel_drops_a_held_record_and_ignores_later_input() {
    let options = config("2", "fields");
    let config = json!({ "options": options });
    let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
    let mut out = Vec::new();
    for chunk in long_line(MAX_HELD / 2).chunks(WORK) {
        stream.feed(chunk, &mut out).unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
    }
    assert!(out.is_empty());
    assert!(stream.cancel());
    assert!(!stream.busy());
    stream.feed(b"x\ty\n", &mut out).unwrap();
    stream.drain(&mut out).unwrap();
    stream.finish(&mut out).unwrap();
    assert!(out.is_empty());
}

#[test]
fn huge_records_and_output_delimiters_drain_in_bounded_steps() {
    for mode in ["bytes", "characters", "fields"] {
        let mut options = config("1-", mode);
        let input = [vec![b'x'; 2 * 1024 * 1024], b"\n".to_vec()].concat();
        assert_eq!(execute(&options, &input, 16384), input);
        if mode == "fields" {
            options.push(typed("delimiter", b"x"));
            options.push(typed("fields", b"1,3"));
            options.push(typed("output_delimiter", "y".repeat(3 * WORK).as_bytes()));
            assert_eq!(
                execute(&options, b"xxx\n", 1),
                [vec![b'y'; 3 * WORK], b"\n".to_vec()].concat()
            );
        }
    }
}

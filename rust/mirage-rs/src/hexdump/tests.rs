use serde_json::json;

use crate::host::{Fault, Host};
use crate::open;

use super::size;

fn hexdump(options: serde_json::Value, operands: &[&str]) -> Box<dyn crate::Stream> {
    let config = json!({"options": options, "operands": operands});
    open("hexdump", config.to_string().as_bytes()).expect("opens")
}

/// The output, the diagnostics and the status of one run over `files`.
fn run(
    options: serde_json::Value,
    operands: &[&str],
    files: &[(&str, &str)],
) -> (String, String, i32) {
    let mut host = Host::with(files, "");
    host.directories.push("d".into());
    let mut stream = hexdump(options, operands);
    let status = host.drive(stream.as_mut());
    (
        String::from_utf8_lossy(&host.out).into_owned(),
        String::from_utf8_lossy(&host.err).into_owned(),
        status,
    )
}

#[test]
fn canonical_reads_the_operands_as_one_input() {
    let (out, err, status) = run(
        json!([["canonical", true]]),
        &["a", "nope", "d", "b"],
        &[("a", "hello\n"), ("b", "abcdefghijklmnopq")],
    );
    assert_eq!(
        out,
        "00000000  68 65 6c 6c 6f 0a 61 62  63 64 65 66 67 68 69 6a  |hello.abcdefghij|\n\
         00000010  6b 6c 6d 6e 6f 70 71                              |klmnopq|\n\
         00000017\n"
    );
    assert_eq!(
        err,
        "hexdump: nope: No such file or directory\nhexdump: d: Is a directory\n"
    );
    assert_eq!(status, 1);
}

#[test]
fn a_directory_fails_nothing_and_every_missing_file_fails_all() {
    assert_eq!(
        run(json!([["canonical", true]]), &["d"], &[]),
        (String::new(), "hexdump: d: Is a directory\n".into(), 0)
    );
    assert_eq!(
        run(json!([["canonical", true]]), &["x", "y"], &[]),
        (
            String::new(),
            "hexdump: x: No such file or directory\nhexdump: y: No such file or directory\n\
             hexdump: all input file arguments failed\n"
                .into(),
            1
        )
    );
}

#[test]
fn the_default_shows_two_byte_words_padding_the_last_line() {
    let (out, _, status) = run(json!([]), &["a"], &[("a", "hello\n")]);
    assert_eq!(
        out,
        format!("0000000 6568 6c6c 0a6f{}\n0000006\n", " ".repeat(25))
    );
    assert_eq!(status, 0);
    let (out, _, _) = run(
        json!([["one_byte_char", true]]),
        &["a"],
        &[("a", "\0\x01 ~\t")],
    );
    assert_eq!(
        out,
        format!("0000000  \\0 001       ~  \\t{}\n0000005\n", " ".repeat(44))
    );
}

#[test]
fn a_repeated_block_shows_as_a_star_unless_verbose() {
    let zeros = "\0".repeat(64);
    let line = "00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|\n";
    let (out, _, _) = run(json!([["canonical", true]]), &["z"], &[("z", &zeros)]);
    assert_eq!(out, format!("00000000  {line}*\n00000040\n"));
    let (out, _, _) = run(
        json!([["canonical", true], ["no_squeezing", true]]),
        &["z"],
        &[("z", &zeros)],
    );
    assert_eq!(
        out,
        format!("00000000  {line}00000010  {line}00000020  {line}00000030  {line}00000040\n")
    );
}

#[test]
fn skip_and_length_bound_the_dump_and_the_end_offset() {
    let file = [("b", "abcdefghijklmnopq")];
    let (out, _, _) = run(
        json!([["canonical", true], ["skip", "3"], ["length", "4"]]),
        &["b"],
        &file,
    );
    assert_eq!(
        out,
        format!("00000003  64 65 66 67{}|defg|\n00000007\n", " ".repeat(39))
    );
    // A skip past the end still shows where the input ended; none read
    // or a length of none shows nothing.
    let (out, _, _) = run(json!([["canonical", true], ["skip", "20"]]), &["b"], &file);
    assert_eq!(out, "00000011\n");
    let (out, _, _) = run(
        json!([["canonical", true], ["skip", "3"]]),
        &["e"],
        &[("e", "")],
    );
    assert_eq!(out, "");
    let (out, _, _) = run(
        json!([["canonical", true], ["skip", "3"], ["length", "0"]]),
        &["b"],
        &file,
    );
    assert_eq!(out, "");
}

#[test]
fn a_short_format_repeats_its_last_uncounted_unit_to_fill_the_block() {
    let file = [("a", "hello\n")];
    let grown = run(
        json!([["format", "/1 \"%02x \""], ["format", "4/1 \"%c\" \"\\n\""]]),
        &["a"],
        &file,
    );
    assert_eq!(grown.0, "68 65 6c 6chell\n6f 0a      o\n\n");
    let counted = run(
        json!([
            ["format", "1/1 \"%02x \""],
            ["format", "4/1 \"%c\" \"\\n\""]
        ]),
        &["a"],
        &file,
    );
    assert_eq!(counted.0, "68 hell\n6f o\n\n");
}

#[test]
fn the_end_unit_runs_once_with_its_offsets_alone() {
    let file = [("a", "hello\n")];
    let (out, _, _) = run(json!([["format", "1/1 \"%02x %_Ad|\""]]), &["a"], &file);
    assert_eq!(out, "*\n 6|");
    let (out, _, _) = run(
        json!([["format", "1/1 \"%02x\" \" end %_Ad|\\n\""]]),
        &["a"],
        &file,
    );
    assert_eq!(out, "68656c*\n6f0a end 6|\n");
    // Only the last `%_A` unit runs at the end.
    let (out, _, _) = run(
        json!([["one_byte_octal", true], ["canonical", true]]),
        &["a"],
        &file,
    );
    assert!(out.ends_with("|hello.|\n00000006\n"), "{out}");
}

#[test]
fn conversions_read_as_c_formats_them() {
    let file = [("b", "abcdefghijklmnopq")];
    let (out, _, _) = run(
        json!([["format", "1/4 \"%u \" 1/4 \"%i\\n\""]]),
        &["b"],
        &file,
    );
    assert_eq!(out, "1684234849 1751606885\n1818978921 1886350957\n113 \n");
    let (out, _, _) = run(
        json!([["format", "3/2 \"%s|\""]]),
        &["a"],
        &[("a", "hello\n")],
    );
    assert_eq!(out, "hello\n|llo\n|o\n|");
    let (out, _, _) = run(
        json!([["format", "1/1 \"%5_u|\""]]),
        &["c"],
        &[("c", "\0\x7f\u{1b} ")],
    );
    assert_eq!(out, "  nul|  del|  esc|     |");
    let (out, _, _) = run(
        json!([["format", "1/1 \"%-+ #05d|\""]]),
        &["a"],
        &[("a", "h\n")],
    );
    assert_eq!(out, "+104 |+10  |");
}

#[test]
fn a_format_file_holds_one_format_a_line() {
    let file = "# comment\n\n  # indented\n\"%02x\" \"\\n\"\n  1/1 \"[%c]\"\n";
    let (out, err, status) = run(
        json!([["format_file", "ff"]]),
        &["a"],
        &[("a", "hello\n"), ("ff", file)],
    );
    assert_eq!(
        (out.as_str(), err.as_str(), status),
        ("6c6c6568\n[h]a6f\n[o]", "", 0)
    );
    let (out, err, status) = run(json!([["format_file", "nofile"]]), &["a"], &[("a", "x")]);
    assert_eq!(
        (out.as_str(), err.as_str(), status),
        (
            "",
            "hexdump: can't read nofile: No such file or directory\n",
            1
        )
    );
}

#[test]
fn a_format_it_cannot_run_is_refused_before_any_read() {
    let refused = |format: &str| run(json!([["format", format]]), &["a"], &[("a", "x")]).1;
    assert_eq!(
        refused("4/1\"%02x\""),
        "hexdump: bad format {4/1\"%02x\"}\n"
    );
    assert_eq!(refused("1/1 \"%02x"), "hexdump: bad format {1/1 \"%02x}\n");
    assert_eq!(refused("\"%5\""), "hexdump: bad format {%5}\n");
    assert_eq!(
        refused("1/1 \"%y\""),
        "hexdump: bad conversion character %y\n"
    );
    assert_eq!(
        refused("\"%_ay\""),
        "hexdump: bad conversion character %_ay\n"
    );
    assert_eq!(
        refused("1/3 \"%x\""),
        "hexdump: bad byte count for conversion character x\n"
    );
    assert_eq!(
        refused("1/2 \"%_p\""),
        "hexdump: bad byte count for conversion character _p\n"
    );
    assert_eq!(
        refused("1/1 \"%o|%u\""),
        "hexdump: byte count with multiple conversion characters\n"
    );
    assert_eq!(
        refused("\"%3s|\""),
        "hexdump: %s requires a precision or a byte count\n"
    );
    let color = run(json!([["color", "bogus"]]), &["a"], &[("a", "x")]);
    assert_eq!(color.1, "hexdump: unsupported color mode: 'bogus'\n");
}

#[test]
fn sizes_read_as_util_linux_reads_them() {
    assert_eq!(size(b"1K", "offset"), Ok(1024));
    assert_eq!(size(b"1kib", "offset"), Ok(1024));
    assert_eq!(size(b"1KB", "offset"), Ok(1000));
    assert_eq!(size(b"1.5K", "offset"), Ok(1536));
    assert_eq!(size(b"0.5K", "offset"), Ok(512));
    assert_eq!(size(b"0x1K", "offset"), Ok(1024));
    assert_eq!(size(b"010", "offset"), Ok(8));
    assert_eq!(size(b" +5", "offset"), Ok(5));
    for bad in ["", "-1", "1B", "1iB", "1e3", "5b", ".5K", "1,5K", "2x"] {
        assert_eq!(
            size(bad.as_bytes(), "length"),
            Err(format!(
                "hexdump: failed to parse length: '{bad}': Invalid argument"
            )),
            "{bad}"
        );
    }
    assert_eq!(
        size(b"99999999999999999999", "length"),
        Err("hexdump: failed to parse length: '99999999999999999999': Numerical result out of range".into())
    );
}

/// The output of one format over `data`.
fn shows(format: &str, data: &str) -> String {
    run(json!([["format", format]]), &["a"], &[("a", data)]).0
}

#[test]
fn a_byte_count_after_an_iteration_count_needs_no_slash() {
    assert_eq!(shows("2 1 \"%02x\" \"\\n\"", "ab"), "6162\n");
    assert_eq!(shows("1 1 \"%02x\" \"\\n\"", "ab"), "61\n62\n");
}

#[test]
fn a_color_annotation_shows_nothing() {
    assert_eq!(shows("1/1 \"%02x_L[red]|\" \"\\n\"", "ab"), "61|\n62|\n");
    // It runs to the text's last `]`, over what lies between.
    assert_eq!(shows("1/1 \"%02x_L[a]b]c]|\" \"\\n\"", "ab"), "61|\n62|\n");
    assert_eq!(shows("1/1 \"%02x|_L[red]\" \"\\n\"", "a"), "61|_L[red]\n");
    let refused = run(
        json!([["format", "1/1 \"%02x_Lx\""]]),
        &["a"],
        &[("a", "x")],
    )
    .1;
    assert_eq!(refused, "hexdump: bad conversion character %_L\n");
}

#[test]
fn a_unit_with_a_byte_count_and_no_conversion_takes_block_room_alone() {
    assert_eq!(
        shows("1/2 \"tag\" 1/1 \"%02x\" \"\\n\"", "abcd"),
        "tag61\ntag64\n"
    );
    assert_eq!(
        shows("1/4 \"%_ad \" 1/1 \"%02x\" \"\\n\"", "abcdefgh"),
        "0 61\n5 66\n"
    );
    let grown = run(
        json!([["format", "4/1 \"%02x\" \"\\n\""], ["format", "/2 \"t\""]]),
        &["a"],
        &[("a", "abcd")],
    );
    assert_eq!(grown.0, "61626364\ntt");
}

#[test]
fn a_string_runs_to_a_nul_or_the_block_end() {
    assert_eq!(
        shows("1/2 \"%s|\" 1/2 \"%04x\" \"\\n\"", "abZ\0"),
        "abZ|005a\n"
    );
    assert_eq!(
        shows("1/2 \"%s|\" 1/2 \"%04x\" \"\\n\"", "abcdef"),
        "abcd|6463\nef|    \n"
    );
    assert_eq!(shows("1/2 \"%.3s|\" \"\\n\"", "abcd"), "ab|\ncd|\n");
}

#[test]
fn a_format_stops_at_its_end_unit_in_each_block() {
    assert_eq!(
        shows("1/1 \"%02x\" \":%_Ad\\n\" 1/1 \"%02x\"", "ab"),
        "61:2\n"
    );
    let two = run(
        json!([
            ["format", "1/1 \"%02x\" \":%_Ad\\n\" 1/1 \"%02x\""],
            ["format", "\"[\" 2/1 \"%02x\" \"]\\n\""]
        ]),
        &["a"],
        &[("a", "ab")],
    );
    assert_eq!(two.0, "61[6162]\n:2\n");
}

#[test]
fn the_last_iteration_drops_one_trailing_blank() {
    assert_eq!(shows("2/1 \"%02x  \" \"|\\n\"", "ab"), "61  62 |\n");
    assert_eq!(shows("2/1 \"%02x \\n\" \"|\\n\"", "ab"), "61 \n62 |\n");
    assert_eq!(
        shows("1/1 \"%02x \" 3 \"ab  \" \"|\\n\"", "a"),
        "61 ab  ab  ab |\n"
    );
    assert_eq!(shows("2/1 \"%-4x\" \"|\\n\"", "ab"), "61  62  |\n");
}

#[test]
fn fraction_digits_count_as_util_linux_counts_them() {
    for (raw, want) in [
        ("0.9K", 1024),
        ("0.7K", 1024),
        ("0.3K", 341),
        ("0.25K", 255),
        ("0.99K", 1117),
        ("0.123K", 125),
        ("0.0009M", 943),
        ("0.95KB", 1050),
        ("0.K", 0),
    ] {
        assert_eq!(size(raw.as_bytes(), "length"), Ok(want), "{raw}");
    }
}

#[test]
fn a_format_file_is_read_where_it_stands_among_the_options() {
    let refusal =
        |options: serde_json::Value| run(options, &["a"], &[("a", "x"), ("bad", "\"%5\"\n")]).1;
    assert_eq!(
        refusal(json!([["format_file", "nofile"], ["length", "bogus"]])),
        "hexdump: can't read nofile: No such file or directory\n"
    );
    assert_eq!(
        refusal(json!([["format_file", "nofile"], ["format", "\"abc"]])),
        "hexdump: can't read nofile: No such file or directory\n"
    );
    assert_eq!(
        refusal(json!([["format", "\"abc"], ["format_file", "nofile"]])),
        "hexdump: bad format {\"abc}\n"
    );
    assert_eq!(
        refusal(json!([["format_file", "bad"], ["length", "bogus"]])),
        "hexdump: failed to parse length: 'bogus': Invalid argument\n"
    );
}

#[test]
fn a_read_error_after_the_open_fails_nothing() {
    let mut host = Host::with(&[("a", "abcd"), ("b", "ef")], "");
    host.faults.insert(
        "a".into(),
        Fault {
            after: 2,
            errno: "EIO",
            text: "Input/output error",
        },
    );
    let mut stream = hexdump(json!([["format", "1/1 \"%c\""]]), &["a", "b"]);
    assert_eq!(host.drive(stream.as_mut()), 0);
    assert_eq!(host.out, b"abef");
    assert_eq!(host.err, b"hexdump: a: Input/output error\n");
    let mut host = Host::with(&[("a", "abcd")], "");
    host.faults.insert(
        "a".into(),
        Fault {
            after: 0,
            errno: "EACCES",
            text: "Permission denied",
        },
    );
    let mut stream = hexdump(json!([["format", "1/1 \"%c\""]]), &["a"]);
    assert_eq!(host.drive(stream.as_mut()), 1);
}

#[test]
fn a_length_hands_back_what_it_leaves_of_standard_input() {
    let mut host = Host::with(&[], "abcdef");
    let mut stream = hexdump(json!([["format", "1/1 \"%c\""], ["length", "2"]]), &[]);
    assert_eq!(host.drive(stream.as_mut()), 0);
    assert_eq!(host.out, b"ab");
    assert_eq!(host.stdin, b"cdef");
}

#[test]
fn a_wide_or_long_format_writes_a_bounded_step_a_drain() {
    let mut host = Host::with(&[("a", "a")], "");
    let mut stream = hexdump(json!([["format", "1/1 \"%1000000x|\""]]), &["a"]);
    assert_eq!(host.drive(stream.as_mut()), 0);
    assert_eq!(host.out.len(), 1_000_001);
    assert!(host.out.ends_with(b"61|"));
    assert!(host.drains > 1_000_000 / super::OUTPUT, "{}", host.drains);
    // A million iterations that write nothing past the end hand back too.
    let mut host = Host::with(&[("a", "a")], "");
    let mut stream = hexdump(json!([["format", "1000000/1 \"%x\""]]), &["a"]);
    assert_eq!(host.drive(stream.as_mut()), 0);
    assert_eq!(host.out, b"61");
    assert!(host.drains > 1_000_000 / super::PRINTS, "{}", host.drains);
}

#[test]
fn a_width_past_int_shows_nothing_of_its_conversion() {
    assert_eq!(shows("1/1 \"<%2147483648x|\" \"\\n\"", "ab"), "|\n|\n");
    assert_eq!(shows("1/1 \"<%.4294967297x|\" \"\\n\"", "a"), "|\n");
}

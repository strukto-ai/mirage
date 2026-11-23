use serde_json::json;

use crate::host::Host;
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

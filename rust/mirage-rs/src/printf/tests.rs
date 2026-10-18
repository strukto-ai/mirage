use super::*;

fn request(format: &[u8], args: &[&[u8]], program: bool, split: usize) -> Box<dyn Stream> {
    let config = serde_json::json!({ "mode": if program { "program" } else { "builtin" }, "argument_count": args.len() });
    let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
    let mut out = Vec::new();
    for (index, input) in std::iter::once(format)
        .chain(args.iter().copied())
        .enumerate()
    {
        for part in input.chunks(split) {
            stream.feed_input(index, part, &mut out).unwrap();
        }
        stream.end_input(index, &mut out).unwrap();
    }
    assert!(out.is_empty());
    stream
}

fn run(
    format: &[u8],
    args: &[&[u8]],
    program: bool,
    split: usize,
) -> (Vec<u8>, Vec<u8>, i32, bool) {
    let mut stream = request(format, args, program, split);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut out = Vec::new();
    stream.finish(&mut out).unwrap();
    loop {
        assert!(out.len() <= STEP);
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        assert!(err.len() <= STEP);
        assert!(out.is_empty() || err.is_empty());
        stdout.append(&mut out);
        stderr.append(&mut err);
        if !stream.busy() {
            break;
        }
        stream.drain(&mut out).unwrap();
    }
    (stdout, stderr, stream.status(), stream.done())
}

#[test]
fn reuse_missing_and_empty_arguments() {
    assert_eq!(
        run(b"%s-%s\n", &[b"a", b"b", b"c"], false, 1),
        (b"a-b\nc-\n".to_vec(), Vec::new(), 0, false)
    );
    assert_eq!(
        run(b"%d", &[], true, 1),
        (b"0".to_vec(), Vec::new(), 0, false)
    );
    assert_eq!(
        run(b"%d", &[b""], true, 1),
        (
            b"0".to_vec(),
            b"printf: '': expected a numeric value\n".to_vec(),
            1,
            false
        )
    );
    assert_eq!(
        run(b"x", &[b"a\x1b"], true, 1),
        (
            b"x".to_vec(),
            b"printf: warning: ignoring excess arguments, starting with 'a\\033'\n".to_vec(),
            0,
            false
        )
    );
}

#[test]
fn numeric_diagnostics_and_stop_keep_their_order() {
    for program in [false, true] {
        let prefix = if program {
            "printf: 'abc': expected a numeric value\n"
        } else {
            "bash: printf: abc: invalid number\n"
        };
        assert_eq!(
            run(b"%d%b%d", &[b"abc", b"x\\cy", b"bad"], program, 2),
            (b"0x".to_vec(), prefix.as_bytes().to_vec(), 0, true)
        );
        assert_eq!(
            run(b"%d\\c%d", &[b"abc", b"bad"], program, 2),
            (b"0".to_vec(), prefix.as_bytes().to_vec(), 1, true)
        );
    }
    assert_eq!(
        run(b"a[%*s]", &[b"2147483648", b"x"], true, 3),
        (
            b"a[".to_vec(),
            b"printf: invalid field width: '2147483648'\n".to_vec(),
            1,
            true
        )
    );
}

#[test]
fn output_events_precede_later_diagnostics() {
    let mut stream = request(b"before%dafter", &[b"bad"], false, 1);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut events = Vec::new();
    stream.finish(&mut out).unwrap();
    loop {
        stream.take_stderr(&mut err);
        if !out.is_empty() {
            events.push((false, std::mem::take(&mut out)));
        }
        if !err.is_empty() {
            events.push((true, std::mem::take(&mut err)));
        }
        if !stream.busy() {
            break;
        }
        stream.drain(&mut out).unwrap();
    }
    assert_eq!(
        events,
        vec![
            (false, b"before".to_vec()),
            (true, b"bash: printf: bad: invalid number\n".to_vec()),
            (false, b"0after".to_vec())
        ]
    );
}

#[test]
fn byte_precision_escapes_and_quoting() {
    let args: &[&[u8]] = &[
        "é".as_bytes(),
        "é".as_bytes(),
        b"\\uD800\\xff",
        b"a b",
        b"\xff",
    ];
    let expected = b"[\xc3][\xc3][\xed\xa0\x80\xff][  a\\ b][$'\\377']";
    for split in [1, 2, 3, 7, STEP] {
        assert_eq!(
            run(b"[%c][%.1s][%b][%6q][%q]", args, false, split),
            (expected.to_vec(), Vec::new(), 0, false)
        );
    }
    assert_eq!(
        run(b"%b", &[b"\\0003\\400\\U7fffffff"], false, 1).0,
        b"\x03\0\xfd\xbf\xbf\xbf\xbf\xbf"
    );
}

#[test]
fn scans_large_numeric_tokens_without_losing_late_digits() {
    let integer = [vec![b'0'; STEP * 3], b"7".to_vec()].concat();
    let float = [b"0.".to_vec(), vec![b'0'; STEP * 3], b"25e49154".to_vec()].concat();
    let nan = [b"-nan(".to_vec(), vec![b'0'; STEP * 3], b")".to_vec()].concat();
    assert_eq!(
        run(b"%d|%g|%+f", &[&integer, &float, &nan], false, 7),
        (b"7|25|-nan".to_vec(), Vec::new(), 0, false)
    );
}

#[test]
fn huge_output_remains_bounded_and_can_be_dropped() {
    for format in [
        b"%18446744073709551615s".as_slice(),
        b"%.18446744073709551615f",
        b"%.18446744073709551615d",
    ] {
        let mut stream = request(format, &[b"1"], false, 1);
        let mut out = Vec::new();
        stream.finish(&mut out).unwrap();
        for _ in 0..10 {
            assert!(out.len() <= STEP);
            out.clear();
            stream.drain(&mut out).unwrap();
        }
        assert!(stream.busy());
    }
}

#[test]
fn nan_signs_hex_carry_and_negative_zero() {
    for program in [false, true] {
        assert_eq!(
            run(
                b"%+.1f|%+.1a|%.0a|%.1a|%.0f",
                &[b"nan", b"-nan", b"0x1.ffp0", b"0x1.ffp0", b"-0"],
                program,
                1
            ),
            (
                b"+nan|-nan|0x2p+0|0x2.0p+0|-0".to_vec(),
                Vec::new(),
                0,
                false
            )
        );
    }
}

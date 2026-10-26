//! What the integ corpus does not pin on both hosts: the request
//! protocol round trip, numeric fields GNU tolerates, and the run's own
//! accounting for members that shrink or do not open.

use serde_json::{Value as Json, json};

use super::escaped;
use super::header::{self, BLOCK, Kind, RECORD};
use crate::host::Host;

fn run(host: &mut Host, config: Json) -> (i32, String, String) {
    let mut stream = crate::open("tar", config.to_string().as_bytes()).expect("opens");
    let status = host.drive(stream.as_mut());
    let out = String::from_utf8_lossy(&std::mem::take(&mut host.out)).into_owned();
    let err = String::from_utf8_lossy(&std::mem::take(&mut host.err)).into_owned();
    (status, out, err)
}

fn read(host: &mut Host, archive: &[u8], options: Json) -> (i32, String, String) {
    host.files.insert("a.tar".into(), archive.to_vec());
    let mut config = json!({"mode": "list", "archive": "a.tar", "base": "/out"});
    for (key, value) in options.as_object().expect("options") {
        config[key] = value.clone();
    }
    run(host, config)
}

fn file(name: &str, operand: usize, size: Option<u64>) -> Json {
    json!({"name": name, "kind": "file", "path": name, "operand": operand, "size": size})
}

/// One member's blocks, `patch` laid over its header, whose checksum is
/// made again.
fn member(name: &str, patch: (usize, &[u8])) -> Vec<u8> {
    let mut out = header::encode(name.as_bytes(), Kind::File, 6, b"");
    let (at, bytes) = patch;
    out[at..at + bytes.len()].copy_from_slice(bytes);
    out[148..156].copy_from_slice(b"        ");
    let sum: u32 = out.iter().map(|&b| u32::from(b)).sum();
    out[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    out.extend_from_slice(b"hello\n");
    out.resize(2 * BLOCK, 0);
    out
}

/// One member's blocks and the two zero blocks that end an archive.
fn archive(name: &str, patch: (usize, &[u8])) -> Vec<u8> {
    [member(name, patch), vec![0; 2 * BLOCK]].concat()
}

#[test]
fn an_archive_round_trips_through_the_host() {
    let body = "alpha beta gamma\n".repeat(5000);
    let mut host = Host::with(&[("a.txt", "hello\n"), ("d/b.txt", &body)], "");
    let members = json!([
        {"name": "d/", "kind": "dir"},
        file("d/b.txt", 2, Some(body.len() as u64)),
        file("a.txt", 3, None),
        {"name": "l", "kind": "link", "target": "a.txt"},
    ]);
    let config =
        json!({"archive": "a.tar", "output": "a.tar", "codec": "gzip", "members": members});
    assert_eq!(run(&mut host, config), (0, String::new(), String::new()));
    let tar = host.files["a.tar"].clone();
    let (status, out, _) = read(&mut host, &tar, json!({"mode": "extract", "verbose": true}));
    assert_eq!((status, out.as_str()), (0, "d/\nd/b.txt\na.txt\n"));
    assert_eq!(host.files["/out/d/b.txt"], body.as_bytes());
    assert_eq!(host.files["/out/a.txt"], b"hello\n");
    let plain = json!({"archive": "-", "members": [file("a.txt", 2, None)]});
    let mut stream = crate::open("tar", plain.to_string().as_bytes()).expect("opens");
    assert_eq!(host.drive(stream.as_mut()), 0);
    assert_eq!(host.out.len(), RECORD);
}

#[test]
fn numeric_fields_are_read_as_gnu_reads_them() {
    let row = |patch| {
        read(
            &mut Host::default(),
            &archive("a", patch),
            json!({"verbose": true}),
        )
    };
    let stamp = |date: &str| format!("-rw-r--r-- 0/0               6 {date} a\n");
    assert_eq!(
        row((124, b"\x80\0\0\0\0\0\0\0\0\0\0\x06")).1,
        stamp("1970-01-01 00:00")
    );
    assert_eq!(row((124, b"        6  ")).1, stamp("1970-01-01 00:00"));
    assert_eq!(row((136, b"77777777777\0")).1, stamp("2242-03-16 12:56"));
    assert_eq!(row((136, &[0xff; 12])).1, stamp("1969-12-31 23:59"));
    let wide = "-rwsrwsrwt 0/0               6 1970-01-01 00:00 a\n";
    assert_eq!(row((100, b"7777777\0")).1, wide);
    let (status, _, err) = row((124, b"0000000000x\0"));
    let said = "tar: Archive contains '0000000000x' where numeric off_t value expected\n";
    assert!(status == 2 && err.starts_with(said), "{err}");
    // Checksum spellings GNU tar 1.35 accepts: any octal count after blanks,
    // ended by a NUL, a blank or the field's end.
    let sum = &archive("a", (0, b""))[148..154];
    let sum = u32::from_str_radix(std::str::from_utf8(sum).expect("octal"), 8).expect("octal");
    for text in [
        format!("{sum:07o}\0"),
        format!("   {sum:o}\0"),
        format!("{sum:08o}"),
        format!("{sum:06o}\n\0"),
        format!("{sum:06o}\0x"),
    ] {
        let mut tar = archive("a", (0, b""));
        tar[148..148 + text.len()].copy_from_slice(text.as_bytes());
        assert_eq!(read(&mut Host::default(), &tar, json!({})).0, 0, "{text:?}");
    }
}

#[test]
fn a_member_that_does_not_open_is_left_out_and_a_shrunk_one_padded() {
    let mut host = Host::with(&[("a.txt", "hello\n")], "");
    let members = json!([file("gone", 2, Some(3)), file("a.txt", 3, Some(10))]);
    let config = json!({"archive": "a.tar", "output": "a.tar", "members": members,
        "notices": ["tar: noted"], "status": 0});
    let (status, _, err) = run(&mut host, config);
    assert_eq!(status, 2);
    assert_eq!(
        err,
        "tar: noted\ntar: gone: Cannot open: No such file or directory\n\
         tar: a.txt: File shrank by 4 bytes; padding with zeros\n\
         tar: Exiting with failure status due to previous errors\n"
    );
    let tar = host.files["a.tar"].clone();
    let (_, out, _) = read(
        &mut host,
        &tar,
        json!({"mode": "extract", "to_stdout": true}),
    );
    assert_eq!(out.as_bytes(), b"hello\n\0\0\0\0");
}

#[test]
fn strip_components_counts_from_the_name_without_its_slashes() {
    let mut host = Host::default();
    let tar = [member("/x/y/z", (0, b"")), archive("./a/b", (0, b""))].concat();
    let (status, _, _) = read(&mut host, &tar, json!({"mode": "extract", "strip": 1}));
    assert_eq!(status, 0);
    assert_eq!(host.files["/out/y/z"], b"hello\n");
    assert_eq!(host.files["/out/a/b"], b"hello\n");
}

#[test]
fn the_escape_style_is_gnu_tars() {
    // GNU tar 1.35 on debian:stable-slim (LC_ALL=C.UTF-8), `tar -tf` of
    // members created under each name: a space stays bare.
    for (name, shown) in [
        (&b"a b"[..], "a b"),
        (b"back\\slash", "back\\\\slash"),
        (b"tab\tx", "tab\\tx"),
        (b"e\x1bx", "e\\033x"),
        (b"del\x7f", "del\\177"),
        (
            "c1\u{85} e\u{2028}".as_bytes(),
            "c1\\302\\205 e\\342\\200\\250",
        ),
        ("\u{e9}'\"".as_bytes(), "\u{e9}'\""),
        (b"a\xffb", "a\\377b"),
    ] {
        assert_eq!(escaped(name), shown.as_bytes(), "{shown}");
    }
}

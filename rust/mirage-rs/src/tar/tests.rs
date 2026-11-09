//! What the integ corpus does not pin on both hosts: the request
//! protocol round trip, numeric fields GNU tolerates, and the run's own
//! accounting for members that shrink or do not open.

use serde_json::{Value as Json, json};

use super::escaped;
use super::header::{self, BLOCK, Kind, RECORD};
use crate::host::{Fault, Host};

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
    let mut out = header::encode(
        name.as_bytes(),
        Kind::File,
        6,
        b"",
        &header::Stamp::default(),
    );
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
    let (status, _, _) = read(
        &mut host,
        &tar,
        json!({"mode": "extract", "typed": [["extract", ""], ["strip_components", "1"]]}),
    );
    assert_eq!(status, 0);
    assert_eq!(host.files["/out/y/z"], b"hello\n");
    assert_eq!(host.files["/out/a/b"], b"hello\n");
}

#[test]
fn a_pax_record_longer_than_its_header_ends_the_records() {
    let mut pax = header::Pax::default();
    pax.read(b"6 a=b\n18446744073709551615 x=y\n");
    pax.read(b"6 a=b\n4294967295 x=y\n");
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

#[test]
fn decoded_limits_cover_metadata_before_it_is_retained() {
    for flag in *b"LKxg" {
        let size = 128 * 1024;
        let mut tar = header::encode(
            b"././@LongLink",
            Kind::File,
            size as u64,
            b"",
            &header::Stamp::default(),
        );
        tar[156] = flag;
        tar[148..156].fill(b' ');
        let sum: u32 = tar.iter().map(|&b| u32::from(b)).sum();
        tar[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        tar.resize(BLOCK + size, 0);
        if flag == b'L' {
            tar[BLOCK..BLOCK + 2].copy_from_slice(b"a\0");
        }
        tar.extend(archive("a", (0, b"")));
        assert_eq!(read(&mut Host::default(), &tar, json!({})).0, 0);
        let (status, _, err) = read(
            &mut Host::default(),
            &tar,
            json!({"max_decoded_bytes": 32_768}),
        );
        assert_eq!(status, 2);
        assert_eq!(err, "tar: decoded input exceeds size limit\n");
    }
}

#[test]
fn decoded_limit_accepts_its_exact_boundary() {
    let tar = archive("a", (0, b""));
    assert_eq!(
        read(
            &mut Host::default(),
            &tar,
            json!({"max_decoded_bytes": tar.len()})
        )
        .0,
        0
    );
    let (status, _, err) = read(
        &mut Host::default(),
        &tar,
        json!({"max_decoded_bytes": tar.len() - 1}),
    );
    assert_eq!(status, 2);
    assert_eq!(err, "tar: decoded input exceeds size limit\n");
}

/// A type-S sparse member holding `DATA` at the end of a `hole` of zeros.
fn sparse(name: &str, hole: u64) -> Vec<u8> {
    let mut out = header::encode(
        name.as_bytes(),
        Kind::File,
        4,
        b"",
        &header::Stamp::default(),
    );
    out[156] = b'S';
    out[386..398].copy_from_slice(format!("{hole:011o}\0").as_bytes());
    out[398..410].copy_from_slice(b"00000000004\0");
    out[483..495].copy_from_slice(format!("{:011o}\0", hole + 4).as_bytes());
    out[148..156].copy_from_slice(b"        ");
    let sum: u32 = out.iter().map(|&b| u32::from(b)).sum();
    out[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    out.extend_from_slice(b"DATA");
    out.resize(2 * BLOCK, 0);
    out
}

#[test]
fn holes_past_the_room_left_fail_their_member_and_the_run_reads_on() {
    let small = 600 * 1024;
    let tar = [
        sparse("s", small),
        sparse("t", small),
        archive("a", (0, b"")),
    ]
    .concat();
    let failed = "tar: t: Cannot write: File too large\n\
                  tar: Exiting with failure status due to previous errors\n";
    let mut host = Host::default();
    let (status, _, err) = read(&mut host, &tar, json!({"mode": "extract"}));
    assert_eq!((status, err.as_str()), (2, failed));
    assert_eq!(host.files["/out/s"].len() as u64, small + 4);
    assert!(host.files["/out/s"].ends_with(b"\0DATA"));
    assert_eq!(host.files["/out/t"], b"");
    assert_eq!(host.files["/out/a"], b"hello\n");
    let (status, out, err) = read(
        &mut host,
        &tar,
        json!({"mode": "extract", "to_stdout": true}),
    );
    assert_eq!((status, err.as_str()), (2, failed));
    assert_eq!(out.len() as u64, small + 4 + 6);
    let (status, out, _) = read(&mut host, &tar, json!({}));
    assert_eq!((status, out.as_str()), (0, "s\nt\na\n"));
}

#[test]
fn a_meta_header_past_what_a_run_holds_is_memory_exhausted() {
    for flag in *b"LKxg" {
        let mut tar = header::encode(
            b"././@LongLink",
            Kind::File,
            super::read::MAX_META + 1,
            b"",
            &header::Stamp::default(),
        );
        tar[156] = flag;
        tar[148..156].fill(b' ');
        let sum: u32 = tar.iter().map(|&b| u32::from(b)).sum();
        tar[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        tar.extend_from_slice(&[b'n'; BLOCK]);
        for mode in ["list", "extract"] {
            let (status, _, err) = read(&mut Host::default(), &tar, json!({"mode": mode}));
            assert_eq!(
                (status, err.as_str()),
                (
                    2,
                    "tar: memory exhausted\ntar: Error is not recoverable: exiting now\n"
                ),
                "{}",
                flag as char
            );
        }
    }
}

fn packed(host: &mut Host, members: Json) {
    let config = json!({"archive": "a.tar", "output": "a.tar", "members": members});
    assert_eq!(run(host, config), (0, String::new(), String::new()));
}

fn names_in(host: &mut Host) -> String {
    let tar = host.files["a.tar"].clone();
    read(host, &tar, json!({})).1
}

fn dated(name: &str, mtime: i64) -> Json {
    let mut entry = file(name, 2, None);
    entry["mtime"] = json!(mtime);
    entry
}

fn changed(host: &mut Host, mode: &str, members: Json, selectors: Json) -> (i32, String, String) {
    let config = json!({
        "mode": mode,
        "archive": "a.tar",
        "output": "a.tar",
        "members": members,
        "selectors": selectors,
    });
    run(host, config)
}

fn two() -> Host {
    Host::with(&[("a.txt", "one\n"), ("b.txt", "two\n")], "")
}

#[test]
fn an_append_goes_where_the_end_marker_stood() {
    let mut host = two();
    packed(&mut host, json!([file("a.txt", 2, None)]));
    let more = json!([file("b.txt", 2, None)]);
    let (status, _, err) = changed(&mut host, "append", more, json!([]));
    assert_eq!((status, err.as_str()), (0, ""));
    assert_eq!(names_in(&mut host), "a.txt\nb.txt\n");
    assert_eq!(host.files["a.tar"].len() % RECORD, 0);
}

#[test]
fn an_update_adds_only_a_file_newer_than_its_member() {
    let mut host = two();
    packed(&mut host, json!([dated("a.txt", 100)]));
    let same = json!([dated("a.txt", 100), dated("b.txt", 5)]);
    assert_eq!(changed(&mut host, "update", same, json!([])).0, 0);
    assert_eq!(names_in(&mut host), "a.txt\nb.txt\n");
    let newer = json!([dated("a.txt", 200)]);
    assert_eq!(changed(&mut host, "update", newer, json!([])).0, 0);
    assert_eq!(names_in(&mut host), "a.txt\nb.txt\na.txt\n");
}

#[test]
fn a_delete_commits_what_it_found_despite_a_miss() {
    let mut host = two();
    let members = json!([file("a.txt", 2, None), file("b.txt", 3, None)]);
    packed(&mut host, members);
    let (status, _, err) = changed(&mut host, "delete", json!([]), json!(["a.txt", "nope"]));
    assert_eq!(status, 2);
    assert!(err.contains("tar: nope: Not found in archive\n"), "{err}");
    assert_eq!(names_in(&mut host), "b.txt\n");
}

#[test]
fn a_delete_from_no_archive_leaves_an_empty_one() {
    let mut host = two();
    changed(&mut host, "delete", json!([]), json!(["a.txt"]));
    assert!(host.files["a.tar"].is_empty());
}

#[test]
fn a_new_member_records_the_time_and_mode_it_is_given() {
    let mut host = two();
    let mut entry = dated("a.txt", 86_400);
    entry["mode"] = json!(0o640);
    packed(&mut host, json!([entry]));
    let tar = host.files["a.tar"].clone();
    let (_, out, _) = read(&mut host, &tar, json!({"verbose": true}));
    assert!(out.starts_with("-rw-r-----"), "{out}");
    assert!(out.contains("1970-01-02 00:00 a.txt"), "{out}");
    let config = json!({
        "archive": "a.tar",
        "output": "a.tar",
        "mtime": 3600,
        "members": [dated("a.txt", 86_400)],
    });
    assert_eq!(run(&mut host, config).0, 0);
    let tar = host.files["a.tar"].clone();
    let (_, out, _) = read(&mut host, &tar, json!({"verbose": true}));
    assert!(out.contains("1970-01-01 01:00 a.txt"), "{out}");
}

#[test]
fn a_transform_renames_what_it_matches_as_a_run_reads() {
    let mut host = two();
    packed(&mut host, json!([file("a.txt", 2, None)]));
    let tar = host.files["a.tar"].clone();
    let typed = json!([["extract", ""], ["transform", "s/a/z/"]]);
    let options = json!({"mode": "extract", "typed": typed});
    assert_eq!(
        read(&mut host, &tar, options),
        (0, String::new(), String::new())
    );
    assert_eq!(host.files["/out/z.txt"], b"one\n");
}

#[test]
fn a_rename_that_reaches_a_parent_stays_below_the_root() {
    let mut host = Host::with(&[], "");
    let tar = archive("bundle-../x", (0, b""));
    let typed = json!([["extract", ""], ["transform", "s/^bundle-//"]]);
    let options = json!({"mode": "extract", "typed": typed, "base": "/out/sub"});
    let (status, _, err) = read(&mut host, &tar, options);
    assert_eq!(status, 0);
    assert_eq!(err, "tar: Removing leading `../' from member names\n");
    assert_eq!(host.files["/out/sub/x"], b"hello\n");
    assert!(!host.files.contains_key("/out/x"));
}

#[test]
fn a_renamed_member_loses_its_parents_before_its_strip() {
    let mut host = Host::with(&[], "");
    let tar = [
        member("bundle-../x", (0, b"")),
        member("bundle-../d/e/y", (0, b"")),
        vec![0; 2 * BLOCK],
    ]
    .concat();
    let typed = json!([
        ["extract", ""],
        ["transform", "s/^bundle-//"],
        ["strip_components", "1"]
    ]);
    let (status, _, err) = read(&mut host, &tar, json!({"mode": "extract", "typed": typed}));
    assert_eq!(status, 0);
    assert_eq!(err, "tar: Removing leading `../' from member names\n");
    assert_eq!(host.files["/out/e/y"], b"hello\n");
    assert!(!host.files.contains_key("/out/x"));
}

#[test]
fn a_link_to_nothing_counts_as_an_old_file() {
    let mut host = Host::with(&[], "");
    host.links.insert("/out/x".into(), "/out/gone".into());
    let tar = archive("x", (0, b""));
    let keep = json!({"mode": "extract", "typed": [["extract", ""], ["keep_old_files", ""]]});
    let (status, _, err) = read(&mut host, &tar, keep);
    assert_eq!(status, 2);
    assert!(err.contains("tar: x: Cannot open: File exists"), "{err}");
    let skip = json!({"mode": "extract", "typed": [["extract", ""], ["skip_old_files", ""]]});
    assert_eq!(
        read(&mut host, &tar, skip),
        (0, String::new(), String::new())
    );
    assert!(!host.files.contains_key("/out/gone"));
}

#[test]
fn a_value_octal_cannot_hold_goes_in_base_256() {
    let mut host = two();
    let config = json!({
        "archive": "a.tar",
        "output": "a.tar",
        "mtime": -1,
        "members": [file("a.txt", 2, None)],
        "typed": [["create", ""], ["owner", ":3000000"]],
    });
    assert_eq!(run(&mut host, config).0, 0);
    let block = &host.files["a.tar"][..BLOCK];
    assert_eq!(block[108..116], [0x80, 0, 0, 0, 0, 0x2d, 0xc6, 0xc0]);
    assert_eq!(block[136..148], [0xFF; 12]);
}

#[test]
fn an_exclusion_takes_a_name_any_of_its_directories_or_any_tail() {
    let mut host = two();
    let members = json!([file("a.txt", 2, None), file("b.txt", 3, None)]);
    packed(&mut host, members);
    let tar = host.files["a.tar"].clone();
    let rule = |pattern: &str, anchored: bool| json!({"exclusions": [{"pattern": pattern, "anchored": anchored, "wildcards": true}]});
    assert_eq!(read(&mut host, &tar, rule("a.*", false)).1, "b.txt\n");
    assert_eq!(read(&mut host, &tar, rule("*", true)).1, "");
    let selected = {
        let mut options = rule("a.txt", false);
        options["selectors"] = json!(["a.txt"]);
        options
    };
    assert_eq!(
        read(&mut host, &tar, selected),
        (0, String::new(), String::new())
    );
}

#[test]
fn an_abandoned_update_leaves_the_archive_alone() {
    let mut host = two();
    packed(&mut host, json!([file("a.txt", 2, None)]));
    let before = host.files["a.tar"].clone();
    let config = json!({
        "mode": "append",
        "archive": "a.tar",
        "output": "a.tar",
        "abandon": true,
        "status": 2,
        "notices": ["tar: nope: No such file or directory"],
        "members": [file("b.txt", 2, None)],
    });
    let (status, _, err) = run(&mut host, config);
    assert_eq!(
        (status, err.as_str()),
        (2, "tar: nope: No such file or directory\n")
    );
    assert_eq!(host.files["a.tar"], before);
}

#[test]
fn a_failed_read_leaves_the_archive_alone() {
    let mut host = two();
    let members = json!([file("a.txt", 2, None), file("b.txt", 3, None)]);
    packed(&mut host, members);
    let before = host.files["a.tar"].clone();
    let fault = Fault {
        after: BLOCK * 2,
        errno: "EIO",
        text: "Input/output error",
    };
    host.faults.insert("a.tar".into(), fault);
    let (status, ..) = changed(&mut host, "delete", json!([]), json!(["a.txt"]));
    assert_eq!(status, 2);
    assert_eq!(host.files["a.tar"], before);
}

#[test]
fn absolute_names_still_lose_stripped_components() {
    let mut host = two();
    packed(&mut host, json!([file("a.txt", 2, None)]));
    let member = header::encode(b"/x/y/a.txt", Kind::File, 0, b"", &header::Stamp::default());
    let mut tar = member;
    tar.resize(RECORD, 0);
    let typed = json!([["extract", ""], ["strip_components", "2"]]);
    let options = json!({"mode": "extract", "absolute": true, "typed": typed});
    assert_eq!(read(&mut host, &tar, options).0, 0);
    assert!(host.files.contains_key("/out/a.txt"));
}

#[test]
fn a_delete_of_no_names_changes_nothing() {
    let mut host = two();
    packed(&mut host, json!([file("a.txt", 2, None)]));
    assert_eq!(changed(&mut host, "delete", json!([]), json!([])).0, 0);
    assert_eq!(names_in(&mut host), "a.txt\n");
}

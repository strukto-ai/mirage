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

fn read(host: &mut Host, mode: &str, archive: &[u8], options: Json) -> (i32, String, String) {
    host.files.insert("a.tar".into(), archive.to_vec());
    let mut config = json!({"mode": mode, "archive": "a.tar", "base": "/out"});
    for (key, value) in options.as_object().expect("options") {
        config[key] = value.clone();
    }
    run(host, config)
}

fn list(archive: &[u8]) -> (i32, String, String) {
    read(&mut Host::default(), "list", archive, json!({}))
}

fn file(name: &str, operand: usize, size: Option<u64>) -> Json {
    json!({"name": name, "kind": "file", "path": name, "operand": operand, "size": size})
}

/// A member's headers and data, padded to whole blocks.
fn member(name: &str, data: &[u8]) -> Vec<u8> {
    let mut out = header::encode(name.as_bytes(), Kind::File, data.len() as u64, b"");
    out.extend_from_slice(data);
    out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
    out
}

fn ended(mut body: Vec<u8>) -> Vec<u8> {
    body.resize(body.len() + 2 * BLOCK, 0);
    body
}

const JUNK: [u8; BLOCK] = [b'x'; BLOCK];

/// A header block with `bytes` laid at `at` and its checksum made again.
fn patched(name: &str, at: usize, bytes: &[u8]) -> Vec<u8> {
    let mut block = member(name, b"hello\n");
    block[at..at + bytes.len()].copy_from_slice(bytes);
    block[148..156].copy_from_slice(b"        ");
    let sum: u32 = block[..BLOCK].iter().map(|&b| u32::from(b)).sum();
    block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    block
}

#[test]
fn headers_are_gnu_tars_byte_for_byte() {
    // Checksums GNU tar 1.35 wrote for these members with --format=gnu
    // --owner=0 --group=0 --numeric-owner --mtime=@0 (debian:stable-slim).
    let sum = |block: &[u8]| String::from_utf8_lossy(&block[148..156]).into_owned();
    assert_eq!(sum(&header::encode(b"d/", Kind::Dir, 0, b"")), "006130\0 ");
    assert_eq!(sum(&header::encode(b"d/a.txt", Kind::File, 6, b"")), "007105\0 ");
    assert_eq!(sum(&header::encode(b"d/b512", Kind::File, 512, b"")), "006513\0 ");
    assert_eq!(sum(&header::encode(b"d/link", Kind::Link, 0, b"a.txt")), "007766\0 ");
    let long = format!("d/{}", "L".repeat(130));
    let blocks = header::encode(long.as_bytes(), Kind::File, 5, b"");
    assert_eq!(blocks.len(), 3 * BLOCK);
    assert_eq!(&blocks[..13], b"././@LongLink");
    assert_eq!(sum(&blocks), "007770\0 ");
    assert_eq!(&blocks[BLOCK..BLOCK + 133], [long.as_bytes(), b"\0"].concat());
    assert_eq!(sum(&blocks[2 * BLOCK..]), "024555\0 ");
    let target = "T".repeat(150);
    let blocks = header::encode(b"d/l150", Kind::Link, 0, target.as_bytes());
    assert_eq!((blocks[156], sum(&blocks)), (b'K', "007773\0 ".into()));
    assert_eq!(sum(&blocks[2 * BLOCK..]), "027053\0 ");
    let exact = format!("d/{}", "n".repeat(98));
    assert_eq!(header::encode(exact.as_bytes(), Kind::File, 4, b"").len(), BLOCK);
}

#[test]
fn an_archive_round_trips_through_create_list_and_extract() {
    let body = "alpha beta gamma\n".repeat(5000);
    let mut host = Host::with(&[("a.txt", "hello\n"), ("d/b.txt", &body)], "");
    let members = json!([
        {"name": "d/", "kind": "dir"},
        file("d/b.txt", 2, Some(body.len() as u64)),
        file("a.txt", 3, None),
        {"name": "l", "kind": "link", "target": "a.txt"},
    ]);
    let config = json!({"archive": "a.tar", "output": "a.tar", "members": members, "verbose": true});
    let (status, out, err) = run(&mut host, config);
    assert_eq!((status, out.as_str(), err.as_str()), (0, "d/\nd/b.txt\na.txt\nl\n", ""));
    let archive = host.files["a.tar"].clone();
    assert_eq!(archive.len() % RECORD, 0);
    let (status, out, _) = read(&mut host, "list", &archive, json!({"verbose": true}));
    assert_eq!(status, 0);
    assert_eq!(
        out,
        "drwxr-xr-x 0/0               0 1970-01-01 00:00 d/\n\
         -rw-r--r-- 0/0           85000 1970-01-01 00:00 d/b.txt\n\
         -rw-r--r-- 0/0               6 1970-01-01 00:00 a.txt\n\
         lrwxrwxrwx 0/0               0 1970-01-01 00:00 l -> a.txt\n"
    );
    let (status, out, err) = read(&mut host, "extract", &archive, json!({"verbose": true}));
    assert_eq!((status, out.as_str(), err.as_str()), (0, "d/\nd/b.txt\na.txt\n", ""));
    assert_eq!(host.files["/out/d/b.txt"], body.as_bytes());
    assert_eq!(host.files["/out/a.txt"], b"hello\n");
    assert!(host.directories.contains(&"/out/d".to_owned()));
    let (status, out, _) = read(&mut host, "extract", &archive, json!({"to_stdout": true, "selectors": ["a.txt"]}));
    assert_eq!((status, out.as_str()), (0, "hello\n"));
}

#[test]
fn a_compressed_archive_round_trips_and_is_sniffed_from_a_file() {
    for codec in ["gzip", "bzip2", "xz"] {
        let mut host = Host::with(&[("a.txt", "hello\n")], "");
        let config = json!({"archive": "a.tz", "output": "a.tz", "codec": codec, "members": [file("a.txt", 2, Some(6))]});
        assert_eq!(run(&mut host, config).0, 0);
        let archive = host.files["a.tz"].clone();
        let (status, out, err) = read(&mut host, "list", &archive, json!({"codec": codec}));
        assert_eq!((status, out.as_str(), err.as_str()), (0, "a.txt\n", ""), "{codec}");
        let (status, out, _) = read(&mut host, "extract", &archive, json!({"to_stdout": true}));
        assert_eq!((status, out.as_str()), (0, "hello\n"), "{codec}");
    }
}

#[test]
fn standard_input_names_the_option_its_magic_wants() {
    let mut host = Host::with(&[("a.txt", "hello\n")], "");
    let config = json!({"archive": "-", "codec": "xz", "members": [file("a.txt", 2, Some(6))]});
    let mut stream = crate::open("tar", config.to_string().as_bytes()).expect("opens");
    assert_eq!(host.drive(stream.as_mut()), 0);
    host.stdin = std::mem::take(&mut host.out);
    let (status, _, err) = run(&mut host, json!({"mode": "list", "archive": "-"}));
    assert_eq!(
        (status, err.as_str()),
        (2, "tar: Archive is compressed. Use -J option\ntar: Error is not recoverable: exiting now\n")
    );
}

#[test]
fn zero_blocks_end_the_archive_and_a_lone_one_is_named() {
    let one = member("a", b"hello\n");
    assert_eq!(list(&ended(one.clone())), (0, "a\n".into(), String::new()));
    let mut lone = one.clone();
    lone.extend_from_slice(&[0; BLOCK]);
    assert_eq!(list(&lone), (0, "a\n".into(), "tar: A lone zero block at 3\n".into()));
    lone.extend(member("b", b"bee\n"));
    assert_eq!(list(&lone), (0, "a\n".into(), "tar: A lone zero block at 3\n".into()));
    let mut cut = one.clone();
    cut.extend_from_slice(&[b'x'; 100]);
    assert_eq!(list(&cut), (0, "a\n".into(), String::new()));
    assert_eq!(list(&[0; 600]), (0, String::new(), "tar: A lone zero block at 1\n".into()));
    assert_eq!(list(&[0; 2 * BLOCK]), (0, String::new(), String::new()));
}

#[test]
fn a_block_that_is_no_header_is_skipped_to_the_next() {
    let failure = "tar: Exiting with failure status due to previous errors\n";
    let not_tar = "tar: This does not look like a tar archive\n";
    let skipping = "tar: Skipping to next header\n";
    let one = member("a", b"hello\n");
    let between = ended([one.clone(), JUNK.to_vec(), JUNK.to_vec(), member("b", b"bee\n")].concat());
    assert_eq!(list(&between), (2, "a\nb\n".into(), format!("{skipping}{failure}")));
    let first = ended([JUNK.to_vec(), member("b", b"bee\n")].concat());
    assert_eq!(list(&first), (2, "b\n".into(), format!("{not_tar}{skipping}{failure}")));
    let lone = [JUNK.to_vec(), vec![0; BLOCK]].concat();
    let said = format!("{not_tar}{skipping}tar: A lone zero block at 2\n{failure}");
    assert_eq!(list(&lone), (2, String::new(), said));
    assert_eq!(list(b"hello\n"), (2, String::new(), format!("{not_tar}{failure}")));
    assert_eq!(list(b""), (2, String::new(), format!("{not_tar}{failure}")));
}

#[test]
fn a_member_cut_short_ends_the_run() {
    let one = member("a", b"hello\n");
    let eof = "tar: Unexpected EOF in archive\n";
    let fatal = "tar: Error is not recoverable: exiting now\n";
    assert_eq!(list(&one[..600]), (2, "a\n".into(), format!("{eof}{fatal}")));
    let mut host = Host::default();
    let (status, out, err) = read(&mut host, "extract", &one[..BLOCK], json!({"to_stdout": true}));
    assert_eq!((status, out.as_str(), err), (2, "", format!("{eof}{eof}{fatal}")));
}

#[test]
fn numeric_fields_are_read_as_gnu_reads_them() {
    let row = |block: Vec<u8>| list_verbose(&ended(block));
    assert_eq!(row(patched("a", 124, b"\x80\0\0\0\0\0\0\0\0\0\0\x06")).1, "-rw-r--r-- 0/0               6 1970-01-01 00:00 a\n");
    assert_eq!(row(patched("a", 124, b"        6  ")).0, 0);
    assert_eq!(row(patched("a", 136, b"77777777777\0")).1, "-rw-r--r-- 0/0               6 2242-03-16 12:56 a\n");
    assert_eq!(row(patched("a", 136, &[0xff; 12])).1, "-rw-r--r-- 0/0               6 1969-12-31 23:59 a\n");
    assert_eq!(row(patched("a", 100, b"7777777\0")).1, "-rwsrwsrwt 0/0               6 1970-01-01 00:00 a\n");
    let (status, out, err) = row(patched("a", 108, b"000x000\0"));
    assert_eq!(out, "-rw-r--r-- 4294967295/0      6 1970-01-01 00:00 a\n");
    assert_eq!(
        (status, err.as_str()),
        (2, "tar: Archive contains '000x000' where numeric uid_t value expected\ntar: Exiting with failure status due to previous errors\n")
    );
    let (status, _, err) = row(patched("a", 124, b"0000000000x\0"));
    assert!(err.starts_with("tar: Archive contains '0000000000x' where numeric off_t value expected\ntar: This does not look like a tar archive\n"));
    assert_eq!(status, 2);
    let mut host = Host::default();
    let block = patched("a", 148, b"");
    for checksum in ["%07o\0", "   %o\0", "%o\0\0\0\0", "%08o", "%06o\n\0", "%06o\0x"] {
        let mut block = block.clone();
        let sum = u32::from_str_radix(String::from_utf8_lossy(&block[148..154]).trim(), 8).expect("octal");
        let text = checksum.replace("%07o", &format!("{sum:07o}")).replace("%08o", &format!("{sum:08o}"))
            .replace("%06o", &format!("{sum:06o}")).replace("%o", &format!("{sum:o}"));
        block[148..148 + text.len()].copy_from_slice(text.as_bytes());
        assert_eq!(read(&mut host, "list", &ended(block), json!({})).0, 0, "{checksum:?}");
    }
}

fn list_verbose(archive: &[u8]) -> (i32, String, String) {
    read(&mut Host::default(), "list", archive, json!({"verbose": true}))
}

#[test]
fn the_owner_column_widens_for_the_rest_of_the_run() {
    let long = patched("a", 265, b"averylongusernamethatgoeson\0");
    let long = {
        let mut block = long;
        block[297..301].copy_from_slice(b"grp\0");
        block[148..156].copy_from_slice(b"        ");
        let sum: u32 = block[..BLOCK].iter().map(|&b| u32::from(b)).sum();
        block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        block
    };
    let (_, out, _) = list_verbose(&ended([long, member("b", b"bee\n")].concat()));
    assert_eq!(
        out,
        "-rw-r--r-- averylongusernamethatgoeson/grp 6 1970-01-01 00:00 a\n\
         -rw-r--r-- 0/0                             4 1970-01-01 00:00 b\n"
    );
}

#[test]
fn names_lose_their_prefix_and_dotdot_is_refused_on_extraction() {
    let mut host = Host::default();
    let archive = ended([member("/abs", b"1"), member("../up", b"2"), member("a//b", b"3")].concat());
    let (status, out, err) = read(&mut host, "list", &archive, json!({}));
    assert_eq!((status, out.as_str()), (0, "/abs\n../up\na//b\n"));
    assert_eq!(err, "tar: Removing leading `/' from member names\ntar: Removing leading `../' from member names\n");
    let (status, _, err) = read(&mut host, "extract", &archive, json!({}));
    assert_eq!(status, 2);
    assert_eq!(
        err,
        "tar: Removing leading `/' from member names\ntar: Removing leading `../' from member names\n\
         tar: ../up: Member name contains '..'\ntar: Exiting with failure status due to previous errors\n"
    );
    assert_eq!(host.files["/out/abs"], b"1");
    assert_eq!(host.files["/out/a/b"], b"3");
    let (_, _, err) = read(&mut host, "list", &ended(member("k/..", b"")), json!({}));
    assert_eq!(err, "tar: Removing leading `k/..' from member names\n");
}

#[test]
fn each_member_is_found_by_the_first_operand_that_names_it() {
    let archive = ended([member("d/", b""), member("d/s/", b""), member("d/s/f", b"1")].concat());
    let mut host = Host::default();
    let (status, out, err) = read(&mut host, "list", &archive, json!({"selectors": ["d", "d/s"]}));
    assert_eq!((status, out.as_str()), (2, "d/\nd/s/\nd/s/f\n"));
    assert_eq!(err, "tar: d/s: Not found in archive\ntar: Exiting with failure status due to previous errors\n");
    let (status, _, _) = read(&mut host, "list", &archive, json!({"selectors": ["d/s", "d"]}));
    assert_eq!(status, 0);
    let (status, _, err) = read(&mut host, "list", &archive, json!({"selectors": ["d*"]}));
    assert_eq!(status, 2);
    assert!(err.starts_with("tar: Pattern matching characters used in file names\n"), "{err}");
}

#[test]
fn strip_components_counts_from_the_name_without_its_slashes() {
    let mut host = Host::default();
    let archive = ended([member("/x/y/z", b"1"), member("./a/b", b"2"), member("q", b"3")].concat());
    let (status, _, _) = read(&mut host, "extract", &archive, json!({"strip": 1}));
    assert_eq!(status, 0);
    assert_eq!((&host.files["/out/y/z"][..], &host.files["/out/a/b"][..]), (&b"1"[..], &b"2"[..]));
    assert!(!host.files.contains_key("/out/q"));
}

#[test]
fn a_missing_archive_and_a_directory_are_worded_as_gnu_words_them() {
    let mut host = Host::default();
    let config = json!({"mode": "list", "archive": "nope.tgz", "codec": "gzip"});
    let (status, _, err) = run(&mut host, config);
    assert_eq!(status, 2);
    assert_eq!(
        err,
        "tar (child): nope.tgz: Cannot open: No such file or directory\ntar (child): Error is not recoverable: exiting now\n\
         tar: Child returned status 2\ntar: Error is not recoverable: exiting now\n"
    );
    host.directories.push("sub".into());
    let (_, _, err) = run(&mut host, json!({"mode": "list", "archive": "sub"}));
    assert_eq!(
        err,
        "tar: sub: Cannot read: Is a directory\ntar: At beginning of tape, quitting now\ntar: Error is not recoverable: exiting now\n"
    );
}

#[test]
fn a_member_that_does_not_open_is_left_out_and_a_shrunk_one_padded() {
    let mut host = Host::with(&[("a.txt", "hello\n")], "");
    let members = json!([file("gone", 2, Some(3)), file("a.txt", 3, Some(10))]);
    let config = json!({"archive": "a.tar", "output": "a.tar", "members": members, "notices": ["tar: noted"], "status": 0});
    let (status, _, err) = run(&mut host, config);
    assert_eq!(status, 2);
    assert_eq!(
        err,
        "tar: noted\ntar: gone: Cannot open: No such file or directory\n\
         tar: a.txt: File shrank by 4 bytes; padding with zeros\ntar: Exiting with failure status due to previous errors\n"
    );
    let archive = host.files["a.tar"].clone();
    let (_, out, _) = read(&mut host, "extract", &archive, json!({"to_stdout": true}));
    assert_eq!(out.as_bytes(), b"hello\n\0\0\0\0");
}

#[test]
fn the_escape_style_doubles_backslashes_and_spells_bytes_in_octal() {
    assert_eq!(escaped(b"a\xffb"), b"a\\377b");
    assert_eq!(escaped(b"back\\slash"), b"back\\\\slash");
    assert_eq!(escaped(b"new\nline sp"), b"new\\nline sp");
    assert_eq!(escaped("\u{85}c1 e\u{2028} ok\u{e9}".as_bytes()), "\\302\\205c1 e\\342\\200\\250 ok\u{e9}".as_bytes());
}

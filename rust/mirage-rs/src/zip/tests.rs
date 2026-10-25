use serde_json::{Value as Json, json};

use super::wildcard;
use crate::host::Host;

fn run(host: &mut Host, kind: &str, config: Json) -> (i32, String, String) {
    let mut stream = crate::open(kind, config.to_string().as_bytes()).expect("opens");
    let status = host.drive(stream.as_mut());
    let out = String::from_utf8_lossy(&std::mem::take(&mut host.out)).into_owned();
    let err = String::from_utf8_lossy(&std::mem::take(&mut host.err)).into_owned();
    (status, out, err)
}

fn zip(host: &mut Host, archive: &str, found: Json) -> (i32, String, String) {
    let config = json!({"archive": archive, "output": archive, "found": found});
    run(host, "zip", config)
}

fn unzip(host: &mut Host, archive: &str, options: Json) -> (i32, String, String) {
    let mut config = json!({"archive": archive, "shown": archive, "base": ""});
    for (key, value) in options.as_object().expect("options") {
        config[key] = value.clone();
    }
    run(host, "unzip", config)
}

fn file(spelled: &str, operand: usize) -> Json {
    json!({"spelled": spelled, "kind": "file", "path": spelled, "operand": operand})
}

fn sample() -> Host {
    let body = "alpha beta gamma\n".repeat(5000);
    let mut host = Host::with(&[("a.txt", "hello\n"), ("d/b.txt", &body)], "");
    let found = json!([file("a.txt", 2), {"spelled": "d", "kind": "dir"}, file("d/b.txt", 3)]);
    let (status, out, err) = zip(&mut host, "z.zip", found);
    assert_eq!((status, err.as_str()), (0, ""));
    assert_eq!(out, "  adding: a.txt\n  adding: d/\n  adding: d/b.txt\n");
    host
}

#[test]
fn a_new_archive_lists_and_pipes_back() {
    let mut host = sample();
    let (status, out, _) = unzip(&mut host, "z.zip", json!({"Z": true, "1": true}));
    assert_eq!((status, out.as_str()), (0, "a.txt\nd/\nd/b.txt\n"));
    let (status, out, _) = unzip(&mut host, "z.zip", json!({"p": true, "members": ["d/*"]}));
    assert_eq!((status, out.len()), (0, 85000));
    let (status, out, _) = unzip(&mut host, "z.zip", json!({"l": true}));
    assert_eq!(status, 0);
    assert_eq!(
        out,
        "  Length      Name\n---------  ----\n        6  a.txt\n        0  d/\n    85000  d/b.txt\n"
    );
    let (status, out, _) = unzip(&mut host, "z.zip", json!({"t": true}));
    assert_eq!(status, 0);
    assert!(
        out.ends_with("No errors detected in compressed data of z.zip.\n"),
        "{out}"
    );
}

#[test]
fn an_update_replaces_in_place_and_appends() {
    let mut host = sample();
    host.files.insert("a.txt".into(), b"changed\n".to_vec());
    host.files.insert("c.txt".into(), b"new\n".to_vec());
    let (status, out, _) = zip(
        &mut host,
        "z.zip",
        json!([file("c.txt", 2), file("a.txt", 3)]),
    );
    assert_eq!(
        (status, out.as_str()),
        (0, "updating: a.txt\n  adding: c.txt\n")
    );
    let (_, names, _) = unzip(&mut host, "z.zip", json!({"Z": true, "1": true}));
    assert_eq!(names, "a.txt\nd/\nd/b.txt\nc.txt\n");
    let (_, out, _) = unzip(
        &mut host,
        "z.zip",
        json!({"p": true, "members": ["a.txt", "c.txt"]}),
    );
    assert_eq!(out, "changed\nnew\n");
}

#[test]
fn zip_strips_leading_slashes_then_dot_slashes() {
    let mut host = Host::with(&[("x", "x")], "");
    let read = |spelled| json!({"spelled": spelled, "kind": "file", "path": "x", "operand": 2});
    assert_eq!(
        zip(&mut host, "s.zip", json!([read("/./x"), read(".//x")])).0,
        0
    );
    let (_, names, _) = unzip(&mut host, "s.zip", json!({"Z": true, "1": true}));
    assert_eq!(names, "x\n/x\n");
}

#[test]
fn zip_refuses_names_two_paths_share() {
    let mut host = Host::with(&[("a.txt", "1"), ("s/a.txt", "2")], "");
    let config = json!({"archive": "j.zip", "output": "j.zip", "junk": true,
        "found": [file("s/a.txt", 2), file("a.txt", 3)]});
    let (status, _, err) = run(&mut host, "zip", config);
    assert_eq!(status, 16);
    assert!(err.ends_with("this may be a result of using -j\n\nzip error: Invalid command arguments (cannot repeat names in zip file)\n"), "{err}");
    assert!(!host.files.contains_key("j.zip"));
}

#[test]
fn extraction_asks_before_it_replaces() {
    let mut host = sample();
    host.stdin = b"n\n".to_vec();
    host.directories.push("/o".into());
    host.files.insert("/o/a.txt".into(), b"old\n".to_vec());
    let (status, out, err) = unzip(&mut host, "z.zip", json!({"base": "/o"}));
    assert_eq!(status, 0, "{err}");
    assert_eq!(
        out,
        "Archive:  z.zip\n   creating: d/\n  inflating: d/b.txt                 \n"
    );
    assert_eq!(err, "replace a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: ");
    assert_eq!(host.files["/o/a.txt"], b"old\n");
    assert_eq!(host.files["/o/d/b.txt"].len(), 85000);
}

#[test]
fn a_bad_crc_is_reported_in_info_zips_words() {
    let mut host = sample();
    let archive = host.files.get_mut("z.zip").expect("written");
    // a.txt's stored CRC, in its local header and its central record.
    for at in [14, archive.len() - 22 - (3 * 46 + 14) + 16] {
        archive[at] ^= 1;
    }
    let (status, out, _) = unzip(&mut host, "z.zip", json!({"t": true, "members": ["a.txt"]}));
    assert_eq!(status, 2);
    assert!(
        out.contains(
            "    testing: a.txt                    bad CRC 363a3020  (should be 363a3021)\n"
        ),
        "{out}"
    );
    let (status, out, err) = unzip(&mut host, "z.zip", json!({"p": true, "members": ["a.txt"]}));
    assert_eq!((status, out.as_str()), (2, "hello\n"));
    assert_eq!(
        err,
        "a.txt                   bad CRC 363a3020  (should be 363a3021)\n"
    );
}

#[test]
fn a_file_that_is_no_archive_is_refused() {
    let mut host = Host::with(&[("p.zip", "plain text")], "");
    let (status, _, err) = unzip(&mut host, "p.zip", json!({"p": true}));
    assert_eq!(status, 9);
    assert!(
        err.starts_with("[p.zip]\n  End-of-central-directory signature not found."),
        "{err}"
    );
    let (status, _, err) = unzip(&mut host, "nope.zip", json!({}));
    assert_eq!(
        (status, err.as_str()),
        (9, "unzip: nope.zip: No such file or directory\n")
    );
}

#[test]
fn filespecs_match_byte_by_byte() {
    for (pattern, name, escapes, expected) in [
        ("*", "d/x", false, true),
        ("d/*", "d/", false, true),
        ("?.txt", "é.txt", false, false),
        ("??.txt", "é.txt", false, true),
        ("[!a]*", "b", false, true),
        ("[^a]*", "a", false, false),
        ("[]x]", "]", false, true),
        ("[a-c]", "b", false, true),
        ("[ab", "[ab", false, true),
        ("\\*", "*", true, true),
        ("\\*", "x", true, false),
        ("*.txt", "a.txt.gz", false, false),
    ] {
        assert_eq!(
            wildcard(pattern.as_bytes(), name.as_bytes(), escapes),
            expected,
            "{pattern} {name}"
        );
    }
}

#[test]
fn a_chain_that_cannot_be_made_skips_its_member_and_goes_on() {
    let mut host = Host::with(&[("denied/a.txt", "A"), ("ok.txt", "OK")], "");
    let found = json!([file("denied/a.txt", 2), file("ok.txt", 3)]);
    assert_eq!(zip(&mut host, "z.zip", found).0, 0);
    let (status, _, err) = unzip(&mut host, "z.zip", json!({"q": true}));
    assert_eq!(status, 2);
    assert_eq!(
        err,
        "checkdir error:  cannot create denied\n                 Permission denied\n                 unable to process denied/a.txt.\n"
    );
    assert_eq!(host.files["/ok.txt"], b"OK");
}

#[test]
fn a_zip64_end_record_is_read() {
    let mut host = sample();
    let archive = host.files.remove("z.zip").expect("written");
    let end = archive.len() - 22;
    let (size, offset) = (&archive[end + 12..end + 16], &archive[end + 16..end + 20]);
    let [size, offset] =
        [size, offset].map(|b| u64::from(u32::from_le_bytes(b.try_into().expect("4 bytes"))));
    let mut wide = archive[..end].to_vec();
    let record = wide.len() as u64;
    wide.extend(0x0606_4b50u32.to_le_bytes());
    wide.extend(44u64.to_le_bytes());
    wide.extend([45, 0, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for value in [3, 3, size, offset] {
        wide.extend(u64::to_le_bytes(value));
    }
    wide.extend(0x0706_4b50u32.to_le_bytes());
    wide.extend(0u32.to_le_bytes());
    wide.extend(record.to_le_bytes());
    wide.extend(1u32.to_le_bytes());
    wide.extend(0x0605_4b50u32.to_le_bytes());
    wide.extend([0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);
    wide.extend([0xFF; 8]);
    wide.extend([0, 0]);
    host.files.insert("z.zip".into(), wide);
    let (status, out, err) = unzip(&mut host, "z.zip", json!({"Z": true, "1": true}));
    assert_eq!(
        (status, out.as_str(), err.as_str()),
        (0, "a.txt\nd/\nd/b.txt\n", "")
    );
}

use std::collections::HashMap;
use std::io::Cursor;

use serde_json::{Value, json};

use super::Server;
use super::mount::mountstat3;
use super::nfs::{self, fattr3, ftype3, nfs_fh3, nfsstat3, post_op_attr};
use super::rpc::{accept_body, call_body, opaque_auth, reply_body, rpc_body, rpc_msg};
use super::xdr::XDR;

const GENERATION: u64 = 7;

fn server() -> Server {
    Server::new(br#"{"export": "/", "generation": 7, "port": 2049}"#).unwrap()
}

fn record(xid: u32, prog: u32, proc_: u32, args: &[u8]) -> Vec<u8> {
    let msg = rpc_msg {
        xid,
        body: rpc_body::CALL(call_body {
            rpcvers: 2,
            prog,
            vers: 3,
            proc: proc_,
            cred: opaque_auth::default(),
            verf: opaque_auth::default(),
        }),
    };
    let mut body = Vec::new();
    msg.serialize(&mut body).unwrap();
    body.extend_from_slice(args);
    let mut framed = (body.len() as u32 | 0x8000_0000).to_be_bytes().to_vec();
    framed.extend(body);
    framed
}

type Part<'a> = &'a dyn Fn(&mut Vec<u8>);

fn args(parts: &[Part<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts {
        part(&mut out);
    }
    out
}

fn fh(id: u64) -> nfs_fh3 {
    let mut data = GENERATION.to_le_bytes().to_vec();
    data.extend(id.to_le_bytes());
    nfs_fh3 { data }
}

/// A file's bytes, or a directory's children.
type Body = Result<Vec<u8>, Vec<&'static str>>;

/// A mount the fake host serves: path to mode and body.
struct Tree(HashMap<&'static str, (u32, Body)>);

impl Tree {
    fn sample() -> Self {
        let mut tree = HashMap::new();
        tree.insert("/", (0o040755, Err(vec!["a.txt", "sub"])));
        tree.insert("/a.txt", (0o100644, Ok(b"hello\n".to_vec())));
        tree.insert("/sub", (0o040755, Err(vec![])));
        Tree(tree)
    }

    fn attrs(&self, path: &str) -> Option<Value> {
        let (mode, body) = self.0.get(path)?;
        let size = body.as_ref().map_or(0, Vec::len);
        Some(json!({
            "mode": mode, "size": size, "nlink": 1, "uid": 501, "gid": 20,
            "atime": [1, 0], "mtime": [2, 500], "ctime": [3, 0],
        }))
    }

    fn answer(&self, request: &Value) -> (Value, Vec<u8>) {
        let path = request["path"].as_str().unwrap();
        let missing = (json!({"error": "ENOENT"}), Vec::new());
        match request["op"].as_str().unwrap() {
            "getattr" => match self.attrs(path) {
                Some(attrs) => (json!({ "attrs": attrs }), Vec::new()),
                None => missing,
            },
            "read" => match self.0.get(path) {
                Some((_, Ok(body))) => {
                    let offset = (request["offset"].as_u64().unwrap() as usize).min(body.len());
                    let end = (offset + request["size"].as_u64().unwrap() as usize).min(body.len());
                    (json!({}), body[offset..end].to_vec())
                }
                Some(_) => (json!({"error": "EISDIR"}), Vec::new()),
                None => missing,
            },
            "readdir" => match self.0.get(path) {
                Some((_, Err(children))) => {
                    let entries: Vec<Value> = children
                        .iter()
                        .map(|name| {
                            let child = format!("{}/{name}", path.trim_end_matches('/'));
                            json!({"name": name, "attrs": self.attrs(&child)})
                        })
                        .collect();
                    (json!({ "entries": entries }), Vec::new())
                }
                Some(_) => (json!({"error": "ENOTDIR"}), Vec::new()),
                None => missing,
            },
            op => panic!("unexpected op {op}"),
        }
    }

    /// Feed one connection's bytes, answer every request they lead to,
    /// and return what the server wrote back, with how many requests ran.
    fn run(&self, server: &mut Server, conn: u32, input: &[u8]) -> (Vec<u8>, usize) {
        let mut out = Vec::new();
        server.feed(conn, input, &mut out).unwrap();
        let mut ran = 0;
        loop {
            let mut raw = Vec::new();
            server.requests(&mut raw);
            let requests: Vec<Value> = serde_json::from_slice(&raw).unwrap();
            if requests.is_empty() {
                return (out, ran);
            }
            for request in requests {
                ran += 1;
                let (reply, data) = self.answer(&request);
                let id = request["id"].as_u64().unwrap() as u32;
                let reply = serde_json::to_vec(&reply).unwrap();
                let owner = server.complete(id, &reply, &data, &mut out).unwrap();
                assert_eq!(owner, Some(conn));
            }
        }
    }
}

/// Split the server's output into replies: (xid, the bytes after the
/// accepted-reply header).
fn replies(mut out: &[u8]) -> Vec<(u32, Cursor<Vec<u8>>)> {
    let mut found = Vec::new();
    while !out.is_empty() {
        let header = u32::from_be_bytes(out[..4].try_into().unwrap());
        assert!(header & 0x8000_0000 != 0);
        let len = (header & 0x7fff_ffff) as usize;
        let mut cursor = Cursor::new(out[4..4 + len].to_vec());
        let mut msg = rpc_msg::default();
        msg.deserialize(&mut cursor).unwrap();
        let rpc_body::REPLY(reply_body::MSG_ACCEPTED(accepted)) = msg.body else {
            panic!("not an accepted reply");
        };
        assert!(matches!(accepted.reply_data, accept_body::SUCCESS));
        found.push((msg.xid, cursor));
        out = &out[4 + len..];
    }
    found
}

fn status(cursor: &mut Cursor<Vec<u8>>) -> nfsstat3 {
    let mut stat = nfsstat3::NFS3ERR_SERVERFAULT;
    stat.deserialize(cursor).unwrap();
    stat
}

fn attrs(cursor: &mut Cursor<Vec<u8>>) -> fattr3 {
    let mut attr = fattr3::default();
    attr.deserialize(cursor).unwrap();
    attr
}

fn lookup(tree: &Tree, server: &mut Server, dir: u64, name: &str) -> (nfsstat3, Option<nfs_fh3>) {
    let input = record(
        9,
        nfs::PROGRAM,
        3,
        &args(&[&|o| fh(dir).serialize(o).unwrap(), &|o| {
            name.as_bytes().to_vec().serialize(o).unwrap()
        }]),
    );
    let (out, _) = tree.run(server, 1, &input);
    let mut found = replies(&out);
    let (_, cursor) = &mut found[0];
    let stat = status(cursor);
    if !matches!(stat, nfsstat3::NFS3_OK) {
        return (stat, None);
    }
    let mut handle = nfs_fh3::default();
    handle.deserialize(cursor).unwrap();
    (stat, Some(handle))
}

#[test]
fn null_answers_without_the_host() {
    let mut server = server();
    let (out, ran) = Tree::sample().run(&mut server, 1, &record(5, nfs::PROGRAM, 0, &[]));
    assert_eq!(ran, 0);
    let found = replies(&out);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, 5);
}

#[test]
fn mount_hands_out_the_root_handle() {
    let mut server = server();
    let input = record(
        6,
        super::mount::PROGRAM,
        1,
        &args(&[&|o| b"/".to_vec().serialize(o).unwrap()]),
    );
    let (out, _) = Tree::sample().run(&mut server, 1, &input);
    let mut found = replies(&out);
    let cursor = &mut found[0].1;
    let mut stat = mountstat3::MNT3ERR_IO;
    stat.deserialize(cursor).unwrap();
    assert!(matches!(stat, mountstat3::MNT3_OK));
    let mut handle = Vec::<u8>::new();
    handle.deserialize(cursor).unwrap();
    assert_eq!(handle, fh(1).data);
}

#[test]
fn getattr_asks_the_host_and_answers_its_attributes() {
    let mut server = server();
    let input = record(
        7,
        nfs::PROGRAM,
        1,
        &args(&[&|o| fh(1).serialize(o).unwrap()]),
    );
    let (out, ran) = Tree::sample().run(&mut server, 1, &input);
    assert_eq!(ran, 1);
    let mut found = replies(&out);
    let cursor = &mut found[0].1;
    assert!(matches!(status(cursor), nfsstat3::NFS3_OK));
    let attr = attrs(cursor);
    assert!(matches!(attr.ftype, ftype3::NF3DIR));
    assert_eq!((attr.mode, attr.fileid, attr.uid), (0o755, 1, 501));
    assert_eq!((attr.mtime.seconds, attr.mtime.nseconds), (2, 500));
}

#[test]
fn lookup_then_read_returns_the_file_bytes() {
    let tree = Tree::sample();
    let mut server = server();
    let (stat, handle) = lookup(&tree, &mut server, 1, "a.txt");
    assert!(matches!(stat, nfsstat3::NFS3_OK));
    let handle = handle.unwrap();
    let input = record(
        10,
        nfs::PROGRAM,
        6,
        &args(&[
            &|o| handle.serialize(o).unwrap(),
            &|o| 0_u64.serialize(o).unwrap(),
            &|o| 100_u32.serialize(o).unwrap(),
        ]),
    );
    let (out, _) = tree.run(&mut server, 1, &input);
    let mut found = replies(&out);
    let cursor = &mut found[0].1;
    assert!(matches!(status(cursor), nfsstat3::NFS3_OK));
    let mut attr = post_op_attr::Void;
    attr.deserialize(cursor).unwrap();
    let (mut count, mut eof, mut data) = (0_u32, false, Vec::<u8>::new());
    count.deserialize(cursor).unwrap();
    eof.deserialize(cursor).unwrap();
    data.deserialize(cursor).unwrap();
    assert_eq!((count, eof, data.as_slice()), (6, true, &b"hello\n"[..]));
}

#[test]
fn lookup_of_a_missing_name_is_noent() {
    let tree = Tree::sample();
    let mut server = server();
    let (stat, _) = lookup(&tree, &mut server, 1, "nope");
    assert!(matches!(stat, nfsstat3::NFS3ERR_NOENT));
}

#[test]
fn a_handle_from_another_generation_is_stale() {
    let mut server = server();
    let mut old = fh(1);
    old.data[..8].copy_from_slice(&3_u64.to_le_bytes());
    let input = record(
        11,
        nfs::PROGRAM,
        1,
        &args(&[&|o| old.serialize(o).unwrap()]),
    );
    let (out, ran) = Tree::sample().run(&mut server, 1, &input);
    assert_eq!(ran, 0);
    let mut found = replies(&out);
    assert!(matches!(status(&mut found[0].1), nfsstat3::NFS3ERR_STALE));
}

#[test]
fn readdirplus_lists_entries_with_handles_and_attributes() {
    let tree = Tree::sample();
    let mut server = server();
    let input = record(
        12,
        nfs::PROGRAM,
        17,
        &args(&[
            &|o| fh(1).serialize(o).unwrap(),
            &|o| 0_u64.serialize(o).unwrap(),
            &|o| [0_u8; 8].serialize(o).unwrap(),
            &|o| 4096_u32.serialize(o).unwrap(),
            &|o| 32768_u32.serialize(o).unwrap(),
        ]),
    );
    let (out, _) = tree.run(&mut server, 1, &input);
    let mut found = replies(&out);
    let cursor = &mut found[0].1;
    assert!(matches!(status(cursor), nfsstat3::NFS3_OK));
    let mut dir_attr = post_op_attr::Void;
    dir_attr.deserialize(cursor).unwrap();
    let mut verifier = [0_u8; 8];
    verifier.deserialize(cursor).unwrap();
    let mut names = Vec::new();
    loop {
        let mut more = false;
        more.deserialize(cursor).unwrap();
        if !more {
            break;
        }
        let (mut fileid, mut name, mut cookie) = (0_u64, Vec::<u8>::new(), 0_u64);
        fileid.deserialize(cursor).unwrap();
        name.deserialize(cursor).unwrap();
        cookie.deserialize(cursor).unwrap();
        let mut attr = post_op_attr::Void;
        attr.deserialize(cursor).unwrap();
        let mut handle = super::nfs::post_op_fh3::Void;
        handle.deserialize(cursor).unwrap();
        names.push(String::from_utf8(name).unwrap());
    }
    let mut eof = false;
    eof.deserialize(cursor).unwrap();
    assert_eq!(names, ["a.txt", "sub"]);
    assert!(eof);
}

#[test]
fn a_record_split_across_feeds_still_answers() {
    let tree = Tree::sample();
    let mut server = server();
    let input = record(13, nfs::PROGRAM, 0, &[]);
    let mut out = Vec::new();
    for byte in &input {
        server
            .feed(1, std::slice::from_ref(byte), &mut out)
            .unwrap();
    }
    assert_eq!(replies(&out)[0].0, 13);
    let (out, _) = tree.run(&mut server, 1, &record(14, nfs::PROGRAM, 0, &[]));
    assert_eq!(replies(&out)[0].0, 14);
}

#[test]
fn a_closed_connection_drops_its_waiting_call() {
    let mut server = server();
    let mut out = Vec::new();
    let input = record(
        15,
        nfs::PROGRAM,
        1,
        &args(&[&|o| fh(1).serialize(o).unwrap()]),
    );
    server.feed(2, &input, &mut out).unwrap();
    let mut raw = Vec::new();
    server.requests(&mut raw);
    let requests: Vec<Value> = serde_json::from_slice(&raw).unwrap();
    server.close(2);
    let id = requests[0]["id"].as_u64().unwrap() as u32;
    let owner = server
        .complete(id, br#"{"error": "EIO"}"#, &[], &mut out)
        .unwrap();
    assert_eq!(owner, None);
    assert!(out.is_empty());
}

#[test]
fn writes_are_refused_as_a_read_only_filesystem() {
    let tree = Tree::sample();
    let mut server = server();
    let input = record(
        16,
        nfs::PROGRAM,
        9,
        &args(&[
            &|o| fh(1).serialize(o).unwrap(),
            &|o| b"new".to_vec().serialize(o).unwrap(),
            &|o| super::nfs::sattr3::default().serialize(o).unwrap(),
        ]),
    );
    let (out, _) = tree.run(&mut server, 1, &input);
    let mut found = replies(&out);
    assert!(matches!(status(&mut found[0].1), nfsstat3::NFS3ERR_ROFS));
}

#[test]
fn readdir_pages_a_large_directory_from_each_cookie() {
    let names: Vec<&'static str> = (0..100)
        .map(|i| &*Box::leak(format!("f{i:03}").into_boxed_str()))
        .collect();
    let mut tree = Tree::sample();
    tree.0.insert("/", (0o040755, Err(names.clone())));
    for name in &names {
        let path: &'static str = Box::leak(format!("/{name}").into_boxed_str());
        tree.0.insert(path, (0o100644, Ok(Vec::new())));
    }
    let mut server = server();
    let (mut cookie, mut seen, mut pages) = (0_u64, Vec::new(), 0);
    loop {
        pages += 1;
        assert!(pages < 50, "readdir never reached eof");
        let input = record(
            20 + pages,
            nfs::PROGRAM,
            16,
            &args(&[
                &|o| fh(1).serialize(o).unwrap(),
                &|o| cookie.serialize(o).unwrap(),
                &|o| [0_u8; 8].serialize(o).unwrap(),
                &|o| 512_u32.serialize(o).unwrap(),
            ]),
        );
        let (out, _) = tree.run(&mut server, 1, &input);
        let mut found = replies(&out);
        let cursor = &mut found[0].1;
        assert!(matches!(status(cursor), nfsstat3::NFS3_OK));
        let mut dir_attr = post_op_attr::Void;
        dir_attr.deserialize(cursor).unwrap();
        let mut verifier = [0_u8; 8];
        verifier.deserialize(cursor).unwrap();
        loop {
            let mut more = false;
            more.deserialize(cursor).unwrap();
            if !more {
                break;
            }
            let (mut fileid, mut name) = (0_u64, Vec::<u8>::new());
            fileid.deserialize(cursor).unwrap();
            name.deserialize(cursor).unwrap();
            cookie.deserialize(cursor).unwrap();
            seen.push(String::from_utf8(name).unwrap());
        }
        let mut eof = false;
        eof.deserialize(cursor).unwrap();
        if eof {
            break;
        }
    }
    assert!(pages > 1);
    assert_eq!(seen, names);
}

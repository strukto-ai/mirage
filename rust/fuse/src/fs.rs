use crate::link::{Failure, Link};
use crate::proto::Frame;
use fuser::{
    AccessFlags, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation,
    INodeNo, InitFlags, KernelConfig, LockOwner, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate,
    ReplyData, ReplyDirectory, ReplyDirectoryPlus, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs,
    ReplyWrite, ReplyXattr, Request, TimeOrNow, WriteFlags,
};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::path::Path;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long the kernel and the client keep an answer the host gave no
/// directive to keep: `KERNEL_CACHE_SECONDS`, as sshfs keeps one.
const SHORT: Duration = Duration::from_secs(1);
/// How long they keep one the host said to keep: until it says otherwise.
const LONG: Duration = Duration::from_secs(86_400);
/// The bytes of content the client keeps in memory.
const CACHE_BYTES: usize = 256 << 20;
/// The largest file read whole into the cache; a larger one reads by range.
const WHOLE_FILE: u64 = 8 << 20;
const ROOT: u64 = 1;

/// One answer about a path: its attributes and whether the host said to
/// keep them, which it says only of a backend nothing but the workspace
/// changes.
#[derive(Clone, Debug, PartialEq)]
pub struct Attrs {
    pub mode: u32,
    pub size: u64,
    pub atime: f64,
    pub mtime: f64,
    pub ctime: f64,
    pub nlink: u32,
    pub rdev: u32,
    pub kept: bool,
}

impl Attrs {
    /// The attributes in a reply's `a` (or a listing row), kept when the
    /// reply's `k` says so.
    pub fn parse(value: &Value, kept: bool) -> Option<Attrs> {
        let f = |key: &str| value.get(key).and_then(Value::as_f64);
        Some(Attrs {
            mode: f("m")? as u32,
            size: f("s").unwrap_or(0.0) as u64,
            atime: f("a").unwrap_or(0.0),
            mtime: f("t").unwrap_or(0.0),
            ctime: f("c").unwrap_or(0.0),
            nlink: f("n").unwrap_or(1.0) as u32,
            rdev: f("r").unwrap_or(0.0) as u32,
            kept,
        })
    }

    fn is(&self, kind: u32) -> bool {
        self.mode & libc::S_IFMT == kind
    }

    /// What content cached under these attributes is: its size and mtime.
    fn version(&self) -> (u64, u64) {
        (self.size, self.mtime.to_bits())
    }
}

struct Known {
    attrs: Attrs,
    at: Instant,
}

impl Known {
    fn fresh(&self) -> bool {
        self.attrs.kept || self.at.elapsed() < SHORT
    }
}

struct Listing {
    rows: Vec<(String, Attrs)>,
    names: HashSet<String>,
    kept: bool,
    at: Instant,
}

impl Listing {
    fn fresh(&self) -> bool {
        self.kept || self.at.elapsed() < SHORT
    }
}

struct Content {
    version: (u64, u64),
    data: Arc<Vec<u8>>,
}

#[derive(Clone)]
struct Open {
    path: String,
    host: Option<u64>,
    data: Option<Arc<Vec<u8>>>,
    writes: bool,
}

/// What the kernel must forget, and the host's barriers, in the order they
/// came: run on a thread of their own, so a notification the kernel holds
/// back never stalls the replies a request waits for.
pub enum Note {
    Entry(u64, String),
    Inode(u64),
    Ack(u64),
}

#[derive(Default)]
struct State {
    paths: HashMap<u64, String>,
    inodes: HashMap<String, u64>,
    next_ino: u64,
    known: HashMap<String, Known>,
    listings: HashMap<String, Listing>,
    covered: HashSet<String>,
    content: HashMap<String, Content>,
    order: VecDeque<String>,
    bytes: usize,
    fetched: HashSet<String>,
    opens: HashMap<u64, Open>,
    dirs: HashMap<u64, Vec<(String, Attrs)>>,
    next_fh: u64,
}

/// A listing's rows from its JSON: `[[name, attrs], ...]`.
fn entries(rows: Option<&Value>, kept: bool) -> Vec<(String, Attrs)> {
    rows.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some((
                row.get(0)?.as_str()?.to_string(),
                Attrs::parse(row.get(1)?, kept)?,
            ))
        })
        .collect()
}

impl State {
    /// Keep `dir`'s listing and each entry's attributes; a folder a tree
    /// answer listed counts as covered, so it is listed alone after.
    fn listed(&mut self, dir: &str, rows: &[(String, Attrs)], kept: bool, at: Instant) {
        for (name, attrs) in rows {
            self.known.insert(
                child(dir, name),
                Known {
                    attrs: attrs.clone(),
                    at,
                },
            );
        }
        self.covered.insert(dir.to_string());
        self.listings.insert(
            dir.to_string(),
            Listing {
                names: rows.iter().map(|(n, _)| n.clone()).collect(),
                rows: rows.to_vec(),
                kept,
                at,
            },
        );
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `name` under `dir`, both workspace paths.
pub fn child(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The folder `path` is in, and its name there; None for `/`.
pub fn split(path: &str) -> Option<(String, String)> {
    let (dir, name) = path.rsplit_once('/')?;
    if name.is_empty() {
        return None;
    }
    Some((
        if dir.is_empty() {
            "/".into()
        } else {
            dir.into()
        },
        name.into(),
    ))
}

/// Whether a change at `changed` reaches `path`: the same path, or one under it.
pub fn reaches(changed: &str, path: &str) -> bool {
    let changed = changed.trim_end_matches('/');
    changed.is_empty() || path == changed || path.starts_with(&format!("{changed}/"))
}

fn errno(condition: &str) -> Errno {
    Errno::from_i32(match condition {
        "ENOENT" => libc::ENOENT,
        "EACCES" => libc::EACCES,
        "EPERM" => libc::EPERM,
        "EROFS" => libc::EROFS,
        "EEXIST" => libc::EEXIST,
        "ENOTDIR" => libc::ENOTDIR,
        "EISDIR" => libc::EISDIR,
        "ENOTEMPTY" => libc::ENOTEMPTY,
        "EINVAL" => libc::EINVAL,
        "EXDEV" => libc::EXDEV,
        "EBUSY" => libc::EBUSY,
        "EBADF" => libc::EBADF,
        "EFBIG" => libc::EFBIG,
        "ELOOP" => libc::ELOOP,
        "ENAMETOOLONG" => libc::ENAMETOOLONG,
        "ENOSPC" => libc::ENOSPC,
        "EDQUOT" => libc::EDQUOT,
        "ENXIO" => libc::ENXIO,
        "EPIPE" => libc::EPIPE,
        "ESTALE" => libc::ESTALE,
        "ENOTSUP" | "EOPNOTSUPP" => libc::EOPNOTSUPP,
        "ENODATA" | "ENOATTR" => libc::ENODATA,
        "ERANGE" => libc::ERANGE,
        "EAGAIN" => libc::EAGAIN,
        "ENOSYS" => libc::ENOSYS,
        _ => libc::EIO,
    })
}

fn failed(failure: Failure) -> Errno {
    match failure {
        Failure::Refused(condition) => errno(&condition),
        Failure::Lost => Errno::from_i32(libc::ENOTCONN),
    }
}

fn time(ms: f64) -> SystemTime {
    if ms >= 0.0 {
        UNIX_EPOCH + Duration::from_secs_f64(ms / 1000.0)
    } else {
        UNIX_EPOCH - Duration::from_secs_f64(-ms / 1000.0)
    }
}

/// A time as milliseconds since the epoch, `now` read from the machine's
/// clock as a kernel mount reads it for `touch`.
fn ms(when: TimeOrNow) -> Value {
    let t = match when {
        TimeOrNow::Now => SystemTime::now(),
        TimeOrNow::SpecificTime(t) => t,
    };
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => Value::from(d.as_secs_f64() * 1000.0),
        Err(e) => Value::from(-e.duration().as_secs_f64() * 1000.0),
    }
}

fn ttl(attrs: &Attrs) -> Duration {
    if attrs.kept { LONG } else { SHORT }
}

/// The client's side of fsproto: a workspace prefix served by the host,
/// answered from what the host said to keep and asked of it otherwise.
pub struct MirageFs {
    link: Arc<Link>,
    shared: Arc<Shared>,
    uid: u32,
    gid: u32,
}

/// The state the filesystem and the host's pushes share.
pub struct Shared {
    root: String,
    state: Mutex<State>,
    notes: Mutex<Sender<Note>>,
}

impl Shared {
    pub fn new(root: String, notes: Sender<Note>) -> Shared {
        let mut state = State {
            next_ino: ROOT + 1,
            next_fh: 1,
            ..State::default()
        };
        state.paths.insert(ROOT, root.clone());
        state.inodes.insert(root.clone(), ROOT);
        Shared {
            root,
            state: Mutex::new(state),
            notes: Mutex::new(notes),
        }
    }

    fn note(&self, note: Note) {
        let _ = locked(&self.notes).send(note);
    }

    /// A frame the host started: `inval` forgets what it names, and a
    /// `begin` barrier is answered once every forget before it is done.
    pub fn push(&self, frame: Frame) {
        if let Some(hid) = frame.u64("hid") {
            self.note(Note::Ack(hid));
            return;
        }
        if frame.str("push") == Some("inval") {
            let paths: Vec<String> = frame
                .head
                .get("paths")
                .and_then(Value::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(|p| p.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            for path in paths {
                self.forget(&path);
            }
        }
    }

    /// Forget everything a change at `changed` reaches, in the client and
    /// in the kernel: the path, what is under it, and its folder's listing.
    /// A change at or above the root reaches everything.
    pub fn forget(&self, changed: &str) {
        let everything = reaches(changed, &self.root);
        let mut notes = Vec::new();
        {
            let mut st = locked(&self.state);
            let hit = |p: &str| everything || reaches(changed, p);
            st.known.retain(|p, _| !hit(p));
            st.listings.retain(|p, _| !hit(p));
            st.fetched.retain(|p| !hit(p));
            let gone: Vec<String> = st.content.keys().filter(|p| hit(p)).cloned().collect();
            for p in gone {
                if let Some(c) = st.content.remove(&p) {
                    st.bytes -= c.data.len();
                }
            }
            st.order.retain(|p| !hit(p));
            if let Some((dir, _)) = split(changed) {
                st.listings.remove(&dir);
                st.fetched.remove(&dir);
                if let Some(&ino) = st.inodes.get(&dir) {
                    notes.push(Note::Inode(ino));
                }
            }
            for (path, &ino) in st.inodes.iter() {
                if !hit(path) {
                    continue;
                }
                if let Some((dir, name)) = split(path)
                    && let Some(&parent) = st.inodes.get(&dir)
                {
                    notes.push(Note::Entry(parent, name));
                }
                notes.push(Note::Inode(ino));
            }
            if !everything
                && !st.inodes.contains_key(changed)
                && let Some((dir, name)) = split(changed)
                && let Some(&parent) = st.inodes.get(&dir)
            {
                notes.push(Note::Entry(parent, name));
            }
        }
        for note in notes {
            self.note(note);
        }
    }
}

impl MirageFs {
    pub fn new(link: Arc<Link>, shared: Arc<Shared>) -> MirageFs {
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        MirageFs {
            link,
            shared,
            uid,
            gid,
        }
    }

    fn st(&self) -> MutexGuard<'_, State> {
        locked(&self.shared.state)
    }

    fn path(&self, ino: INodeNo) -> Option<String> {
        self.st().paths.get(&ino.0).cloned()
    }

    fn ino(&self, path: &str) -> u64 {
        let mut st = self.st();
        if let Some(&ino) = st.inodes.get(path) {
            return ino;
        }
        let ino = st.next_ino;
        st.next_ino += 1;
        st.paths.insert(ino, path.to_string());
        st.inodes.insert(path.to_string(), ino);
        ino
    }

    fn attr(&self, ino: u64, a: &Attrs) -> FileAttr {
        let kind = match a.mode & libc::S_IFMT {
            libc::S_IFDIR => FileType::Directory,
            libc::S_IFLNK => FileType::Symlink,
            libc::S_IFIFO => FileType::NamedPipe,
            libc::S_IFSOCK => FileType::Socket,
            libc::S_IFCHR => FileType::CharDevice,
            libc::S_IFBLK => FileType::BlockDevice,
            _ => FileType::RegularFile,
        };
        FileAttr {
            ino: INodeNo(ino),
            size: a.size,
            blocks: a.size.div_ceil(512),
            atime: time(a.atime),
            mtime: time(a.mtime),
            ctime: time(a.ctime),
            crtime: time(a.mtime),
            kind,
            perm: (a.mode & 0o7777) as u16,
            nlink: a.nlink,
            uid: self.uid,
            gid: self.gid,
            rdev: a.rdev,
            blksize: 4096,
            flags: 0,
        }
    }

    fn call(&self, op: &str, args: Value, body: &[u8]) -> Result<Frame, Errno> {
        self.link.call(op, args, body).map_err(failed)
    }

    fn keep(&self, path: &str, attrs: &Attrs) {
        self.st().known.insert(
            path.to_string(),
            Known {
                attrs: attrs.clone(),
                at: Instant::now(),
            },
        );
    }

    /// Drop what the client holds of `path` and its folder's listing after
    /// a change of its own, which the kernel already knows of.
    fn changed(&self, path: &str) {
        let mut st = self.st();
        st.known.remove(path);
        if let Some(c) = st.content.remove(path) {
            st.bytes -= c.data.len();
        }
        if let Some((dir, _)) = split(path) {
            st.listings.remove(&dir);
            st.fetched.remove(&dir);
            st.known.remove(&dir);
        }
    }

    fn reply_attrs(&self, frame: &Frame) -> Option<Attrs> {
        let kept = frame
            .head
            .get("k")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Attrs::parse(frame.head.get("a")?, kept)
    }

    /// `path`'s attributes, from what the client keeps or the host.
    fn stat(&self, path: &str) -> Result<Attrs, Errno> {
        {
            let st = self.st();
            if let Some(known) = st.known.get(path).filter(|k| k.fresh()) {
                return Ok(known.attrs.clone());
            }
        }
        let frame = self.call("getattr", json!({ "path": path }), &[])?;
        let attrs = self.reply_attrs(&frame).ok_or(Errno::EIO)?;
        self.keep(path, &attrs);
        Ok(attrs)
    }

    /// `dir`'s entries with their attributes, from a kept listing or the host.
    /// The first listing of a folder asks for its tree: a kept mount answers
    /// the folders under it too, so a walk costs a few round trips, not one
    /// per folder. A folder a tree answer covered is listed alone after.
    fn list(&self, dir: &str) -> Result<Vec<(String, Attrs)>, Errno> {
        let deep = {
            let st = self.st();
            if let Some(listing) = st.listings.get(dir).filter(|l| l.fresh()) {
                return Ok(listing.rows.clone());
            }
            !st.covered.contains(dir)
        };
        let frame = self.call("list", json!({ "path": dir, "deep": deep }), &[])?;
        let kept = frame
            .head
            .get("k")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let rows = entries(frame.head.get("e"), kept);
        let mut st = self.st();
        let now = Instant::now();
        st.listed(dir, &rows, kept, now);
        for folder in frame
            .head
            .get("d")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(path) = folder.get(0).and_then(Value::as_str) {
                let below = entries(folder.get(1), kept);
                st.listed(path, &below, kept, now);
            }
        }
        if deep {
            st.covered.insert(dir.to_string());
        }
        Ok(rows)
    }

    /// Whether `dir`'s fresh listing holds `name`, and whether it is kept;
    /// None when no fresh listing is held.
    fn listed(&self, dir: &str, name: &str) -> Option<(bool, bool)> {
        let st = self.st();
        st.listings
            .get(dir)
            .filter(|l| l.fresh())
            .map(|l| (l.names.contains(name), l.kept))
    }

    fn cached(&self, path: &str, attrs: &Attrs) -> Option<Arc<Vec<u8>>> {
        let st = self.st();
        let content = st.content.get(path)?;
        (content.version == attrs.version()).then(|| content.data.clone())
    }

    fn store(&self, path: &str, attrs: &Attrs, data: Vec<u8>) -> Arc<Vec<u8>> {
        let data = Arc::new(data);
        let mut st = self.st();
        if let Some(old) = st.content.remove(path) {
            st.bytes -= old.data.len();
        }
        st.order.retain(|p| p != path);
        st.bytes += data.len();
        st.content.insert(
            path.to_string(),
            Content {
                version: attrs.version(),
                data: data.clone(),
            },
        );
        st.order.push_back(path.to_string());
        while st.bytes > CACHE_BYTES {
            let Some(oldest) = st.order.pop_front() else {
                break;
            };
            if let Some(c) = st.content.remove(&oldest) {
                st.bytes -= c.data.len();
            }
        }
        data
    }

    /// Bring the small files of `dir` into the cache in one request, once
    /// until a change reaches the folder.
    fn prefetch(&self, dir: &str) {
        if !self.st().fetched.insert(dir.to_string()) {
            return;
        }
        let Ok(frame) = self.call("fetchdir", json!({ "path": dir }), &[]) else {
            return;
        };
        let kept = frame
            .head
            .get("k")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !kept {
            return;
        }
        let mut at = 0usize;
        for row in frame
            .head
            .get("f")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(name), Some(attrs)) = (
                row.get(0).and_then(Value::as_str),
                row.get(1).and_then(|a| Attrs::parse(a, true)),
            ) else {
                return;
            };
            let end = at + attrs.size as usize;
            let Some(bytes) = frame.body.get(at..end) else {
                return;
            };
            let path = child(dir, name);
            self.keep(&path, &attrs);
            self.store(&path, &attrs, bytes.to_vec());
            at = end;
        }
    }

    fn opened(
        &self,
        path: &str,
        host: Option<u64>,
        data: Option<Arc<Vec<u8>>>,
        writes: bool,
    ) -> u64 {
        let mut st = self.st();
        let fh = st.next_fh;
        st.next_fh += 1;
        st.opens.insert(
            fh,
            Open {
                path: path.to_string(),
                host,
                data,
                writes,
            },
        );
        fh
    }

    fn entry(&self, path: &str, attrs: &Attrs, reply: ReplyEntry) {
        let ino = self.ino(path);
        reply.entry(&ttl(attrs), &self.attr(ino, attrs), Generation(0));
    }

    fn name<'a>(&self, name: &'a OsStr) -> Result<&'a str, Errno> {
        name.to_str().ok_or(Errno::EINVAL)
    }

    fn rows(&self, ino: INodeNo, fh: FileHandle) -> Vec<(String, u64, Attrs)> {
        let Some(dir) = self.path(ino) else {
            return Vec::new();
        };
        let here = self.stat(&dir).ok();
        let up = split(&dir).map(|(p, _)| p).unwrap_or_else(|| dir.clone());
        let parent = if dir == self.shared.root {
            ino.0
        } else {
            self.ino(&up)
        };
        let dot = here.clone().unwrap_or(Attrs {
            mode: libc::S_IFDIR | 0o755,
            size: 0,
            atime: 0.0,
            mtime: 0.0,
            ctime: 0.0,
            nlink: 2,
            rdev: 0,
            kept: false,
        });
        let mut out = vec![(".".into(), ino.0, dot.clone()), ("..".into(), parent, dot)];
        let rows = self.st().dirs.get(&fh.0).cloned().unwrap_or_default();
        for (name, attrs) in rows {
            let ino = self.ino(&child(&dir, &name));
            out.push((name, ino, attrs));
        }
        out
    }
}

impl Filesystem for MirageFs {
    fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
        let _ = config.add_capabilities(InitFlags::FUSE_DO_READDIRPLUS);
        Ok(())
    }

    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let (Some(dir), Ok(name)) = (self.path(parent), self.name(name)) else {
            return reply.error(Errno::ENOENT);
        };
        let path = child(&dir, name);
        let mut listed = self.listed(&dir, name);
        let kept = || self.st().known.get(&dir).is_some_and(|k| k.attrs.kept);
        if listed.is_none() && kept() && self.list(&dir).is_ok() {
            listed = self.listed(&dir, name);
        }
        if let Some((false, kept)) = listed {
            if kept {
                let gone = Attrs {
                    mode: 0,
                    size: 0,
                    atime: 0.0,
                    mtime: 0.0,
                    ctime: 0.0,
                    nlink: 0,
                    rdev: 0,
                    kept: true,
                };
                return reply.entry(&LONG, &self.attr(0, &gone), Generation(0));
            }
            return reply.error(Errno::ENOENT);
        }
        match self.stat(&path) {
            Ok(attrs) => self.entry(&path, &attrs, reply),
            Err(err) => reply.error(err),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let Some(path) = self.path(ino) else {
            return reply.error(Errno::ENOENT);
        };
        match self.stat(&path) {
            Ok(attrs) => reply.attr(&ttl(&attrs), &self.attr(ino.0, &attrs)),
            Err(err) => reply.error(err),
        }
    }

    fn setattr(
        &self,
        _req: &Request,
        ino: INodeNo,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<fuser::BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let Some(path) = self.path(ino) else {
            return reply.error(Errno::ENOENT);
        };
        let mut args = Map::new();
        args.insert("path".into(), path.clone().into());
        if let Some(mode) = mode {
            args.insert("mode".into(), (mode & 0o7777).into());
        }
        if let Some(uid) = uid {
            args.insert("uid".into(), uid.into());
        }
        if let Some(gid) = gid {
            args.insert("gid".into(), gid.into());
        }
        if let Some(size) = size {
            args.insert("size".into(), size.into());
        }
        if let Some(atime) = atime {
            args.insert("atime".into(), ms(atime));
        }
        if let Some(mtime) = mtime {
            args.insert("mtime".into(), ms(mtime));
        }
        self.changed(&path);
        match self.call("setattr", Value::Object(args), &[]) {
            Ok(frame) => match self.reply_attrs(&frame) {
                Some(attrs) => {
                    self.keep(&path, &attrs);
                    reply.attr(&ttl(&attrs), &self.attr(ino.0, &attrs))
                }
                None => reply.error(Errno::EIO),
            },
            Err(err) => reply.error(err),
        }
    }

    fn readlink(&self, _req: &Request, ino: INodeNo, reply: ReplyData) {
        let Some(path) = self.path(ino) else {
            return reply.error(Errno::ENOENT);
        };
        match self.call("readlink", json!({ "path": path }), &[]) {
            Ok(frame) => reply.data(frame.str("target").unwrap_or("").as_bytes()),
            Err(err) => reply.error(err),
        }
    }

    fn mknod(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _name: &OsStr,
        _mode: u32,
        _umask: u32,
        _rdev: u32,
        reply: ReplyEntry,
    ) {
        reply.error(Errno::EPERM);
    }

    fn mkdir(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        umask: u32,
        reply: ReplyEntry,
    ) {
        let (Some(dir), Ok(name)) = (self.path(parent), self.name(name)) else {
            return reply.error(Errno::EINVAL);
        };
        let path = child(&dir, name);
        self.changed(&path);
        match self.call(
            "mkdir",
            json!({ "path": path, "mode": mode & !umask & 0o7777 }),
            &[],
        ) {
            Ok(frame) => match self.reply_attrs(&frame) {
                Some(attrs) => {
                    self.keep(&path, &attrs);
                    self.entry(&path, &attrs, reply)
                }
                None => reply.error(Errno::EIO),
            },
            Err(err) => reply.error(err),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let (Some(dir), Ok(name)) = (self.path(parent), self.name(name)) else {
            return reply.error(Errno::ENOENT);
        };
        let path = child(&dir, name);
        self.changed(&path);
        match self.call("unlink", json!({ "path": path }), &[]) {
            Ok(_) => reply.ok(),
            Err(err) => reply.error(err),
        }
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let (Some(dir), Ok(name)) = (self.path(parent), self.name(name)) else {
            return reply.error(Errno::ENOENT);
        };
        let path = child(&dir, name);
        self.changed(&path);
        match self.call("rmdir", json!({ "path": path }), &[]) {
            Ok(_) => reply.ok(),
            Err(err) => reply.error(err),
        }
    }

    fn symlink(
        &self,
        _req: &Request,
        parent: INodeNo,
        link_name: &OsStr,
        target: &Path,
        reply: ReplyEntry,
    ) {
        let (Some(dir), Ok(name), Some(target)) =
            (self.path(parent), self.name(link_name), target.to_str())
        else {
            return reply.error(Errno::EINVAL);
        };
        let path = child(&dir, name);
        self.changed(&path);
        match self.call("symlink", json!({ "path": path, "target": target }), &[]) {
            Ok(frame) => match self.reply_attrs(&frame) {
                Some(attrs) => {
                    self.keep(&path, &attrs);
                    self.entry(&path, &attrs, reply)
                }
                None => reply.error(Errno::EIO),
            },
            Err(err) => reply.error(err),
        }
    }

    fn rename(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        if flags.contains(RenameFlags::RENAME_EXCHANGE) {
            return reply.error(Errno::EINVAL);
        }
        let (Some(dir), Some(newdir), Ok(name), Ok(newname)) = (
            self.path(parent),
            self.path(newparent),
            self.name(name),
            self.name(newname),
        ) else {
            return reply.error(Errno::ENOENT);
        };
        let (from, to) = (child(&dir, name), child(&newdir, newname));
        let noreplace = flags.contains(RenameFlags::RENAME_NOREPLACE);
        match self.call(
            "rename",
            json!({ "from": from, "to": to, "noreplace": noreplace }),
            &[],
        ) {
            Ok(_) => {
                self.shared.forget(&from);
                self.shared.forget(&to);
                let mut st = self.st();
                let moved: Vec<(String, u64)> = st
                    .inodes
                    .iter()
                    .filter(|(p, _)| reaches(&from, p))
                    .map(|(p, &i)| (p.clone(), i))
                    .collect();
                for (old, ino) in moved {
                    let new = format!("{to}{}", &old[from.len()..]);
                    st.inodes.remove(&old);
                    if let Some(stale) = st.inodes.insert(new.clone(), ino) {
                        st.paths.remove(&stale);
                    }
                    st.paths.insert(ino, new);
                }
                drop(st);
                reply.ok()
            }
            Err(err) => reply.error(err),
        }
    }

    fn link(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _newparent: INodeNo,
        _newname: &OsStr,
        reply: ReplyEntry,
    ) {
        reply.error(Errno::EPERM);
    }

    fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let Some(path) = self.path(ino) else {
            return reply.error(Errno::ENOENT);
        };
        let writes = flags.0 & libc::O_ACCMODE != libc::O_RDONLY || flags.0 & libc::O_TRUNC != 0;
        if !writes
            && let Ok(attrs) = self.stat(&path)
            && attrs.kept
            && attrs.is(libc::S_IFREG)
            && attrs.size <= WHOLE_FILE
        {
            if let Some(data) = self.cached(&path, &attrs) {
                let fh = self.opened(&path, None, Some(data), false);
                return reply.opened(FileHandle(fh), FopenFlags::FOPEN_KEEP_CACHE);
            }
            if let Some((dir, _)) = split(&path) {
                self.prefetch(&dir);
            }
            let data = match self.cached(&path, &attrs) {
                Some(data) => data,
                None => match self.call("readall", json!({ "path": path }), &[]) {
                    Ok(frame) => {
                        let now = self.reply_attrs(&frame).unwrap_or(attrs);
                        self.keep(&path, &now);
                        self.store(&path, &now, frame.body)
                    }
                    Err(err) => return reply.error(err),
                },
            };
            let fh = self.opened(&path, None, Some(data), false);
            return reply.opened(FileHandle(fh), FopenFlags::empty());
        }
        let args = json!({
            "path": path,
            "read": flags.0 & libc::O_ACCMODE != libc::O_WRONLY,
            "write": flags.0 & libc::O_ACCMODE != libc::O_RDONLY,
            "truncate": flags.0 & libc::O_TRUNC != 0,
            "append": flags.0 & libc::O_APPEND != 0,
        });
        if writes {
            self.changed(&path);
        }
        match self.call("open", args, &[]) {
            Ok(frame) => {
                let Some(host) = frame.u64("fh") else {
                    return reply.error(Errno::EIO);
                };
                let kept = frame
                    .head
                    .get("k")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let fh = self.opened(&path, Some(host), None, writes);
                let mode = if kept && !writes {
                    FopenFlags::empty()
                } else {
                    FopenFlags::FOPEN_DIRECT_IO
                };
                reply.opened(FileHandle(fh), mode)
            }
            Err(err) => reply.error(err),
        }
    }

    fn read(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let Some(open) = self.st().opens.get(&fh.0).cloned() else {
            return reply.error(Errno::EBADF);
        };
        if let Some(data) = open.data {
            let start = (offset as usize).min(data.len());
            let end = start.saturating_add(size as usize).min(data.len());
            return reply.data(&data[start..end]);
        }
        let Some(host) = open.host else {
            return reply.error(Errno::EBADF);
        };
        match self.call(
            "read",
            json!({ "fh": host, "offset": offset, "size": size }),
            &[],
        ) {
            Ok(frame) => reply.data(&frame.body),
            Err(err) => reply.error(err),
        }
    }

    fn write(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let Some(open) = self.st().opens.get(&fh.0).cloned() else {
            return reply.error(Errno::EBADF);
        };
        let Some(host) = open.host else {
            return reply.error(Errno::EBADF);
        };
        self.changed(&open.path);
        match self.call("write", json!({ "fh": host, "offset": offset }), data) {
            Ok(_) => reply.written(data.len() as u32),
            Err(err) => reply.error(err),
        }
    }

    fn flush(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn release(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let open = self.st().opens.remove(&fh.0);
        if let Some(Open {
            host: Some(host),
            path,
            writes,
            ..
        }) = open
        {
            self.link.post("release", json!({ "fh": host }));
            if writes {
                self.changed(&path);
            }
        }
        reply.ok();
    }

    fn fsync(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _d: bool, reply: ReplyEmpty) {
        reply.ok();
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let Some(dir) = self.path(ino) else {
            return reply.error(Errno::ENOENT);
        };
        match self.list(&dir) {
            Ok(rows) => {
                let mut st = self.st();
                let fh = st.next_fh;
                st.next_fh += 1;
                st.dirs.insert(fh, rows);
                reply.opened(FileHandle(fh), FopenFlags::empty())
            }
            Err(err) => reply.error(err),
        }
    }

    fn readdir(
        &self,
        _req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        for (i, (name, ino, attrs)) in self
            .rows(ino, fh)
            .into_iter()
            .enumerate()
            .skip(offset as usize)
        {
            let kind = self.attr(ino, &attrs).kind;
            if reply.add(INodeNo(ino), (i + 1) as u64, kind, &name) {
                break;
            }
        }
        reply.ok();
    }

    fn readdirplus(
        &self,
        _req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectoryPlus,
    ) {
        for (i, (name, ino, attrs)) in self
            .rows(ino, fh)
            .into_iter()
            .enumerate()
            .skip(offset as usize)
        {
            let attr = self.attr(ino, &attrs);
            if reply.add(
                INodeNo(ino),
                (i + 1) as u64,
                &name,
                &ttl(&attrs),
                &attr,
                Generation(0),
            ) {
                break;
            }
        }
        reply.ok();
    }

    fn releasedir(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        reply: ReplyEmpty,
    ) {
        self.st().dirs.remove(&fh.0);
        reply.ok();
    }

    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        match self.call("statfs", json!({}), &[]) {
            Ok(frame) => {
                let n = |key: &str| frame.u64(key).unwrap_or(0);
                reply.statfs(
                    n("blocks"),
                    n("bfree"),
                    n("bavail"),
                    n("files"),
                    n("ffree"),
                    n("bsize").max(1) as u32,
                    n("namelen").max(1) as u32,
                    n("frsize").max(1) as u32,
                )
            }
            Err(err) => reply.error(err),
        }
    }

    fn setxattr(
        &self,
        _req: &Request,
        ino: INodeNo,
        name: &OsStr,
        value: &[u8],
        flags: i32,
        _position: u32,
        reply: ReplyEmpty,
    ) {
        let (Some(path), Ok(name)) = (self.path(ino), self.name(name)) else {
            return reply.error(Errno::EINVAL);
        };
        match self.call(
            "setxattr",
            json!({ "path": path, "name": name, "flags": flags }),
            value,
        ) {
            Ok(_) => reply.ok(),
            Err(err) => reply.error(err),
        }
    }

    fn getxattr(&self, _req: &Request, ino: INodeNo, name: &OsStr, size: u32, reply: ReplyXattr) {
        let (Some(path), Ok(name)) = (self.path(ino), self.name(name)) else {
            return reply.error(Errno::EINVAL);
        };
        // The kernel asks before a write whether the file carries
        // capabilities to drop; on a nosuid mount none apply, so the answer
        // needs no round trip.
        if name == "security.capability" {
            return reply.error(Errno::ENODATA);
        }
        match self.call("getxattr", json!({ "path": path, "name": name }), &[]) {
            Ok(frame) if size == 0 => reply.size(frame.body.len() as u32),
            Ok(frame) if frame.body.len() > size as usize => reply.error(Errno::ERANGE),
            Ok(frame) => reply.data(&frame.body),
            Err(err) => reply.error(err),
        }
    }

    fn listxattr(&self, _req: &Request, ino: INodeNo, size: u32, reply: ReplyXattr) {
        let Some(path) = self.path(ino) else {
            return reply.error(Errno::ENOENT);
        };
        match self.call("listxattr", json!({ "path": path }), &[]) {
            Ok(frame) => {
                let mut out = Vec::new();
                for name in frame
                    .head
                    .get("names")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(name) = name.as_str() {
                        out.extend_from_slice(name.as_bytes());
                        out.push(0);
                    }
                }
                if size == 0 {
                    reply.size(out.len() as u32)
                } else if out.len() > size as usize {
                    reply.error(Errno::ERANGE)
                } else {
                    reply.data(&out)
                }
            }
            Err(err) => reply.error(err),
        }
    }

    fn removexattr(&self, _req: &Request, ino: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let (Some(path), Ok(name)) = (self.path(ino), self.name(name)) else {
            return reply.error(Errno::EINVAL);
        };
        match self.call("removexattr", json!({ "path": path, "name": name }), &[]) {
            Ok(_) => reply.ok(),
            Err(err) => reply.error(err),
        }
    }

    fn access(&self, _req: &Request, _ino: INodeNo, _mask: AccessFlags, reply: ReplyEmpty) {
        reply.ok();
    }

    fn create(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        umask: u32,
        flags: i32,
        reply: ReplyCreate,
    ) {
        let (Some(dir), Ok(name)) = (self.path(parent), self.name(name)) else {
            return reply.error(Errno::EINVAL);
        };
        let path = child(&dir, name);
        self.changed(&path);
        let args = json!({
            "path": path,
            "mode": mode & !umask & 0o7777,
            "exclusive": flags & libc::O_EXCL != 0,
        });
        match self.call("create", args, &[]) {
            Ok(frame) => {
                let (Some(host), Some(attrs)) = (frame.u64("fh"), self.reply_attrs(&frame)) else {
                    return reply.error(Errno::EIO);
                };
                let ino = self.ino(&path);
                let fh = self.opened(&path, Some(host), None, true);
                reply.created(
                    &ttl(&attrs),
                    &self.attr(ino, &attrs),
                    Generation(0),
                    FileHandle(fh),
                    FopenFlags::FOPEN_DIRECT_IO,
                )
            }
            Err(err) => reply.error(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn attrs(kept: bool) -> Attrs {
        Attrs::parse(&json!({"m": 0o100644, "s": 3, "t": 1000.0}), kept).unwrap()
    }

    #[test]
    fn a_path_splits_into_its_folder_and_name() {
        assert_eq!(split("/w/a"), Some(("/w".into(), "a".into())));
        assert_eq!(split("/a"), Some(("/".into(), "a".into())));
        assert_eq!(split("/"), None);
        assert_eq!(child("/", "a"), "/a");
        assert_eq!(child("/w", "a"), "/w/a");
    }

    #[test]
    fn a_change_reaches_itself_and_what_is_under_it() {
        assert!(reaches("/w/a", "/w/a"));
        assert!(reaches("/w/a", "/w/a/b"));
        assert!(!reaches("/w/a", "/w/ab"));
        assert!(reaches("/", "/w/a"));
    }

    #[test]
    fn a_change_forgets_the_path_its_folder_listing_and_its_content() {
        let (tx, rx) = channel();
        let shared = Shared::new("/w".into(), tx);
        {
            let mut st = locked(&shared.state);
            for p in ["/w/a", "/w/b"] {
                st.known.insert(
                    p.into(),
                    Known {
                        attrs: attrs(true),
                        at: Instant::now(),
                    },
                );
                st.inodes.insert(p.into(), if p == "/w/a" { 2 } else { 3 });
            }
            st.listings.insert(
                "/w".into(),
                Listing {
                    rows: vec![],
                    names: HashSet::new(),
                    kept: true,
                    at: Instant::now(),
                },
            );
            st.content.insert(
                "/w/a".into(),
                Content {
                    version: (3, 0),
                    data: Arc::new(vec![1, 2, 3]),
                },
            );
            st.bytes = 3;
        }
        shared.forget("/w/a");
        let st = locked(&shared.state);
        assert!(!st.known.contains_key("/w/a"));
        assert!(st.known.contains_key("/w/b"));
        assert!(!st.listings.contains_key("/w"));
        assert_eq!(st.bytes, 0);
        drop(st);
        let notes: Vec<Note> = rx.try_iter().collect();
        assert!(
            notes
                .iter()
                .any(|n| matches!(n, Note::Entry(1, name) if name == "a"))
        );
        assert!(notes.iter().any(|n| matches!(n, Note::Inode(2))));
    }

    #[test]
    fn a_barrier_is_answered_after_the_forgets_before_it() {
        let (tx, rx) = channel();
        let shared = Shared::new("/w".into(), tx);
        locked(&shared.state).inodes.insert("/w/a".into(), 2);
        shared.push(Frame::new(
            json!({"push": "inval", "paths": ["/w/a"]}),
            vec![],
        ));
        shared.push(Frame::new(json!({"hid": 5, "op": "begin"}), vec![]));
        let notes: Vec<Note> = rx.try_iter().collect();
        assert!(matches!(notes.last(), Some(Note::Ack(5))));
        assert!(notes.len() > 1);
    }

    #[test]
    fn a_tree_answer_keeps_each_folder_listed_and_covered() {
        let rows = entries(
            Some(&json!([["a.txt", {"m": 0o100644, "s": 1}], ["sub", {"m": 0o040755}], ["bad"]])),
            true,
        );
        assert_eq!(
            rows.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            ["a.txt", "sub"]
        );
        let mut st = State::default();
        st.listed("/w/sub", &rows, true, Instant::now());
        assert!(st.covered.contains("/w/sub"));
        assert!(st.listings["/w/sub"].names.contains("a.txt"));
        assert_eq!(st.known["/w/sub/a.txt"].attrs.size, 1);
    }

    #[test]
    fn content_is_cached_by_size_and_mtime() {
        let kept = attrs(true);
        let mut later = kept.clone();
        later.mtime = 2000.0;
        assert_ne!(kept.version(), later.version());
    }
}

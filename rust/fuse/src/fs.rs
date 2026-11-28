use crate::link::{Failure, Link, REPLY_WAIT, Sent};
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
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A mode's file-type bits as fsproto carries them: POSIX's, on every
/// platform, though macOS's `mode_t` is 16 bits and Linux's 32.
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;
const S_IFIFO: u32 = 0o010000;
const S_IFSOCK: u32 = 0o140000;
const S_IFCHR: u32 = 0o020000;
const S_IFBLK: u32 = 0o060000;
/// How long the kernel and the client keep an answer the host gave no
/// directive to keep: `KERNEL_CACHE_SECONDS`, as sshfs keeps one.
const SHORT: Duration = Duration::from_secs(1);
/// How long they keep one the host said to keep: until it says otherwise.
const LONG: Duration = Duration::from_secs(86_400);
/// The bytes of content the client keeps in memory.
const CACHE_BYTES: usize = 256 << 20;
/// The largest file read whole into the cache; a larger one reads by range.
const WHOLE_FILE: u64 = 8 << 20;
/// How far past its reads a file read in order keeps asked for, unless the
/// host's `hello` says otherwise (a machine's `read_ahead`), in
/// READ_REQUESTS requests of no more than READ_WINDOW each: enough on
/// their way at once that each reply's delay on the pipe overlaps the
/// others'.
const READ_AHEAD: u64 = 2 << 20;
const READ_REQUESTS: u64 = 4;
const READ_WINDOW: u64 = 1 << 20;
/// How far behind a reader's next bytes the kernel may still ask, so the
/// stretches a reader holds that close before it are kept.
const READ_BEHIND: u64 = 256 << 10;
/// The most bytes every file read in order keeps asked for together, unless
/// `hello` says otherwise (`read_ahead_total`). On a mount that keeps an
/// answer for SHORT, a stretch read more than SHORT after it was asked is
/// asked again, so a link that moves less than this in SHORT reads files
/// in parallel faster with less.
const READ_AHEAD_TOTAL: usize = 16 << 20;
/// The most bytes a read-only open through a host handle asks to read with
/// it, no more than the read-ahead.
const READ_FIRST: u64 = 128 << 10;
/// The most readers the opens of one file on a kept mount share, one where
/// each of its programs reads in order.
const READ_STREAMS: usize = 4;
/// How many times an answer a forget crossed is asked for before it is
/// used once, unkept.
const FILLS: u32 = 3;
const ROOT: u64 = 1;

/// What the host's `hello` said: how far files are read ahead, and whether
/// attributes mark an entry that carries extended attributes (`x`), so an
/// entry kept without the mark carries none.
#[derive(Clone, Copy)]
pub struct Served {
    ahead: u64,
    total: usize,
    xattrs: bool,
}

impl Served {
    /// From the reply to `hello`; what it leaves out takes the client's own.
    pub fn of(frame: &Frame) -> Served {
        Served {
            ahead: frame.u64("read_ahead").unwrap_or(READ_AHEAD),
            total: frame
                .u64("read_ahead_total")
                .map_or(READ_AHEAD_TOTAL, |total| total as usize),
            xattrs: frame.head.get("xattrs").and_then(Value::as_bool) == Some(true),
        }
    }

    /// The most one request ahead asks for: a READ_REQUESTS share of the
    /// read-ahead, no more than READ_WINDOW.
    fn window(&self) -> u64 {
        (self.ahead / READ_REQUESTS).min(READ_WINDOW)
    }

    /// The bytes a read-only open asks to read with it.
    fn first(&self) -> u64 {
        READ_FIRST.min(self.ahead)
    }
}

impl Default for Served {
    fn default() -> Served {
        Served {
            ahead: READ_AHEAD,
            total: READ_AHEAD_TOTAL,
            xattrs: false,
        }
    }
}

/// One answer about a path: its attributes, whether the host said to
/// keep them, which it says only of a backend nothing but the workspace
/// changes, and whether a policy judges every call the session makes, so
/// neither the client nor the kernel keeps the answer at all. `xattrs`
/// when the host marked it as carrying extended attributes.
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
    pub watched: bool,
    pub xattrs: bool,
}

impl Attrs {
    /// The attributes in a reply's `a` (or a listing row), kept when the
    /// reply's `k` says so and the row's own `k`, which a folder another
    /// mount serves carries, does not say otherwise; watched when the
    /// reply's `w` says a policy judges every call.
    pub fn parse(value: &Value, kept: bool, watched: bool) -> Option<Attrs> {
        let f = |key: &str| value.get(key).and_then(Value::as_f64);
        let kept = !watched && kept && value.get("k").and_then(Value::as_bool) != Some(false);
        Some(Attrs {
            mode: f("m")? as u32,
            size: f("s").unwrap_or(0.0) as u64,
            atime: f("a").unwrap_or(0.0),
            mtime: f("t").unwrap_or(0.0),
            ctime: f("c").unwrap_or(0.0),
            nlink: f("n").unwrap_or(1.0) as u32,
            rdev: f("r").unwrap_or(0.0) as u32,
            kept,
            watched,
            xattrs: value.get("x").and_then(Value::as_bool) == Some(true),
        })
    }

    fn is(&self, kind: u32) -> bool {
        self.mode & S_IFMT == kind
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

/// One entry of a folder stream: the offset after it, its name, inode
/// and attributes.
type Row = (u64, String, u64, Attrs);

/// An open folder stream: the folder, the epoch it was listed at (never
/// current again once a change of this machine's reached it), its rows.
type Stream = (String, u64, Vec<(String, Attrs)>);

impl Known {
    fn fresh(&self) -> bool {
        self.attrs.kept || (!self.attrs.watched && self.at.elapsed() < SHORT)
    }
}

struct Listing {
    rows: Vec<(String, Attrs)>,
    names: HashSet<String>,
    kept: bool,
    watched: bool,
    at: Instant,
}

impl Listing {
    fn fresh(&self) -> bool {
        self.kept || (!self.watched && self.at.elapsed() < SHORT)
    }
}

struct Content {
    version: (u64, u64),
    data: Arc<Vec<u8>>,
}

/// A file open on this machine: through a host handle, or on bytes the
/// client holds. `cached` when the kernel may keep its pages, so a read
/// may never reach the client; `revoked` once a policy came to judge every
/// call, which such an open can no longer let it; `watched` while a policy
/// judges every call, so each write waits for its answer; `apart` once a
/// change the host pushed named its path, which may now name another
/// file, so it reads apart from the opens after it.
#[derive(Clone)]
struct Open {
    path: String,
    host: Option<u64>,
    data: Option<Arc<Vec<u8>>>,
    attrs: Option<Attrs>,
    writes: bool,
    detached: bool,
    apart: bool,
    cached: bool,
    revoked: bool,
    watched: bool,
}

/// Where one stretch a reader asked for stands: about to be asked, on its
/// way (taken while one read waits for its reply), come, or refused. On
/// its way and come carry when it was asked for, before the host read its
/// bytes, as a reply can wait unread for as long as the program pauses.
enum Part {
    Unsent,
    Sent(Option<Sent>, Instant),
    Held(Arc<Vec<u8>>, Instant),
    Failed,
}

/// One stretch of a file a reader asked for: `size` bytes at `offset`.
struct Window {
    offset: u64,
    size: u64,
    part: Part,
}

impl Window {
    fn end(&self) -> u64 {
        self.offset + self.size
    }
}

/// A reading in order of the file at `path` through host handles: the
/// stretches it asked for, end to end from `start` to `next`, which every
/// read inside them takes its bytes from, whichever thread the kernel sends
/// it on. `ahead` is how far past a read it asks, doubling with each read
/// up to the read-ahead; `end` is the end of the file once a reply came
/// short, past which it asks for nothing, and when that reply came. On a
/// mount that is not `kept`, a stretch serves for SHORT after it came, as
/// the machine keeps any other answer there, and the reader is one open's
/// (`owner`). On a kept mount, where the kernel's pages of a file are
/// shared by its opens and so are their reads, the reader is the file's,
/// any of its opens reading through it (`owner` None). Readers are kept by
/// an id never used twice, so a read that waited finds whether the reader
/// it waited on is still there.
struct Reader {
    path: String,
    owner: Option<u64>,
    kept: bool,
    windows: VecDeque<Window>,
    start: u64,
    next: u64,
    ahead: u64,
    end: Option<(u64, Instant)>,
}

impl Reader {
    /// Whether a read at `offset` takes its bytes from this reader: one at
    /// or past the end of the file asks the host, which sees a file that
    /// grew since.
    fn serves(&self, offset: u64) -> bool {
        self.start <= offset && offset <= self.next && self.end.is_none_or(|(end, _)| offset < end)
    }

    /// Whether a read at `offset` meets the end of the file a reply showed
    /// less than SHORT ago: it reads nothing without asking, as the kernel
    /// keeps the file's size that long.
    fn ended(&self, offset: u64) -> bool {
        self.end
            .is_some_and(|(end, when)| end == offset && when.elapsed() < SHORT)
    }

    /// Whether a stretch a read from `offset` to `stop` needs was asked for
    /// longer ago than an answer on its mount is kept, come or not.
    fn stale(&self, offset: u64, stop: u64) -> bool {
        !self.kept
            && self.windows.iter().any(|w| {
                w.end() > offset
                    && w.offset < stop
                    && matches!(w.part, Part::Held(_, asked) | Part::Sent(_, asked) if asked.elapsed() >= SHORT)
            })
    }

    /// The bytes its stretches hold or ask for.
    fn charge(&self) -> usize {
        self.windows.iter().map(|w| w.size as usize).sum()
    }
}

/// When an open was asked of the host: whether its reply said a policy
/// judges every call, and how many `watch` pushes had come before it, so
/// one that came meanwhile marks the open watched too.
#[derive(Clone, Copy)]
struct Asked {
    watched: bool,
    watches: u64,
}

/// Whose readers a read through open `fh` takes its bytes from: None for
/// one that shares its file's, a read-only open through a host handle on a
/// kept mount whose name still names its file and no change the host
/// pushed named since it opened, as the kernel shares that file's pages,
/// and so their reads, among its opens; else the open's own.
fn owner_of(fh: u64, open: &Open) -> Option<u64> {
    let shares = open.cached
        && open.host.is_some()
        && !open.writes
        && !open.watched
        && !open.detached
        && !open.apart;
    (!shares).then_some(fh)
}

/// Whether a read with `owner` through an open of `path` uses `reader`.
fn reads_for(reader: &Reader, owner: Option<u64>, path: &str) -> bool {
    match owner {
        Some(fh) => reader.owner == Some(fh),
        None => reader.owner.is_none() && reader.path == path,
    }
}

/// An open asked when `watches` pushes had come, whose reply said no
/// policy judges every call.
fn unwatched(watches: u64) -> Asked {
    Asked {
        watched: false,
        watches,
    }
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
    content: HashMap<String, Content>,
    order: VecDeque<String>,
    bytes: usize,
    opens: HashMap<u64, Open>,
    reads: HashMap<u64, Reader>,
    read_bytes: usize,
    next_reader: u64,
    read_drops: u64,
    dirs: HashMap<u64, Stream>,
    revoked_dirs: HashSet<u64>,
    next_fh: u64,
    epoch: u64,
    watches: u64,
}

/// A listing's rows from its JSON: `[[name, attrs], ...]`.
fn entries(rows: Option<&Value>, kept: bool, watched: bool) -> Vec<(String, Attrs)> {
    rows.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some((
                row.get(0)?.as_str()?.to_string(),
                Attrs::parse(row.get(1)?, kept, watched)?,
            ))
        })
        .collect()
}

impl State {
    /// Keep `dir`'s listing and each entry's attributes.
    fn listed(
        &mut self,
        dir: &str,
        rows: &[(String, Attrs)],
        kept: bool,
        watched: bool,
        at: Instant,
    ) {
        for (name, attrs) in rows {
            self.known.insert(
                child(dir, name),
                Known {
                    attrs: attrs.clone(),
                    at,
                },
            );
        }
        self.listings.insert(
            dir.to_string(),
            Listing {
                names: rows.iter().map(|(n, _)| n.clone()).collect(),
                rows: rows.to_vec(),
                kept,
                watched,
                at,
            },
        );
    }

    /// Drop the readers of the files at the paths `hit` reaches, with what
    /// they asked for: a read waiting on one reads anew. It counts in
    /// `read_drops`, so bytes an open read before it are not kept after.
    fn drop_reads(&mut self, hit: impl Fn(&str) -> bool) {
        self.read_drops += 1;
        let ids: Vec<u64> = self
            .reads
            .iter()
            .filter(|(_, r)| hit(&r.path))
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            self.forget_reader(id);
        }
    }

    /// Drop reader `id` and what it asked for.
    fn forget_reader(&mut self, id: u64) {
        if let Some(reader) = self.reads.remove(&id) {
            self.read_bytes -= reader.charge();
        }
    }

    /// The reader a read through open `fh` at `offset` takes its bytes
    /// from: the open's own, or, for an open that shares its file's, the
    /// one of them that reads in order at `offset`.
    fn reader_at(&self, fh: u64, offset: u64) -> Option<u64> {
        let open = self.opens.get(&fh)?;
        let owner = owner_of(fh, open);
        self.reads
            .iter()
            .find(|(_, r)| {
                reads_for(r, owner, &open.path)
                    && (owner.is_some() || r.serves(offset) || r.ended(offset))
            })
            .map(|(&id, _)| id)
    }

    /// Drop what open `fh` read ahead through as it closes: its own reader,
    /// or its file's once no other open shares them.
    fn forget_open(&mut self, fh: u64) {
        let Some(open) = self.opens.get(&fh) else {
            return;
        };
        let owner = owner_of(fh, open);
        let path = open.path.clone();
        let shared = owner.is_none()
            && self
                .opens
                .iter()
                .any(|(&other, o)| other != fh && owner_of(other, o).is_none() && o.path == path);
        if shared {
            return;
        }
        let ids: Vec<u64> = self
            .reads
            .iter()
            .filter(|(_, r)| reads_for(r, owner, &path))
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            self.forget_reader(id);
        }
    }

    /// Keep `data` as `path`'s content at `version`, dropping the oldest
    /// content past CACHE_BYTES.
    fn store(&mut self, path: &str, version: (u64, u64), data: Arc<Vec<u8>>) {
        if let Some(old) = self.content.remove(path) {
            self.bytes -= old.data.len();
        }
        self.order.retain(|p| p != path);
        self.bytes += data.len();
        self.content
            .insert(path.to_string(), Content { version, data });
        self.order.push_back(path.to_string());
        while self.bytes > CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(c) = self.content.remove(&oldest) {
                self.bytes -= c.data.len();
            }
        }
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
        "ENODATA" | "ENOATTR" => return Errno::NO_XATTR,
        "ERANGE" => libc::ERANGE,
        "EAGAIN" => libc::EAGAIN,
        "ENOSYS" => libc::ENOSYS,
        _ => libc::EIO,
    })
}

/// Whether a rename swaps the two names, and whether it refuses to replace
/// one: renameat2's flags on Linux, renamex_np's on macOS.
#[cfg(target_os = "linux")]
fn rename_flags(flags: RenameFlags) -> (bool, bool) {
    (
        flags.contains(RenameFlags::RENAME_EXCHANGE),
        flags.contains(RenameFlags::RENAME_NOREPLACE),
    )
}

#[cfg(target_os = "macos")]
fn rename_flags(flags: RenameFlags) -> (bool, bool) {
    (
        flags.bits() & libc::RENAME_SWAP != 0,
        flags.bits() & libc::RENAME_EXCL != 0,
    )
}

/// setxattr's flags as fsproto carries them, Linux's values (create 1,
/// replace 2), from the platform's (macOS's are 2 and 4).
fn xattr_flags(flags: i32) -> i32 {
    i32::from(flags & libc::XATTR_CREATE != 0) | i32::from(flags & libc::XATTR_REPLACE != 0) << 1
}

fn failed(failure: Failure) -> Errno {
    match failure {
        Failure::Refused(condition) => errno(&condition),
        Failure::Lost => Errno::from_i32(libc::ENOTCONN),
        Failure::Late => Errno::from_i32(libc::ETIMEDOUT),
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
    if attrs.kept {
        LONG
    } else if attrs.watched {
        Duration::ZERO
    } else {
        SHORT
    }
}

/// Whether a reply says the client may keep it (`k`), and whether a policy
/// judges every call, so nothing is kept at all (`w`).
fn keep_of(frame: &Frame) -> (bool, bool) {
    let flag = |key: &str| frame.head.get(key).and_then(Value::as_bool) == Some(true);
    (flag("k"), flag("w"))
}

/// The client's side of fsproto: a workspace prefix served by the host,
/// answered from what the host said to keep and asked of it otherwise.
pub struct MirageFs {
    link: Arc<Link>,
    shared: Arc<Shared>,
    served: Served,
    uid: u32,
    gid: u32,
}

/// The state the filesystem and the host's pushes share, and `arrived`,
/// which wakes the reads waiting on a stretch another read receives or a
/// change takes.
pub struct Shared {
    root: String,
    state: Mutex<State>,
    arrived: Condvar,
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
            arrived: Condvar::new(),
            notes: Mutex::new(notes),
        }
    }

    fn note(&self, note: Note) {
        let _ = locked(&self.notes).send(note);
    }

    /// A frame the host started: `inval` forgets what it names, `watch`
    /// forgets everything once a policy judges every call and refuses the
    /// reads of opens the kernel may cache and of folder streams listed
    /// before it, and a `begin` barrier is answered once every forget
    /// before it is done.
    pub fn push(&self, frame: Frame) {
        if let Some(hid) = frame.u64("hid") {
            self.note(Note::Ack(hid));
            return;
        }
        if frame.str("push") == Some("watch") {
            self.forget(&self.root.clone());
            let mut st = locked(&self.state);
            st.watches += 1;
            for open in st.opens.values_mut() {
                if open.cached {
                    open.revoked = true;
                }
                open.watched = true;
            }
            st.drop_reads(|_| true);
            let streams: Vec<u64> = st.dirs.keys().copied().collect();
            st.revoked_dirs.extend(streams);
            drop(st);
            self.arrived.notify_all();
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
    /// A change at or above the root reaches everything. It moves the
    /// epoch, so an answer asked for before it is not kept after it.
    pub fn forget(&self, changed: &str) {
        let everything = reaches(changed, &self.root);
        let mut notes = Vec::new();
        {
            let mut st = locked(&self.state);
            st.epoch += 1;
            let hit = |p: &str| everything || reaches(changed, p);
            st.drop_reads(hit);
            for open in st.opens.values_mut() {
                if hit(&open.path) {
                    open.apart = true;
                }
            }
            st.known.retain(|p, _| !hit(p));
            st.listings.retain(|p, _| !hit(p));
            let gone: Vec<String> = st.content.keys().filter(|p| hit(p)).cloned().collect();
            for p in gone {
                if let Some(c) = st.content.remove(&p) {
                    st.bytes -= c.data.len();
                }
            }
            st.order.retain(|p| !hit(p));
            if let Some((dir, _)) = split(changed) {
                st.listings.remove(&dir);
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
        self.arrived.notify_all();
        for note in notes {
            self.note(note);
        }
    }
}

impl MirageFs {
    pub fn new(link: Arc<Link>, shared: Arc<Shared>, served: Served) -> MirageFs {
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        MirageFs {
            link,
            shared,
            served,
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
        let kind = match a.mode & S_IFMT {
            S_IFDIR => FileType::Directory,
            S_IFLNK => FileType::Symlink,
            S_IFIFO => FileType::NamedPipe,
            S_IFSOCK => FileType::Socket,
            S_IFCHR => FileType::CharDevice,
            S_IFBLK => FileType::BlockDevice,
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

    /// Keep `attrs` for `path` unless a forget came since the epoch
    /// `asked`: Ok with them, or Err with them unkept, for the caller to
    /// ask again or answer once with the short time.
    fn keep(&self, path: &str, attrs: Attrs, asked: u64) -> Result<Attrs, Attrs> {
        let mut st = self.st();
        if st.epoch != asked {
            return Err(Attrs {
                kept: false,
                ..attrs
            });
        }
        st.known.insert(
            path.to_string(),
            Known {
                attrs: attrs.clone(),
                at: Instant::now(),
            },
        );
        Ok(attrs)
    }

    /// Drop what the client holds of `path` and its folder's listing after
    /// a change of its own, which the kernel already knows of; a stream
    /// of that folder opened before it hands the kernel no attributes.
    fn changed(&self, path: &str) {
        let mut st = self.st();
        st.drop_reads(|p| reaches(path, p));
        self.shared.arrived.notify_all();
        st.known.remove(path);
        if let Some(c) = st.content.remove(path) {
            st.bytes -= c.data.len();
        }
        if let Some((dir, _)) = split(path) {
            st.listings.remove(&dir);
            st.known.remove(&dir);
            for (folder, listed, _) in st.dirs.values_mut() {
                if *folder == dir {
                    *listed = u64::MAX;
                }
            }
        }
    }

    /// Have the cached opens of the file a write on this machine changed in
    /// place read it anew, and drop what its readers asked for: a read
    /// asked between `changed` and the write reached the host before it, so
    /// its reply holds the bytes the write replaced. `now` names the file
    /// as it is named at this point, `path` when it cannot: a rename may
    /// have moved it, and its opens with it, since the write was asked.
    fn rewritten(&self, path: &str, now: impl FnOnce(&State) -> Option<String>) {
        let mut st = self.st();
        let path = now(&st).unwrap_or_else(|| path.to_string());
        for open in st.opens.values_mut() {
            if open.path == path && open.host.is_none() && !open.detached {
                open.data = None;
            }
        }
        st.drop_reads(|p| p == path);
        drop(st);
        self.shared.arrived.notify_all();
    }

    /// Whether `path` carries no extended attribute, as the attributes the
    /// client still keeps of it say: only once the host's `hello` said they
    /// mark an entry that carries one, and never while a policy judges
    /// every call, as such attributes are never kept.
    fn bare(&self, path: &str) -> bool {
        self.served.xattrs
            && self
                .st()
                .known
                .get(path)
                .is_some_and(|k| k.fresh() && !k.attrs.xattrs)
    }

    /// Drop what the client keeps of `path`'s attributes, and its folder's
    /// listing, after an extended attribute changed on it here, set or not:
    /// they say whether it carries one. It moves the epoch, so attributes
    /// asked for before the change are not kept after it.
    fn xattrs_changed(&self, path: &str) {
        let mut st = self.st();
        st.epoch += 1;
        st.known.remove(path);
        if let Some((dir, _)) = split(path) {
            st.listings.remove(&dir);
        }
    }

    /// Tie the opens at or under `path` to the file they hold, once its
    /// name went to another file or to none: a write at the name later
    /// no longer refreshes them, and they read ahead on readers of their
    /// own, so a file the name names next never takes their bytes.
    fn detach(st: &mut State, path: &str) {
        for open in st.opens.values_mut() {
            if reaches(path, &open.path) {
                open.detached = true;
            }
        }
        st.drop_reads(|p| reaches(path, p));
    }

    /// Move the inodes, opens and readers at or under `from` to `to` once
    /// the host renamed it, tying the opens of what `to` named to the file
    /// they hold.
    fn renamed(st: &mut State, from: &str, to: &str) {
        let moved: Vec<(String, u64)> = st
            .inodes
            .iter()
            .filter(|(p, _)| reaches(from, p))
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
        MirageFs::detach(st, to);
        for open in st.opens.values_mut() {
            if reaches(from, &open.path) {
                open.path = format!("{to}{}", &open.path[from.len()..]);
            }
        }
        for reader in st.reads.values_mut() {
            if reaches(from, &reader.path) {
                reader.path = format!("{to}{}", &reader.path[from.len()..]);
            }
        }
    }

    /// Forget `path` and what is under it, mappings included, after a
    /// change whose outcome the host never answered.
    fn unknown(&self, path: &str) {
        self.shared.forget(path);
        let mut st = self.st();
        let gone: Vec<(String, u64)> = st
            .inodes
            .iter()
            .filter(|(p, _)| reaches(path, p))
            .map(|(p, &i)| (p.clone(), i))
            .collect();
        for (p, ino) in gone {
            st.inodes.remove(&p);
            st.paths.remove(&ino);
        }
    }

    fn reply_attrs(&self, frame: &Frame) -> Option<Attrs> {
        let (kept, watched) = keep_of(frame);
        Attrs::parse(frame.head.get("a")?, kept, watched)
    }

    /// `path`'s attributes, from what the client keeps or the host; an
    /// answer a forget crossed is asked for again.
    fn stat(&self, path: &str) -> Result<Attrs, Errno> {
        let mut tries = 0;
        loop {
            let asked = {
                let st = self.st();
                if let Some(known) = st.known.get(path).filter(|k| k.fresh()) {
                    return Ok(known.attrs.clone());
                }
                st.epoch
            };
            let frame = self.call("getattr", json!({ "path": path }), &[])?;
            let attrs = self.reply_attrs(&frame).ok_or(Errno::EIO)?;
            tries += 1;
            match self.keep(path, attrs, asked) {
                Ok(attrs) => return Ok(attrs),
                Err(attrs) if tries >= FILLS => return Ok(attrs),
                Err(_) => {}
            }
        }
    }

    /// The attributes of a file open on `path` whose name went: through
    /// its host handle, or those it was opened with.
    fn held(&self, path: &str) -> Option<Result<Attrs, Errno>> {
        let open = self.st().opens.values().find(|o| o.path == path).cloned()?;
        if let Some(host) = open.host {
            return Some(self.fstat(path, host));
        }
        open.attrs.map(|attrs| {
            Ok(Attrs {
                kept: false,
                ..attrs
            })
        })
    }

    /// The attributes of the file the host handle `host` is open on.
    fn fstat(&self, path: &str, host: u64) -> Result<Attrs, Errno> {
        let frame = self.call("getattr", json!({ "path": path, "fh": host }), &[])?;
        self.reply_attrs(&frame).ok_or(Errno::EIO)
    }

    /// `dir`'s entries with their attributes, from a kept listing or the
    /// host, and the epoch they hold at. Only the folder a program lists
    /// is asked for, so the host's policies see each listing a program
    /// makes and no other. An answer a forget crossed is used once and not
    /// kept.
    fn list(&self, dir: &str) -> Result<(Vec<(String, Attrs)>, u64), Errno> {
        let asked = {
            let st = self.st();
            if let Some(listing) = st.listings.get(dir).filter(|l| l.fresh()) {
                return Ok((listing.rows.clone(), st.epoch));
            }
            st.epoch
        };
        let frame = self.call("list", json!({ "path": dir }), &[])?;
        let (kept, watched) = keep_of(&frame);
        let rows = entries(frame.head.get("e"), kept, watched);
        let mut st = self.st();
        if st.epoch != asked {
            return Ok((rows, asked));
        }
        st.listed(dir, &rows, kept, watched, Instant::now());
        Ok((rows, asked))
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

    /// Whether a read-only open of a file with `attrs` reads it whole
    /// first: a kept regular file of at most WHOLE_FILE, unless the host
    /// said to read only what is asked (`read_ahead: 0`).
    fn whole_first(&self, attrs: &Attrs) -> bool {
        self.served.ahead > 0 && attrs.kept && attrs.is(S_IFREG) && attrs.size <= WHOLE_FILE
    }

    /// `path`'s whole content, and the attributes it was read at; kept
    /// unless a forget came while it was read.
    fn whole(&self, path: &str, attrs: Attrs) -> Result<(Arc<Vec<u8>>, Attrs), Errno> {
        let asked = self.st().epoch;
        let frame = self.call("readall", json!({ "path": path }), &[])?;
        let mut now = self.reply_attrs(&frame).unwrap_or(attrs);
        let data = Arc::new(frame.body);
        let mut st = self.st();
        if st.epoch != asked {
            now.kept = false;
        } else {
            st.store(path, now.version(), data.clone());
            st.known.insert(
                path.to_string(),
                Known {
                    attrs: now.clone(),
                    at: Instant::now(),
                },
            );
        }
        Ok((data, now))
    }

    fn opened(
        &self,
        path: &str,
        host: Option<u64>,
        data: Option<(Arc<Vec<u8>>, Attrs)>,
        writes: bool,
        cached: bool,
        asked: Asked,
    ) -> u64 {
        let mut st = self.st();
        let fh = st.next_fh;
        st.next_fh += 1;
        let (data, attrs) = data.unzip();
        let crossed = st.watches != asked.watches;
        st.opens.insert(
            fh,
            Open {
                path: path.to_string(),
                host,
                data,
                attrs,
                writes,
                detached: false,
                apart: false,
                cached,
                revoked: cached && crossed,
                watched: asked.watched || crossed,
            },
        );
        fh
    }

    /// Write `data` at `offset` through open `fh`: sent ahead of its
    /// reply, which the handle's close or fsync waits for, or answered
    /// first while a policy judges every call.
    fn write_at(&self, fh: u64, offset: u64, data: &[u8]) -> Result<(), Errno> {
        let Some(open) = self.st().opens.get(&fh).cloned() else {
            return Err(Errno::EBADF);
        };
        let Some(host) = open.host else {
            return Err(Errno::EBADF);
        };
        self.changed(&open.path);
        let args = json!({ "fh": host, "offset": offset });
        if open.watched {
            if let Some(refused) = self.link.refusal(host) {
                return Err(failed(refused));
            }
            self.call("write", args, data)?;
        } else {
            self.link
                .send_ahead(host, "write", args, data)
                .map_err(failed)?;
        }
        self.rewritten(&open.path, |st| st.opens.get(&fh).map(|o| o.path.clone()));
        Ok(())
    }

    /// Read `size` bytes at `offset` through open `fh` on host handle
    /// `host`. A read-only open read in order asks for what follows before
    /// the program reads it, further with each read up to the read-ahead,
    /// so those requests are on their way together, and every read inside
    /// what it asked for takes its bytes from there, on whichever thread
    /// the kernel sends it, through whichever of the file's opens on a kept
    /// mount. A write open, a policy judging every call, a read-ahead of 0,
    /// a read outside what was asked for, a change to the file meanwhile or
    /// a refused request ahead reads as asked.
    fn read_at(&self, fh: u64, host: u64, offset: u64, size: u64) -> Result<Vec<u8>, Errno> {
        let reader = {
            let mut st = self.st();
            match st.opens.get(&fh) {
                None => return Err(Errno::EBADF),
                Some(open) if open.writes || open.watched || self.served.ahead == 0 => None,
                Some(_) => match st.reader_at(fh, offset) {
                    Some(id) if st.reads[&id].ended(offset) => return Ok(Vec::new()),
                    Some(id) if st.reads[&id].stale(offset, offset + size) => {
                        st.forget_reader(id);
                        Some(None)
                    }
                    Some(id) if st.reads[&id].serves(offset) => Some(Some(id)),
                    _ => Some(None),
                },
            }
        };
        match reader {
            None => self.read_host(host, offset, size),
            Some(None) => self.read_fresh(fh, host, offset, size),
            Some(Some(id)) => match self.read_ahead(host, id, offset, size) {
                Some(data) => Ok(data),
                None => self.read_fresh(fh, host, offset, size),
            },
        }
    }

    /// Start open `fh`'s reader on `data`, the first bytes the reply to its
    /// open carried, unless the open writes or is watched, a change took
    /// what reads held since `drops`, when the open was asked, as those
    /// bytes may be older than it, they do not fit the read-ahead total,
    /// or one of the file's readers its open shares reads from the start.
    fn first_read(&self, fh: u64, drops: u64, data: Vec<u8>) {
        let mut st = self.st();
        let Some((owner, path, kept)) = st
            .opens
            .get(&fh)
            .filter(|o| !o.writes && !o.watched)
            .map(|o| (owner_of(fh, o), o.path.clone(), o.cached))
        else {
            return;
        };
        if st.read_drops != drops || st.read_bytes + data.len() > self.served.total {
            return;
        }
        if owner.is_none() && st.reader_at(fh, 0).is_some() {
            return;
        }
        let got = data.len() as u64;
        let first = self.served.first();
        let id = st.next_reader;
        st.next_reader += 1;
        st.read_bytes += data.len();
        st.reads.insert(
            id,
            Reader {
                path,
                owner,
                kept,
                windows: VecDeque::from([Window {
                    offset: 0,
                    size: got,
                    part: Part::Held(Arc::new(data), Instant::now()),
                }]),
                start: 0,
                next: got,
                ahead: first,
                end: (got < first).then(|| (got, Instant::now())),
            },
        );
    }

    /// Read `size` bytes at `offset` through host handle `host`, waiting
    /// for the answer.
    fn read_host(&self, host: u64, offset: u64, size: u64) -> Result<Vec<u8>, Errno> {
        let args = json!({ "fh": host, "offset": offset, "size": size });
        Ok(self.call("read", args, &[])?.body)
    }

    /// Read as asked through open `fh`, then start a reader past what came
    /// back, in place of the one the read was meant for, unless one that has
    /// not met the end of the file reaches past it already, as it does for a
    /// read the kernel sent behind another, or a change took what reads held
    /// while this one was out: its reply may be older than the change, so
    /// the end of the file it shows is not kept. A file whose opens share
    /// its readers keeps READ_STREAMS of them, the oldest going first.
    fn read_fresh(&self, fh: u64, host: u64, offset: u64, size: u64) -> Result<Vec<u8>, Errno> {
        let drops = self.st().read_drops;
        let data = self.read_host(host, offset, size)?;
        let at = offset + data.len() as u64;
        let mut st = self.st();
        let Some((owner, path, kept)) = st
            .opens
            .get(&fh)
            .filter(|o| !o.writes && !o.watched)
            .map(|o| (owner_of(fh, o), o.path.clone(), o.cached))
        else {
            return Ok(data);
        };
        let ahead = st.reads.values().any(|r| {
            reads_for(r, owner, &path) && r.end.is_none() && r.start <= at && at <= r.next
        });
        if !ahead && st.read_drops == drops {
            if let Some(meant) = st.reader_at(fh, offset) {
                st.forget_reader(meant);
            }
            if owner.is_none() {
                let mut streams: Vec<u64> = st
                    .reads
                    .iter()
                    .filter(|(_, r)| reads_for(r, owner, &path))
                    .map(|(&id, _)| id)
                    .collect();
                streams.sort_unstable();
                for old in streams
                    .iter()
                    .take((streams.len() + 1).saturating_sub(READ_STREAMS))
                {
                    st.forget_reader(*old);
                }
            }
            let id = st.next_reader;
            st.next_reader += 1;
            let end = ((data.len() as u64) < size).then(|| (at, Instant::now()));
            st.reads.insert(
                id,
                Reader {
                    path,
                    owner,
                    kept,
                    windows: VecDeque::new(),
                    start: at,
                    next: at,
                    ahead: size,
                    end,
                },
            );
        }
        Ok(data)
    }

    /// Read `size` bytes at `offset` from reader `id` through host handle
    /// `host`, having asked for what follows them: from the stretches that came, waiting
    /// for the reply to each one this read needs, or for the read already
    /// waiting on it. None once the reader went, a stretch it needs was
    /// refused, came longer ago than its mount keeps an answer, or was
    /// never asked for, or no reply came in time.
    fn read_ahead(&self, host: u64, id: u64, offset: u64, size: u64) -> Option<Vec<u8>> {
        self.ask_ahead(host, id, offset, size);
        let deadline = Instant::now() + REPLY_WAIT;
        let mut guard = self.st();
        loop {
            let step = {
                let st = &mut *guard;
                let reader = st.reads.get_mut(&id)?;
                let stop = reader
                    .end
                    .map_or(offset + size, |(end, _)| end.min(offset + size));
                let stale = reader.stale(offset, stop);
                let waiting = reader.windows.iter_mut().find(|w| {
                    w.end() > offset && w.offset < stop && !matches!(w.part, Part::Held(..))
                });
                match waiting {
                    _ if stale => Step::Forget,
                    None => Step::Gather(stop),
                    Some(window) => match &mut window.part {
                        Part::Failed => Step::Forget,
                        Part::Sent(sent, _) => match sent.take() {
                            Some(sent) => Step::Receive(sent, window.offset, window.size),
                            None => Step::Wait,
                        },
                        _ => Step::Wait,
                    },
                }
            };
            match step {
                Step::Gather(stop) => {
                    let st = &mut *guard;
                    let data = gathered(st.reads.get(&id)?, offset, stop)?;
                    trim(st, id, offset);
                    return Some(data);
                }
                Step::Forget => {
                    guard.forget_reader(id);
                    return None;
                }
                Step::Receive(sent, at, asked) => {
                    drop(guard);
                    let reply = self.link.answer(sent);
                    guard = self.st();
                    landed(&mut guard, id, at, asked, reply);
                    self.shared.arrived.notify_all();
                }
                Step::Wait => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return None;
                    }
                    guard = self
                        .shared
                        .arrived
                        .wait_timeout(guard, left)
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .0;
                }
            }
        }
    }

    /// Ask, through host handle `host`, for what follows a read of `size`
    /// bytes at `offset` from reader `id`: as far as its reach, a window at
    /// a time and as far as the read-ahead total leaves room. A read that
    /// finds no room for its own bytes reads as asked, so what reads hold
    /// never passes the total.
    fn ask_ahead(&self, host: u64, id: u64, offset: u64, size: u64) {
        let wanted = {
            let mut guard = self.st();
            let st = &mut *guard;
            let Some(reader) = st.reads.get_mut(&id) else {
                return;
            };
            reader.ahead = (reader.ahead * 2).min(self.served.ahead).max(size);
            let needed = offset + size;
            let reach = needed + reader.ahead;
            let mut wanted = Vec::new();
            while reader.end.is_none() && reader.next < reach {
                let window = self.served.window().min(reader.ahead).max(size);
                if st.read_bytes + window as usize > self.served.total {
                    break;
                }
                reader.windows.push_back(Window {
                    offset: reader.next,
                    size: window,
                    part: Part::Unsent,
                });
                st.read_bytes += window as usize;
                wanted.push((reader.next, window));
                reader.next += window;
            }
            wanted
        };
        for (at, window) in wanted {
            let args = json!({ "fh": host, "offset": at, "size": window });
            let asked = Instant::now();
            let sent = self.link.ask("read", args, &[]);
            let mut st = self.st();
            if let Some(w) = st
                .reads
                .get_mut(&id)
                .and_then(|r| r.windows.iter_mut().find(|w| w.offset == at))
            {
                w.part = match sent {
                    Ok(sent) => Part::Sent(Some(sent), asked),
                    Err(_) => Part::Failed,
                };
            }
            drop(st);
            self.shared.arrived.notify_all();
        }
    }
    /// Wait until every write open `fh` sent ahead has its answer: the
    /// first refusal among them fails the close or fsync that waits.
    fn settle(&self, fh: u64) -> Result<(), Errno> {
        let host = self
            .st()
            .opens
            .get(&fh)
            .filter(|o| o.writes)
            .and_then(|o| o.host);
        match host {
            Some(host) => self.link.settle(host).map_err(failed),
            None => Ok(()),
        }
    }

    fn entry(&self, path: &str, attrs: &Attrs, reply: ReplyEntry) {
        let ino = self.ino(path);
        reply.entry(&ttl(attrs), &self.attr(ino, attrs), Generation(0));
    }

    fn name<'a>(&self, name: &'a OsStr) -> Result<&'a str, Errno> {
        name.to_str().ok_or(Errno::EINVAL)
    }

    /// The folder stream `fh` from `offset`: each entry's next offset,
    /// name, inode and attributes, `.` and `..` first, its inode resolved
    /// only as the caller takes it; and whether no forget came since it
    /// was listed, so its attributes may still be kept.
    fn rows(
        &self,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
    ) -> (Box<dyn Iterator<Item = Row> + '_>, bool) {
        let Some(dir) = self.path(ino) else {
            return (Box::new(std::iter::empty()), false);
        };
        let mut dots = Vec::new();
        if offset < 2 {
            let dot = self.stat(&dir).unwrap_or(Attrs {
                mode: S_IFDIR | 0o755,
                size: 0,
                atime: 0.0,
                mtime: 0.0,
                ctime: 0.0,
                nlink: 2,
                rdev: 0,
                kept: false,
                watched: false,
                xattrs: false,
            });
            let parent = match split(&dir) {
                Some((up, _)) if dir != self.shared.root => self.ino(&up),
                _ => ino.0,
            };
            dots.push((1, ".".to_string(), ino.0, dot.clone()));
            dots.push((2, "..".to_string(), parent, dot));
            dots.drain(..offset as usize);
        }
        let start = offset.max(2);
        let (rest, current) = {
            let st = self.st();
            match st.dirs.get(&fh.0) {
                Some((_, listed, rows)) => (
                    rows.get((start - 2) as usize..).unwrap_or(&[]).to_vec(),
                    *listed == st.epoch,
                ),
                None => (Vec::new(), false),
            }
        };
        let rest = rest.into_iter().enumerate().map(move |(i, (name, attrs))| {
            let ino = self.ino(&child(&dir, &name));
            (start + i as u64 + 1, name, ino, attrs)
        });
        (Box::new(dots.into_iter().chain(rest)), current)
    }
}

/// The bytes from `offset` to `stop` that `reader`'s stretches hold, every
/// one of them come; None when they leave a gap.
fn gathered(reader: &Reader, offset: u64, stop: u64) -> Option<Vec<u8>> {
    let mut data = Vec::with_capacity(stop.saturating_sub(offset) as usize);
    let mut at = offset;
    for window in &reader.windows {
        if at >= stop {
            break;
        }
        if window.end() <= at {
            continue;
        }
        if window.offset > at {
            return None;
        }
        let Part::Held(bytes, _) = &window.part else {
            return None;
        };
        let from = (at - window.offset) as usize;
        let to = ((stop.min(window.end()) - window.offset) as usize).min(bytes.len());
        if from >= to {
            return None;
        }
        data.extend_from_slice(&bytes[from..to]);
        at = window.offset + to as u64;
    }
    (at >= stop).then_some(data)
}

/// Drop the stretches of reader `id` that end a READ_BEHIND or more
/// before `offset`: a read the kernel sent a little behind still finds
/// its bytes.
fn trim(st: &mut State, id: u64, offset: u64) {
    let Some(reader) = st.reads.get_mut(&id) else {
        return;
    };
    while let Some(window) = reader.windows.front() {
        if window.end() + READ_BEHIND > offset {
            break;
        }
        st.read_bytes -= window.size as usize;
        reader.windows.pop_front();
    }
    reader.start = reader.windows.front().map_or(reader.next, |w| w.offset);
}

/// Put `reply`, to the stretch of `asked` bytes at `offset` reader `id`
/// asked for, where it stands: held, or refused. One that came
/// short ends the file there and drops what was asked past it.
fn landed(st: &mut State, id: u64, offset: u64, asked: u64, reply: Result<Frame, Failure>) {
    let Some(reader) = st.reads.get_mut(&id) else {
        return;
    };
    let Some(i) = reader.windows.iter().position(|w| w.offset == offset) else {
        return;
    };
    let Part::Sent(_, sent_at) = reader.windows[i].part else {
        return;
    };
    let Ok(frame) = reply else {
        reader.windows[i].part = Part::Failed;
        return;
    };
    let got = frame.body.len() as u64;
    reader.windows[i].part = Part::Held(Arc::new(frame.body), sent_at);
    if got < asked {
        let past: u64 = reader.windows.iter().skip(i + 1).map(|w| w.size).sum();
        reader.windows.truncate(i + 1);
        reader.windows[i].size = got;
        reader.next = offset + got;
        reader.end = Some((offset + got, sent_at));
        st.read_bytes -= (asked - got + past) as usize;
    }
}

/// What a read from a reader does next: take the bytes up to the offset it
/// holds, give up on the reader when a stretch it needs was refused or came
/// longer ago than its mount keeps an answer, wait for the reply to one it
/// took, or wait for the read already receiving one.
enum Step {
    Gather(u64),
    Forget,
    Receive(Sent, u64, u64),
    Wait,
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
                    watched: false,
                    xattrs: false,
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

    fn getattr(&self, _req: &Request, ino: INodeNo, fh: Option<FileHandle>, reply: ReplyAttr) {
        let open = fh.and_then(|fh| self.st().opens.get(&fh.0).cloned());
        let Some(path) = self
            .path(ino)
            .or_else(|| open.as_ref().map(|o| o.path.clone()))
        else {
            return reply.error(Errno::ENOENT);
        };
        let found = match open {
            Some(Open {
                host: Some(host), ..
            }) => self.fstat(&path, host),
            Some(Open {
                attrs: Some(attrs), ..
            }) => Ok(Attrs {
                kept: false,
                ..attrs
            }),
            _ => match self.stat(&path) {
                Err(err) if err == Errno::ENOENT => self.held(&path).unwrap_or(Err(err)),
                found => found,
            },
        };
        match found {
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
        fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<fuser::BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let open = fh.and_then(|fh| self.st().opens.get(&fh.0).cloned());
        let Some(path) = self
            .path(ino)
            .or_else(|| open.as_ref().map(|o| o.path.clone()))
        else {
            return reply.error(Errno::ENOENT);
        };
        let mut args = Map::new();
        args.insert("path".into(), path.clone().into());
        let host = open.and_then(|o| o.host);
        if let Some(host) = host {
            args.insert("fh".into(), host.into());
        }
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
        let asked = self.st().epoch;
        match self.call("setattr", Value::Object(args), &[]) {
            Ok(frame) => match self.reply_attrs(&frame) {
                Some(attrs) => {
                    let attrs = match host {
                        Some(_) => Attrs {
                            kept: false,
                            ..attrs
                        },
                        None => self.keep(&path, attrs, asked).unwrap_or_else(|a| a),
                    };
                    if size.is_some() {
                        self.rewritten(&path, |st| st.paths.get(&ino.0).cloned());
                    }
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
        let asked = self.st().epoch;
        match self.call(
            "mkdir",
            json!({ "path": path, "mode": mode & !umask & 0o7777 }),
            &[],
        ) {
            Ok(frame) => match self.reply_attrs(&frame) {
                Some(attrs) => {
                    let attrs = self.keep(&path, attrs, asked).unwrap_or_else(|a| a);
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
            Ok(_) => {
                MirageFs::detach(&mut self.st(), &path);
                reply.ok()
            }
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
        let asked = self.st().epoch;
        match self.call("symlink", json!({ "path": path, "target": target }), &[]) {
            Ok(frame) => match self.reply_attrs(&frame) {
                Some(attrs) => {
                    let attrs = self.keep(&path, attrs, asked).unwrap_or_else(|a| a);
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
        let (exchange, noreplace) = rename_flags(flags);
        if exchange {
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
        match self.call(
            "rename",
            json!({ "from": from, "to": to, "noreplace": noreplace }),
            &[],
        ) {
            Ok(_) => {
                self.shared.forget(&from);
                self.shared.forget(&to);
                MirageFs::renamed(&mut self.st(), &from, &to);
                reply.ok()
            }
            Err(err) => {
                if err == Errno::ETIMEDOUT {
                    self.unknown(&from);
                    self.unknown(&to);
                }
                reply.error(err)
            }
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
        let watches = self.st().watches;
        if !writes
            && let Ok(attrs) = self.stat(&path)
            && self.whole_first(&attrs)
        {
            if let Some(data) = self.cached(&path, &attrs) {
                let fh = self.opened(
                    &path,
                    None,
                    Some((data, attrs)),
                    false,
                    true,
                    unwatched(watches),
                );
                return reply.opened(FileHandle(fh), FopenFlags::FOPEN_KEEP_CACHE);
            }
            let held = match self.whole(&path, attrs) {
                Ok((data, now)) if now.kept => Some((data, now)),
                Ok(_) => None,
                Err(err) if err == Errno::EFBIG => None,
                Err(err) => return reply.error(err),
            };
            if let Some(held) = held {
                let fh = self.opened(&path, None, Some(held), false, true, unwatched(watches));
                return reply.opened(FileHandle(fh), FopenFlags::empty());
            }
        }
        let args = json!({
            "path": path,
            "read": flags.0 & libc::O_ACCMODE != libc::O_WRONLY,
            "write": flags.0 & libc::O_ACCMODE != libc::O_RDONLY,
            "truncate": flags.0 & libc::O_TRUNC != 0,
            "append": flags.0 & libc::O_APPEND != 0,
            "first": if writes { 0 } else { self.served.first() },
        });
        if writes {
            self.changed(&path);
        }
        let drops = self.st().read_drops;
        match self.call("open", args, &[]) {
            Ok(frame) => {
                let Some(host) = frame.u64("fh") else {
                    return reply.error(Errno::EIO);
                };
                if flags.0 & libc::O_TRUNC != 0 {
                    self.rewritten(&path, |st| st.paths.get(&ino.0).cloned());
                }
                let (kept, watched) = keep_of(&frame);
                let fh = self.opened(
                    &path,
                    Some(host),
                    None,
                    writes,
                    kept && !writes,
                    Asked { watched, watches },
                );
                if frame.head.get("first").and_then(Value::as_bool) == Some(true) {
                    self.first_read(fh, drops, frame.body);
                }
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
        if open.revoked {
            return reply.error(Errno::EACCES);
        }
        let Some(host) = open.host else {
            let data = match (open.data, open.attrs) {
                (Some(data), _) => data,
                (None, Some(_)) if open.detached => return reply.error(Errno::ESTALE),
                (None, Some(attrs)) => match self.whole(&open.path, attrs) {
                    Ok((data, now)) => {
                        if let Some(held) = self.st().opens.get_mut(&fh.0) {
                            held.data = Some(data.clone());
                            held.attrs = Some(now);
                        }
                        data
                    }
                    Err(err) => return reply.error(err),
                },
                (None, None) => return reply.error(Errno::EBADF),
            };
            let start = (offset as usize).min(data.len());
            let end = start.saturating_add(size as usize).min(data.len());
            return reply.data(&data[start..end]);
        };
        match self.read_at(fh.0, host, offset, u64::from(size)) {
            Ok(data) => reply.data(&data),
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
        match self.write_at(fh.0, offset, data) {
            Ok(()) => reply.written(data.len() as u32),
            Err(err) => reply.error(err),
        }
    }

    fn flush(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        match self.settle(fh.0) {
            Ok(()) => reply.ok(),
            Err(err) => reply.error(err),
        }
    }

    fn release(
        &self,
        _req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let open = {
            let mut st = self.st();
            st.forget_open(fh.0);
            st.opens.remove(&fh.0)
        };
        self.shared.arrived.notify_all();
        if let Some(Open {
            host: Some(host),
            path,
            writes,
            ..
        }) = open
        {
            self.link.post("release", json!({ "fh": host }));
            self.link.released(host);
            if writes {
                self.changed(&path);
                self.rewritten(&path, |st| st.paths.get(&ino.0).cloned());
            }
        }
        reply.ok();
    }

    fn fsync(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _d: bool, reply: ReplyEmpty) {
        let host = self
            .st()
            .opens
            .get(&fh.0)
            .filter(|o| o.writes)
            .and_then(|o| o.host);
        let Some(host) = host else {
            return reply.ok();
        };
        if let Err(err) = self.settle(fh.0) {
            return reply.error(err);
        }
        match self.call("flush", json!({ "fh": host }), &[]) {
            Ok(_) => reply.ok(),
            Err(err) => reply.error(err),
        }
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let Some(dir) = self.path(ino) else {
            return reply.error(Errno::ENOENT);
        };
        match self.list(&dir) {
            Ok((rows, listed)) => {
                let mut st = self.st();
                let fh = st.next_fh;
                st.next_fh += 1;
                st.dirs.insert(fh, (dir, listed, rows));
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
        if self.st().revoked_dirs.contains(&fh.0) {
            return reply.error(Errno::EACCES);
        }
        let (rows, _) = self.rows(ino, fh, offset);
        for (next, name, ino, attrs) in rows {
            let kind = self.attr(ino, &attrs).kind;
            if reply.add(INodeNo(ino), next, kind, &name) {
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
        if self.st().revoked_dirs.contains(&fh.0) {
            return reply.error(Errno::EACCES);
        }
        let (rows, current) = self.rows(ino, fh, offset);
        for (next, name, ino, attrs) in rows {
            let attr = self.attr(ino, &attrs);
            let held = if current { ttl(&attrs) } else { Duration::ZERO };
            if reply.add(INodeNo(ino), next, &name, &held, &attr, Generation(0)) {
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
        let mut st = self.st();
        st.dirs.remove(&fh.0);
        st.revoked_dirs.remove(&fh.0);
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
        let set = self.call(
            "setxattr",
            json!({ "path": path, "name": name, "flags": xattr_flags(flags) }),
            value,
        );
        self.xattrs_changed(&path);
        match set {
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
        if name == "security.capability" || self.bare(&path) {
            return reply.error(Errno::NO_XATTR);
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
        if self.bare(&path) {
            return if size == 0 {
                reply.size(0)
            } else {
                reply.data(&[])
            };
        }
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
        let removed = self.call("removexattr", json!({ "path": path, "name": name }), &[]);
        self.xattrs_changed(&path);
        match removed {
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
        let watches = self.st().watches;
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
                let fh = self.opened(
                    &path,
                    Some(host),
                    None,
                    true,
                    false,
                    Asked {
                        watched: attrs.watched,
                        watches,
                    },
                );
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
    use crate::proto::{read_frame, write_frame};
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc::channel;

    fn attrs(kept: bool) -> Attrs {
        Attrs::parse(&json!({"m": 0o100644, "s": 3, "t": 1000.0}), kept, false).unwrap()
    }

    #[test]
    fn setxattr_flags_reach_the_host_as_linux_numbers_them() {
        assert_eq!(xattr_flags(0), 0);
        assert_eq!(xattr_flags(libc::XATTR_CREATE), 1);
        assert_eq!(xattr_flags(libc::XATTR_REPLACE), 2);
    }

    #[test]
    fn a_mode_reads_by_posix_file_type_bits() {
        assert!(attrs(false).is(S_IFREG));
        assert!(!attrs(false).is(S_IFDIR));
    }

    /// The host end of a client's pipe, played by the test: each request
    /// the client sends is read back, and each reply or push written.
    struct Host {
        requests: UnixStream,
        replies: UnixStream,
    }

    impl Host {
        fn next(&mut self) -> Frame {
            read_frame(&mut self.requests)
                .expect("the client sent no request in time")
                .expect("the client closed its pipe")
        }

        fn send(&mut self, head: Value, body: &[u8]) {
            let Value::Object(head) = head else {
                unreachable!()
            };
            write_frame(&mut self.replies, &head, body).unwrap();
        }
    }

    fn hosted() -> (Arc<MirageFs>, Host) {
        hosted_as(Served::default())
    }

    /// A client of a fake host whose `hello` said `served`.
    fn hosted_as(served: Served) -> (Arc<MirageFs>, Host) {
        let (client_out, requests) = UnixStream::pair().unwrap();
        requests
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (replies, mut client_in) = UnixStream::pair().unwrap();
        let link = Arc::new(Link::new(Box::new(client_out)));
        let (notes, _) = channel();
        let shared = Arc::new(Shared::new("/w".into(), notes));
        {
            let (link, shared) = (link.clone(), shared.clone());
            std::thread::spawn(move || link.serve(&mut client_in, |f| shared.push(f)));
        }
        (
            Arc::new(MirageFs::new(link, shared, served)),
            Host { requests, replies },
        )
    }

    #[test]
    fn attributes_a_forget_crossed_are_asked_for_again() {
        let (fs, mut host) = hosted();
        let asking = {
            let fs = fs.clone();
            std::thread::spawn(move || fs.stat("/w/a"))
        };
        let first = host.next();
        assert_eq!(first.str("op"), Some("getattr"));
        host.send(json!({"push": "inval", "paths": ["/w/a"]}), b"");
        host.send(
            json!({"id": first.u64("id"), "a": {"m": 0o100644, "s": 3}, "k": true}),
            b"",
        );
        let second = host.next();
        host.send(
            json!({"id": second.u64("id"), "a": {"m": 0o100644, "s": 5}, "k": true}),
            b"",
        );
        let found = asking.join().unwrap().unwrap();
        assert_eq!((found.size, found.kept), (5, true));
        assert_eq!(locked(&fs.shared.state).known["/w/a"].attrs.size, 5);
    }

    #[test]
    fn a_write_goes_ahead_of_its_answer_and_the_close_waits_for_it() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, true, false, unwatched(0));
        assert_eq!(fs.write_at(fh, 0, b"hi"), Ok(()));
        let sent = host.next();
        assert_eq!(
            (sent.str("op"), sent.u64("fh"), sent.body.as_slice()),
            (Some("write"), Some(7), &b"hi"[..])
        );
        let closing = {
            let fs = fs.clone();
            std::thread::spawn(move || fs.settle(fh))
        };
        host.send(json!({"id": sent.u64("id"), "errno": "EACCES"}), b"");
        assert_eq!(closing.join().unwrap(), Err(Errno::EACCES));
        assert_eq!(fs.settle(fh), Ok(()));
    }

    #[test]
    fn a_write_while_a_policy_judges_every_call_waits_for_its_answer() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, true, false, unwatched(0));
        fs.shared.push(Frame::new(json!({"push": "watch"}), vec![]));
        let writing = {
            let fs = fs.clone();
            std::thread::spawn(move || fs.write_at(fh, 0, b"hi"))
        };
        let sent = host.next();
        host.send(json!({"id": sent.u64("id"), "errno": "EACCES"}), b"");
        assert_eq!(writing.join().unwrap(), Err(Errno::EACCES));
        assert_eq!(fs.settle(fh), Ok(()));
    }

    /// Read `size` bytes at `offset` through open `fh` on a thread of its
    /// own, as the kernel's call does.
    fn reading(
        fs: &Arc<MirageFs>,
        fh: u64,
        offset: u64,
        size: u64,
    ) -> std::thread::JoinHandle<Result<Vec<u8>, Errno>> {
        let fs = fs.clone();
        std::thread::spawn(move || fs.read_at(fh, 7, offset, size))
    }

    /// Answer a read request with the bytes `content` has where it asks.
    fn answer_read(host: &mut Host, sent: &Frame, content: &[u8]) {
        let at = (sent.u64("offset").unwrap() as usize).min(content.len());
        let end = (at + sent.u64("size").unwrap() as usize).min(content.len());
        host.send(json!({"id": sent.u64("id")}), &content[at..end]);
    }

    /// The offset and size each read request asks for.
    fn asked(sent: &Frame) -> (Option<&str>, u64, u64) {
        (
            sent.str("op"),
            sent.u64("offset").unwrap_or(u64::MAX),
            sent.u64("size").unwrap_or(u64::MAX),
        )
    }

    const CONTENT: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";

    #[test]
    fn a_file_read_in_order_asks_for_what_follows_before_it_is_read() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let first = reading(&fs, fh, 0, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 0, 4));
        answer_read(&mut host, &sent, CONTENT);
        assert_eq!(first.join().unwrap().unwrap(), b"abcd");
        let second = reading(&fs, fh, 4, 4);
        let windows = [host.next(), host.next()];
        assert_eq!(
            windows.iter().map(asked).collect::<Vec<_>>(),
            [(Some("read"), 4, 8), (Some("read"), 12, 8)]
        );
        for sent in &windows {
            answer_read(&mut host, sent, CONTENT);
        }
        assert_eq!(second.join().unwrap().unwrap(), b"efgh");
        let third = reading(&fs, fh, 8, 4);
        assert_eq!(third.join().unwrap().unwrap(), b"ijkl");
        assert_eq!(asked(&host.next()), (Some("read"), 20, 16));
    }

    #[test]
    fn reads_the_kernel_sends_together_share_what_was_asked_for() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let first = reading(&fs, fh, 0, 4);
        let sent = host.next();
        answer_read(&mut host, &sent, CONTENT);
        first.join().unwrap().unwrap();
        let second = reading(&fs, fh, 4, 4);
        let windows = [host.next(), host.next()];
        let third = reading(&fs, fh, 8, 4);
        let further = host.next();
        assert_eq!(asked(&further), (Some("read"), 20, 16));
        for sent in windows.iter().chain([&further]) {
            answer_read(&mut host, sent, CONTENT);
        }
        assert_eq!(second.join().unwrap().unwrap(), b"efgh");
        assert_eq!(third.join().unwrap().unwrap(), b"ijkl");
        let fourth = reading(&fs, fh, 12, 8);
        assert_eq!(fourth.join().unwrap().unwrap(), b"mnopqrst");
    }

    #[test]
    fn a_change_to_the_file_drops_what_its_reads_asked_for_ahead() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let first = reading(&fs, fh, 0, 4);
        let sent = host.next();
        answer_read(&mut host, &sent, CONTENT);
        first.join().unwrap().unwrap();
        let second = reading(&fs, fh, 4, 4);
        for sent in [host.next(), host.next()] {
            answer_read(&mut host, &sent, CONTENT);
        }
        second.join().unwrap().unwrap();
        fs.changed("/w/a");
        assert!(locked(&fs.shared.state).reads.is_empty());
        assert_eq!(locked(&fs.shared.state).read_bytes, 0);
        let third = reading(&fs, fh, 8, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 8, 4));
        answer_read(&mut host, &sent, b"abcdefghIJKL");
        assert_eq!(third.join().unwrap().unwrap(), b"IJKL");
    }

    #[test]
    fn a_reply_that_comes_short_ends_the_file_until_the_kernel_would_ask_again() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let short = b"abcdefghij";
        let first = reading(&fs, fh, 0, 4);
        let sent = host.next();
        answer_read(&mut host, &sent, short);
        first.join().unwrap().unwrap();
        let second = reading(&fs, fh, 4, 4);
        for sent in [host.next(), host.next()] {
            answer_read(&mut host, &sent, short);
        }
        assert_eq!(second.join().unwrap().unwrap(), b"efgh");
        assert_eq!(reading(&fs, fh, 8, 4).join().unwrap().unwrap(), b"ij");
        assert_eq!(reading(&fs, fh, 10, 4).join().unwrap().unwrap(), b"");
        reader_of(&mut locked(&fs.shared.state), fh).end = Some((10, Instant::now() - SHORT));
        let grown = reading(&fs, fh, 10, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 10, 4));
        answer_read(&mut host, &sent, b"abcdefghijklmn");
        assert_eq!(grown.join().unwrap().unwrap(), b"klmn");
    }

    #[test]
    fn a_read_while_a_policy_judges_every_call_asks_for_nothing_ahead() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        fs.shared.push(Frame::new(json!({"push": "watch"}), vec![]));
        for offset in [0, 4] {
            let read = reading(&fs, fh, offset, 4);
            let sent = host.next();
            assert_eq!(asked(&sent), (Some("read"), offset, 4));
            answer_read(&mut host, &sent, CONTENT);
            read.join().unwrap().unwrap();
        }
        assert!(locked(&fs.shared.state).reads.is_empty());
    }

    #[test]
    fn a_refused_request_ahead_reads_as_asked_and_hands_over_that_answer() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let first = reading(&fs, fh, 0, 4);
        let sent = host.next();
        answer_read(&mut host, &sent, CONTENT);
        first.join().unwrap().unwrap();
        let second = reading(&fs, fh, 4, 4);
        let windows = [host.next(), host.next()];
        host.send(json!({"id": windows[0].u64("id"), "errno": "EIO"}), b"");
        answer_read(&mut host, &windows[1], CONTENT);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 4, 4));
        host.send(json!({"id": sent.u64("id"), "errno": "EACCES"}), b"");
        assert_eq!(second.join().unwrap(), Err(Errno::EACCES));
    }

    #[test]
    fn the_first_bytes_an_open_read_serve_its_reads_and_the_end_of_the_file() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let drops = locked(&fs.shared.state).read_drops;
        fs.first_read(fh, drops, b"abcdefghij".to_vec());
        assert_eq!(reading(&fs, fh, 0, 4).join().unwrap().unwrap(), b"abcd");
        assert_eq!(reading(&fs, fh, 4, 128).join().unwrap().unwrap(), b"efghij");
        assert_eq!(reading(&fs, fh, 10, 128).join().unwrap().unwrap(), b"");
        assert_eq!(reading(&fs, fh, 2, 4).join().unwrap().unwrap(), b"cdef");
        let elsewhere = reading(&fs, fh, 20, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 20, 4));
        answer_read(&mut host, &sent, CONTENT);
        assert_eq!(elsewhere.join().unwrap().unwrap(), b"uvwx");
    }

    #[test]
    fn the_first_bytes_an_open_read_before_a_change_are_not_kept() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let drops = locked(&fs.shared.state).read_drops;
        fs.changed("/w/b");
        fs.first_read(fh, drops, b"abcdefghij".to_vec());
        assert!(locked(&fs.shared.state).reads.is_empty());
        let read = reading(&fs, fh, 0, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 0, 4));
        answer_read(&mut host, &sent, b"ABCD");
        assert_eq!(read.join().unwrap().unwrap(), b"ABCD");
    }

    /// Read the first 4 bytes of `fh`, then the next 4 in order, so its
    /// reader holds the stretch [4, 12) the host answered from `content`.
    fn read_ahead_of(fs: &Arc<MirageFs>, host: &mut Host, fh: u64, content: &[u8]) {
        let first = reading(fs, fh, 0, 4);
        let sent = host.next();
        answer_read(host, &sent, content);
        first.join().unwrap().unwrap();
        let second = reading(fs, fh, 4, 4);
        for sent in [host.next(), host.next()] {
            answer_read(host, &sent, content);
        }
        second.join().unwrap().unwrap();
    }

    #[test]
    fn what_a_reader_asked_for_while_a_write_was_on_its_way_goes_once_it_is_sent() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        fs.changed("/w/a");
        read_ahead_of(&fs, &mut host, fh, CONTENT);
        fs.rewritten("/w/a", |_| None);
        assert!(locked(&fs.shared.state).reads.is_empty());
        let read = reading(&fs, fh, 8, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 8, 4));
        answer_read(&mut host, &sent, b"abcdefghWXYZ");
        assert_eq!(read.join().unwrap().unwrap(), b"WXYZ");
    }

    /// The writing open is watched, so its write waits for an answer, and
    /// the rename and the reads land while it does.
    #[test]
    fn a_reader_a_rename_moved_while_a_write_was_on_its_way_goes_once_it_is_sent() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/d/a", Some(7), None, false, false, unwatched(0));
        let watched = Asked {
            watched: true,
            watches: 0,
        };
        let writer = fs.opened("/w/d/a", Some(8), None, true, false, watched);
        let writing = {
            let fs = fs.clone();
            std::thread::spawn(move || fs.write_at(writer, 0, b"hi"))
        };
        let write = host.next();
        assert_eq!(write.str("op"), Some("write"));
        MirageFs::renamed(&mut fs.st(), "/w/d", "/w/e");
        read_ahead_of(&fs, &mut host, fh, CONTENT);
        host.send(json!({"id": write.u64("id")}), b"");
        assert_eq!(writing.join().unwrap(), Ok(()));
        let st = locked(&fs.shared.state);
        assert_eq!(st.opens[&fh].path, "/w/e/a");
        assert!(st.reads.is_empty());
    }

    #[test]
    fn a_read_with_no_room_left_for_its_bytes_reads_as_asked_and_holds_nothing() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let first = reading(&fs, fh, 0, 4);
        let sent = host.next();
        answer_read(&mut host, &sent, CONTENT);
        first.join().unwrap().unwrap();
        locked(&fs.shared.state).read_bytes = READ_AHEAD_TOTAL;
        let read = reading(&fs, fh, 4, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 4, 4));
        answer_read(&mut host, &sent, CONTENT);
        assert_eq!(read.join().unwrap().unwrap(), b"efgh");
        let mut st = locked(&fs.shared.state);
        assert_eq!(st.read_bytes, READ_AHEAD_TOTAL);
        assert!(reader_of(&mut st, fh).windows.is_empty());
    }

    /// The reader open `fh` reads ahead through: its own, or its file's.
    fn reader_of(st: &mut State, fh: u64) -> &mut Reader {
        let open = &st.opens[&fh];
        let (owner, path) = (owner_of(fh, open), open.path.clone());
        st.reads
            .values_mut()
            .find(|r| reads_for(r, owner, &path))
            .unwrap()
    }

    /// Make every stretch open `fh`'s reader asked for, come or on its way,
    /// asked longer than SHORT ago.
    fn age(fs: &Arc<MirageFs>, fh: u64) {
        let mut st = locked(&fs.shared.state);
        for window in &mut reader_of(&mut st, fh).windows {
            if let Part::Held(_, asked) | Part::Sent(_, asked) = &mut window.part {
                *asked = Instant::now() - SHORT;
            }
        }
    }

    /// `read_ahead_of` answers the stretch [12, 20) too, whose reply waits
    /// unread for a read that needs it.
    #[test]
    fn a_reply_ahead_left_unread_past_a_second_is_asked_again_on_a_mount_that_is_not_kept() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        read_ahead_of(&fs, &mut host, fh, CONTENT);
        age(&fs, fh);
        let read = reading(&fs, fh, 12, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 12, 4));
        answer_read(&mut host, &sent, b"abcdefghijklWXYZ");
        assert_eq!(read.join().unwrap().unwrap(), b"WXYZ");
    }

    #[test]
    fn a_stretch_held_past_a_second_is_asked_again_on_a_mount_that_is_not_kept() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        read_ahead_of(&fs, &mut host, fh, CONTENT);
        age(&fs, fh);
        let read = reading(&fs, fh, 8, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 8, 4));
        answer_read(&mut host, &sent, b"abcdefghWXYZ");
        assert_eq!(read.join().unwrap().unwrap(), b"WXYZ");
    }

    #[test]
    fn opens_of_one_file_on_a_kept_mount_share_what_was_asked_for() {
        let (fs, mut host) = hosted();
        let first = fs.opened("/w/a", Some(7), None, false, true, unwatched(0));
        let second = fs.opened("/w/a", Some(8), None, false, true, unwatched(0));
        read_ahead_of(&fs, &mut host, first, CONTENT);
        let read = reading(&fs, second, 8, 4);
        assert_eq!(asked(&host.next()), (Some("read"), 20, 16));
        assert_eq!(read.join().unwrap().unwrap(), b"ijkl");
    }

    #[test]
    fn opens_of_one_file_on_a_mount_that_is_not_kept_read_ahead_apart() {
        let (fs, mut host) = hosted();
        let first = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let second = fs.opened("/w/a", Some(8), None, false, false, unwatched(0));
        read_ahead_of(&fs, &mut host, first, CONTENT);
        let read = reading(&fs, second, 8, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 8, 4));
        answer_read(&mut host, &sent, CONTENT);
        assert_eq!(read.join().unwrap().unwrap(), b"ijkl");
    }

    #[test]
    fn a_kept_file_read_in_two_places_keeps_a_reader_for_each() {
        let (fs, mut host) = hosted();
        let first = fs.opened("/w/a", Some(7), None, false, true, unwatched(0));
        let second = fs.opened("/w/a", Some(8), None, false, true, unwatched(0));
        read_ahead_of(&fs, &mut host, first, CONTENT);
        let far = reading(&fs, second, 30, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 30, 4));
        answer_read(&mut host, &sent, CONTENT);
        assert_eq!(far.join().unwrap().unwrap(), b"4567");
        let near = reading(&fs, first, 8, 4);
        assert_eq!(asked(&host.next()), (Some("read"), 20, 16));
        assert_eq!(near.join().unwrap().unwrap(), b"ijkl");
    }

    #[test]
    fn opens_of_a_file_its_name_no_longer_names_share_nothing_with_the_next() {
        let (fs, mut host) = hosted();
        let old = fs.opened("/w/a", Some(7), None, false, true, unwatched(0));
        read_ahead_of(&fs, &mut host, old, CONTENT);
        MirageFs::detach(&mut fs.st(), "/w/a");
        assert!(locked(&fs.shared.state).reads.is_empty());
        let new = fs.opened("/w/a", Some(8), None, false, true, unwatched(0));
        let read = reading(&fs, new, 8, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 8, 4));
        answer_read(&mut host, &sent, b"abcdefghWXYZ");
        assert_eq!(read.join().unwrap().unwrap(), b"WXYZ");
        let mut st = locked(&fs.shared.state);
        assert_eq!(reader_of(&mut st, new).owner, None);
        assert!(owner_of(old, &st.opens[&old]).is_some());
    }

    #[test]
    fn an_open_a_pushed_change_named_reads_apart_from_the_opens_after_it() {
        let (fs, mut host) = hosted();
        let old = fs.opened("/w/a", Some(7), None, false, true, unwatched(0));
        fs.shared.forget("/w/a");
        read_ahead_of(&fs, &mut host, old, CONTENT);
        let new = fs.opened("/w/a", Some(8), None, false, true, unwatched(0));
        let read = reading(&fs, new, 8, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 8, 4));
        answer_read(&mut host, &sent, b"abcdefghWXYZ");
        assert_eq!(read.join().unwrap().unwrap(), b"WXYZ");
        let mut st = locked(&fs.shared.state);
        assert_eq!(reader_of(&mut st, new).owner, None);
        assert!(owner_of(old, &st.opens[&old]).is_some());
    }

    #[test]
    fn a_read_ahead_of_none_reads_no_file_whole_at_its_open() {
        let small = attrs(true);
        let (fs, _host) = hosted();
        assert!(fs.whole_first(&small));
        assert!(!fs.whole_first(&Attrs {
            size: WHOLE_FILE + 1,
            ..small.clone()
        }));
        let (none, _host) = hosted_as(Served {
            ahead: 0,
            ..Served::default()
        });
        assert!(!none.whole_first(&small));
    }

    #[test]
    fn a_read_ahead_of_none_reads_only_what_is_asked() {
        let (fs, mut host) = hosted_as(Served {
            ahead: 0,
            ..Served::default()
        });
        let fh = fs.opened("/w/a", Some(7), None, false, true, unwatched(0));
        for at in [0, 4] {
            let read = reading(&fs, fh, at, 4);
            let sent = host.next();
            assert_eq!(asked(&sent), (Some("read"), at, 4));
            answer_read(&mut host, &sent, CONTENT);
            read.join().unwrap().unwrap();
        }
        assert!(locked(&fs.shared.state).reads.is_empty());
        assert_eq!(fs.served.first(), 0);
    }

    #[test]
    fn hello_sets_the_read_ahead_and_says_whether_attributes_mark_attributes() {
        let said = Served::of(&Frame::new(
            json!({"proto": 1, "read_ahead": 2 << 20, "read_ahead_total": 16 << 20, "xattrs": true}),
            vec![],
        ));
        assert_eq!(
            (said.ahead, said.total, said.xattrs),
            (2 << 20, 16 << 20, true)
        );
        assert_eq!((said.window(), said.first()), (512 << 10, READ_FIRST));
        let far = Served::of(&Frame::new(
            json!({"proto": 1, "read_ahead": 64 << 20}),
            vec![],
        ));
        assert_eq!(far.window(), READ_WINDOW);
        let bare = Served::of(&Frame::new(json!({"proto": 1}), vec![]));
        assert_eq!(
            (bare.ahead, bare.total, bare.xattrs),
            (READ_AHEAD, READ_AHEAD_TOTAL, false)
        );
    }

    #[test]
    fn an_entry_kept_without_the_mark_carries_no_extended_attribute() {
        let marking = Served {
            xattrs: true,
            ..Served::default()
        };
        let (fs, _host) = hosted_as(marking);
        let keep = |path: &str, mark: bool| {
            let attrs = Attrs {
                xattrs: mark,
                ..attrs(true)
            };
            locked(&fs.shared.state).known.insert(
                path.into(),
                Known {
                    attrs,
                    at: Instant::now(),
                },
            );
        };
        keep("/w/bare", false);
        keep("/w/marked", true);
        assert!(fs.bare("/w/bare"));
        assert!(!fs.bare("/w/marked"));
        assert!(!fs.bare("/w/unknown"));
        let asked = locked(&fs.shared.state).epoch;
        fs.xattrs_changed("/w/bare");
        assert!(!fs.bare("/w/bare"));
        assert!(fs.keep("/w/bare", attrs(true), asked).is_err());
        assert!(!fs.bare("/w/bare"));
        let (older, _host) = hosted();
        locked(&older.shared.state).known.insert(
            "/w/bare".into(),
            Known {
                attrs: attrs(true),
                at: Instant::now(),
            },
        );
        assert!(!older.bare("/w/bare"));
    }

    #[test]
    fn an_entry_kept_for_a_second_says_nothing_of_its_attributes_after() {
        let (fs, _host) = hosted_as(Served {
            xattrs: true,
            ..Served::default()
        });
        locked(&fs.shared.state).known.insert(
            "/w/a".into(),
            Known {
                attrs: attrs(false),
                at: Instant::now() - SHORT,
            },
        );
        assert!(!fs.bare("/w/a"));
    }

    #[test]
    fn a_stretch_held_past_a_second_still_serves_on_a_kept_mount() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, true, unwatched(0));
        read_ahead_of(&fs, &mut host, fh, CONTENT);
        age(&fs, fh);
        let read = reading(&fs, fh, 8, 4);
        assert_eq!(asked(&host.next()), (Some("read"), 20, 16));
        assert_eq!(read.join().unwrap().unwrap(), b"ijkl");
    }

    #[test]
    fn the_first_bytes_of_an_open_past_what_reads_may_hold_are_not_kept() {
        let (fs, _host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let drops = {
            let mut st = locked(&fs.shared.state);
            st.read_bytes = READ_AHEAD_TOTAL - 4;
            st.read_drops
        };
        fs.first_read(fh, drops, b"abcdefghij".to_vec());
        let st = locked(&fs.shared.state);
        assert!(st.reads.is_empty());
        assert_eq!(st.read_bytes, READ_AHEAD_TOTAL - 4);
    }

    #[test]
    fn a_short_reply_a_change_raced_starts_no_reader() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, false, false, unwatched(0));
        let read = reading(&fs, fh, 0, 4);
        let sent = host.next();
        fs.changed("/w/b");
        answer_read(&mut host, &sent, b"ab");
        assert_eq!(read.join().unwrap().unwrap(), b"ab");
        assert!(locked(&fs.shared.state).reads.is_empty());
        let grown = reading(&fs, fh, 2, 4);
        let sent = host.next();
        assert_eq!(asked(&sent), (Some("read"), 2, 4));
        answer_read(&mut host, &sent, b"abcdef");
        assert_eq!(grown.join().unwrap().unwrap(), b"cdef");
    }

    #[test]
    fn a_write_open_reads_as_asked() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, true, false, unwatched(0));
        for offset in [0, 4] {
            let read = reading(&fs, fh, offset, 4);
            let sent = host.next();
            assert_eq!(asked(&sent), (Some("read"), offset, 4));
            answer_read(&mut host, &sent, CONTENT);
            read.join().unwrap().unwrap();
        }
    }

    #[test]
    fn a_watched_write_after_a_refused_one_fails_unsent_and_the_close_still_hears_it() {
        let (fs, mut host) = hosted();
        let fh = fs.opened("/w/a", Some(7), None, true, false, unwatched(0));
        fs.write_at(fh, 0, b"a").unwrap();
        let sent = host.next();
        host.send(json!({"id": sent.u64("id"), "errno": "EACCES"}), b"");
        while fs.link.refusal(7).is_none() {
            std::thread::yield_now();
        }
        fs.shared.push(Frame::new(json!({"push": "watch"}), vec![]));
        assert_eq!(fs.write_at(fh, 1, b"b"), Err(Errno::EACCES));
        assert_eq!(fs.settle(fh), Err(Errno::EACCES));
    }

    #[test]
    fn an_open_a_watch_crossed_is_watched_and_its_kept_pages_revoked() {
        let (fs, _host) = hosted();
        let asked = fs.st().watches;
        fs.shared.push(Frame::new(json!({"push": "watch"}), vec![]));
        let held = Some((Arc::new(b"old".to_vec()), attrs(true)));
        let cached = fs.opened("/w/a", None, held, false, true, unwatched(asked));
        let direct = fs.opened("/w/b", Some(7), None, true, false, unwatched(asked));
        let now = fs.st().watches;
        let after = fs.opened("/w/c", Some(8), None, true, false, unwatched(now));
        let st = fs.st();
        assert!(st.opens[&cached].revoked && st.opens[&cached].watched);
        assert!(st.opens[&direct].watched && !st.opens[&direct].revoked);
        assert!(!st.opens[&after].watched);
    }

    #[test]
    fn a_reader_of_a_removed_name_keeps_its_bytes_when_the_name_is_rewritten() {
        let (fs, _host) = hosted();
        let held = |bytes: &[u8]| Some((Arc::new(bytes.to_vec()), attrs(true)));
        let old = fs.opened("/w/a", None, held(b"old"), false, true, unwatched(0));
        MirageFs::detach(&mut fs.st(), "/w/a");
        let new = fs.opened("/w/a", None, held(b"new"), false, true, unwatched(0));
        fs.rewritten("/w/a", |_| None);
        let st = fs.st();
        assert_eq!(
            st.opens[&old].data.as_deref().map(Vec::as_slice),
            Some(&b"old"[..])
        );
        assert!(st.opens[&new].data.is_none());
    }

    #[test]
    fn a_whole_read_a_forget_crossed_is_not_kept_and_the_next_reads_anew() {
        let (fs, mut host) = hosted();
        let read = |fs: &Arc<MirageFs>| {
            let fs = fs.clone();
            std::thread::spawn(move || fs.whole("/w/a", attrs(true)))
        };
        let asking = read(&fs);
        let first = host.next();
        assert_eq!(first.str("op"), Some("readall"));
        host.send(json!({"push": "inval", "paths": ["/w/a"]}), b"");
        host.send(
            json!({"id": first.u64("id"), "a": {"m": 0o100644, "s": 3, "t": 1.0}, "k": true}),
            b"old",
        );
        assert_eq!(asking.join().unwrap().unwrap().0.as_slice(), b"old");
        {
            let st = locked(&fs.shared.state);
            assert!(!st.content.contains_key("/w/a"));
            assert!(!st.known.contains_key("/w/a"));
        }
        let asking = read(&fs);
        let again = host.next();
        host.send(
            json!({"id": again.u64("id"), "a": {"m": 0o100644, "s": 3, "t": 2.0}, "k": true}),
            b"new",
        );
        assert_eq!(asking.join().unwrap().unwrap().0.as_slice(), b"new");
        assert_eq!(
            locked(&fs.shared.state).content["/w/a"].data.as_slice(),
            b"new"
        );
    }

    #[test]
    fn a_listing_a_forget_crossed_is_used_once_and_not_kept() {
        let (fs, mut host) = hosted();
        let asking = {
            let fs = fs.clone();
            std::thread::spawn(move || fs.list("/w"))
        };
        let first = host.next();
        host.send(json!({"push": "inval", "paths": ["/w/b"]}), b"");
        host.send(
            json!({"id": first.u64("id"), "e": [["a", {"m": 0o100644}]], "k": true}),
            b"",
        );
        let (rows, listed) = asking.join().unwrap().unwrap();
        assert_eq!(rows.len(), 1);
        let st = locked(&fs.shared.state);
        assert!(!st.listings.contains_key("/w"));
        assert_ne!(listed, st.epoch);
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
                    watched: false,
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
    fn a_listing_keeps_each_entry_it_names() {
        let rows = entries(
            Some(&json!([["a.txt", {"m": 0o100644, "s": 1}], ["sub", {"m": 0o040755}], ["bad"]])),
            true,
            false,
        );
        assert_eq!(
            rows.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            ["a.txt", "sub"]
        );
        let mut st = State::default();
        st.listed("/w/sub", &rows, true, false, Instant::now());
        assert!(st.listings["/w/sub"].names.contains("a.txt"));
        assert_eq!(st.known["/w/sub/a.txt"].attrs.size, 1);
    }

    #[test]
    fn a_folder_another_mount_serves_keeps_its_own_cache_choice() {
        let rows = entries(
            Some(&json!([["a", {"m": 0o100644}], ["disk", {"m": 0o040755, "k": false}]])),
            true,
            false,
        );
        assert_eq!(
            rows.iter().map(|(_, a)| a.kept).collect::<Vec<_>>(),
            [true, false]
        );
    }

    #[test]
    fn content_is_cached_by_size_and_mtime() {
        let kept = attrs(true);
        let mut later = kept.clone();
        later.mtime = 2000.0;
        assert_ne!(kept.version(), later.version());
    }

    #[test]
    fn a_watched_answer_is_kept_by_neither_the_client_nor_the_kernel() {
        let watched = Attrs::parse(&json!({"m": 0o100644, "s": 3}), true, true).unwrap();
        assert!(!watched.kept);
        assert_eq!(ttl(&watched), Duration::ZERO);
        assert_eq!(ttl(&attrs(false)), SHORT);
        let known = Known {
            attrs: watched.clone(),
            at: Instant::now(),
        };
        assert!(!known.fresh());
        let mut st = State::default();
        st.listed("/w", &[("a".into(), watched)], false, true, Instant::now());
        assert!(!st.listings["/w"].fresh());
        st.listed(
            "/w",
            &[("a".into(), attrs(false))],
            false,
            false,
            Instant::now(),
        );
        assert!(st.listings["/w"].fresh());
    }

    #[test]
    fn a_watched_listing_is_asked_for_each_time() {
        let (fs, mut host) = hosted();
        for _ in 0..2 {
            let asking = {
                let fs = fs.clone();
                std::thread::spawn(move || fs.list("/w"))
            };
            let asked = host.next();
            assert_eq!(asked.str("op"), Some("list"));
            host.send(
                json!({"id": asked.u64("id"), "e": [["a", {"m": 0o100644}]], "k": false, "w": true}),
                b"",
            );
            assert_eq!(asking.join().unwrap().unwrap().0.len(), 1);
        }
    }

    #[test]
    fn a_policy_that_comes_refuses_reads_the_kernel_may_cache_and_old_streams() {
        let (fs, _host) = hosted();
        let held = Some((Arc::new(b"plan".to_vec()), attrs(true)));
        let cached = fs.opened("/w/a", None, held, false, true, unwatched(0));
        let direct = fs.opened("/w/b", Some(7), None, false, false, unwatched(0));
        fs.st().dirs.insert(9, ("/w".into(), 0, vec![]));
        fs.shared.push(Frame::new(json!({"push": "watch"}), vec![]));
        let st = fs.st();
        assert!(st.opens[&cached].revoked);
        assert!(!st.opens[&direct].revoked);
        assert!(st.revoked_dirs.contains(&9));
    }

    #[test]
    fn a_whole_read_a_forget_crossed_is_reported_unkept() {
        let (fs, mut host) = hosted();
        let asking = {
            let fs = fs.clone();
            std::thread::spawn(move || fs.whole("/w/a", attrs(true)))
        };
        let first = host.next();
        host.send(json!({"push": "inval", "paths": ["/w/a"]}), b"");
        host.send(
            json!({"id": first.u64("id"), "a": {"m": 0o100644, "s": 3, "t": 1.0}, "k": true}),
            b"old",
        );
        assert!(!asking.join().unwrap().unwrap().1.kept);
    }
}

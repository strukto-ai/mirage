use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};

use serde::{Deserialize, Serialize};

use super::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, specdata3,
};
use super::vfs::{DirEntry, ReadDirResult, VFSCapabilities};
use crate::StreamError;

pub const ROOT_ID: fileid3 = 1;

/// A file operation a call asks the host to run on its mount core.
#[derive(Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    Getattr {
        path: String,
    },
    Readdir {
        path: String,
    },
    Read {
        path: String,
        offset: u64,
        size: u32,
    },
    Readlink {
        path: String,
    },
}

#[derive(Serialize)]
pub struct Request {
    id: u32,
    #[serde(flatten)]
    op: Op,
}

/// What the host answers a request: an errno name (`"ENOENT"`) when the
/// operation failed, or what it asked for.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    attrs: Option<Attrs>,
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    target: Option<String>,
    #[serde(skip)]
    data: Vec<u8>,
}

/// One entry's attributes, times as `[seconds, nanoseconds]`.
#[derive(Deserialize, Clone, Copy)]
#[serde(deny_unknown_fields)]
pub struct Attrs {
    mode: u32,
    size: u64,
    nlink: u32,
    uid: u32,
    gid: u32,
    atime: (u32, u32),
    mtime: (u32, u32),
    ctime: (u32, u32),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    name: String,
    attrs: Option<Attrs>,
}

/// What the server and its calls share: the file ids handed out, the
/// requests not yet taken, the replies not yet read, and which call
/// waits on which request.
#[derive(Default)]
pub struct Shared {
    paths: HashMap<fileid3, String>,
    ids: HashMap<String, fileid3>,
    requests: Vec<Request>,
    replies: HashMap<u32, Reply>,
    waiting: HashMap<u32, u64>,
    pub current: u64,
    next_request: u32,
}

pub fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    pub fn take_requests(&mut self) -> Vec<Request> {
        std::mem::take(&mut self.requests)
    }

    /// Store request `id`'s reply and return the call waiting on it.
    pub fn complete(
        &mut self,
        id: u32,
        reply: &[u8],
        data: &[u8],
    ) -> Result<Option<u64>, StreamError> {
        let mut reply: Reply = serde_json::from_slice(reply)
            .map_err(|err| StreamError::new(format!("bad nfs reply: {err}")))?;
        reply.data = data.to_vec();
        let Some(task) = self.waiting.remove(&id) else {
            return Ok(None);
        };
        self.replies.insert(id, reply);
        Ok(Some(task))
    }

    /// Stop waiting for the requests of the calls `gone` names.
    pub fn forget(&mut self, gone: impl Fn(u64) -> bool) {
        self.waiting.retain(|_, task| !gone(*task));
    }

    fn request(&mut self, op: Op) -> u32 {
        self.next_request = self.next_request.wrapping_add(1);
        let id = self.next_request;
        self.requests.push(Request { id, op });
        self.waiting.insert(id, self.current);
        id
    }

    fn path(&self, id: fileid3) -> Result<String, nfsstat3> {
        if id == ROOT_ID {
            return Ok("/".to_string());
        }
        self.paths.get(&id).cloned().ok_or(nfsstat3::NFS3ERR_STALE)
    }

    fn intern(&mut self, path: &str) -> fileid3 {
        if path == "/" {
            return ROOT_ID;
        }
        if let Some(id) = self.ids.get(path) {
            return *id;
        }
        let id = ROOT_ID + 1 + self.paths.len() as fileid3;
        self.paths.insert(id, path.to_string());
        self.ids.insert(path.to_string(), id);
        id
    }
}

/// A call's wait for one request: pending until the host completes it.
struct HostCall {
    shared: Arc<Mutex<Shared>>,
    op: Option<Op>,
    id: u32,
}

impl Future for HostCall {
    type Output = Reply;

    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Reply> {
        let this = &mut *self;
        let mut shared = lock(&this.shared);
        if let Some(op) = this.op.take() {
            this.id = shared.request(op);
            return Poll::Pending;
        }
        match shared.replies.remove(&this.id) {
            Some(reply) => Poll::Ready(reply),
            None => Poll::Pending,
        }
    }
}

/// The filesystem the handlers serve: every answer comes from the host,
/// which runs each operation on its mount core. Files are named by the
/// ids handed out as paths are looked up.
pub struct HostFs {
    shared: Arc<Mutex<Shared>>,
    generation: u64,
}

impl HostFs {
    pub fn new(shared: Arc<Mutex<Shared>>, generation: u64) -> Self {
        Self { shared, generation }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadOnly
    }

    pub fn root_dir(&self) -> fileid3 {
        ROOT_ID
    }

    async fn call(&self, op: Op) -> Result<Reply, nfsstat3> {
        let reply = HostCall {
            shared: self.shared.clone(),
            op: Some(op),
            id: 0,
        }
        .await;
        match &reply.error {
            Some(error) => Err(status(error)),
            None => Ok(reply),
        }
    }

    fn path(&self, id: fileid3) -> Result<String, nfsstat3> {
        lock(&self.shared).path(id)
    }

    fn intern(&self, path: &str) -> fileid3 {
        lock(&self.shared).intern(path)
    }

    pub async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let dir = self.path(dirid)?;
        let name = std::str::from_utf8(&filename.0).map_err(|_| nfsstat3::NFS3ERR_NOENT)?;
        let path = match name {
            "." => return Ok(dirid),
            ".." => match dir.rsplit_once('/') {
                Some(("", _)) | None => "/".to_string(),
                Some((parent, _)) => parent.to_string(),
            },
            "" => return Err(nfsstat3::NFS3ERR_NOENT),
            name if name.contains('/') => return Err(nfsstat3::NFS3ERR_INVAL),
            name => child(&dir, name),
        };
        self.call(Op::Getattr { path: path.clone() }).await?;
        Ok(self.intern(&path))
    }

    pub async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let path = self.path(id)?;
        let reply = self.call(Op::Getattr { path }).await?;
        let attrs = reply.attrs.ok_or(nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok(fattr(id, &attrs))
    }

    pub async fn setattr(&self, _id: fileid3, _setattr: sattr3) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    pub async fn read(
        &self,
        id: fileid3,
        offset: u64,
        count: u32,
    ) -> Result<(Vec<u8>, bool), nfsstat3> {
        let path = self.path(id)?;
        let reply = self
            .call(Op::Read {
                path,
                offset,
                size: count,
            })
            .await?;
        let eof = reply.data.len() < count as usize;
        Ok((reply.data, eof))
    }

    pub async fn write(
        &self,
        _id: fileid3,
        _offset: u64,
        _data: &[u8],
    ) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    pub async fn create(
        &self,
        _dirid: fileid3,
        _filename: &filename3,
        _attr: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    pub async fn create_exclusive(
        &self,
        _dirid: fileid3,
        _filename: &filename3,
    ) -> Result<fileid3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    pub async fn mkdir(
        &self,
        _dirid: fileid3,
        _dirname: &filename3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    pub async fn remove(&self, _dirid: fileid3, _filename: &filename3) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    pub async fn rename(
        &self,
        _from_dirid: fileid3,
        _from_filename: &filename3,
        _to_dirid: fileid3,
        _to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    pub async fn symlink(
        &self,
        _dirid: fileid3,
        _linkname: &filename3,
        _symlink: &nfspath3,
        _attr: &sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    /// The entries after `start_after` (0 for the first), at most
    /// `max_entries` of them, each with its attributes.
    pub async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let dir = self.path(dirid)?;
        let reply = self.call(Op::Readdir { path: dir.clone() }).await?;
        let mut entries = Vec::new();
        for entry in reply.entries {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let Some(attrs) = entry.attrs else { continue };
            let fileid = self.intern(&child(&dir, &entry.name));
            entries.push(DirEntry {
                fileid,
                name: entry.name.into_bytes().into(),
                attr: fattr(fileid, &attrs),
            });
        }
        let start = match start_after {
            0 => 0,
            after => match entries.iter().position(|e| e.fileid == after) {
                Some(at) => at + 1,
                None => entries.len(),
            },
        };
        let end = entries.len() - start <= max_entries;
        let entries = entries.into_iter().skip(start).take(max_entries).collect();
        Ok(ReadDirResult { entries, end })
    }

    pub async fn readlink(&self, id: fileid3) -> Result<nfspath3, nfsstat3> {
        let path = self.path(id)?;
        let reply = self.call(Op::Readlink { path }).await?;
        let target = reply.target.ok_or(nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok(target.into_bytes().into())
    }
}

fn child(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn time((seconds, nseconds): (u32, u32)) -> nfstime3 {
    nfstime3 { seconds, nseconds }
}

fn fattr(fileid: fileid3, attrs: &Attrs) -> fattr3 {
    let ftype = match attrs.mode & 0o170000 {
        0o040000 => ftype3::NF3DIR,
        0o120000 => ftype3::NF3LNK,
        0o060000 => ftype3::NF3BLK,
        0o020000 => ftype3::NF3CHR,
        0o140000 => ftype3::NF3SOCK,
        0o010000 => ftype3::NF3FIFO,
        _ => ftype3::NF3REG,
    };
    fattr3 {
        ftype,
        mode: attrs.mode & 0o7777,
        nlink: attrs.nlink,
        uid: attrs.uid,
        gid: attrs.gid,
        size: attrs.size,
        used: attrs.size,
        rdev: specdata3::default(),
        fsid: 0,
        fileid,
        atime: time(attrs.atime),
        mtime: time(attrs.mtime),
        ctime: time(attrs.ctime),
    }
}

/// The NFS status for an errno name.
fn status(error: &str) -> nfsstat3 {
    match error {
        "EPERM" => nfsstat3::NFS3ERR_PERM,
        "ENOENT" => nfsstat3::NFS3ERR_NOENT,
        "ENXIO" => nfsstat3::NFS3ERR_NXIO,
        "EACCES" => nfsstat3::NFS3ERR_ACCES,
        "EEXIST" => nfsstat3::NFS3ERR_EXIST,
        "EXDEV" => nfsstat3::NFS3ERR_XDEV,
        "ENODEV" => nfsstat3::NFS3ERR_NODEV,
        "ENOTDIR" => nfsstat3::NFS3ERR_NOTDIR,
        "EISDIR" => nfsstat3::NFS3ERR_ISDIR,
        "EINVAL" => nfsstat3::NFS3ERR_INVAL,
        "EFBIG" => nfsstat3::NFS3ERR_FBIG,
        "ENOSPC" => nfsstat3::NFS3ERR_NOSPC,
        "EROFS" => nfsstat3::NFS3ERR_ROFS,
        "EMLINK" => nfsstat3::NFS3ERR_MLINK,
        "ENAMETOOLONG" => nfsstat3::NFS3ERR_NAMETOOLONG,
        "ENOTEMPTY" => nfsstat3::NFS3ERR_NOTEMPTY,
        "EDQUOT" => nfsstat3::NFS3ERR_DQUOT,
        "ESTALE" => nfsstat3::NFS3ERR_STALE,
        "ENOTSUP" | "EOPNOTSUPP" | "ENOSYS" => nfsstat3::NFS3ERR_NOTSUPP,
        _ => nfsstat3::NFS3ERR_IO,
    }
}

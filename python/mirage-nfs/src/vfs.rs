// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

use async_trait::async_trait;
use nfsserve::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, set_size3,
    specdata3,
};
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};
use pyo3::prelude::*;

use crate::bridge::Delegate;

/// The nfsserve VFS: every trait method forwards to the Python
/// delegate and converts the answer to wire types. No filesystem
/// decision is made here -- ids, buffering, link handling and errno
/// all live in `mirage/nfs`, where they are unit-tested; this file is
/// marshalling plus the fattr3 shape.
pub struct MirageVFS {
    delegate: Delegate,
    root: fileid3,
    uid: u32,
    gid: u32,
}

impl MirageVFS {
    pub fn new(delegate: Delegate, root: fileid3, uid: u32, gid: u32) -> Self {
        Self {
            delegate,
            root,
            uid,
            gid,
        }
    }

    fn name(raw: &filename3) -> Result<String, nfsstat3> {
        String::from_utf8(raw.0.clone()).map_err(|_| nfsstat3::NFS3ERR_INVAL)
    }

    /// Build a fattr3 from the duck-typed attrs a delegate returns.
    ///
    /// Reads fileid, size, is_dir, is_symlink, plus optional mode and
    /// mtime_epoch, which is epoch SECONDS -- nfstime3.seconds is a
    /// u32, so anything finer saturates it and dates every file 2106.
    /// mode falls back to 755/644 the way mount/stat's dir_stat and
    /// file_stat do; uid and gid are the server process's, which is
    /// what a loopback mount should show.
    fn attrs(&self, obj: &Py<PyAny>) -> Result<fattr3, nfsstat3> {
        Python::with_gil(|py| {
            let bound = obj.bind(py);
            let get_u64 = |name: &str| -> Result<u64, nfsstat3> {
                bound
                    .getattr(name)
                    .and_then(|v| v.extract::<u64>())
                    .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)
            };
            let get_bool = |name: &str| -> Result<bool, nfsstat3> {
                bound
                    .getattr(name)
                    .and_then(|v| v.extract::<bool>())
                    .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)
            };
            let fileid = get_u64("fileid")?;
            let size = get_u64("size")?;
            let is_dir = get_bool("is_dir")?;
            let is_symlink = get_bool("is_symlink")?;
            let mode = bound
                .getattr("mode")
                .ok()
                .and_then(|v| v.extract::<u32>().ok())
                .unwrap_or(if is_dir { 0o755 } else { 0o644 });
            let mtime = bound
                .getattr("mtime_epoch")
                .ok()
                .and_then(|v| v.extract::<f64>().ok())
                .unwrap_or(0.0);
            let ftype = if is_symlink {
                ftype3::NF3LNK
            } else if is_dir {
                ftype3::NF3DIR
            } else {
                ftype3::NF3REG
            };
            let stamp = nfstime3 {
                seconds: mtime as u32,
                nseconds: ((mtime.fract()) * 1e9) as u32,
            };
            Ok(fattr3 {
                ftype,
                mode: mode & 0o7777,
                nlink: if is_dir { 2 } else { 1 },
                uid: self.uid,
                gid: self.gid,
                size,
                used: size,
                rdev: specdata3::default(),
                fsid: 1,
                fileid,
                atime: stamp,
                mtime: stamp,
                ctime: stamp,
            })
        })
    }

    async fn getattr_of(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let obj = self.delegate.call("getattr", (id,)).await?;
        self.attrs(&obj)
    }
}

#[async_trait]
impl NFSFileSystem for MirageVFS {
    fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadWrite
    }

    fn root_dir(&self) -> fileid3 {
        self.root
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let name = Self::name(filename)?;
        let obj = self.delegate.call("lookup", (dirid, name)).await?;
        Python::with_gil(|py| obj.extract::<u64>(py)).map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        self.getattr_of(id).await
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        // Size is the one attribute that acts; the delegate discards
        // the rest, the way every mirage kernel mount does -- a backend
        // has nowhere to persist mode, owner or times.
        let size = match setattr.size {
            set_size3::size(value) => Some(value),
            set_size3::Void => None,
        };
        let obj = self.delegate.call("set_size", (id, size)).await?;
        self.attrs(&obj)
    }

    async fn read(
        &self,
        id: fileid3,
        offset: u64,
        count: u32,
    ) -> Result<(Vec<u8>, bool), nfsstat3> {
        let obj = self.delegate.call("read", (id, offset, count)).await?;
        let data = Python::with_gil(|py| obj.extract::<Vec<u8>>(py))
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
        // Short answer means end of file: the adapter serves the whole
        // remaining slice, so a full-length answer may still end
        // exactly at EOF -- the client discovers that on its next read.
        let eof = (data.len() as u32) < count;
        Ok((data, eof))
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let payload = data.to_vec();
        let obj = self.delegate.call("write", (id, offset, payload)).await?;
        self.attrs(&obj)
    }

    async fn create(
        &self,
        dirid: fileid3,
        filename: &filename3,
        _attr: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let name = Self::name(filename)?;
        let obj = self.delegate.call("create", (dirid, name)).await?;
        let id = Python::with_gil(|py| obj.extract::<u64>(py))
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok((id, self.getattr_of(id).await?))
    }

    async fn create_exclusive(
        &self,
        dirid: fileid3,
        filename: &filename3,
    ) -> Result<fileid3, nfsstat3> {
        // Its own delegate method, not `create`. EXCLUSIVE is the wire
        // form of O_CREAT|O_EXCL, and `create` truncates: routing it
        // here turned every lockfile idiom into a silent wipe of the
        // file it was meant to refuse to touch. Mirage still has no
        // create-verifier to replay; the delegate implements the half
        // that carries the data loss, refusing an existing path.
        let name = Self::name(filename)?;
        let obj = self
            .delegate
            .call("create_exclusive", (dirid, name))
            .await?;
        Python::with_gil(|py| obj.extract::<u64>(py)).map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)
    }

    async fn mkdir(
        &self,
        dirid: fileid3,
        dirname: &filename3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let name = Self::name(dirname)?;
        let obj = self.delegate.call("mkdir", (dirid, name)).await?;
        let id = Python::with_gil(|py| obj.extract::<u64>(py))
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok((id, self.getattr_of(id).await?))
    }

    async fn remove(&self, dirid: fileid3, filename: &filename3) -> Result<(), nfsstat3> {
        let name = Self::name(filename)?;
        self.delegate.call("remove", (dirid, name)).await?;
        Ok(())
    }

    async fn rename(
        &self,
        from_dirid: fileid3,
        from_filename: &filename3,
        to_dirid: fileid3,
        to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        let from = Self::name(from_filename)?;
        let to = Self::name(to_filename)?;
        self.delegate
            .call("rename", (from_dirid, from, to_dirid, to))
            .await?;
        Ok(())
    }

    async fn symlink(
        &self,
        dirid: fileid3,
        linkname: &filename3,
        symlink: &nfspath3,
        _attr: &sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let name = Self::name(linkname)?;
        let target =
            String::from_utf8(symlink.0.clone()).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        let obj = self.delegate.call("symlink", (dirid, name, target)).await?;
        let id = Python::with_gil(|py| obj.extract::<u64>(py))
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok((id, self.getattr_of(id).await?))
    }

    async fn readlink(&self, id: fileid3) -> Result<nfspath3, nfsstat3> {
        let obj = self.delegate.call("readlink", (id,)).await?;
        let target = Python::with_gil(|py| obj.extract::<String>(py))
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok(target.as_bytes().into())
    }

    async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        // start_after is the cookie of the last entry the client saw,
        // which the delegate defined as the entry's position.
        let obj = self
            .delegate
            .call("readdir", (dirid, start_after, max_entries as u64))
            .await?;
        Python::with_gil(|py| {
            let bound = obj.bind(py);
            let mut entries = Vec::new();
            for item in bound.try_iter().map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)? {
                let item = item.map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
                let name: String = item
                    .getattr("name")
                    .and_then(|v| v.extract())
                    .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
                let fileid: u64 = item
                    .getattr("fileid")
                    .and_then(|v| v.extract())
                    .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
                let attrs_obj = item
                    .getattr("attrs")
                    .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?
                    .unbind();
                entries.push(DirEntry {
                    fileid,
                    name: name.as_bytes().into(),
                    attr: self.attrs(&attrs_obj)?,
                });
            }
            let end = entries.len() < max_entries;
            Ok(ReadDirResult { entries, end })
        })
    }
}

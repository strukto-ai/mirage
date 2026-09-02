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

use crate::bridge::{
    call, Attrs, BytesReply, EntriesReply, IdArgs, IdReply, Method, NameArgs, ReadArgs,
    ReaddirArgs, RenameArgs, SetSizeArgs, SymlinkArgs, TextReply, UnitReply, WriteArgs,
};

/// Every delegate method, one ThreadsafeFunction each, wrapped by the
/// TypeScript loader from the MirageNFS adapter's methods.
pub struct Delegate {
    pub lookup: Method<NameArgs>,
    pub getattr: Method<IdArgs>,
    pub set_size: Method<SetSizeArgs>,
    pub read: Method<ReadArgs>,
    pub write: Method<WriteArgs>,
    pub create: Method<NameArgs>,
    pub create_exclusive: Method<NameArgs>,
    pub mkdir: Method<NameArgs>,
    pub remove: Method<NameArgs>,
    pub rename: Method<RenameArgs>,
    pub symlink: Method<SymlinkArgs>,
    pub readlink: Method<IdArgs>,
    pub readdir: Method<ReaddirArgs>,
    pub flush_idle: Method<IdArgs>,
}

/// The nfsserve VFS: pure marshalling onto the delegate, no
/// filesystem decision made here -- the exact stance of the PyO3
/// crate this mirrors.
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

    fn fattr(&self, attrs: &Attrs) -> fattr3 {
        let ftype = if attrs.is_symlink {
            ftype3::NF3LNK
        } else if attrs.is_dir {
            ftype3::NF3DIR
        } else {
            ftype3::NF3REG
        };
        let mtime = attrs.mtime_epoch.unwrap_or(0.0);
        let stamp = nfstime3 {
            seconds: mtime as u32,
            nseconds: (mtime.fract() * 1e9) as u32,
        };
        fattr3 {
            ftype,
            mode: attrs.mode.unwrap_or(if attrs.is_dir { 0o755 } else { 0o644 }) & 0o7777,
            nlink: if attrs.is_dir { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            size: attrs.size as u64,
            used: attrs.size as u64,
            rdev: specdata3::default(),
            fsid: 1,
            fileid: attrs.fileid as u64,
            atime: stamp,
            mtime: stamp,
            ctime: stamp,
        }
    }

    fn id_of(reply: IdReply) -> Result<fileid3, nfsstat3> {
        reply
            .fileid
            .map(|id| id as u64)
            .ok_or(nfsstat3::NFS3ERR_SERVERFAULT)
    }

    async fn getattr_of(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let attrs: Attrs = call(&self.delegate.getattr, IdArgs { id: id as f64 }).await?;
        Ok(self.fattr(&attrs))
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
        let reply: IdReply = call(
            &self.delegate.lookup,
            NameArgs {
                dir_id: dirid as f64,
                name: Self::name(filename)?,
            },
        )
        .await?;
        Self::id_of(reply)
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        self.getattr_of(id).await
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        let size = match setattr.size {
            set_size3::size(value) => Some(value as f64),
            set_size3::Void => None,
        };
        let attrs: Attrs = call(
            &self.delegate.set_size,
            SetSizeArgs {
                id: id as f64,
                size,
            },
        )
        .await?;
        Ok(self.fattr(&attrs))
    }

    async fn read(
        &self,
        id: fileid3,
        offset: u64,
        count: u32,
    ) -> Result<(Vec<u8>, bool), nfsstat3> {
        let reply: BytesReply = call(
            &self.delegate.read,
            ReadArgs {
                id: id as f64,
                offset: offset as f64,
                count,
            },
        )
        .await?;
        let data: Vec<u8> = reply
            .data
            .map(|b| b.to_vec())
            .ok_or(nfsstat3::NFS3ERR_SERVERFAULT)?;
        let eof = (data.len() as u32) < count;
        Ok((data, eof))
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let attrs: Attrs = call(
            &self.delegate.write,
            WriteArgs {
                id: id as f64,
                offset: offset as f64,
                data: data.to_vec().into(),
            },
        )
        .await?;
        Ok(self.fattr(&attrs))
    }

    async fn create(
        &self,
        dirid: fileid3,
        filename: &filename3,
        _attr: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let reply: IdReply = call(
            &self.delegate.create,
            NameArgs {
                dir_id: dirid as f64,
                name: Self::name(filename)?,
            },
        )
        .await?;
        let id = Self::id_of(reply)?;
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
        // file it was meant to refuse to touch.
        let reply: IdReply = call(
            &self.delegate.create_exclusive,
            NameArgs {
                dir_id: dirid as f64,
                name: Self::name(filename)?,
            },
        )
        .await?;
        Self::id_of(reply)
    }

    async fn mkdir(
        &self,
        dirid: fileid3,
        dirname: &filename3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        let reply: IdReply = call(
            &self.delegate.mkdir,
            NameArgs {
                dir_id: dirid as f64,
                name: Self::name(dirname)?,
            },
        )
        .await?;
        let id = Self::id_of(reply)?;
        Ok((id, self.getattr_of(id).await?))
    }

    async fn remove(&self, dirid: fileid3, filename: &filename3) -> Result<(), nfsstat3> {
        let _: UnitReply = call(
            &self.delegate.remove,
            NameArgs {
                dir_id: dirid as f64,
                name: Self::name(filename)?,
            },
        )
        .await?;
        Ok(())
    }

    async fn rename(
        &self,
        from_dirid: fileid3,
        from_filename: &filename3,
        to_dirid: fileid3,
        to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        let _: UnitReply = call(
            &self.delegate.rename,
            RenameArgs {
                from_dir_id: from_dirid as f64,
                from_name: Self::name(from_filename)?,
                to_dir_id: to_dirid as f64,
                to_name: Self::name(to_filename)?,
            },
        )
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
        let target =
            String::from_utf8(symlink.0.clone()).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        let reply: IdReply = call(
            &self.delegate.symlink,
            SymlinkArgs {
                dir_id: dirid as f64,
                name: Self::name(linkname)?,
                target,
            },
        )
        .await?;
        let id = Self::id_of(reply)?;
        Ok((id, self.getattr_of(id).await?))
    }

    async fn readlink(&self, id: fileid3) -> Result<nfspath3, nfsstat3> {
        let reply: TextReply = call(&self.delegate.readlink, IdArgs { id: id as f64 }).await?;
        let target = reply.text.ok_or(nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok(target.as_bytes().into())
    }

    async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let reply: EntriesReply = call(
            &self.delegate.readdir,
            ReaddirArgs {
                dir_id: dirid as f64,
                start_after: start_after as f64,
                max_entries: max_entries as u32,
            },
        )
        .await?;
        let raw = reply.entries.ok_or(nfsstat3::NFS3ERR_SERVERFAULT)?;
        let mut entries = Vec::with_capacity(raw.len());
        for item in raw {
            entries.push(DirEntry {
                fileid: item.attrs.fileid as u64,
                name: item.name.as_bytes().into(),
                attr: self.fattr(&item.attrs),
            });
        }
        let end = entries.len() < max_entries;
        Ok(ReadDirResult { entries, end })
    }
}

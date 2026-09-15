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

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi_derive::napi;
use nfsserve::nfs::nfsstat3;

/// One delegate method: a ThreadsafeFunction taking a single args
/// object and resolving a reply object. No exception ever crosses the
/// boundary -- the TS wrapper catches, classifies through the shared
/// mount/errors machinery, and resolves `{ errno }`; this side only
/// maps errno onto the wire status.
pub type Method<Args> = ThreadsafeFunction<Args, ErrorStrategy::Fatal>;

/// Await one delegate call from a tokio worker: the tsfn schedules the
/// JS callback onto the Node event loop, the callback returns a
/// promise, and awaiting it yields the reply -- the pattern the bridge
/// spike measured at ~20us per call.
pub async fn call<Args, Reply>(
    method: &Method<Args>,
    args: Args,
) -> std::result::Result<Reply, nfsstat3>
where
    Args: 'static,
    Reply: FromNapiValue + HasErrno + 'static,
{
    let promise: Promise<Reply> = method
        .call_async(args)
        .await
        .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
    let reply = promise.await.map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
    match reply.errno() {
        Some(code) => Err(errno_to_status(code)),
        None => Ok(reply),
    }
}

/// Read the errno a reply carries, when the delegate reports a failure.
pub trait HasErrno {
    fn errno(&self) -> Option<i32>;
}

/// errno -> NFS status, the same table the PyO3 crate carries; the
/// classification itself (typed error -> errno) happens in TypeScript
/// through the shared mount/errors machinery.
pub fn errno_to_status(errno: i32) -> nfsstat3 {
    match errno {
        1 => nfsstat3::NFS3ERR_PERM,
        2 => nfsstat3::NFS3ERR_NOENT,
        5 => nfsstat3::NFS3ERR_IO,
        13 => nfsstat3::NFS3ERR_ACCES,
        17 => nfsstat3::NFS3ERR_EXIST,
        20 => nfsstat3::NFS3ERR_NOTDIR,
        21 => nfsstat3::NFS3ERR_ISDIR,
        22 => nfsstat3::NFS3ERR_INVAL,
        27 => nfsstat3::NFS3ERR_FBIG,
        28 => nfsstat3::NFS3ERR_NOSPC,
        30 => nfsstat3::NFS3ERR_ROFS,
        36 | 63 => nfsstat3::NFS3ERR_NAMETOOLONG,
        39 | 66 => nfsstat3::NFS3ERR_NOTEMPTY,
        70 => nfsstat3::NFS3ERR_STALE,
        _ => nfsstat3::NFS3ERR_IO,
    }
}

/// The attribute shape a delegate resolves; the wire fattr3 is built
/// from it in vfs.rs. Sizes and ids are f64-safe: ids are minted
/// monotonically from 1 and never approach 2^53.
#[napi(object)]
#[derive(Clone)]
pub struct Attrs {
    pub errno: Option<i32>,
    pub fileid: f64,
    pub size: f64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub mode: Option<u32>,
    pub mtime_epoch: Option<f64>,
}

impl HasErrno for Attrs {
    fn errno(&self) -> Option<i32> {
        self.errno
    }
}

#[napi(object)]
pub struct IdReply {
    pub errno: Option<i32>,
    pub fileid: Option<f64>,
}

impl HasErrno for IdReply {
    fn errno(&self) -> Option<i32> {
        self.errno
    }
}

#[napi(object)]
pub struct BytesReply {
    pub errno: Option<i32>,
    pub data: Option<Buffer>,
}

impl HasErrno for BytesReply {
    fn errno(&self) -> Option<i32> {
        self.errno
    }
}

#[napi(object)]
pub struct TextReply {
    pub errno: Option<i32>,
    pub text: Option<String>,
}

impl HasErrno for TextReply {
    fn errno(&self) -> Option<i32> {
        self.errno
    }
}

#[napi(object)]
pub struct UnitReply {
    pub errno: Option<i32>,
}

impl HasErrno for UnitReply {
    fn errno(&self) -> Option<i32> {
        self.errno
    }
}

#[napi(object)]
pub struct DirEntryOut {
    pub name: String,
    pub attrs: Attrs,
}

#[napi(object)]
pub struct EntriesReply {
    pub errno: Option<i32>,
    pub entries: Option<Vec<DirEntryOut>>,
}

impl HasErrno for EntriesReply {
    fn errno(&self) -> Option<i32> {
        self.errno
    }
}

#[napi(object)]
pub struct NameArgs {
    pub dir_id: f64,
    pub name: String,
}

#[napi(object)]
pub struct IdArgs {
    pub id: f64,
}

#[napi(object)]
pub struct ReadArgs {
    pub id: f64,
    pub offset: f64,
    pub count: u32,
}

#[napi(object)]
pub struct WriteArgs {
    pub id: f64,
    pub offset: f64,
    pub data: Buffer,
}

#[napi(object)]
pub struct SetSizeArgs {
    pub id: f64,
    pub size: Option<f64>,
}

#[napi(object)]
pub struct RenameArgs {
    pub from_dir_id: f64,
    pub from_name: String,
    pub to_dir_id: f64,
    pub to_name: String,
}

#[napi(object)]
pub struct SymlinkArgs {
    pub dir_id: f64,
    pub name: String,
    pub target: String,
}

#[napi(object)]
pub struct ReaddirArgs {
    pub dir_id: f64,
    pub start_after: f64,
    pub max_entries: u32,
}

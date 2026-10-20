// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
// this is just a complete enumeration of everything in the RFC
#![allow(dead_code)]
// And its nice to keep the original RFC names and case
#![allow(non_camel_case_types)]

use std::fmt;
use std::io::{Read, Write};

use byteorder::{ReadBytesExt, WriteBytesExt};
use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::cast::FromPrimitive;

use super::xdr::*;

// Transcribed from RFC 1813.

// Section 2.2 Constants
/// These are the RPC constants needed to call the NFS Version 3
///  service.  They are given in decimal.
pub const PROGRAM: u32 = 100003;
pub const VERSION: u32 = 3;

// Section 2.4 Sizes
//
/// The maximum size in bytes of the opaque file handle.
pub const NFS3_FHSIZE: u32 = 64;

/// The size in bytes of the opaque cookie verifier passed by
/// READDIR and READDIRPLUS.
pub const NFS3_COOKIEVERFSIZE: u32 = 8;

/// The size in bytes of the opaque verifier used for
/// exclusive CREATE.
pub const NFS3_CREATEVERFSIZE: u32 = 8;

/// The size in bytes of the opaque verifier used for
/// asynchronous WRITE.
pub const NFS3_WRITEVERFSIZE: u32 = 8;

// Section 2.5 Basic Data Types
#[allow(non_camel_case_types)]
#[derive(Default, Clone)]
pub struct nfsstring(pub Vec<u8>);
impl nfsstring {
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}
impl From<Vec<u8>> for nfsstring {
    fn from(value: Vec<u8>) -> Self {
        Self(value)
    }
}
impl From<&[u8]> for nfsstring {
    fn from(value: &[u8]) -> Self {
        Self(value.into())
    }
}
impl AsRef<[u8]> for nfsstring {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl std::ops::Deref for nfsstring {
    type Target = Vec<u8>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl fmt::Debug for nfsstring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", String::from_utf8_lossy(&self.0))
    }
}
impl fmt::Display for nfsstring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", String::from_utf8_lossy(&self.0))
    }
}
pub type opaque = u8;
pub type filename3 = nfsstring;
pub type nfspath3 = nfsstring;
pub type fileid3 = u64;
pub type cookie3 = u64;
pub type cookieverf3 = [opaque; NFS3_COOKIEVERFSIZE as usize];
pub type createverf3 = [opaque; NFS3_CREATEVERFSIZE as usize];
pub type writeverf3 = [opaque; NFS3_WRITEVERFSIZE as usize];
pub type uid3 = u32;
pub type gid3 = u32;
pub type size3 = u64;
pub type offset3 = u64;
pub type mode3 = u32;
pub type count3 = u32;

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
#[repr(u32)]
pub enum nfsstat3 {
    /// Indicates the call completed successfully.
    NFS3_OK = 0,
    /// Not owner. The operation was not allowed because the
    /// caller is either not a privileged user (root) or not the
    /// owner of the target of the operation.
    NFS3ERR_PERM = 1,
    /// No such file or directory. The file or directory name
    /// specified does not exist.
    NFS3ERR_NOENT = 2,
    /// I/O error. A hard error (for example, a disk error)
    /// occurred while processing the requested operation.
    NFS3ERR_IO = 5,
    /// I/O error. No such device or address.
    NFS3ERR_NXIO = 6,
    /// Permission denied. The caller does not have the correct
    /// permission to perform the requested operation. Contrast
    /// this with NFS3ERR_PERM, which restricts itself to owner
    /// or privileged user permission failures.
    NFS3ERR_ACCES = 13,
    /// File exists. The file specified already exists.
    NFS3ERR_EXIST = 17,
    /// Attempt to do a cross-device hard link.
    NFS3ERR_XDEV = 18,
    /// No such device.
    NFS3ERR_NODEV = 19,
    /// Not a directory. The caller specified a non-directory in
    /// a directory operation.
    NFS3ERR_NOTDIR = 20,
    /// Is a directory. The caller specified a directory in a
    /// non-directory operation.
    NFS3ERR_ISDIR = 21,
    /// Invalid argument or unsupported argument for an
    /// operation. Two examples are attempting a READLINK on an
    /// object other than a symbolic link or attempting to
    /// SETATTR a time field on a server that does not support
    /// this operation.
    NFS3ERR_INVAL = 22,
    /// File too large. The operation would have caused a file to
    /// grow beyond the server's limit.
    NFS3ERR_FBIG = 27,
    /// No space left on device. The operation would have caused
    /// the server's file system to exceed its limit.
    NFS3ERR_NOSPC = 28,
    /// Read-only file system. A modifying operation was
    /// attempted on a read-only file system.
    NFS3ERR_ROFS = 30,
    /// Too many hard links.
    NFS3ERR_MLINK = 31,
    /// The filename in an operation was too long.
    NFS3ERR_NAMETOOLONG = 63,
    /// An attempt was made to remove a directory that was not empty.
    NFS3ERR_NOTEMPTY = 66,
    /// Resource (quota) hard limit exceeded. The user's resource
    /// limit on the server has been exceeded.
    NFS3ERR_DQUOT = 69,
    /// Invalid file handle. The file handle given in the
    /// arguments was invalid. The file referred to by that file
    /// handle no longer exists or access to it has been
    /// revoked.
    NFS3ERR_STALE = 70,
    /// Too many levels of remote in path. The file handle given
    /// in the arguments referred to a file on a non-local file
    /// system on the server.
    NFS3ERR_REMOTE = 71,
    /// Illegal NFS file handle. The file handle failed internal
    /// consistency checks.
    NFS3ERR_BADHANDLE = 10001,
    /// Update synchronization mismatch was detected during a
    /// SETATTR operation.
    NFS3ERR_NOT_SYNC = 10002,
    /// READDIR or READDIRPLUS cookie is stale
    NFS3ERR_BAD_COOKIE = 10003,
    /// Operation is not supported.
    NFS3ERR_NOTSUPP = 10004,
    /// Buffer or request is too small.
    NFS3ERR_TOOSMALL = 10005,
    /// An error occurred on the server which does not map to any
    /// of the legal NFS version 3 protocol error values.  The
    /// client should translate this into an appropriate error.
    /// UNIX clients may choose to translate this to EIO.
    NFS3ERR_SERVERFAULT = 10006,
    /// An attempt was made to create an object of a type not
    /// supported by the server.
    NFS3ERR_BADTYPE = 10007,
    /// The server initiated the request, but was not able to
    /// complete it in a timely fashion. The client should wait
    /// and then try the request with a new RPC transaction ID.
    /// For example, this error should be returned from a server
    /// that supports hierarchical storage and receives a request
    /// to process a file that has been migrated. In this case,
    /// the server should start the immigration process and
    /// respond to client with this error.
    NFS3ERR_JUKEBOX = 10008,
}

xdr_enum_serde!(nfsstat3);

/// File Type
#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default, FromPrimitive, ToPrimitive)]
#[repr(u32)]
pub enum ftype3 {
    /// Regular File
    #[default]
    NF3REG = 1,
    /// Directory
    NF3DIR = 2,
    /// Block Special Device
    NF3BLK = 3,
    /// Character Special Device
    NF3CHR = 4,
    /// Symbolic Link
    NF3LNK = 5,
    /// Socket
    NF3SOCK = 6,
    /// Named Pipe
    NF3FIFO = 7,
}
xdr_enum_serde!(ftype3);
/// Device Number information. Ex: Major / Minor device
#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
#[repr(C)]
pub struct specdata3 {
    pub specdata1: u32,
    pub specdata2: u32,
}
xdr_struct!(specdata3, specdata1, specdata2);

/// File Handle information
#[allow(non_camel_case_types)]
#[derive(Clone, Debug)]
pub struct nfs_fh3 {
    pub data: Vec<u8>,
}
xdr_struct!(nfs_fh3, data);
#[allow(clippy::derivable_impls)]
impl Default for nfs_fh3 {
    fn default() -> nfs_fh3 {
        nfs_fh3 { data: Vec::new() }
    }
}

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
#[repr(C)]
pub struct nfstime3 {
    pub seconds: u32,
    pub nseconds: u32,
}
xdr_struct!(nfstime3, seconds, nseconds);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
pub struct fattr3 {
    pub ftype: ftype3,
    pub mode: mode3,
    pub nlink: u32,
    pub uid: uid3,
    pub gid: gid3,
    pub size: size3,
    pub used: size3,
    pub rdev: specdata3,
    pub fsid: u64,
    pub fileid: fileid3,
    pub atime: nfstime3,
    pub mtime: nfstime3,
    pub ctime: nfstime3,
}
xdr_struct!(
    fattr3, ftype, mode, nlink, uid, gid, size, used, rdev, fsid, fileid, atime, mtime, ctime
);

// Section 3.3.19. Procedure 19: FSINFO - Get static file system Information
// The following constants are used in fsinfo to construct the bitmask 'properties',
// which represents the file system properties.

/// If this bit is 1 (TRUE), the file system supports hard links.
pub const FSF_LINK: u32 = 0x0001;

/// If this bit is 1 (TRUE), the file system supports symbolic links.
pub const FSF_SYMLINK: u32 = 0x0002;

/// If this bit is 1 (TRUE), the information returned by
/// PATHCONF is identical for every file and directory
/// in the file system. If it is 0 (FALSE), the client
/// should retrieve PATHCONF information for each file
/// and directory as required.
pub const FSF_HOMOGENEOUS: u32 = 0x0008;

/// If this bit is 1 (TRUE), the server will set the
/// times for a file via SETATTR if requested (to the
/// accuracy indicated by time_delta). If it is 0
/// (FALSE), the server cannot set times as requested.
pub const FSF_CANSETTIME: u32 = 0x0010;

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
pub struct fsinfo3 {
    pub obj_attributes: post_op_attr,
    pub rtmax: u32,
    pub rtpref: u32,
    pub rtmult: u32,
    pub wtmax: u32,
    pub wtpref: u32,
    pub wtmult: u32,
    pub dtpref: u32,
    pub maxfilesize: size3,
    pub time_delta: nfstime3,
    pub properties: u32,
}
xdr_struct!(
    fsinfo3,
    obj_attributes,
    rtmax,
    rtpref,
    rtmult,
    wtmax,
    wtpref,
    wtmult,
    dtpref,
    maxfilesize,
    time_delta,
    properties
);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
pub struct wcc_attr {
    pub size: size3,
    pub mtime: nfstime3,
    pub ctime: nfstime3,
}
xdr_struct!(wcc_attr, size, mtime, ctime);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
#[repr(u32)]
pub enum pre_op_attr {
    #[default]
    Void,
    attributes(wcc_attr),
}
xdr_bool_union!(pre_op_attr, attributes, wcc_attr);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
#[repr(u32)]
pub enum post_op_attr {
    #[default]
    Void,
    attributes(fattr3),
}
xdr_bool_union!(post_op_attr, attributes, fattr3);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
pub struct wcc_data {
    pub before: pre_op_attr,
    pub after: post_op_attr,
}
xdr_struct!(wcc_data, before, after);

#[allow(non_camel_case_types)]
#[derive(Clone, Debug, Default)]
#[repr(u32)]
pub enum post_op_fh3 {
    #[default]
    Void,
    handle(nfs_fh3),
}
xdr_bool_union!(post_op_fh3, handle, nfs_fh3);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
#[repr(u32)]
/// This enum is only used as a discriminant for set_atime / set_mtime
/// and should not be used directly.
pub enum _time_how {
    DONT_CHANGE = 0,
    SET_TO_SERVER_TIME = 1,
    SET_TO_CLIENT_TIME = 2,
}
xdr_enum_serde!(_time_how);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
#[repr(u32)]
pub enum set_mode3 {
    Void,
    mode(mode3),
}
xdr_bool_union!(set_mode3, mode, mode3);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
#[repr(u32)]
pub enum set_uid3 {
    Void,
    uid(uid3),
}
xdr_bool_union!(set_uid3, uid, uid3);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
#[repr(u32)]
pub enum set_gid3 {
    Void,
    gid(gid3),
}
xdr_bool_union!(set_gid3, gid, gid3);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
#[repr(u32)]
pub enum set_size3 {
    Void,
    size(size3),
}
xdr_bool_union!(set_size3, size, size3);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
#[repr(u32)]
/// discriminant is time_how
pub enum set_atime {
    DONT_CHANGE,
    SET_TO_SERVER_TIME,
    SET_TO_CLIENT_TIME(nfstime3),
}
impl XDR for set_atime {
    fn serialize<R: Write>(&self, dest: &mut R) -> std::io::Result<()> {
        match self {
            set_atime::DONT_CHANGE => {
                0_u32.serialize(dest)?;
            }
            set_atime::SET_TO_SERVER_TIME => {
                1_u32.serialize(dest)?;
            }
            set_atime::SET_TO_CLIENT_TIME(v) => {
                2_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
        }
        Ok(())
    }
    fn deserialize<R: Read>(&mut self, src: &mut R) -> std::io::Result<()> {
        let mut c: u32 = 0;
        c.deserialize(src)?;
        if c == 0 {
            *self = set_atime::DONT_CHANGE;
        } else if c == 1 {
            *self = set_atime::SET_TO_SERVER_TIME;
        } else if c == 2 {
            let mut r = nfstime3::default();
            r.deserialize(src)?;
            *self = set_atime::SET_TO_CLIENT_TIME(r);
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid value for set_atime",
            ));
        }
        Ok(())
    }
}

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
#[repr(u32)]
/// discriminant is time_how
pub enum set_mtime {
    DONT_CHANGE,
    SET_TO_SERVER_TIME,
    SET_TO_CLIENT_TIME(nfstime3),
}

impl XDR for set_mtime {
    fn serialize<R: Write>(&self, dest: &mut R) -> std::io::Result<()> {
        match self {
            set_mtime::DONT_CHANGE => {
                0_u32.serialize(dest)?;
            }
            set_mtime::SET_TO_SERVER_TIME => {
                1_u32.serialize(dest)?;
            }
            set_mtime::SET_TO_CLIENT_TIME(v) => {
                2_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
        }
        Ok(())
    }
    fn deserialize<R: Read>(&mut self, src: &mut R) -> std::io::Result<()> {
        let mut c: u32 = 0;
        c.deserialize(src)?;
        if c == 0 {
            *self = set_mtime::DONT_CHANGE;
        } else if c == 1 {
            *self = set_mtime::SET_TO_SERVER_TIME;
        } else if c == 2 {
            let mut r = nfstime3::default();
            r.deserialize(src)?;
            *self = set_mtime::SET_TO_CLIENT_TIME(r);
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid value for set_mtime",
            ));
        }
        Ok(())
    }
}

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug)]
pub struct sattr3 {
    pub mode: set_mode3,
    pub uid: set_uid3,
    pub gid: set_gid3,
    pub size: set_size3,
    pub atime: set_atime,
    pub mtime: set_mtime,
}
xdr_struct!(sattr3, mode, uid, gid, size, atime, mtime);
impl Default for sattr3 {
    fn default() -> sattr3 {
        sattr3 {
            mode: set_mode3::Void,
            uid: set_uid3::Void,
            gid: set_gid3::Void,
            size: set_size3::Void,
            atime: set_atime::DONT_CHANGE,
            mtime: set_mtime::DONT_CHANGE,
        }
    }
}

#[allow(non_camel_case_types)]
#[derive(Clone, Debug, Default)]
pub struct diropargs3 {
    pub dir: nfs_fh3,
    pub name: filename3,
}
xdr_struct!(diropargs3, dir, name);

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
pub struct symlinkdata3 {
    pub symlink_attributes: sattr3,
    pub symlink_data: nfspath3,
}
xdr_struct!(symlinkdata3, symlink_attributes, symlink_data);

/// We define the root handle here
pub fn get_root_mount_handle() -> Vec<u8> {
    vec![0]
}

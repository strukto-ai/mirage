// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
#![allow(clippy::upper_case_acronyms)]
#![allow(dead_code)]
use std::io::{Read, Write};

use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::cast::FromPrimitive;

use super::context::RPCContext;
use super::nfs;
use super::rpc::*;
use super::xdr::*;
/*
program NFS_PROGRAM {
 version NFS_V3 {

    void
     NFSPROC3_NULL(void)                    = 0;

    GETATTR3res
     NFSPROC3_GETATTR(GETATTR3args)         = 1;

    SETATTR3res
     NFSPROC3_SETATTR(SETATTR3args)         = 2;

    LOOKUP3res
     NFSPROC3_LOOKUP(LOOKUP3args)           = 3;

    ACCESS3res
     NFSPROC3_ACCESS(ACCESS3args)           = 4;

    READLINK3res
     NFSPROC3_READLINK(READLINK3args)       = 5;

    READ3res
     NFSPROC3_READ(READ3args)               = 6;

    WRITE3res
     NFSPROC3_WRITE(WRITE3args)             = 7;

    CREATE3res
     NFSPROC3_CREATE(CREATE3args)           = 8;

    MKDIR3res
     NFSPROC3_MKDIR(MKDIR3args)             = 9;

    SYMLINK3res
     NFSPROC3_SYMLINK(SYMLINK3args)         = 10;

    MKNOD3res
     NFSPROC3_MKNOD(MKNOD3args)             = 11;

    REMOVE3res
     NFSPROC3_REMOVE(REMOVE3args)           = 12;

    RMDIR3res
     NFSPROC3_RMDIR(RMDIR3args)             = 13;

    RENAME3res
     NFSPROC3_RENAME(RENAME3args)           = 14;

    LINK3res
     NFSPROC3_LINK(LINK3args)               = 15;

    READDIR3res
     NFSPROC3_READDIR(READDIR3args)         = 16;

    READDIRPLUS3res
     NFSPROC3_READDIRPLUS(READDIRPLUS3args) = 17;

    FSSTAT3res
     NFSPROC3_FSSTAT(FSSTAT3args)           = 18;

    FSINFO3res
     NFSPROC3_FSINFO(FSINFO3args)           = 19;

    PATHCONF3res
     NFSPROC3_PATHCONF(PATHCONF3args)       = 20;

    COMMIT3res
     NFSPROC3_COMMIT(COMMIT3args)           = 21;

 } = 3;
} = 100003;
*/

#[allow(non_camel_case_types)]
#[allow(clippy::upper_case_acronyms)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
enum NFSProgram {
    NFSPROC3_NULL = 0,
    NFSPROC3_GETATTR = 1,
    NFSPROC3_SETATTR = 2,
    NFSPROC3_LOOKUP = 3,
    NFSPROC3_ACCESS = 4,
    NFSPROC3_READLINK = 5,
    NFSPROC3_READ = 6,
    NFSPROC3_WRITE = 7,
    NFSPROC3_CREATE = 8,
    NFSPROC3_MKDIR = 9,
    NFSPROC3_SYMLINK = 10,
    NFSPROC3_MKNOD = 11,
    NFSPROC3_REMOVE = 12,
    NFSPROC3_RMDIR = 13,
    NFSPROC3_RENAME = 14,
    NFSPROC3_LINK = 15,
    NFSPROC3_READDIR = 16,
    NFSPROC3_READDIRPLUS = 17,
    NFSPROC3_FSSTAT = 18,
    NFSPROC3_FSINFO = 19,
    NFSPROC3_PATHCONF = 20,
    NFSPROC3_COMMIT = 21,
    INVALID = 22,
}

pub async fn handle_nfs(
    xid: u32,
    call: call_body,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    if call.vers != nfs::VERSION {
        warn!(
            "Invalid NFS Version number {} != {}",
            call.vers,
            nfs::VERSION
        );
        prog_mismatch_reply_message(xid, nfs::VERSION).serialize(output)?;
        return Ok(());
    }
    let prog = NFSProgram::from_u32(call.proc).unwrap_or(NFSProgram::INVALID);

    match prog {
        NFSProgram::NFSPROC3_NULL => nfsproc3_null(xid, input, output)?,
        NFSProgram::NFSPROC3_GETATTR => nfsproc3_getattr(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_LOOKUP => nfsproc3_lookup(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_READ => nfsproc3_read(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_FSINFO => nfsproc3_fsinfo(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_ACCESS => nfsproc3_access(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_PATHCONF => nfsproc3_pathconf(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_FSSTAT => nfsproc3_fsstat(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_READDIR => nfsproc3_readdir(xid, input, output, context).await?,
        NFSProgram::NFSPROC3_READDIRPLUS => {
            nfsproc3_readdirplus(xid, input, output, context).await?
        }
        NFSProgram::NFSPROC3_SETATTR
        | NFSProgram::NFSPROC3_WRITE
        | NFSProgram::NFSPROC3_CREATE
        | NFSProgram::NFSPROC3_MKDIR
        | NFSProgram::NFSPROC3_SYMLINK
        | NFSProgram::NFSPROC3_REMOVE
        | NFSProgram::NFSPROC3_RMDIR => nfsproc3_read_only(xid, 1, output)?,
        NFSProgram::NFSPROC3_RENAME => nfsproc3_read_only(xid, 2, output)?,
        NFSProgram::NFSPROC3_READLINK => nfsproc3_readlink(xid, input, output, context).await?,
        _ => {
            warn!("Unimplemented message {:?}", prog);
            proc_unavail_reply_message(xid).serialize(output)?;
        } /*
          NFSPROC3_MKNOD,
          NFSPROC3_LINK,
          NFSPROC3_COMMIT,
          INVALID*/
    }
    Ok(())
}

pub fn nfsproc3_null(xid: u32, _: &mut impl Read, output: &mut impl Write) -> std::io::Result<()> {
    debug!("nfsproc3_null({:?}) ", xid);
    let msg = make_success_reply(xid);
    debug!("\t{:?} --> {:?}", xid, msg);
    msg.serialize(output)?;
    Ok(())
}
/*
GETATTR3res NFSPROC3_GETATTR(GETATTR3args) = 1;
struct GETATTR3args {
  nfs_fh3  object;
};

struct GETATTR3resok {
  fattr3   obj_attributes;
};

union GETATTR3res switch (nfsstat3 status) {
 case NFS3_OK:
  GETATTR3resok  resok;
 default:
  void;
};
 */
pub async fn nfsproc3_getattr(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut handle = nfs::nfs_fh3::default();
    handle.deserialize(input)?;
    debug!("nfsproc3_getattr({:?},{:?}) ", xid, handle);

    let id = context.vfs.fh_to_id(&handle);
    // fail if unable to convert file handle
    if let Err(stat) = id {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        return Ok(());
    }
    let id = id.unwrap();
    match context.vfs.getattr(id).await {
        Ok(fh) => {
            debug!(" {:?} --> {:?}", xid, fh);
            make_success_reply(xid).serialize(output)?;
            nfs::nfsstat3::NFS3_OK.serialize(output)?;
            fh.serialize(output)?;
        }
        Err(stat) => {
            error!("getattr error {:?} --> {:?}", xid, stat);
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
        }
    }
    Ok(())
}

/*
 LOOKUP3res NFSPROC3_LOOKUP(LOOKUP3args) = 3;

 struct LOOKUP3args {
      diropargs3  what;
 };

 struct LOOKUP3resok {
      nfs_fh3      object;
      post_op_attr obj_attributes;
      post_op_attr dir_attributes;
 };

 struct LOOKUP3resfail {
      post_op_attr dir_attributes;
 };

 union LOOKUP3res switch (nfsstat3 status) {
 case NFS3_OK:
      LOOKUP3resok    resok;
 default:
      LOOKUP3resfail  resfail;
 };
*
*/
pub async fn nfsproc3_lookup(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut dirops = nfs::diropargs3::default();
    dirops.deserialize(input)?;
    debug!("nfsproc3_lookup({:?},{:?}) ", xid, dirops);

    let dirid = context.vfs.fh_to_id(&dirops.dir);
    // fail if unable to convert file handle
    if let Err(stat) = dirid {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let dirid = dirid.unwrap();

    let dir_attr = match context.vfs.getattr(dirid).await {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(_) => nfs::post_op_attr::Void,
    };
    match context.vfs.lookup(dirid, &dirops.name).await {
        Ok(fid) => {
            let obj_attr = match context.vfs.getattr(fid).await {
                Ok(v) => nfs::post_op_attr::attributes(v),
                Err(_) => nfs::post_op_attr::Void,
            };

            debug!("lookup success {:?} --> {:?}", xid, obj_attr);
            make_success_reply(xid).serialize(output)?;
            nfs::nfsstat3::NFS3_OK.serialize(output)?;
            context.vfs.id_to_fh(fid).serialize(output)?;
            obj_attr.serialize(output)?;
            dir_attr.serialize(output)?;
        }
        Err(stat) => {
            debug!("lookup error {:?}({:?}) --> {:?}", xid, dirops.name, stat);
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
            dir_attr.serialize(output)?;
        }
    }
    Ok(())
}

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct READ3args {
    file: nfs::nfs_fh3,
    offset: nfs::offset3,
    count: nfs::count3,
}
xdr_struct!(READ3args, file, offset, count);

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct READ3resok {
    file_attributes: nfs::post_op_attr,
    count: nfs::count3,
    eof: bool,
    data: Vec<u8>,
}
xdr_struct!(READ3resok, file_attributes, count, eof, data);
/*
READ3res NFSPROC3_READ(READ3args) = 6;

struct READ3args {
   nfs_fh3  file;
   offset3  offset;
   count3   count;
};

struct READ3resok {
   post_op_attr   file_attributes;
   count3         count;
   bool           eof;
   opaque         data<>;
};

struct READ3resfail {
   post_op_attr   file_attributes;
};

union READ3res switch (nfsstat3 status) {
case NFS3_OK:
   READ3resok   resok;
default:
   READ3resfail resfail;
};
 */
pub async fn nfsproc3_read(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut args = READ3args::default();
    args.deserialize(input)?;
    debug!("nfsproc3_read({:?},{:?}) ", xid, args);

    let id = context.vfs.fh_to_id(&args.file);
    if let Err(stat) = id {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let id = id.unwrap();

    let obj_attr = match context.vfs.getattr(id).await {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(_) => nfs::post_op_attr::Void,
    };
    match context.vfs.read(id, args.offset, args.count).await {
        Ok((bytes, eof)) => {
            let res = READ3resok {
                file_attributes: obj_attr,
                count: bytes.len() as u32,
                eof,
                data: bytes,
            };
            make_success_reply(xid).serialize(output)?;
            nfs::nfsstat3::NFS3_OK.serialize(output)?;
            res.serialize(output)?;
        }
        Err(stat) => {
            error!("read error {:?} --> {:?}", xid, stat);
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
            obj_attr.serialize(output)?;
        }
    }
    Ok(())
}

/*

  FSINFO3res NFSPROC3_FSINFO(FSINFO3args) = 19;

  const FSF3_LINK        = 0x0001;
  const FSF3_SYMLINK     = 0x0002;
  const FSF3_HOMOGENEOUS = 0x0008;
  const FSF3_CANSETTIME  = 0x0010;

  struct FSINFOargs {
       nfs_fh3   fsroot;
  };

  struct FSINFO3resok {
       post_op_attr obj_attributes;
       uint32       rtmax;
       uint32       rtpref;
       uint32       rtmult;
       uint32       wtmax;
       uint32       wtpref;
       uint32       wtmult;
       uint32       dtpref;
       size3        maxfilesize;
       nfstime3     time_delta;
       uint32       properties;
  };

  struct FSINFO3resfail {
       post_op_attr obj_attributes;
  };

  union FSINFO3res switch (nfsstat3 status) {
  case NFS3_OK:
       FSINFO3resok   resok;
  default:
       FSINFO3resfail resfail;
  };
*/

pub async fn nfsproc3_fsinfo(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut handle = nfs::nfs_fh3::default();
    handle.deserialize(input)?;
    debug!("nfsproc3_fsinfo({:?},{:?}) ", xid, handle);

    let id = context.vfs.fh_to_id(&handle);
    // fail if unable to convert file handle
    if let Err(stat) = id {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let id = id.unwrap();

    match context.vfs.fsinfo(id).await {
        Ok(fsinfo) => {
            debug!(" {:?} --> {:?}", xid, fsinfo);
            make_success_reply(xid).serialize(output)?;
            nfs::nfsstat3::NFS3_OK.serialize(output)?;
            fsinfo.serialize(output)?;
        }
        Err(stat) => {
            error!("fsinfo error {:?} --> {:?}", xid, stat);
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
        }
    }
    Ok(())
}

const ACCESS3_READ: u32 = 0x0001;
const ACCESS3_LOOKUP: u32 = 0x0002;
const ACCESS3_MODIFY: u32 = 0x0004;
const ACCESS3_EXTEND: u32 = 0x0008;
const ACCESS3_DELETE: u32 = 0x0010;
const ACCESS3_EXECUTE: u32 = 0x0020;
/*

 ACCESS3res NFSPROC3_ACCESS(ACCESS3args) = 4;


 struct ACCESS3args {
      nfs_fh3  object;
      uint32   access;
 };

 struct ACCESS3resok {
      post_op_attr   obj_attributes;
      uint32         access;
 };

 struct ACCESS3resfail {
      post_op_attr   obj_attributes;
 };

 union ACCESS3res switch (nfsstat3 status) {
 case NFS3_OK:
      ACCESS3resok   resok;
 default:
      ACCESS3resfail resfail;
 };
*/

pub async fn nfsproc3_access(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut handle = nfs::nfs_fh3::default();
    handle.deserialize(input)?;
    let mut access: u32 = 0;
    access.deserialize(input)?;
    debug!("nfsproc3_access({:?},{:?},{:?})", xid, handle, access);

    let id = context.vfs.fh_to_id(&handle);
    // fail if unable to convert file handle
    if let Err(stat) = id {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let id = id.unwrap();

    let obj_attr = match context.vfs.getattr(id).await {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(_) => nfs::post_op_attr::Void,
    };
    access &= ACCESS3_READ | ACCESS3_LOOKUP | ACCESS3_EXECUTE;
    debug!(" {:?} ---> {:?}", xid, access);
    make_success_reply(xid).serialize(output)?;
    nfs::nfsstat3::NFS3_OK.serialize(output)?;
    obj_attr.serialize(output)?;
    access.serialize(output)?;
    Ok(())
}

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct PATHCONF3resok {
    obj_attributes: nfs::post_op_attr,
    linkmax: u32,
    name_max: u32,
    no_trunc: bool,
    chown_restricted: bool,
    case_insensitive: bool,
    case_preserving: bool,
}
xdr_struct!(
    PATHCONF3resok,
    obj_attributes,
    linkmax,
    name_max,
    no_trunc,
    chown_restricted,
    case_insensitive,
    case_preserving
);
/*

     PATHCONF3res NFSPROC3_PATHCONF(PATHCONF3args) = 20;

     struct PATHCONF3args {
          nfs_fh3   object;
     };

     struct PATHCONF3resok {
          post_op_attr obj_attributes;
          uint32       linkmax;
          uint32       name_max;
          bool         no_trunc;
          bool         chown_restricted;
          bool         case_insensitive;
          bool         case_preserving;
     };

     struct PATHCONF3resfail {
          post_op_attr obj_attributes;
     };

     union PATHCONF3res switch (nfsstat3 status) {
     case NFS3_OK:
          PATHCONF3resok   resok;
     default:
          PATHCONF3resfail resfail;
     };
*/
pub async fn nfsproc3_pathconf(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut handle = nfs::nfs_fh3::default();
    handle.deserialize(input)?;
    debug!("nfsproc3_pathconf({:?},{:?})", xid, handle);

    let id = context.vfs.fh_to_id(&handle);
    // fail if unable to convert file handle
    if let Err(stat) = id {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let id = id.unwrap();

    let obj_attr = match context.vfs.getattr(id).await {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(_) => nfs::post_op_attr::Void,
    };
    let res = PATHCONF3resok {
        obj_attributes: obj_attr,
        linkmax: 0,
        name_max: 32768,
        no_trunc: true,
        chown_restricted: true,
        case_insensitive: false,
        case_preserving: true,
    };
    debug!(" {:?} ---> {:?}", xid, res);
    make_success_reply(xid).serialize(output)?;
    nfs::nfsstat3::NFS3_OK.serialize(output)?;
    res.serialize(output)?;
    Ok(())
}

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct FSSTAT3resok {
    obj_attributes: nfs::post_op_attr,
    tbytes: nfs::size3,
    fbytes: nfs::size3,
    abytes: nfs::size3,
    tfiles: nfs::size3,
    ffiles: nfs::size3,
    afiles: nfs::size3,
    invarsec: u32,
}
xdr_struct!(
    FSSTAT3resok,
    obj_attributes,
    tbytes,
    fbytes,
    abytes,
    tfiles,
    ffiles,
    afiles,
    invarsec
);

/*
 FSSTAT3res NFSPROC3_FSSTAT(FSSTAT3args) = 18;

     struct FSSTAT3args {
          nfs_fh3   fsroot;
     };

     struct FSSTAT3resok {
          post_op_attr obj_attributes;
          size3        tbytes;
          size3        fbytes;
          size3        abytes;
          size3        tfiles;
          size3        ffiles;
          size3        afiles;
          uint32       invarsec;
     };

     struct FSSTAT3resfail {
          post_op_attr obj_attributes;
     };

     union FSSTAT3res switch (nfsstat3 status) {
     case NFS3_OK:
          FSSTAT3resok   resok;
     default:
          FSSTAT3resfail resfail;
     };

*/

pub async fn nfsproc3_fsstat(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut handle = nfs::nfs_fh3::default();
    handle.deserialize(input)?;
    debug!("nfsproc3_fsstat({:?},{:?}) ", xid, handle);
    let id = context.vfs.fh_to_id(&handle);
    // fail if unable to convert file handle
    if let Err(stat) = id {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let id = id.unwrap();

    let obj_attr = match context.vfs.getattr(id).await {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(_) => nfs::post_op_attr::Void,
    };
    let res = FSSTAT3resok {
        obj_attributes: obj_attr,
        tbytes: 1024 * 1024 * 1024 * 1024,
        fbytes: 1024 * 1024 * 1024 * 1024,
        abytes: 1024 * 1024 * 1024 * 1024,
        tfiles: 1024 * 1024 * 1024,
        ffiles: 1024 * 1024 * 1024,
        afiles: 1024 * 1024 * 1024,
        invarsec: u32::MAX,
    };
    make_success_reply(xid).serialize(output)?;
    nfs::nfsstat3::NFS3_OK.serialize(output)?;
    debug!(" {:?} ---> {:?}", xid, res);
    res.serialize(output)?;
    Ok(())
}

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct READDIRPLUS3args {
    dir: nfs::nfs_fh3,
    cookie: nfs::cookie3,
    cookieverf: nfs::cookieverf3,
    dircount: nfs::count3,
    maxcount: nfs::count3,
}
xdr_struct!(
    READDIRPLUS3args,
    dir,
    cookie,
    cookieverf,
    dircount,
    maxcount
);

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct entry3 {
    fileid: nfs::fileid3,
    name: nfs::filename3,
    cookie: nfs::cookie3,
}
xdr_struct!(entry3, fileid, name, cookie);

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct READDIR3args {
    dir: nfs::nfs_fh3,
    cookie: nfs::cookie3,
    cookieverf: nfs::cookieverf3,
    dircount: nfs::count3,
}
xdr_struct!(READDIR3args, dir, cookie, cookieverf, dircount);

#[allow(non_camel_case_types)]
#[derive(Debug, Default)]
struct entryplus3 {
    fileid: nfs::fileid3,
    name: nfs::filename3,
    cookie: nfs::cookie3,
    name_attributes: nfs::post_op_attr,
    name_handle: nfs::post_op_fh3,
}
xdr_struct!(
    entryplus3,
    fileid,
    name,
    cookie,
    name_attributes,
    name_handle
);
/*

      READDIRPLUS3res NFSPROC3_READDIRPLUS(READDIRPLUS3args) = 17;

      struct READDIRPLUS3args {
           nfs_fh3      dir;
           cookie3      cookie;
           cookieverf3  cookieverf;
           count3       dircount;
           count3       maxcount;
      };


      struct dirlistplus3 {
           entryplus3   *entries;
           bool         eof;
      };

      struct READDIRPLUS3resok {
           post_op_attr dir_attributes;
           cookieverf3  cookieverf;
           dirlistplus3 reply;
      };
   struct READDIRPLUS3resfail {
           post_op_attr dir_attributes;
      };
*/
pub async fn nfsproc3_readdirplus(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut args = READDIRPLUS3args::default();
    args.deserialize(input)?;
    debug!("nfsproc3_readdirplus({:?},{:?}) ", xid, args);

    let dirid = context.vfs.fh_to_id(&args.dir);
    // fail if unable to convert file handle
    if let Err(stat) = dirid {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let dirid = dirid.unwrap();
    let dir_attr_maybe = context.vfs.getattr(dirid).await;

    let dir_attr = match dir_attr_maybe {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(_) => nfs::post_op_attr::Void,
    };

    let dirversion = if let Ok(ref dir_attr) = dir_attr_maybe {
        let cvf_version = (dir_attr.mtime.seconds as u64) << 32 | (dir_attr.mtime.nseconds as u64);
        cvf_version.to_be_bytes()
    } else {
        nfs::cookieverf3::default()
    };
    debug!(" -- Dir attr {:?}", dir_attr);
    debug!(" -- Dir version {:?}", dirversion);
    let has_version = args.cookieverf != nfs::cookieverf3::default();
    // initial call should hve empty cookie verf
    // subsequent calls should have cvf_version as defined above
    // which is based off the mtime.
    //
    // TODO: This is *far* too aggressive. and unnecessary.
    // The client should maintain this correctly typically.
    //
    // The way cookieverf is handled is quite interesting...
    //
    // There are 2 notes in the RFC of interest:
    // 1. If the
    // server detects that the cookie is no longer valid, the
    // server will reject the READDIR request with the status,
    // NFS3ERR_BAD_COOKIE. The client should be careful to
    // avoid holding directory entry cookies across operations
    // that modify the directory contents, such as REMOVE and
    // CREATE.
    //
    // 2. One implementation of the cookie-verifier mechanism might
    //  be for the server to use the modification time of the
    //  directory. This might be overly restrictive, however. A
    //  better approach would be to record the time of the last
    //  directory modification that changed the directory
    //  organization in a way that would make it impossible to
    //  reliably interpret a cookie. Servers in which directory
    //  cookies are always valid are free to use zero as the
    //  verifier always.
    //
    //  Basically, as long as the cookie is "kinda" intepretable,
    //  we should keep accepting it.
    //  On testing, the Mac NFS client pretty much expects that
    //  especially on highly concurrent modifications to the directory.
    //
    //  1. If part way through a directory enumeration we fail with BAD_COOKIE
    //  if the directory contents change, the client listing may fail resulting
    //  in a "no such file or directory" error.
    //  2. if we cache readdir results. i.e. we think of a readdir as two parts a. enumerating everything first b. the
    //     cookie is then used to paginate the enumeration we can run into file time synchronization issues. i.e. while
    //     one listing occurs and another file is touched, the listing may report an outdated file status.
    //
    //     This cache also appears to have to be *quite* long lasting
    //     as the client may hold on to a directory enumerator
    //     with unbounded time.
    //
    //  Basically, if we think about how linux directory listing works
    //  is that you just get an enumerator. There is no mechanic available for
    //  "restarting" a pagination and this enumerator is assumed to be valid
    //  even across directory modifications and should reflect changes
    //  immediately.
    //
    //  The best solution is simply to really completely avoid sending
    //  BAD_COOKIE all together and to ignore the cookie mechanism.
    //
    /*if args.cookieverf != nfs::cookieverf3::default() && args.cookieverf != dirversion {
        info!(" -- Dir version mismatch. Received {:?}", args.cookieverf);
        make_success_reply(xid).serialize(output)?;
        nfs::nfsstat3::NFS3ERR_BAD_COOKIE.serialize(output)?;
        dir_attr.serialize(output)?;
        return Ok(());
    }*/
    let mut fixed = Vec::new();
    dir_attr.serialize(&mut fixed)?;
    dirversion.serialize(&mut fixed)?;
    let max_bytes_allowed =
        (args.maxcount.min(super::host::TRANSFER) as usize).saturating_sub(fixed.len() + 8);
    // args.dircount is bytes of just fileid, name, cookie.
    // This is hard to ballpark, so we just divide it by 16
    let estimated_max_results = args.dircount.min(super::host::TRANSFER) / 16;
    let max_dircount_bytes = args.dircount.min(super::host::TRANSFER) as usize;
    let mut ctr = 0;
    match context
        .vfs
        .readdir(dirid, args.cookie, estimated_max_results as usize)
        .await
    {
        Ok(result) => {
            // we count dir_count seperately as it is just a subset of fields
            let mut accumulated_dircount: usize = 0;
            let mut all_entries_written = true;
            let mut body: Vec<u8> = Vec::new();
            for entry in result.entries {
                let obj_attr = entry.attr;
                let handle = nfs::post_op_fh3::handle(context.vfs.id_to_fh(entry.fileid));

                let entry = entryplus3 {
                    fileid: entry.fileid,
                    name: entry.name,
                    cookie: entry.fileid,
                    name_attributes: nfs::post_op_attr::attributes(obj_attr),
                    name_handle: handle,
                };
                // write the entry into a buffer first
                let mut write_buf: Vec<u8> = Vec::new();
                let mut write_cursor = std::io::Cursor::new(&mut write_buf);
                // true flag for the entryplus3* to mark that this contains an entry
                true.serialize(&mut write_cursor)?;
                entry.serialize(&mut write_cursor)?;
                write_cursor.flush()?;
                let added_dircount = std::mem::size_of::<nfs::fileid3>()                   // fileid
                                    + std::mem::size_of::<u32>() + entry.name.len()  // name
                                    + std::mem::size_of::<nfs::cookie3>(); // cookie
                let added_output_bytes = write_buf.len();
                // check if we can write without hitting the limits
                if body.len() + added_output_bytes <= max_bytes_allowed
                    && accumulated_dircount + added_dircount <= max_dircount_bytes
                {
                    trace!("  -- dirent {:?}", entry);
                    // commit the entry
                    ctr += 1;
                    body.extend_from_slice(&write_buf);
                    accumulated_dircount += added_dircount;
                    trace!(
                        "  -- lengths: {:?} / {:?} {:?} / {:?}",
                        accumulated_dircount,
                        max_dircount_bytes,
                        body.len(),
                        max_bytes_allowed
                    );
                } else {
                    trace!(" -- insufficient space. truncating");
                    all_entries_written = false;
                    break;
                }
            }
            // eof is only valid here if we wrote everything
            let eof = all_entries_written && result.end;
            if ctr == 0 && !eof {
                make_success_reply(xid).serialize(output)?;
                nfs::nfsstat3::NFS3ERR_TOOSMALL.serialize(output)?;
                dir_attr.serialize(output)?;
                return Ok(());
            }
            make_success_reply(xid).serialize(output)?;
            nfs::nfsstat3::NFS3_OK.serialize(output)?;
            output.write_all(&fixed)?;
            output.write_all(&body)?;
            // false flag for the final entryplus* linked list
            false.serialize(output)?;
            debug!("  -- readdir eof {:?}", eof);
            eof.serialize(output)?;
            debug!(
                "readir {}, has_version {},  start at {}, flushing {} entries, complete {}",
                dirid, has_version, args.cookie, ctr, all_entries_written
            );
        }
        Err(stat) => {
            error!("readdir error {:?} --> {:?} ", xid, stat);
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
            dir_attr.serialize(output)?;
        }
    };
    Ok(())
}

pub async fn nfsproc3_readdir(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut args = READDIR3args::default();
    args.deserialize(input)?;
    debug!("nfsproc3_readdirplus({:?},{:?}) ", xid, args);

    let dirid = context.vfs.fh_to_id(&args.dir);
    // fail if unable to convert file handle
    if let Err(stat) = dirid {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        nfs::post_op_attr::Void.serialize(output)?;
        return Ok(());
    }
    let dirid = dirid.unwrap();
    let dir_attr_maybe = context.vfs.getattr(dirid).await;

    let dir_attr = match dir_attr_maybe {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(_) => nfs::post_op_attr::Void,
    };

    let dirversion = if let Ok(ref dir_attr) = dir_attr_maybe {
        let cvf_version = (dir_attr.mtime.seconds as u64) << 32 | (dir_attr.mtime.nseconds as u64);
        cvf_version.to_be_bytes()
    } else {
        nfs::cookieverf3::default()
    };
    debug!(" -- Dir attr {:?}", dir_attr);
    debug!(" -- Dir version {:?}", dirversion);
    let has_version = args.cookieverf != nfs::cookieverf3::default();
    let mut fixed = Vec::new();
    dir_attr.serialize(&mut fixed)?;
    dirversion.serialize(&mut fixed)?;
    let max_bytes_allowed =
        (args.dircount.min(super::host::TRANSFER) as usize).saturating_sub(fixed.len() + 8);
    // args.dircount is bytes of just fileid, name, cookie.
    // This is hard to ballpark, so we just divide it by 16
    let estimated_max_results = args.dircount.min(super::host::TRANSFER) / 16;
    let mut ctr = 0;
    match context
        .vfs
        .readdir_simple(dirid, args.cookie, estimated_max_results as usize)
        .await
    {
        Ok(result) => {
            let mut all_entries_written = true;
            let mut body: Vec<u8> = Vec::new();
            for entry in result.entries {
                let entry = entry3 {
                    fileid: entry.fileid,
                    name: entry.name,
                    cookie: entry.fileid,
                };
                // write the entry into a buffer first
                let mut write_buf: Vec<u8> = Vec::new();
                let mut write_cursor = std::io::Cursor::new(&mut write_buf);
                // true flag for the entryplus3* to mark that this contains an entry
                true.serialize(&mut write_cursor)?;
                entry.serialize(&mut write_cursor)?;
                write_cursor.flush()?;
                // check if we can write without hitting the limits
                if body.len() + write_buf.len() <= max_bytes_allowed {
                    trace!("  -- dirent {:?}", entry);
                    // commit the entry
                    ctr += 1;
                    body.extend_from_slice(&write_buf);
                    trace!("  -- lengths: {:?} / {:?}", body.len(), max_bytes_allowed);
                } else {
                    trace!(" -- insufficient space. truncating");
                    all_entries_written = false;
                    break;
                }
            }
            // eof is only valid here if we wrote everything
            let eof = all_entries_written && result.end;
            if ctr == 0 && !eof {
                make_success_reply(xid).serialize(output)?;
                nfs::nfsstat3::NFS3ERR_TOOSMALL.serialize(output)?;
                dir_attr.serialize(output)?;
                return Ok(());
            }
            make_success_reply(xid).serialize(output)?;
            nfs::nfsstat3::NFS3_OK.serialize(output)?;
            output.write_all(&fixed)?;
            output.write_all(&body)?;
            // false flag for the final entryplus* linked list
            false.serialize(output)?;
            debug!("  -- readdir eof {:?}", eof);
            eof.serialize(output)?;
            debug!(
                "readir {}, has_version {},  start at {}, flushing {} entries, complete {}",
                dirid, has_version, args.cookie, ctr, all_entries_written
            );
        }
        Err(stat) => {
            error!("readdir error {:?} --> {:?} ", xid, stat);
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
            dir_attr.serialize(output)?;
        }
    };
    Ok(())
}

/// The procedures that change the export (SETATTR, WRITE, CREATE, MKDIR,
/// SYMLINK, REMOVE, RMDIR, RENAME): the export is read-only, so each
/// answers NFS3ERR_ROFS and its failure's empty wcc_data, without reading
/// its arguments. RENAME's carries two, the source and target directories'.
pub fn nfsproc3_read_only(xid: u32, dirs: usize, output: &mut impl Write) -> std::io::Result<()> {
    warn!("No write capabilities.");
    make_success_reply(xid).serialize(output)?;
    nfs::nfsstat3::NFS3ERR_ROFS.serialize(output)?;
    for _ in 0..dirs {
        nfs::wcc_data::default().serialize(output)?;
    }
    Ok(())
}

/*

 READLINK3res NFSPROC3_READLINK(READLINK3args) = 5;

 struct READLINK3args {
      nfs_fh3  symlink;
 };

 struct READLINK3resok {
      post_op_attr   symlink_attributes;
      nfspath3       data;
 };

 struct READLINK3resfail {
      post_op_attr   symlink_attributes;
 };

 union READLINK3res switch (nfsstat3 status) {
 case NFS3_OK:
      READLINK3resok   resok;
 default:
      READLINK3resfail resfail;
 };
*/
pub async fn nfsproc3_readlink(
    xid: u32,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut handle = nfs::nfs_fh3::default();
    handle.deserialize(input)?;
    debug!("nfsproc3_readlink({:?},{:?}) ", xid, handle);

    let id = context.vfs.fh_to_id(&handle);
    // fail if unable to convert file handle
    if let Err(stat) = id {
        make_success_reply(xid).serialize(output)?;
        stat.serialize(output)?;
        return Ok(());
    }
    let id = id.unwrap();
    // if the id does not exist, we fail
    let symlink_attr = match context.vfs.getattr(id).await {
        Ok(v) => nfs::post_op_attr::attributes(v),
        Err(stat) => {
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
            nfs::post_op_attr::Void.serialize(output)?;
            return Ok(());
        }
    };
    match context.vfs.readlink(id).await {
        Ok(path) => {
            debug!(" {:?} --> {:?}", xid, path);
            make_success_reply(xid).serialize(output)?;
            nfs::nfsstat3::NFS3_OK.serialize(output)?;
            symlink_attr.serialize(output)?;
            path.serialize(output)?;
        }
        Err(stat) => {
            // failed to read link
            // retry with failure and the post_op_attr
            make_success_reply(xid).serialize(output)?;
            stat.serialize(output)?;
            symlink_attr.serialize(output)?;
        }
    }
    Ok(())
}

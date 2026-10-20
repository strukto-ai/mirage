// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
// this is just a complete enumeration of everything in the RFC
#![allow(dead_code)]
// And its nice to keep the original RFC names and case
#![allow(non_camel_case_types)]

use std::io::{Read, Write};

use byteorder::{ReadBytesExt, WriteBytesExt};
use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::cast::FromPrimitive;

use super::xdr::*;
// Transcribed from RFC 1057

#[allow(non_camel_case_types)]
#[allow(clippy::upper_case_acronyms)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
#[repr(u32)]
/// This is only defined as the discriminant for rpc_body and should not
/// be used directly
pub enum _msg_type {
    CALL = 0,
    REPLY = 1,
}
xdr_enum_serde!(_msg_type);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
#[repr(u32)]
/// This is only defined as the discriminant for reply_body and should not
/// be used directly
pub enum _reply_stat {
    MSG_ACCEPTED = 0,
    MSG_DENIED = 1,
}
xdr_enum_serde!(_reply_stat);

#[allow(non_camel_case_types)]
#[allow(clippy::upper_case_acronyms)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
#[repr(u32)]
/// This is only defined as the discriminant for accept_body and should not
/// be used directly
pub enum _accept_stat {
    /// RPC executed successfully
    SUCCESS = 0,
    /// remote hasn't exported program
    PROG_UNAVAIL = 1,
    /// remote can't support version #
    PROG_MISMATCH = 2,
    /// program can't support procedure
    PROC_UNAVAIL = 3,
    /// procedure can't decode params
    GARBAGE_ARGS = 4,
}
xdr_enum_serde!(_accept_stat);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
#[repr(u32)]
/// This is only defined as the discriminant for reject_body and should not
/// be used directly
pub enum _reject_stat {
    /// RPC version number != 2
    RPC_MISMATCH = 0,
    /// remote can't authenticate caller
    AUTH_ERROR = 1,
}
xdr_enum_serde!(_reject_stat);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default, FromPrimitive, ToPrimitive)]
#[repr(u32)]
///   Why authentication failed
pub enum auth_stat {
    /// bad credentials (seal broken)
    #[default]
    AUTH_BADCRED = 1,
    /// client must begin new session
    AUTH_REJECTEDCRED = 2,
    /// bad verifier (seal broken)
    AUTH_BADVERF = 3,
    /// verifier expired or replayed
    AUTH_REJECTEDVERF = 4,
    /// rejected for security reasons
    AUTH_TOOWEAK = 5,
}
xdr_enum_serde!(auth_stat);

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
#[repr(u32)]
#[non_exhaustive]
pub enum auth_flavor {
    AUTH_NULL = 0,
    AUTH_UNIX = 1,
    AUTH_SHORT = 2,
    AUTH_DES = 3, /* and more to be defined */
}
xdr_enum_serde!(auth_flavor);

#[allow(non_camel_case_types)]
#[derive(Clone, Debug, Default)]
pub struct auth_unix {
    stamp: u32,
    machinename: Vec<u8>,
    uid: u32,
    gid: u32,
    gids: Vec<u32>,
}
xdr_struct!(auth_unix, stamp, machinename, uid, gid, gids);

///Provisions for authentication of caller to service and vice-versa are
///provided as a part of the RPC protocol.  The call message has two
///authentication fields, the credentials and verifier.  The reply
///message has one authentication field, the response verifier.  The RPC
///protocol specification defines all three fields to be the following
///opaque type (in the eXternal Data Representation (XDR) language [9]):
///
///   In other words, any "opaque_auth" structure is an "auth_flavor"
///enumeration followed by bytes which are opaque to (uninterpreted by)
///the RPC protocol implementation.
///
///The interpretation and semantics of the data contained within the
///authentication fields is specified by individual, independent
///authentication protocol specifications.  (Section 9 defines the
///various authentication protocols.)
///
///If authentication parameters were rejected, the reply message
///contains information stating why they were rejected.
#[allow(non_camel_case_types)]
#[derive(Clone, Debug)]
pub struct opaque_auth {
    pub flavor: auth_flavor,
    pub body: Vec<u8>,
}
xdr_struct!(opaque_auth, flavor, body);
impl Default for opaque_auth {
    fn default() -> opaque_auth {
        opaque_auth {
            flavor: auth_flavor::AUTH_NULL,
            body: Vec::new(),
        }
    }
}

#[allow(non_camel_case_types)]
#[derive(Clone, Debug, Default)]
///All messages start with a transaction identifier, xid, followed by a
///two-armed discriminated union.  The union's discriminant is a
///msg_type which switches to one of the two types of the message.  The
///xid of a REPLY message always matches that of the initiating CALL
///message.  NB: The xid field is only used for clients matching reply
///messages with call messages or for servers detecting retransmissions;
///the service side cannot treat this id as any type of sequence number.
pub struct rpc_msg {
    pub xid: u32,
    pub body: rpc_body,
}
xdr_struct!(rpc_msg, xid, body);

#[allow(non_camel_case_types)]
#[allow(clippy::upper_case_acronyms)]
#[derive(Clone, Debug)]
#[repr(u32)]
/// Discriminant is msg_type
pub enum rpc_body {
    CALL(call_body),
    REPLY(reply_body),
}

impl Default for rpc_body {
    fn default() -> rpc_body {
        rpc_body::CALL(call_body::default())
    }
}
impl XDR for rpc_body {
    fn serialize<R: Write>(&self, dest: &mut R) -> std::io::Result<()> {
        match self {
            rpc_body::CALL(v) => {
                0_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
            rpc_body::REPLY(v) => {
                1_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
        }
        Ok(())
    }
    fn deserialize<R: Read>(&mut self, src: &mut R) -> std::io::Result<()> {
        let mut c: u32 = 0;
        c.deserialize(src)?;
        if c == 0 {
            let mut r = call_body::default();
            r.deserialize(src)?;
            *self = rpc_body::CALL(r);
        } else if c == 1 {
            let mut r = reply_body::default();
            r.deserialize(src)?;
            *self = rpc_body::REPLY(r);
        }
        Ok(())
    }
}

///The RPC call message has three unsigned integer fields -- remote
///program number, remote program version number, and remote procedure
///number -- which uniquely identify the procedure to be called.
///Program numbers are administered by some central authority (like
///Sun).  Once implementors have a program number, they can implement
///their remote program; the first implementation would most likely have
///the version number 1.  Because most new protocols evolve, a version
///field of the call message identifies which version of the protocol
///the caller is using.  Version numbers make speaking old and new
///protocols through the same server process possible.
///
///The procedure number identifies the procedure to be called.  These
///numbers are documented in the specific program's protocol
///specification.  For example, a file service's protocol specification
///may state that its procedure number 5 is "read" and procedure number
///12 is "write".
///
///Just as remote program protocols may change over several versions,
///the actual RPC message protocol could also change.  Therefore, the
///call message also has in it the RPC version number, which is always
///equal to two for the version of RPC described here.
///
///The reply message to a request message has enough information to
///distinguish the following error conditions:
///
///(1) The remote implementation of RPC does not speak protocol version
///  2. The lowest and highest supported RPC version numbers are returned.
///
///(2) The remote program is not available on the remote system.
///
///(3) The remote program does not support the requested version number.
///The lowest and highest supported remote program version numbers are
///returned.
///
///(4) The requested procedure number does not exist.  (This is usually
///a client side protocol or programming error.)
///
///(5) The parameters to the remote procedure appear to be garbage from
///the server's point of view.  (Again, this is usually caused by a
///disagreement about the protocol between client and service.)
///
///   In version 2 of the RPC protocol specification, rpcvers must be equal
///to 2.  The fields prog, vers, and proc specify the remote program,
///its version number, and the procedure within the remote program to be
///called.  After these fields are two authentication parameters:  cred
///(authentication credentials) and verf (authentication verifier).  The
///two authentication parameters are followed by the parameters to the
///remote procedure, which are specified by the specific program
///protocol.
#[allow(non_camel_case_types)]
#[derive(Clone, Debug, Default)]
pub struct call_body {
    /// Must be = 2
    pub rpcvers: u32,
    pub prog: u32,
    pub vers: u32,
    pub proc: u32,
    pub cred: opaque_auth,
    pub verf: opaque_auth,
    /* procedure specific parameters start here */
}

xdr_struct!(call_body, rpcvers, prog, vers, proc, cred, verf);

#[allow(non_camel_case_types)]
#[derive(Clone, Debug)]
#[repr(u32)]
pub enum reply_body {
    MSG_ACCEPTED(accepted_reply),
    MSG_DENIED(rejected_reply),
}

impl Default for reply_body {
    fn default() -> reply_body {
        reply_body::MSG_ACCEPTED(accepted_reply::default())
    }
}

impl XDR for reply_body {
    fn serialize<R: Write>(&self, dest: &mut R) -> std::io::Result<()> {
        match self {
            reply_body::MSG_ACCEPTED(v) => {
                0_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
            reply_body::MSG_DENIED(v) => {
                1_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
        }
        Ok(())
    }
    fn deserialize<R: Read>(&mut self, src: &mut R) -> std::io::Result<()> {
        let mut c: u32 = 0;
        c.deserialize(src)?;
        if c == 0 {
            let mut r = accepted_reply::default();
            r.deserialize(src)?;
            *self = reply_body::MSG_ACCEPTED(r);
        } else if c == 1 {
            let mut r = rejected_reply::default();
            r.deserialize(src)?;
            *self = reply_body::MSG_DENIED(r);
        }
        Ok(())
    }
}

#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
#[repr(C)]
pub struct mismatch_info {
    pub low: u32,
    pub high: u32,
}
xdr_struct!(mismatch_info, low, high);

///Reply to an RPC call that was accepted by the server:
///There could be an error even though the call was accepted.  The first
///field is an authentication verifier that the server generates in
///order to validate itself to the client.  It is followed by a union
///whose discriminant is an enum accept_stat.  The SUCCESS arm of the
///union is protocol specific.  The PROG_UNAVAIL, PROC_UNAVAIL, and
///GARBAGE_ARGS arms of the union are void.  The PROG_MISMATCH arm
///specifies the lowest and highest version numbers of the remote
///program supported by the server.
/// Discriminant is reply_stat
#[allow(non_camel_case_types)]
#[derive(Clone, Debug, Default)]
pub struct accepted_reply {
    pub verf: opaque_auth,
    pub reply_data: accept_body,
}
xdr_struct!(accepted_reply, verf, reply_data);

#[allow(non_camel_case_types)]
#[allow(clippy::upper_case_acronyms)]
#[derive(Copy, Clone, Debug, Default)]
#[repr(u32)]
/// Discriminant is accept_stat
pub enum accept_body {
    #[default]
    SUCCESS,
    PROG_UNAVAIL,
    /// remote can't support version #
    PROG_MISMATCH(mismatch_info),
    PROC_UNAVAIL,
    /// procedure can't decode params
    GARBAGE_ARGS,
}
impl XDR for accept_body {
    fn serialize<R: Write>(&self, dest: &mut R) -> std::io::Result<()> {
        match self {
            accept_body::SUCCESS => {
                0_u32.serialize(dest)?;
            }
            accept_body::PROG_UNAVAIL => {
                1_u32.serialize(dest)?;
            }
            accept_body::PROG_MISMATCH(v) => {
                2_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
            accept_body::PROC_UNAVAIL => {
                3_u32.serialize(dest)?;
            }
            accept_body::GARBAGE_ARGS => {
                4_u32.serialize(dest)?;
            }
        }
        Ok(())
    }
    fn deserialize<R: Read>(&mut self, src: &mut R) -> std::io::Result<()> {
        let mut c: u32 = 0;
        c.deserialize(src)?;
        if c == 0 {
            *self = accept_body::SUCCESS;
        } else if c == 1 {
            *self = accept_body::PROG_UNAVAIL;
        } else if c == 2 {
            let mut r = mismatch_info::default();
            r.deserialize(src)?;
            *self = accept_body::PROG_MISMATCH(r);
        } else if c == 3 {
            *self = accept_body::PROC_UNAVAIL;
        } else {
            *self = accept_body::GARBAGE_ARGS;
        }
        Ok(())
    }
}

#[allow(non_camel_case_types)]
#[derive(Clone, Debug)]
#[repr(u32)]
///Reply to an RPC call that was rejected by the server:
///
///The call can be rejected for two reasons: either the server is not
///running a compatible version of the RPC protocol (RPC_MISMATCH), or
///the server refuses to authenticate the caller (AUTH_ERROR). In case
///of an RPC version mismatch, the server returns the lowest and highest
///supported RPC version numbers.  In case of refused authentication,
///failure status is returned.
/// Discriminant is reject_stat
pub enum rejected_reply {
    RPC_MISMATCH(mismatch_info),
    AUTH_ERROR(auth_stat),
}

impl Default for rejected_reply {
    fn default() -> rejected_reply {
        rejected_reply::RPC_MISMATCH(mismatch_info::default())
    }
}

impl XDR for rejected_reply {
    fn serialize<R: Write>(&self, dest: &mut R) -> std::io::Result<()> {
        match self {
            rejected_reply::RPC_MISMATCH(v) => {
                0_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
            rejected_reply::AUTH_ERROR(v) => {
                1_u32.serialize(dest)?;
                v.serialize(dest)?;
            }
        }
        Ok(())
    }
    fn deserialize<R: Read>(&mut self, src: &mut R) -> std::io::Result<()> {
        let mut c: u32 = 0;
        c.deserialize(src)?;
        if c == 0 {
            let mut r = mismatch_info::default();
            r.deserialize(src)?;
            *self = rejected_reply::RPC_MISMATCH(r);
        } else if c == 1 {
            let mut r = auth_stat::default();
            r.deserialize(src)?;
            *self = rejected_reply::AUTH_ERROR(r);
        }
        Ok(())
    }
}

pub fn proc_unavail_reply_message(xid: u32) -> rpc_msg {
    let reply = reply_body::MSG_ACCEPTED(accepted_reply {
        verf: opaque_auth::default(),
        reply_data: accept_body::PROC_UNAVAIL,
    });
    rpc_msg {
        xid,
        body: rpc_body::REPLY(reply),
    }
}
pub fn prog_unavail_reply_message(xid: u32) -> rpc_msg {
    let reply = reply_body::MSG_ACCEPTED(accepted_reply {
        verf: opaque_auth::default(),
        reply_data: accept_body::PROG_UNAVAIL,
    });
    rpc_msg {
        xid,
        body: rpc_body::REPLY(reply),
    }
}
pub fn prog_mismatch_reply_message(xid: u32, accepted_ver: u32) -> rpc_msg {
    let reply = reply_body::MSG_ACCEPTED(accepted_reply {
        verf: opaque_auth::default(),
        reply_data: accept_body::PROG_MISMATCH(mismatch_info {
            low: accepted_ver,
            high: accepted_ver,
        }),
    });
    rpc_msg {
        xid,
        body: rpc_body::REPLY(reply),
    }
}
pub fn garbage_args_reply_message(xid: u32) -> rpc_msg {
    let reply = reply_body::MSG_ACCEPTED(accepted_reply {
        verf: opaque_auth::default(),
        reply_data: accept_body::GARBAGE_ARGS,
    });
    rpc_msg {
        xid,
        body: rpc_body::REPLY(reply),
    }
}

pub fn rpc_vers_mismatch(xid: u32) -> rpc_msg {
    let reply = reply_body::MSG_DENIED(rejected_reply::RPC_MISMATCH(mismatch_info::default()));
    rpc_msg {
        xid,
        body: rpc_body::REPLY(reply),
    }
}

pub fn make_success_reply(xid: u32) -> rpc_msg {
    let reply = reply_body::MSG_ACCEPTED(accepted_reply {
        verf: opaque_auth::default(),
        reply_data: accept_body::SUCCESS,
    });
    rpc_msg {
        xid,
        body: rpc_body::REPLY(reply),
    }
}

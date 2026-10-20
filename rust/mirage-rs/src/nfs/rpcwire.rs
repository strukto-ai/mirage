// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
use std::io::{Read, Write};

use super::context::RPCContext;
use super::rpc::*;
use super::xdr::*;
use super::{mount, mount_handlers, nfs, nfs_handlers, portmap, portmap_handlers};

// Information from RFC 5531
// https://datatracker.ietf.org/doc/html/rfc5531

const NFS_ACL_PROGRAM: u32 = 100227;
const NFS_ID_MAP_PROGRAM: u32 = 100270;
const NFS_METADATA_PROGRAM: u32 = 200024;

pub async fn handle_rpc(
    input: &mut impl Read,
    output: &mut impl Write,
    context: RPCContext,
) -> std::io::Result<bool> {
    let mut recv = rpc_msg::default();
    recv.deserialize(input)?;
    let xid = recv.xid;
    if let rpc_body::CALL(call) = recv.body {
        if call.rpcvers != 2 {
            warn!("Invalid RPC version {} != 2", call.rpcvers);
            rpc_vers_mismatch(xid).serialize(output)?;
            return Ok(true);
        }

        if context
            .transaction_tracker
            .is_retransmission(xid, &context.client_addr)
        {
            // This is a retransmission
            // Drop the message and return
            debug!(
                "Retransmission detected, xid: {}, client_addr: {}, call: {:?}",
                xid, context.client_addr, call
            );
            return Ok(false);
        }

        let res = {
            if call.prog == nfs::PROGRAM {
                nfs_handlers::handle_nfs(xid, call, input, output, &context).await
            } else if call.prog == portmap::PROGRAM {
                portmap_handlers::handle_portmap(xid, call, input, output, &context)
            } else if call.prog == mount::PROGRAM {
                mount_handlers::handle_mount(xid, call, input, output, &context).await
            } else if call.prog == NFS_ACL_PROGRAM
                || call.prog == NFS_ID_MAP_PROGRAM
                || call.prog == NFS_METADATA_PROGRAM
            {
                trace!("ignoring NFS_ACL packet");
                prog_unavail_reply_message(xid).serialize(output)?;
                Ok(())
            } else {
                warn!(
                    "Unknown RPC Program number {} != {}",
                    call.prog,
                    nfs::PROGRAM
                );
                prog_unavail_reply_message(xid).serialize(output)?;
                Ok(())
            }
        }
        .map(|_| true);
        context
            .transaction_tracker
            .mark_processed(xid, &context.client_addr);
        res
    } else {
        error!("Unexpectedly received a Reply instead of a Call");
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Bad RPC Call format",
        ))
    }
}

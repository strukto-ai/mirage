// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
use std::io::{Read, Write};

use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::cast::FromPrimitive;

use super::context::RPCContext;
use super::portmap;
use super::rpc::*;
use super::xdr::*;

/*
 From RFC 1057 Appendix A

 program PMAP_PROG {
    version PMAP_VERS {
       void PMAPPROC_NULL(void)         = 0;
       bool PMAPPROC_SET(mapping)       = 1;
       bool PMAPPROC_UNSET(mapping)     = 2;
       unsigned int PMAPPROC_GETPORT(mapping)   = 3;
       pmaplist PMAPPROC_DUMP(void)         = 4;
       call_result PMAPPROC_CALLIT(call_args)  = 5;
    } = 2;
 } = 100000;
*/

#[allow(non_camel_case_types)]
#[allow(clippy::upper_case_acronyms)]
#[derive(Copy, Clone, Debug, FromPrimitive, ToPrimitive)]
enum PortmapProgram {
    PMAPPROC_NULL = 0,
    PMAPPROC_SET = 1,
    PMAPPROC_UNSET = 2,
    PMAPPROC_GETPORT = 3,
    PMAPPROC_DUMP = 4,
    PMAPPROC_CALLIT = 5,
    INVALID,
}

pub fn handle_portmap(
    xid: u32,
    call: call_body,
    input: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    if call.vers != portmap::VERSION {
        error!(
            "Invalid Portmap Version number {} != {}",
            call.vers,
            portmap::VERSION
        );
        prog_mismatch_reply_message(xid, portmap::VERSION).serialize(output)?;
        return Ok(());
    }
    let prog = PortmapProgram::from_u32(call.proc).unwrap_or(PortmapProgram::INVALID);

    match prog {
        PortmapProgram::PMAPPROC_NULL => pmapproc_null(xid, input, output)?,
        PortmapProgram::PMAPPROC_GETPORT => pmapproc_getport(xid, input, output, context)?,
        _ => {
            proc_unavail_reply_message(xid).serialize(output)?;
        }
    }
    Ok(())
}

pub fn pmapproc_null(xid: u32, _: &mut impl Read, output: &mut impl Write) -> std::io::Result<()> {
    debug!("pmapproc_null({:?}) ", xid);
    // build an RPC reply
    let msg = make_success_reply(xid);
    debug!("\t{:?} --> {:?}", xid, msg);
    msg.serialize(output)?;
    Ok(())
}

/*
 * We fake a portmapper here. And always direct back to the same host port
 */
pub fn pmapproc_getport(
    xid: u32,
    read: &mut impl Read,
    output: &mut impl Write,
    context: &RPCContext,
) -> std::io::Result<()> {
    let mut mapping = portmap::mapping::default();
    mapping.deserialize(read)?;
    debug!("pmapproc_getport({:?}, {:?}) ", xid, mapping);
    make_success_reply(xid).serialize(output)?;
    let port = context.local_port as u32;
    debug!("\t{:?} --> {:?}", xid, port);
    port.serialize(output)?;
    Ok(())
}

// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
// this is just a complete enumeration of everything in the RFC
#![allow(dead_code)]
// And its nice to keep the original RFC names and case
#![allow(non_camel_case_types)]

use std::io::{Read, Write};

use super::xdr::*;
// Transcribed from RFC 1057 Appendix A

/// Device Number information. Ex: Major / Minor device
#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, Default)]
#[repr(C)]
pub struct mapping {
    pub prog: u32,
    pub vers: u32,
    pub prot: u32,
    pub port: u32,
}
xdr_struct!(mapping, prog, vers, prot, port);
pub const IPPROTO_TCP: u32 = 6; /* protocol number for TCP/IP */
pub const IPPROTO_UDP: u32 = 17; /* protocol number for UDP/IP */
pub const PROGRAM: u32 = 100000;
pub const VERSION: u32 = 2;

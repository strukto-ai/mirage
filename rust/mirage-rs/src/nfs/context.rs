// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
use std::sync::Arc;

use super::host::HostFs;
use super::transaction_tracker::TransactionTracker;

#[derive(Clone)]
pub struct RPCContext {
    pub local_port: u16,
    pub client_addr: String,
    pub vfs: Arc<HostFs>,
    pub export_name: Arc<String>,
    pub transaction_tracker: Arc<TransactionTracker>,
}

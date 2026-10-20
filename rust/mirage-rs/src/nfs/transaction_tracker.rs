// Adapted from nfsserve 0.11.0.
// https://github.com/huggingface/nfsserve/tree/af4f1176dd709847f3dda4f1a7cd093edaadde63/src
// Licensed under BSD-3-Clause. See licenses/third_party/nfsserve.txt.
use std::collections::{HashSet, VecDeque};
use std::sync::{Mutex, PoisonError};

/// How many finished calls are remembered: a retransmission of one of
/// them is dropped. Counted rather than timed, as the host owns the clock.
const RETAINED: usize = 4096;

/// `TransactionTracker` tracks the state of transactions to detect retransmissions.
#[derive(Default)]
pub struct TransactionTracker {
    transactions: Mutex<Transactions>,
}

#[derive(Default)]
struct Transactions {
    in_progress: HashSet<(u32, String)>,
    completed: HashSet<(u32, String)>,
    order: VecDeque<(u32, String)>,
}

impl TransactionTracker {
    /// Checks if the transaction is a retransmission.
    /// If it's a new transaction, it is marked as `InProgress`.
    ///
    /// Returns `true` if the transaction is a retransmission, `false` otherwise.
    pub fn is_retransmission(&self, xid: u32, client_addr: &str) -> bool {
        let key = (xid, client_addr.to_string());
        let mut transactions = self
            .transactions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if transactions.in_progress.contains(&key) || transactions.completed.contains(&key) {
            return true;
        }
        transactions.in_progress.insert(key);
        false
    }

    /// Marks the transaction as processed.
    pub fn mark_processed(&self, xid: u32, client_addr: &str) {
        let key = (xid, client_addr.to_string());
        let mut transactions = self
            .transactions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !transactions.in_progress.remove(&key) {
            return;
        }
        transactions.completed.insert(key.clone());
        transactions.order.push_back(key);
        if transactions.order.len() > RETAINED {
            if let Some(oldest) = transactions.order.pop_front() {
                transactions.completed.remove(&oldest);
            }
        }
    }
}

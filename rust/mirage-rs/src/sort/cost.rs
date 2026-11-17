/// A record's bytes that count as one more comparison's work, about what a
/// keyed comparison of two short records costs.
pub(super) const COST_BYTES: usize = 256;

pub(super) fn weight(record: &[u8]) -> usize {
    1 + record.len() / COST_BYTES
}

/// What comparing two records may cost: each can be read to its end.
pub(super) fn cost(a: &[u8], b: &[u8]) -> usize {
    weight(a) + weight(b) - 1
}

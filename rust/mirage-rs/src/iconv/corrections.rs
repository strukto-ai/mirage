/// Where a charset's standard differs from the WHATWG decoder that seeds
/// it; scripts/gen_iconv_multibyte.py derives them from the standards'
/// published tables.
pub(crate) struct Corrections {
    /// A sequence, read big-endian, and the standard's code point.
    pub(crate) remapped: &'static [(u32, u32)],
    /// The first and last sequence of a range the standard leaves unmapped.
    pub(crate) excluded: &'static [(u32, u32)],
    /// Code points glibc encodes to a sequence that decodes to another one.
    pub(crate) one_way: &'static [(u32, u32)],
}

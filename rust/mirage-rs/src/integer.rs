/// A signed magnitude rendered into caller-owned storage, including i64::MIN.
pub(crate) fn decimal_bytes(mut n: u64, negative: bool, text: &mut [u8; 21]) -> &[u8] {
    let mut at = text.len();
    loop {
        at -= 1;
        text[at] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    if negative {
        at -= 1;
        text[at] = b'-';
    }
    &text[at..]
}

pub(crate) fn decimal(n: u64, negative: bool, width: usize, out: &mut Vec<u8>) {
    let mut text = [0; 21];
    let digits = decimal_bytes(n, negative, &mut text);
    out.resize(out.len() + width.saturating_sub(digits.len()), b' ');
    out.extend_from_slice(digits);
}

/// Fixed-width octal or hexadecimal digits, zero-filled.
pub(crate) fn digits(n: u64, base: u64, count: usize, out: &mut Vec<u8>) {
    let bits = base.trailing_zeros() as usize;
    for place in (0..count).rev() {
        let digit = n.checked_shr((place * bits) as u32).unwrap_or(0) & (base - 1);
        out.push(b"0123456789abcdef"[digit as usize]);
    }
}

pub(crate) fn octal(byte: u8, out: &mut Vec<u8>) {
    out.push(if byte >= 64 { b'0' + (byte >> 6) } else { b' ' });
    out.push(if byte >= 8 {
        b'0' + ((byte >> 3) & 7)
    } else {
        b' '
    });
    out.push(b'0' + (byte & 7));
}

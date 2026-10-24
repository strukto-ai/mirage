use crate::printf::number::Rendered;

use super::value::{FloatSpec, MAX_LEN, Value, decimal, pad, render_int, to_int};
use super::vm::no_memory;

fn digits(fmt: &[u8], from: usize) -> usize {
    fmt[from..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count()
}

/// Format values as awk's printf and sprintf do. A format with more
/// conversions than arguments is fatal, as in gawk, mawk and onetrueawk;
/// an unknown conversion is copied out as written.
pub(super) fn sprintf(fmt: &[u8], args: &[Value], convfmt: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
    let mut out = Vec::with_capacity(fmt.len());
    let mut pending = args.iter();
    let mut take = || {
        pending.next().ok_or_else(|| {
            [
                b"awk: not enough arguments to satisfy format string '".as_slice(),
                fmt,
                b"'",
            ]
            .concat()
        })
    };
    let mut idx = 0;
    while idx < fmt.len() {
        let Some(at) = memchr::memchr(b'%', &fmt[idx..]) else {
            out.extend_from_slice(&fmt[idx..]);
            break;
        };
        out.extend_from_slice(&fmt[idx..idx + at]);
        idx += at;
        if fmt.get(idx + 1) == Some(&b'%') {
            out.push(b'%');
            idx += 2;
            continue;
        }
        let mut at = idx + 1;
        let flag_len = fmt[at..]
            .iter()
            .take_while(|c| b"-+ #0".contains(c))
            .count();
        let mut flags = fmt[at..at + flag_len].to_vec();
        at += flag_len;
        let width_star = fmt.get(at) == Some(&b'*');
        let width_len = if width_star { 1 } else { digits(fmt, at) };
        let mut width = fmt[at..at + width_len].to_vec();
        at += width_len;
        let mut precision = Vec::new();
        let mut precision_star = false;
        if fmt.get(at) == Some(&b'.') {
            precision_star = fmt.get(at + 1) == Some(&b'*');
            let len = if precision_star {
                1
            } else {
                digits(fmt, at + 1)
            };
            precision = fmt[at..at + 1 + len].to_vec();
            at += 1 + len;
        }
        idx = at + 1;
        let Some(&conv) = fmt.get(at) else {
            out.push(b'%');
            break;
        };
        if width_star {
            let star = to_int(take()?.num());
            if star < 0 {
                flags.push(b'-');
            }
            width = star.unsigned_abs().to_string().into_bytes();
        }
        if precision_star {
            let star = to_int(take()?.num());
            precision = if star >= 0 {
                format!(".{star}").into_bytes()
            } else {
                Vec::new()
            };
        }
        if !b"csdiouxXeEfFgGaA".contains(&conv) {
            out.push(b'%');
            out.extend_from_slice(&flags);
            out.extend_from_slice(&width);
            out.extend_from_slice(&precision);
            out.push(conv);
            continue;
        }
        let arg = take()?;
        let width = decimal(&width);
        let precision = (!precision.is_empty()).then(|| decimal(&precision[1..]));
        if width > MAX_LEN || (conv != b's' && precision.is_some_and(|p| p > MAX_LEN)) {
            return Err(no_memory());
        }
        let rendered = match conv {
            b'c' | b's' => {
                let mut body = if conv == b'c' {
                    match arg {
                        Value::Num(n) => vec![(to_int(*n) & 0xFF) as u8],
                        other => other
                            .text(convfmt)
                            .first()
                            .map(|&c| vec![c])
                            .unwrap_or_default(),
                    }
                } else {
                    arg.text(convfmt).into_owned()
                };
                if let (b's', Some(precision)) = (conv, precision) {
                    body.truncate(precision);
                }
                Rendered {
                    prefix: Vec::new(),
                    body,
                    zero_tail: 0,
                    suffix: Vec::new(),
                    allow_zero: false,
                }
            }
            b'd' | b'i' | b'o' | b'u' | b'x' | b'X' => {
                render_int(arg.num(), conv, &flags, precision)
            }
            _ => FloatSpec {
                flags: &flags,
                width,
                precision,
                conv: match conv {
                    b'a' => b'g',
                    b'A' => b'G',
                    other => other,
                },
            }
            .rendered(arg.num()),
        };
        let len = usize::try_from(rendered.byte_len()).unwrap_or(usize::MAX);
        if out.len().saturating_add(len.max(width)) > MAX_LEN {
            return Err(no_memory());
        }
        pad(rendered, &flags, width, &mut out);
    }
    Ok(out)
}

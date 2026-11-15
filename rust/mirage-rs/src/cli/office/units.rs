//! Numbers and lengths as OfficeCLI's .NET formatting writes them: custom
//! formats such as `0.##` rounded half away from zero from a 15-digit
//! decimal form, `F1` from the exact value, banker's rounding where
//! `Math.Round` does it, and lengths in the first of cm, pt and in that
//! holds them exactly.

/// `x` written out without an exponent.
fn plain(x: &str) -> String {
    let Some((mantissa, exp)) = x.split_once('e') else {
        return x.to_string();
    };
    let exp: i32 = exp.parse().unwrap_or(0);
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{int}{frac}");
    if exp >= 0 {
        let whole_len = int.len() as i32 + exp;
        let mut whole = digits.clone();
        while (whole.len() as i32) < whole_len {
            whole.push('0');
        }
        let (a, b) = whole.split_at(whole_len as usize);
        if b.is_empty() {
            a.to_string()
        } else {
            format!("{a}.{b}")
        }
    } else {
        let zeros = (-exp - int.len() as i32).max(0) as usize;
        format!("0.{}{digits}", "0".repeat(zeros))
    }
}

/// `|n|` to 15 significant digits, as .NET's `R`-free custom formats read a double.
fn fifteen(n: f64) -> String {
    if n == 0.0 {
        return "0".to_string();
    }
    let s = format!("{:.14e}", n.abs());
    plain(&s)
}

/// `n` to at most `places` decimals, trailing zeros dropped, as .NET's
/// `0.##` writes it.
pub(super) fn fmt(n: f64, places: usize) -> String {
    if !n.is_finite() {
        return if n.is_nan() {
            "NaN".to_string()
        } else if n > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    let text = fifteen(n);
    let (whole, frac) = text.split_once('.').unwrap_or((&text, ""));
    let frac_digits: Vec<char> = frac.chars().collect();
    let mut kept: String = frac_digits.iter().take(places).collect();
    while kept.len() < places {
        kept.push('0');
    }
    let mut digits: Vec<u8> = format!("{whole}{kept}").bytes().map(|b| b - b'0').collect();
    if frac_digits.get(places).is_some_and(|c| *c >= '5') {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let s: String = digits.iter().map(|d| (b'0' + d) as char).collect();
    let split = s.len() - places;
    let int_part = s[..split].trim_start_matches('0');
    let int_part = if int_part.is_empty() { "0" } else { int_part };
    let frac_part = s[split..].trim_end_matches('0');
    let out = if frac_part.is_empty() {
        int_part.to_string()
    } else {
        format!("{int_part}.{frac_part}")
    };
    if n < 0.0 && out != "0" {
        format!("-{out}")
    } else {
        out
    }
}

/// `0.##`, the format OfficeCLI uses most.
pub(super) fn f2(n: f64) -> String {
    fmt(n, 2)
}

/// `n` with exactly `places` decimals (.NET's `F1`, `F2`).
pub(super) fn fixed(n: f64, places: usize) -> String {
    let s = format!("{n:.places$}");
    if s.starts_with('-') && s[1..].chars().all(|c| c == '0' || c == '.') {
        s[1..].to_string()
    } else {
        s
    }
}

/// `x` rounded half to even, as .NET's `Math.Round` does by default.
pub(super) fn round_even(x: f64) -> f64 {
    let r = x.round();
    if (r - x).abs() == 0.5 && r % 2.0 != 0.0 {
        r - x.signum()
    } else {
        r
    }
}

pub(super) const EMU_PER_CM: f64 = 360_000.0;
pub(super) const EMU_PER_PT: f64 = 12_700.0;
pub(super) const EMU_PER_IN: f64 = 914_400.0;

/// `emu` in a unit when two decimals hold it exactly.
fn emu_in(emu: i64, per: f64, suffix: &str) -> Option<String> {
    let s = f2(emu as f64 / per);
    if s == "0" || s == "-0" {
        return None;
    }
    let back: f64 = s.parse().ok()?;
    (round_even(back * per) as i64 == emu).then(|| format!("{s}{suffix}"))
}

/// An EMU length in the first of cm, pt, in that holds it exactly.
pub(super) fn format_emu(emu: i64) -> String {
    if emu == 0 {
        return "0cm".to_string();
    }
    emu_in(emu, EMU_PER_CM, "cm")
        .or_else(|| emu_in(emu, EMU_PER_PT, "pt"))
        .or_else(|| emu_in(emu, EMU_PER_IN, "in"))
        .unwrap_or_else(|| format!("{emu}emu"))
}

/// Two EMU lengths in one unit, pt first, when one unit holds both.
pub(super) fn format_emu_paired(a: i64, b: i64) -> (String, String) {
    for (per, suffix) in [(EMU_PER_PT, "pt"), (EMU_PER_CM, "cm"), (EMU_PER_IN, "in")] {
        if let (Some(x), Some(y)) = (emu_in(a, per, suffix), emu_in(b, per, suffix)) {
            return (x, y);
        }
    }
    (format_emu(a), format_emu(b))
}

/// An EMU length as `format_emu` writes it, else to two decimals of a cm.
pub(super) fn format_emu_lossy(emu: i64) -> String {
    if emu == 0 {
        return "0cm".to_string();
    }
    emu_in(emu, EMU_PER_CM, "cm")
        .or_else(|| emu_in(emu, EMU_PER_PT, "pt"))
        .or_else(|| emu_in(emu, EMU_PER_IN, "in"))
        .unwrap_or_else(|| format!("{}cm", f2(emu as f64 / EMU_PER_CM)))
}

/// A line width in points.
pub(super) fn format_line_width(emu: i64) -> String {
    if emu == 0 {
        return "0pt".to_string();
    }
    let s = f2(emu as f64 / EMU_PER_PT);
    if s == "0" || s == "-0" {
        format!("{emu}emu")
    } else {
        format!("{s}pt")
    }
}

/// A half-point size as points: `28` -> `14pt`.
pub(super) fn half_points(raw: Option<&str>) -> Option<String> {
    let n = int_prefix(raw?)?;
    Some(format!("{}pt", f2(n as f64 / 2.0)))
}

/// The leading integer of `s`, as JavaScript's `parseInt` reads it.
pub(super) fn int_prefix(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let (sign, digits) = match t.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, t.strip_prefix('+').unwrap_or(t)),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return None;
    }
    digits[..end].parse::<i64>().ok().map(|n| n * sign)
}

pub(super) fn twips_to_cm(twips: f64) -> String {
    format!("{}cm", f2(twips * 2.54 / 1440.0))
}

pub(super) fn twips_to_pt(twips: f64) -> String {
    format!("{}pt", f2(twips / 20.0))
}

/// A number as JavaScript's `Number()` reads text: blank reads as 0.
pub(super) fn js_number(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or(t.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if t.chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))
    {
        t.parse::<f64>().ok()
    } else {
        None
    }
}

/// Word spacing in twips as points.
pub(super) fn word_spacing(raw: &str, non_negative: bool) -> String {
    let Some(mut twips) = js_number(raw).filter(|_| !raw.trim().is_empty()) else {
        return raw.to_string();
    };
    if non_negative && twips < 0.0 {
        twips = 0.0;
    }
    format!("{}pt", f2(twips / 20.0))
}

/// A line spacing: a multiple for `auto`, points otherwise.
pub(super) fn word_line_spacing(raw: &str, rule: Option<&str>) -> String {
    let Some(twips) = js_number(raw).filter(|_| !raw.trim().is_empty()) else {
        return raw.to_string();
    };
    match rule {
        None => format!("{}x", fmt(twips / 240.0, 4)),
        Some(r) if r.eq_ignore_ascii_case("auto") => format!("{}x", fmt(twips / 240.0, 4)),
        Some(_) => format!("{}pt", f2(twips / 20.0)),
    }
}

/// A color as OfficeCLI shows one: `#RRGGBB`, alpha last, `auto` kept.
pub(super) fn hex_color(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    if raw.starts_with('#') {
        return raw.to_uppercase();
    }
    let all_hex = raw.bytes().all(|b| b.is_ascii_hexdigit());
    if raw.len() == 6 && all_hex {
        return format!("#{}", raw.to_uppercase());
    }
    if raw.len() == 8 && all_hex {
        let alpha = &raw[..2];
        if alpha.eq_ignore_ascii_case("FF") {
            return format!("#{}", raw[2..].to_uppercase());
        }
        return format!("#{}{}", raw[2..].to_uppercase(), alpha.to_uppercase());
    }
    let lower = raw.to_lowercase();
    if lower == "auto" || lower == "none" {
        return lower;
    }
    raw.to_string()
}

/// An integer when the text is one within Int32, else the text.
pub(super) fn int_or_text(raw: &str) -> super::node::Value {
    let t = raw.trim();
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(n) = t.parse::<i64>() {
            if n.abs() <= 2_147_483_647 {
                return super::node::Value::Int(n);
            }
        }
    }
    super::node::Value::Str(raw.to_string())
}

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// A W3CDTF date as .NET's round-trip form in UTC: `2026-01-02T03:04:05.0000000+00:00`.
pub(super) fn round_trip_date(text: &str) -> Option<String> {
    let t = text.trim();
    let (date, time) = t.split_once('T')?;
    let mut dp = date.splitn(3, '-');
    let first = dp.next()?;
    let (y, mo, d): (i64, i64, i64) = (
        first.parse().ok()?,
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
    );
    let (clock, offset_min) = if let Some(c) = time.strip_suffix('Z') {
        (c, 0)
    } else if let Some(at) = time.rfind(['+', '-']).filter(|&i| i > 0) {
        let off = &time[at..];
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let (oh, om) = off[1..].split_once(':').unwrap_or((&off[1..], "0"));
        (
            &time[..at],
            sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().ok()?),
        )
    } else {
        (time, 0)
    };
    let mut cp = clock.split(':');
    let h: i64 = cp.next()?.parse().ok()?;
    let mi: i64 = cp.next()?.parse().ok()?;
    let (s, frac) = match cp.next() {
        Some(sec) => match sec.split_once('.') {
            Some((s, f)) => (s.parse::<i64>().ok()?, f.to_string()),
            None => (sec.parse::<i64>().ok()?, String::new()),
        },
        None => (0, String::new()),
    };
    if !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    let total = days * 86_400 + h * 3600 + mi * 60 + s - offset_min * 60;
    let day = total.div_euclid(86_400);
    let secs = total - day * 86_400;
    let (cy, cm, cd) = civil(day);
    let mut ticks: String = frac.chars().take(7).collect();
    while ticks.len() < 7 {
        ticks.push('0');
    }
    Some(format!(
        "{cy:04}-{cm:02}-{cd:02}T{:02}:{:02}:{:02}.{ticks}+00:00",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    ))
}

/// A date as .NET's round-trip `o` form writes the DateTime it parses to.
pub(super) fn round_trip(text: &str) -> String {
    let t = text.trim();
    let (base, rest) = match t.get(..19) {
        Some(b) if t.len() >= 19 && b.as_bytes()[10] == b'T' => (b, &t[19..]),
        _ => return text.to_string(),
    };
    let (frac, zone) = match rest.strip_prefix('.') {
        Some(r) => {
            let end = r.bytes().take_while(u8::is_ascii_digit).count();
            (&r[..end], &r[end..])
        }
        None => ("", rest),
    };
    let mut ticks: String = frac.chars().take(7).collect();
    while ticks.len() < 7 {
        ticks.push('0');
    }
    match zone {
        "" => format!("{base}.{ticks}"),
        "Z" => format!("{base}.{ticks}Z"),
        z if z.len() == 6 && (z.starts_with('+') || z.starts_with('-')) => {
            round_trip_date(text).unwrap_or_else(|| text.to_string())
        }
        _ => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_like_dotnet() {
        assert_eq!(f2(3.175), "3.18");
        assert_eq!(f2(29.21), "29.21");
        assert_eq!(f2(0.0), "0");
        assert_eq!(f2(-1.005), "-1.01");
        assert_eq!(fmt(0.9, 5), "0.9");
        assert_eq!(fixed(6.35, 1), "6.3");
    }

    #[test]
    fn formats_lengths() {
        assert_eq!(format_emu(10_515_600), "29.21cm");
        assert_eq!(format_emu(838_200), "66pt");
        assert_eq!(format_emu(8_748_979), "8748979emu");
        assert_eq!(
            format_emu_paired(12_192_000, 6_858_000),
            ("960pt".into(), "540pt".into())
        );
    }

    #[test]
    fn writes_round_trip_dates() {
        assert_eq!(
            round_trip_date("2026-11-14T14:04:10Z").as_deref(),
            Some("2026-11-14T14:04:10.0000000+00:00")
        );
    }
}

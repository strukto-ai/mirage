use std::collections::HashMap;

use pdf_oxide::object::Object;

use super::doc::Doc;
use crate::calendar::{MONTHS, WEEKDAYS};
use crate::jq::time::{Zone, civil, days_from_civil};

/// The Info entries a document's text fields print, in the order printed.
const FIELDS: [&str; 6] = [
    "Title", "Subject", "Keywords", "Author", "Creator", "Producer",
];

/// The Info entries the standard defines; any other makes custom metadata.
const STANDARD: [&str; 9] = [
    "Title",
    "Author",
    "Subject",
    "Keywords",
    "Creator",
    "Producer",
    "CreationDate",
    "ModDate",
    "Trapped",
];

/// PDFDocEncoding's characters for bytes 0x18 to 0x1F and 0x80 to 0xA0,
/// as the PDF standard's Annex D lists them; U+FFFD where it has none.
const DOC_LOW: [char; 8] = ['˘', 'ˇ', 'ˆ', '˙', '˝', '˛', '˚', '˜'];
const DOC_HIGH: [char; 33] = [
    '•', '†', '‡', '…', '—', '–', 'ƒ', '⁄', '‹', '›', '−', '‰', '„', '“', '”', '‘', '’', '‚', '™',
    'ﬁ', 'ﬂ', 'Ł', 'Œ', 'Š', 'Ÿ', 'Ž', 'ı', 'ł', 'œ', 'š', 'ž', '\u{fffd}', '€',
];

/// A text string as the reader shows it: UTF-16 or UTF-8 behind their
/// byte order marks, else PDFDocEncoding.
pub(crate) fn text_string(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        let units: Vec<u16> = rest
            .chunks(2)
            .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    bytes
        .iter()
        .map(|&b| match b {
            0x18..=0x1f => DOC_LOW[usize::from(b - 0x18)],
            0x7f | 0xad => '\u{fffd}',
            0x80..=0xa0 => DOC_HIGH[usize::from(b - 0x80)],
            _ => char::from(b),
        })
        .collect()
}

/// A PDF date's instant, in seconds since the epoch: `D:` optional, then
/// the year and as many of month, day, hour, minute and second as given,
/// then `Z` or an offset; none given reads as UTC.
fn instant(text: &str) -> Option<i64> {
    let text = text.strip_prefix("D:").unwrap_or(text).trim_start();
    let bytes = text.as_bytes();
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits < 4 {
        return None;
    }
    let field = |at: usize, len: usize, default: i64| -> Option<i64> {
        if at + len > digits {
            return Some(default);
        }
        text.get(at..at + len)?.parse().ok()
    };
    let year = field(0, 4, 0)?;
    let month = field(4, 2, 1)?;
    let day = field(6, 2, 1)?;
    let hour = field(8, 2, 0)?;
    let minute = field(10, 2, 0)?;
    let second = field(12, 2, 0)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let mut east = 0;
    let rest = &bytes[digits.min(14)..];
    if let Some(&sign) = rest.first() {
        if sign == b'+' || sign == b'-' {
            let tail: Vec<i64> = rest[1..]
                .split(|b| !b.is_ascii_digit())
                .filter(|p| !p.is_empty())
                .take(2)
                .filter_map(|p| std::str::from_utf8(p).ok()?.parse().ok())
                .collect();
            let hours = tail.first().copied().unwrap_or(0);
            let minutes = tail.get(1).copied().unwrap_or(0);
            east = (hours * 60 + minutes) * 60;
            if sign == b'-' {
                east = -east;
            }
        }
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86400 + hour * 3600 + minute * 60 + second - east)
}

/// An instant as the C library's `%a %b %e %H:%M:%S %Y %Z` shows it in
/// `zone`.
fn local_time(t: i64, zone: &Zone) -> String {
    let (east, name) = zone.local(t);
    let wall = t + east;
    let days = wall.div_euclid(86400);
    let secs = wall.rem_euclid(86400);
    let (year, month, day) = civil(days);
    let weekday = (days + 4).rem_euclid(7) as usize;
    format!(
        "{} {} {:>2} {:02}:{:02}:{:02} {} {}",
        &WEEKDAYS[weekday][..3],
        &MONTHS[(month - 1) as usize][..3],
        day,
        secs / 3600,
        secs / 60 % 60,
        secs % 60,
        year,
        name
    )
}

/// A number as C's `%g` shows it: six significant digits, trailing zeros
/// dropped.
fn general(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    let exponent = value.abs().log10().floor() as i32;
    if !(-5..6).contains(&exponent) {
        let text = format!("{value:.5e}");
        let (mantissa, power) = text.split_once('e').unwrap_or((&text, "0"));
        let mantissa = mantissa.trim_end_matches('0').trim_end_matches('.');
        let power: i32 = power.parse().unwrap_or(0);
        let sign = if power < 0 { '-' } else { '+' };
        return format!("{mantissa}e{sign}{:02}", power.abs());
    }
    let decimals = (5 - exponent).max(0) as usize;
    let text = format!("{value:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

/// The paper size a page's width and height name, either way round:
/// letter within half a point, A0 to A5 within a millimetre.
fn paper(width: f64, height: f64) -> Option<String> {
    let (short, long) = if width <= height {
        (width, height)
    } else {
        (height, width)
    };
    if (short - 612.0).abs() <= 0.5 && (long - 792.0).abs() <= 0.5 {
        return Some("letter".to_string());
    }
    let mm = |pts: f64| pts * 25.4 / 72.0;
    let (mut w, mut h) = (841, 1189);
    for n in 0..=5 {
        if (mm(short) - f64::from(w)).abs() <= 1.0 && (mm(long) - f64::from(h)).abs() <= 1.0 {
            return Some(format!("A{n}"));
        }
        (w, h) = (h / 2, w);
    }
    None
}

/// The printed line of one field: its label padded to the value's column.
fn line(label: &str, value: &str) -> String {
    format!("{label:<17}{value}\n")
}

fn yes(on: bool) -> &'static str {
    if on { "yes" } else { "no" }
}

/// A dictionary entry, its reference followed.
fn entry(doc: &Doc, dict: &HashMap<String, Object>, key: &str) -> Option<Object> {
    let found = dict.get(key)?;
    doc.inner.resolve_object(found).ok()
}

fn flag(doc: &Doc, dict: &HashMap<String, Object>, key: &str) -> bool {
    entry(doc, dict, key).and_then(|o| o.as_bool()) == Some(true)
}

/// Whether an action, or any in its `Next` chain, runs JavaScript.
fn scripted(doc: &Doc, action: &Object, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    let Some(action) = doc.inner.resolve_object(action).ok() else {
        return false;
    };
    if let Some(list) = action.as_array() {
        return list.iter().any(|a| scripted(doc, a, depth + 1));
    }
    let Some(dict) = action.as_dict() else {
        return false;
    };
    if entry(doc, dict, "S")
        .and_then(|s| s.as_name().map(str::to_owned))
        .as_deref()
        == Some("JavaScript")
    {
        return true;
    }
    dict.get("Next")
        .is_some_and(|n| scripted(doc, n, depth + 1))
}

/// Whether an additional-actions dictionary holds a script.
fn scripted_actions(doc: &Doc, actions: Option<Object>) -> bool {
    actions
        .as_ref()
        .and_then(Object::as_dict)
        .is_some_and(|d| d.values().any(|a| scripted(doc, a, 0)))
}

/// Whether the document carries JavaScript: named scripts, an opening
/// action or a document action that runs a script. A form field's or a
/// link's own script does not count, as the reader counts them.
fn javascript(doc: &Doc, catalog: &HashMap<String, Object>) -> bool {
    let named = entry(doc, catalog, "Names")
        .as_ref()
        .and_then(Object::as_dict)
        .is_some_and(|n| n.contains_key("JavaScript"));
    named
        || catalog
            .get("OpenAction")
            .is_some_and(|a| scripted(doc, a, 0))
        || scripted_actions(doc, entry(doc, catalog, "AA"))
}

/// Whether the file is laid out for reading one page at a time: its first
/// object, in `head`, is a linearization dictionary whose length is the
/// file's, `length`.
fn linearized(head: &[u8], length: usize) -> bool {
    let head = &head[..head.len().min(1024)];
    let Some(at) = head.windows(3).position(|w| w == b"obj") else {
        return false;
    };
    let rest = &head[at..];
    let Some(mark) = rest.windows(11).position(|w| w == b"/Linearized") else {
        return false;
    };
    let Some(end) = rest.windows(6).position(|w| w == b"endobj") else {
        return false;
    };
    if mark > end {
        return false;
    }
    let dict = &rest[..end];
    let Some(l) = (0..dict.len().saturating_sub(1)).find(|&p| {
        &dict[p..p + 2] == b"/L" && !dict.get(p + 2).is_some_and(|b| b.is_ascii_alphanumeric())
    }) else {
        return false;
    };
    let digits: String = dict[l + 2..]
        .iter()
        .skip_while(|b| b.is_ascii_whitespace())
        .take_while(|b| b.is_ascii_digit())
        .map(|&b| char::from(b))
        .collect();
    digits.parse::<usize>().ok() == Some(length)
}

/// The `Encrypted:` value: no, or the permissions and cipher.
fn encryption(doc: &Doc) -> String {
    let Some(trailer) = doc.inner.trailer().as_dict() else {
        return "no".to_string();
    };
    let Some(dict) = entry(doc, trailer, "Encrypt") else {
        return "no".to_string();
    };
    let Some(dict) = dict.as_dict() else {
        return "no".to_string();
    };
    let p = entry(doc, dict, "P")
        .and_then(|p| p.as_integer())
        .unwrap_or(-1) as i32;
    let v = entry(doc, dict, "V")
        .and_then(|v| v.as_integer())
        .unwrap_or(0);
    let method = entry(doc, dict, "CF")
        .as_ref()
        .and_then(Object::as_dict)
        .and_then(|cf| {
            let name = entry(doc, dict, "StmF")
                .and_then(|n| n.as_name().map(str::to_owned))
                .unwrap_or_else(|| "StdCF".to_string());
            entry(doc, cf, &name)
        })
        .as_ref()
        .and_then(Object::as_dict)
        .and_then(|f| entry(doc, f, "CFM"))
        .and_then(|m| m.as_name().map(str::to_owned));
    let algorithm = match (v, method.as_deref()) {
        (5, _) | (_, Some("AESV3")) => "AES-256",
        (4, Some("AESV2")) => "AES",
        _ => "RC4",
    };
    format!(
        "yes (print:{} copy:{} change:{} addNotes:{} algorithm:{algorithm})",
        yes(p & 4 != 0),
        yes(p & 16 != 0),
        yes(p & 8 != 0),
        yes(p & 32 != 0),
    )
}

/// The `PDF version:` value: the header's, or the catalog's when later.
fn version(doc: &Doc, catalog: &HashMap<String, Object>) -> String {
    let (major, minor) = doc.inner.version();
    let header = format!("{major}.{minor}");
    let stated = entry(doc, catalog, "Version").and_then(|v| v.as_name().map(str::to_owned));
    match stated {
        Some(v) if v.parse::<f64>().ok() > header.parse::<f64>().ok() => v,
        _ => header,
    }
}

/// What `pdfinfo` prints for a document whose file starts with `head` and
/// is `length` bytes long, `size` the length it reports, pages `first` to
/// `last` listed one by one when a range was asked for; and the warnings
/// it raises.
pub(crate) fn render(
    doc: &Doc,
    head: &[u8],
    length: usize,
    size: u64,
    pages: Option<(usize, usize)>,
    zone: &Zone,
) -> (String, String) {
    let mut out = String::new();
    let mut warnings = String::new();
    let info = doc.info();
    let info = info.as_ref().and_then(Object::as_dict);
    if let Some(info) = info {
        for key in FIELDS {
            if let Some(value) = entry(doc, info, key) {
                if let Some(raw) = value.as_string() {
                    out.push_str(&line(&format!("{key}:"), &text_string(raw)));
                }
            }
        }
        for key in ["CreationDate", "ModDate"] {
            if let Some(value) = entry(doc, info, key) {
                if let Some(raw) = value.as_string() {
                    let text = text_string(raw);
                    let shown = instant(&text).map_or(text, |t| local_time(t, zone));
                    out.push_str(&line(&format!("{key}:"), &shown));
                }
            }
        }
    }
    let custom = info.is_some_and(|i| i.keys().any(|k| !STANDARD.contains(&k.as_str())));
    out.push_str(&line("Custom Metadata:", yes(custom)));
    let catalog = doc.inner.catalog().ok();
    let empty = HashMap::new();
    let catalog = catalog.as_ref().and_then(Object::as_dict).unwrap_or(&empty);
    out.push_str(&line(
        "Metadata Stream:",
        yes(catalog.contains_key("Metadata")),
    ));
    let mark = entry(doc, catalog, "MarkInfo");
    let mark = mark.as_ref().and_then(Object::as_dict);
    let marked = |key: &str| mark.is_some_and(|m| flag(doc, m, key));
    out.push_str(&line("Tagged:", yes(marked("Marked"))));
    out.push_str(&line("UserProperties:", yes(marked("UserProperties"))));
    out.push_str(&line("Suspects:", yes(marked("Suspects"))));
    let form = entry(doc, catalog, "AcroForm");
    let form = form.as_ref().and_then(Object::as_dict);
    let kind = match form {
        None => "none",
        Some(form) => {
            if !form.contains_key("Fields") {
                warnings.push_str("Syntax Error: Can't get Fields array\n");
            }
            if form.contains_key("XFA") {
                "XFA"
            } else {
                "AcroForm"
            }
        }
    };
    out.push_str(&line("Form:", kind));
    out.push_str(&line("JavaScript:", yes(javascript(doc, catalog))));
    out.push_str(&line("Pages:", &doc.pages.to_string()));
    out.push_str(&line("Encrypted:", &encryption(doc)));
    let page_size = |i: usize| -> String {
        let (x0, y0, x1, y1) = doc
            .inner
            .get_page_visible_box(i)
            .unwrap_or((0.0, 0.0, 612.0, 792.0));
        let (w, h) = (f64::from(x1 - x0).abs(), f64::from(y1 - y0).abs());
        let named = paper(w, h).map_or(String::new(), |n| format!(" ({n})"));
        format!("{} x {} pts{named}", general(w), general(h))
    };
    let rotation = |i: usize| {
        doc.inner
            .get_page_rotation(i)
            .unwrap_or(0)
            .rem_euclid(360)
            .to_string()
    };
    match pages {
        Some((first, last)) => {
            for page in first..=last {
                out.push_str(&line(
                    &format!("Page {page:>4} size:"),
                    &page_size(page - 1),
                ));
                out.push_str(&line(&format!("Page {page:>4} rot:"), &rotation(page - 1)));
            }
        }
        None if doc.pages > 0 => {
            out.push_str(&line("Page size:", &page_size(0)));
            out.push_str(&line("Page rot:", &rotation(0)));
        }
        None => {}
    }
    out.push_str(&line("File size:", &format!("{size} bytes")));
    out.push_str(&line("Optimized:", yes(linearized(head, length))));
    out.push_str(&line("PDF version:", &version(doc, catalog)));
    (out, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn general_matches_the_c_library() {
        assert_eq!(general(612.0), "612");
        assert_eq!(general(595.276), "595.276");
        assert_eq!(general(841.89), "841.89");
        assert_eq!(general(100.123456), "100.123");
        assert_eq!(general(14400.5), "14400.5");
    }

    #[test]
    fn paper_names_letter_and_the_a_series() {
        assert_eq!(paper(612.0, 792.0).as_deref(), Some("letter"));
        assert_eq!(paper(612.5, 792.5).as_deref(), Some("letter"));
        assert_eq!(paper(613.0, 793.0), None);
        assert_eq!(paper(595.276, 841.89).as_deref(), Some("A4"));
        assert_eq!(paper(841.89, 595.276).as_deref(), Some("A4"));
        assert_eq!(paper(594.0, 841.0).as_deref(), Some("A4"));
        assert_eq!(paper(597.0, 843.0).as_deref(), Some("A4"));
        assert_eq!(paper(597.6, 841.44).as_deref(), Some("A4"));
        assert_eq!(paper(2384.0, 3370.0).as_deref(), Some("A0"));
        assert_eq!(paper(420.0, 595.0).as_deref(), Some("A5"));
        assert_eq!(paper(298.0, 420.0), None);
        assert_eq!(paper(612.0, 1008.0), None);
    }

    #[test]
    fn dates_read_their_offset_and_default_to_utc() {
        assert_eq!(instant("D:20240315120000Z"), Some(1710504000));
        assert_eq!(
            instant("D:20240315120000+08'00'"),
            Some(1710504000 - 8 * 3600)
        );
        assert_eq!(
            instant("D:20240315120000-05'30'"),
            Some(1710504000 + 5 * 3600 + 1800)
        );
        assert_eq!(instant("D:2024"), Some(1704067200));
        assert_eq!(instant("20240315120000Z"), Some(1710504000));
        assert_eq!(instant("garbage"), None);
    }

    #[test]
    fn local_time_reads_like_the_c_library() {
        let utc = Zone::parse("UTC");
        assert_eq!(local_time(1710504000, &utc), "Fri Mar 15 12:00:00 2024 UTC");
        assert_eq!(local_time(1704067200, &utc), "Mon Jan  1 00:00:00 2024 UTC");
        let shanghai = Zone::parse("Asia/Shanghai");
        assert_eq!(
            local_time(1710504000, &shanghai),
            "Fri Mar 15 20:00:00 2024 CST"
        );
    }

    #[test]
    fn text_strings_decode_pdfdoc_and_unicode() {
        assert_eq!(
            text_string(b"\x93\x86\x80\xa0\x9f\xad\x18x"),
            "ﬁƒ•€\u{fffd}\u{fffd}˘x"
        );
        assert_eq!(text_string(b"\xfe\xff\x5e\x74\x5e\xa6"), "年度");
        assert_eq!(text_string(b"\xef\xbb\xbf\xe5\xb9\xb4"), "年");
        assert_eq!(text_string(b"Ops Team"), "Ops Team");
    }
}

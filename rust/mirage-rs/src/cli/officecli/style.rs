//! A workbook's styles as `get` reports them: each cell format's font,
//! fill, border, alignment, protection and number format, under the keys
//! OfficeCLI 1.0.161 prints, and a number shown through its format the way
//! OfficeCLI shows a date, a duration or a percentage.

use std::collections::HashMap;

use super::node::{Node, Value, number_text};
use super::xml::{Kind, Tag, tags};

#[derive(Clone, Debug, Default)]
pub(super) struct Color {
    rgb: Option<String>,
    theme: Option<u32>,
    tint: Option<f64>,
}

impl Color {
    fn of(tag: &Tag<'_>) -> Color {
        Color {
            rgb: tag.attr("rgb"),
            theme: tag.attr("theme").and_then(|t| t.parse().ok()),
            tint: tag.attr("tint").and_then(|t| t.parse().ok()),
        }
    }

    /// The color as a hex value, else as its theme slot.
    fn shown(&self) -> Option<String> {
        if let Some(rgb) = &self.rgb {
            return Some(hex(rgb));
        }
        theme_name(self.theme?, self.tint)
    }
}

/// A stored color as `#RRGGBB`, keeping its alpha only when it is not
/// opaque.
pub(super) fn hex(raw: &str) -> String {
    let all_hex = raw.bytes().all(|b| b.is_ascii_hexdigit());
    if raw.starts_with('#') {
        return raw.to_ascii_uppercase();
    }
    if raw.len() == 6 && all_hex {
        return format!("#{}", raw.to_ascii_uppercase());
    }
    if raw.len() == 8 && all_hex {
        let (alpha, rgb) = raw.split_at(2);
        if alpha.eq_ignore_ascii_case("FF") {
            return format!("#{}", rgb.to_ascii_uppercase());
        }
        return format!(
            "#{}{}",
            rgb.to_ascii_uppercase(),
            alpha.to_ascii_uppercase()
        );
    }
    if raw.eq_ignore_ascii_case("auto") || raw.eq_ignore_ascii_case("none") {
        return raw.to_ascii_lowercase();
    }
    raw.to_string()
}

/// A theme slot by its index, with its tint as a percentage.
pub(super) fn theme_name(index: u32, tint: Option<f64>) -> Option<String> {
    const SLOTS: [&str; 12] = [
        "lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5",
        "accent6", "hlink", "folHlink",
    ];
    let name = SLOTS.get(index as usize)?;
    match tint {
        Some(t) if t.abs() >= 0.005 => Some(format!(
            "{name}+tint{}",
            number_text(round_even(t * 100.0, 2))
        )),
        _ => Some(name.to_string()),
    }
}

fn round_even(x: f64, digits: i32) -> f64 {
    let scale = 10f64.powi(digits);
    let scaled = x * scale;
    let floor = scaled.floor();
    let diff = scaled - floor;
    let rounded = if (diff - 0.5).abs() < 1e-9 {
        if floor % 2.0 == 0.0 {
            floor
        } else {
            floor + 1.0
        }
    } else {
        scaled.round()
    };
    rounded / scale
}

/// One child of a font: its name, its attributes, and whether it holds
/// elements of its own.
#[derive(Clone, Debug)]
struct Part {
    name: String,
    attrs: Vec<(String, String)>,
    leaf: bool,
    color: Color,
}

#[derive(Clone, Debug, Default)]
struct Font {
    parts: Vec<Part>,
}

#[derive(Clone, Debug, Default)]
struct Fill {
    pattern: Option<String>,
    has_pattern: bool,
    fg: Option<Color>,
    bg: Option<Color>,
    gradient: Option<(f64, Vec<Option<String>>)>,
}

#[derive(Clone, Debug, Default)]
struct Side {
    style: Option<String>,
    rgb: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct Border {
    sides: HashMap<String, Side>,
    up: bool,
    down: bool,
}

#[derive(Clone, Debug, Default)]
struct Xf {
    num_fmt: u32,
    font: u32,
    fill: u32,
    border: u32,
    quote_prefix: bool,
    alignment: Option<Vec<(String, String)>>,
    protection: Option<Vec<(String, String)>>,
}

/// The styles part read for `get`.
#[derive(Debug, Default)]
pub(super) struct Book {
    formats: HashMap<u32, String>,
    fonts: Vec<Font>,
    fills: Vec<Fill>,
    borders: Vec<Border>,
    xfs: Vec<Xf>,
}

fn truthy(v: &str) -> bool {
    matches!(v, "1" | "true")
}

fn attrs_of(tag: &Tag<'_>) -> Vec<(String, String)> {
    tag.attrs()
        .into_iter()
        .filter(|(k, _)| !k.starts_with(b"xmlns"))
        .map(|(k, v)| {
            let key = String::from_utf8_lossy(k);
            let local = key.rsplit(':').next().unwrap_or(&key).to_string();
            (local, super::xml::unescape(v))
        })
        .collect()
}

impl Book {
    pub(super) fn read(xml: &[u8]) -> Book {
        let all: Vec<Tag<'_>> = tags(xml).collect();
        let mut book = Book::default();
        let mut section = "";
        let mut depth = 0usize;
        let mut side: Option<String> = None;
        let mut in_xf = false;
        for (i, tag) in all.iter().enumerate() {
            let name = tag.local();
            let opens = tag.kind != Kind::End;
            match (tag.kind, name) {
                (Kind::Start, b"numFmts" | b"fonts" | b"fills" | b"borders" | b"cellXfs") => {
                    section = match name {
                        b"numFmts" => "numFmts",
                        b"fonts" => "fonts",
                        b"fills" => "fills",
                        b"borders" => "borders",
                        _ => "cellXfs",
                    };
                    depth = 0;
                    continue;
                }
                (Kind::End, b"numFmts" | b"fonts" | b"fills" | b"borders" | b"cellXfs") => {
                    section = "";
                    continue;
                }
                _ => {}
            }
            match section {
                "numFmts" if opens && name == b"numFmt" => {
                    if let (Some(id), Some(code)) = (
                        tag.attr("numFmtId").and_then(|v| v.parse().ok()),
                        tag.attr("formatCode"),
                    ) {
                        book.formats.insert(id, code);
                    }
                }
                "fonts" => {
                    if name == b"font" && depth == 0 {
                        if opens {
                            book.fonts.push(Font::default());
                            if tag.kind == Kind::Start {
                                depth = 1;
                            }
                        }
                        continue;
                    }
                    if name == b"font" && tag.kind == Kind::End {
                        depth = 0;
                        continue;
                    }
                    if depth == 1 && opens {
                        let leaf = tag.kind == Kind::Empty
                            || all
                                .get(i + 1)
                                .is_some_and(|n| n.kind == Kind::End && n.name == tag.name);
                        if let Some(font) = book.fonts.last_mut() {
                            font.parts.push(Part {
                                name: String::from_utf8_lossy(name).into_owned(),
                                attrs: attrs_of(tag),
                                leaf,
                                color: Color::of(tag),
                            });
                        }
                        if tag.kind == Kind::Start {
                            depth = 2;
                        }
                    } else if depth == 2 && tag.kind == Kind::End {
                        depth = 1;
                    }
                }
                "fills" => {
                    if name == b"fill" && opens {
                        book.fills.push(Fill::default());
                        continue;
                    }
                    let Some(fill) = book.fills.last_mut() else {
                        continue;
                    };
                    match name {
                        b"patternFill" if opens => {
                            fill.has_pattern = true;
                            fill.pattern = tag.attr("patternType");
                        }
                        b"fgColor" if opens => fill.fg = Some(Color::of(tag)),
                        b"bgColor" if opens => fill.bg = Some(Color::of(tag)),
                        b"gradientFill" if opens => {
                            fill.gradient = Some((
                                tag.attr("degree")
                                    .and_then(|d| d.parse().ok())
                                    .unwrap_or(0.0),
                                Vec::new(),
                            ))
                        }
                        b"color" if opens => {
                            if let Some((_, stops)) = fill.gradient.as_mut() {
                                stops.push(tag.attr("rgb"));
                            }
                        }
                        _ => {}
                    }
                }
                "borders" => {
                    if name == b"border" && opens {
                        book.borders.push(Border {
                            up: tag.attr("diagonalUp").is_some_and(|v| truthy(&v)),
                            down: tag.attr("diagonalDown").is_some_and(|v| truthy(&v)),
                            ..Border::default()
                        });
                        continue;
                    }
                    let Some(border) = book.borders.last_mut() else {
                        continue;
                    };
                    match name {
                        b"left" | b"right" | b"top" | b"bottom" | b"diagonal" if opens => {
                            let key = String::from_utf8_lossy(name).into_owned();
                            border.sides.insert(
                                key.clone(),
                                Side {
                                    style: tag.attr("style"),
                                    rgb: None,
                                },
                            );
                            side = (tag.kind == Kind::Start).then_some(key);
                        }
                        b"left" | b"right" | b"top" | b"bottom" | b"diagonal" => side = None,
                        b"color" if opens => {
                            if let Some(s) = side.as_ref().and_then(|k| border.sides.get_mut(k)) {
                                s.rgb = tag.attr("rgb");
                            }
                        }
                        _ => {}
                    }
                }
                "cellXfs" => {
                    if name == b"xf" && opens {
                        let num = |k: &str| tag.attr(k).and_then(|v| v.parse().ok()).unwrap_or(0);
                        book.xfs.push(Xf {
                            num_fmt: num("numFmtId"),
                            font: num("fontId"),
                            fill: num("fillId"),
                            border: num("borderId"),
                            quote_prefix: tag.attr("quotePrefix").is_some_and(|v| truthy(&v)),
                            ..Xf::default()
                        });
                        in_xf = tag.kind == Kind::Start;
                        continue;
                    }
                    if name == b"xf" {
                        in_xf = false;
                        continue;
                    }
                    if !in_xf || !opens {
                        continue;
                    }
                    if let Some(xf) = book.xfs.last_mut() {
                        match name {
                            b"alignment" => xf.alignment = Some(attrs_of(tag)),
                            b"protection" => xf.protection = Some(attrs_of(tag)),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        book
    }

    /// A cell format's number format: its id and its code, None for the
    /// general format.
    pub(super) fn number_format(&self, style: u32) -> Option<(u32, Option<String>)> {
        let xf = self.xfs.get(style as usize)?;
        (xf.num_fmt != 0).then(|| (xf.num_fmt, self.formats.get(&xf.num_fmt).cloned()))
    }

    /// The properties cell format `style` gives a cell, in OfficeCLI's
    /// order.
    pub(super) fn describe(&self, style: u32, node: &mut Node) {
        if style == 0 {
            return;
        }
        let Some(xf) = self.xfs.get(style as usize) else {
            return;
        };
        if xf.font > 0 {
            if let Some(font) = self.fonts.get(xf.font as usize) {
                describe_font(font, node);
            }
        }
        if xf.fill > 0 {
            if let Some(fill) = self.fills.get(xf.fill as usize) {
                describe_fill(fill, node);
            }
        }
        if xf.border > 0 {
            if let Some(border) = self.borders.get(xf.border as usize) {
                for side in ["left", "right", "top", "bottom"] {
                    if let Some(s) = border.sides.get(side) {
                        if let Some(style) = s.style.as_deref().filter(|st| *st != "none") {
                            node.str(&format!("border.{side}"), style);
                            if let Some(rgb) = &s.rgb {
                                node.str(&format!("border.{side}.color"), hex(rgb));
                            }
                        }
                    }
                }
                if let Some(d) = border.sides.get("diagonal") {
                    if let Some(style) = d.style.as_deref().filter(|st| *st != "none") {
                        node.str("border.diagonal", style);
                        if let Some(rgb) = &d.rgb {
                            node.str("border.diagonal.color", hex(rgb));
                        }
                    }
                }
                if border.up {
                    node.flag("border.diagonalUp");
                }
                if border.down {
                    node.flag("border.diagonalDown");
                }
            }
        }
        if let Some(align) = &xf.alignment {
            let get = |k: &str| align.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
            if get("wrapText").is_some_and(truthy) {
                node.flag("alignment.wrapText");
            }
            if let Some(h) = get("horizontal") {
                node.str("alignment.horizontal", h);
            }
            if let Some(v) = get("vertical") {
                node.str("alignment.vertical", v);
            }
            if let Some(r) = get("textRotation")
                .and_then(|r| r.parse::<u32>().ok())
                .filter(|r| *r != 0)
            {
                node.str("alignment.textRotation", r.to_string());
            }
            if let Some(n) = get("indent")
                .and_then(|n| n.parse::<u32>().ok())
                .filter(|n| *n > 0)
            {
                node.str("alignment.indent", n.to_string());
            }
            if get("shrinkToFit").is_some_and(truthy) {
                node.flag("alignment.shrinkToFit");
            }
            if let Some(order) = get("readingOrder")
                .and_then(|o| o.parse::<u32>().ok())
                .filter(|o| *o != 0)
            {
                node.str(
                    "alignment.readingOrder",
                    match order {
                        1 => "ltr",
                        2 => "rtl",
                        _ => "context",
                    },
                );
            }
            const CURATED: [&str; 7] = [
                "horizontal",
                "vertical",
                "wrapText",
                "textRotation",
                "indent",
                "shrinkToFit",
                "readingOrder",
            ];
            for (name, value) in align {
                let key = format!("alignment.{name}");
                if !CURATED.contains(&name.as_str()) && !node.has(&key) {
                    node.str(&key, value.clone());
                }
            }
        }
        if let Some(prot) = &xf.protection {
            for key in ["locked", "hidden"] {
                if let Some((_, v)) = prot.iter().find(|(n, _)| n == key) {
                    node.set(&format!("protection.{key}"), Value::Bool(truthy(v)));
                }
            }
            for (name, value) in prot {
                let key = format!("protection.{name}");
                if name != "locked" && name != "hidden" && !node.has(&key) {
                    node.str(&key, value.clone());
                }
            }
        }
        if xf.quote_prefix {
            node.flag("quotePrefix");
        }
        if xf.num_fmt > 0 {
            node.set("numFmtId", Value::Int(i64::from(xf.num_fmt)));
            let code = self
                .formats
                .get(&xf.num_fmt)
                .cloned()
                .or_else(|| builtin(xf.num_fmt).map(str::to_string));
            node.set(
                "numberformat",
                code.map_or(Value::Int(i64::from(xf.num_fmt)), Value::Str),
            );
        }
    }

    /// A number shown through cell format `style`, when that format makes
    /// it a date, a duration or a percentage.
    pub(super) fn display(&self, value: f64, style: u32, date1904: bool) -> Option<String> {
        let (id, code) = self.number_format(style)?;
        try_format(value, id, code.as_deref(), date1904)
    }
}

fn describe_font(font: &Font, node: &mut Node) {
    let part = |name: &str| font.parts.iter().find(|p| p.name == name);
    let val = |name: &str| {
        part(name).and_then(|p| {
            p.attrs
                .iter()
                .find(|(k, _)| k == "val")
                .map(|(_, v)| v.clone())
        })
    };
    if part("b").is_some() {
        node.flag("font.bold");
    }
    if part("i").is_some() {
        node.flag("font.italic");
    }
    if part("strike").is_some() {
        node.flag("strike");
    }
    if part("u").is_some() {
        match val("u").as_deref() {
            Some("none") => {}
            Some(kind @ ("double" | "singleAccounting" | "doubleAccounting")) => {
                node.str("underline", kind)
            }
            _ => node.str("underline", "single"),
        }
    }
    if let Some(color) = part("color").and_then(|p| p.color.shown()) {
        node.str("font.color", color);
    }
    match val("vertAlign").as_deref() {
        Some("superscript") => node.flag("superscript"),
        Some("subscript") => node.flag("subscript"),
        _ => {}
    }
    if let Some(size) = val("sz").and_then(|s| s.parse::<f64>().ok()) {
        node.str("font.size", format!("{}pt", two_places(size)));
    }
    if let Some(name) = val("name") {
        node.str("font.name", name);
    }
    const CURATED: [&str; 8] = ["b", "i", "strike", "u", "vertAlign", "sz", "name", "color"];
    for p in &font.parts {
        let key = format!("font.{}", p.name);
        if CURATED.contains(&p.name.as_str()) || node.has(&key) || !p.leaf {
            continue;
        }
        match p.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case("val")) {
            Some((_, v)) => node.str(&key, v.clone()),
            None if p.attrs.is_empty() => node.flag(&key),
            None => {}
        }
    }
}

fn describe_fill(fill: &Fill, node: &mut Node) {
    if let Some((degree, stops)) = &fill.gradient {
        if stops.len() >= 2 {
            let colors: Vec<String> = stops
                .iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .map(|s| hex(s))
                .collect();
            if colors.len() >= 2 {
                node.str(
                    "fill",
                    format!("gradient;{};{}", colors.join(";"), *degree as i64),
                );
            }
        }
        return;
    }
    if !fill.has_pattern {
        return;
    }
    let pattern = fill.pattern.as_deref();
    let rgb = |c: &Option<Color>| c.as_ref().and_then(|c| c.rgb.clone());
    let theme = |c: &Option<Color>| {
        c.as_ref()
            .and_then(|c| c.theme.and_then(|t| theme_name(t, c.tint)))
    };
    if pattern.is_some_and(|p| p != "solid" && p != "none") {
        node.str("fillPattern", pattern.unwrap_or_default());
        if let Some(fg) = rgb(&fill.fg).map(|r| hex(&r)).or_else(|| theme(&fill.fg)) {
            node.str("fill", fg);
        }
        if let Some(bg) = rgb(&fill.bg).map(|r| hex(&r)).or_else(|| theme(&fill.bg)) {
            node.str("fillBg", bg);
        }
    } else if let Some(fg) = rgb(&fill.fg) {
        node.str("fill", hex(&fg));
    } else if let Some(fg) = theme(&fill.fg) {
        node.str("fill", fg);
    }
}

/// A size as OfficeCLI prints one: at most two decimal places.
pub(super) fn two_places(v: f64) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    number_text(rounded)
}

/// A built-in number format's code.
pub(super) fn builtin(id: u32) -> Option<&'static str> {
    Some(match id {
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "m/d/yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    })
}

/// A format code with its quoted literals, and its bracketed codes when
/// `brackets`, taken out.
fn stripped(code: &str, brackets: bool) -> String {
    let mut out = String::new();
    let mut quoted = false;
    let mut bracket = false;
    for c in code.chars() {
        match c {
            '"' => quoted = !quoted,
            _ if quoted => {}
            '[' if brackets => bracket = true,
            ']' if bracket => bracket = false,
            _ if bracket => {}
            c => out.push(c),
        }
    }
    out
}

fn is_date(id: u32, code: Option<&str>) -> bool {
    if matches!(id, 14..=22 | 45..=47) {
        return true;
    }
    let Some(code) = code else { return false };
    let plain = stripped(code, true);
    let lower = plain.to_ascii_lowercase();
    let mut no_fraction = String::new();
    let mut rest = lower.as_str();
    while let Some(at) = rest.find("s.0") {
        no_fraction.push_str(&rest[..=at]);
        rest = rest[at + 2..].trim_start_matches('0');
    }
    no_fraction.push_str(rest);
    if no_fraction.contains(['0', '#']) {
        return false;
    }
    let chars: Vec<char> = plain.chars().collect();
    chars.iter().enumerate().any(|(i, &c)| {
        matches!(c, 'y' | 'Y' | 'd' | 'D')
            || (c == 'm' && chars.get(i + 1) == Some(&'m'))
            || (c == 'm'
                && !i
                    .checked_sub(1)
                    .is_some_and(|p| chars[p].is_ascii_alphabetic())
                && !chars.get(i + 1).is_some_and(|n| n.is_ascii_alphabetic()))
    })
}

/// A number through a format, when the format makes it a date, a
/// duration or a percentage.
pub(super) fn try_format(
    value: f64,
    id: u32,
    custom: Option<&str>,
    date1904: bool,
) -> Option<String> {
    let code = custom.or_else(|| builtin(id));
    let mut detect = code.map(str::to_string);
    if let Some(c) = code.filter(|c| c.contains(';')) {
        let sections: Vec<&str> = c.split(';').collect();
        let pick = if value > 0.0 {
            sections[0]
        } else if value < 0.0 {
            sections.get(1).copied().unwrap_or(sections[0])
        } else {
            sections.get(2).copied().unwrap_or(sections[0])
        };
        if pick.trim().is_empty() {
            return None;
        }
        detect = Some(pick.to_string());
    }
    if let Some(d) = detect.as_deref() {
        if let Some(unit) = elapsed_unit(d) {
            return Some(elapsed(value, d, unit));
        }
    }
    if is_date(id, detect.as_deref()) {
        return Some(date(
            if date1904 { value + 1462.0 } else { value },
            detect.as_deref(),
        ));
    }
    if detect
        .as_deref()
        .is_some_and(|d| stripped(d, false).contains('%'))
    {
        return Some(percent(value, code.unwrap_or_default()));
    }
    None
}

/// The unit of a bracketed elapsed-time token, `[h]`, `[mm]` or `[ss]`,
/// and where that token ends.
fn elapsed_unit(code: &str) -> Option<(char, usize)> {
    let bytes = code.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            let close = code[i..].find(']').map(|c| c + i)?;
            let inner = &code[i + 1..close];
            let first = inner.chars().next().map(|c| c.to_ascii_lowercase());
            if let Some(u @ ('h' | 'm' | 's')) = first {
                if !inner.is_empty() && inner.chars().all(|c| c.to_ascii_lowercase() == u) {
                    return Some((u, close + 1));
                }
            }
            i = close + 1;
        } else {
            i += 1;
        }
    }
    None
}

fn elapsed(value: f64, code: &str, (unit, after): (char, usize)) -> String {
    let total = round_even(value.abs() * 86400.0, 0) as i64;
    let rest = stripped(&code[after..], false).to_ascii_lowercase();
    let text = match unit {
        'h' => {
            let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60);
            match (rest.contains('m'), rest.contains('s')) {
                (true, true) => format!("{h}:{m:02}:{s:02}"),
                (true, false) => format!("{h}:{m:02}"),
                _ => h.to_string(),
            }
        }
        'm' => {
            if rest.contains('s') {
                format!("{}:{:02}", total / 60, total % 60)
            } else {
                (total / 60).to_string()
            }
        }
        _ => total.to_string(),
    };
    if value < 0.0 {
        format!("-{text}")
    } else {
        text
    }
}

/// Days since 1899-12-30 as a civil date.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 693_899;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn date(value: f64, code: Option<&str>) -> String {
    if (60.0..61.0).contains(&value) {
        return "1900-02-29".to_string();
    }
    let v = if (1.0..60.0).contains(&value) {
        value + 1.0
    } else {
        value
    };
    if !(-657_435.0..2_958_466.0).contains(&v) {
        return number_text(value);
    }
    let mut ms = (v * 86_400_000.0 + if v >= 0.0 { 0.5 } else { -0.5 }) as i64;
    if ms < 0 {
        ms -= (ms % 86_400_000) * 2;
    }
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil(days);
    let has_time = code.is_some_and(|c| stripped(c, true).contains(['h', 'H', 's', 'S']));
    if has_time {
        let (hh, mm, ss, milli) = (
            in_day / 3_600_000,
            in_day / 60_000 % 60,
            in_day / 1000 % 60,
            in_day % 1000,
        );
        if ss == 0 && milli == 0 {
            return format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}");
        }
        return format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}");
    }
    format!("{y:04}-{m:02}-{d:02}")
}

fn percent(value: f64, code: &str) -> String {
    if code.contains(';') {
        let sections: Vec<&str> = code.split(';').collect();
        if value < 0.0 && sections.len() >= 2 {
            return percent_section(value.abs(), sections[1]);
        }
        if value == 0.0 && sections.len() >= 3 {
            return percent_section(value, sections[2]);
        }
        return percent_section(value, sections[0]);
    }
    percent_section(value, code)
}

fn percent_section(value: f64, section: &str) -> String {
    let mut plain = String::new();
    let mut bracket = false;
    for c in section.chars() {
        match c {
            '[' => bracket = true,
            ']' if bracket => bracket = false,
            _ if bracket => {}
            c => plain.push(c),
        }
    }
    let section = plain.trim();
    let decimals = section
        .match_indices("0.")
        .find_map(|(at, _)| {
            let zeros = section[at + 2..].chars().take_while(|c| *c == '0').count();
            (zeros > 0 && section[at + 2 + zeros..].starts_with('%')).then_some(zeros)
        })
        .unwrap_or(0);
    let scale = 10f64.powi(decimals as i32);
    let pct = (value * 100.0 * scale).round() / scale;
    let mut num = format!("{pct:.decimals$}");
    if section.contains(',') {
        num = grouped(&num);
    }
    num.push('%');
    match placeholder(section) {
        Some((start, end)) => format!("{}{num}{}", &section[..start], &section[end..]),
        None => num,
    }
}

/// A fixed-point number with its whole part grouped by thousands.
fn grouped(num: &str) -> String {
    let (sign, rest) = num.strip_prefix('-').map_or(("", num), |r| ("-", r));
    let (whole, frac) = rest
        .split_once('.')
        .map_or((rest, None), |(w, f)| (w, Some(f)));
    let mut out = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    match frac {
        Some(f) => format!("{sign}{out}.{f}"),
        None => format!("{sign}{out}"),
    }
}

/// Where a percentage's digit placeholders stand in its section.
fn placeholder(section: &str) -> Option<(usize, usize)> {
    let b = section.as_bytes();
    for start in 0..b.len() {
        if !matches!(b[start], b'#' | b'0') {
            continue;
        }
        let mut i = start + 1;
        while i < b.len() && matches!(b[i], b'#' | b'0' | b',') {
            i += 1;
        }
        if i < b.len() && b[i] == b'.' && i + 1 < b.len() && matches!(b[i + 1], b'#' | b'0') {
            i += 1;
            while i < b.len() && matches!(b[i], b'#' | b'0') {
                i += 1;
            }
        }
        if i < b.len() && b[i] == b'%' {
            return Some((start, i + 1));
        }
    }
    None
}

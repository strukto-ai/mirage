// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! Images a picture `add` embeds. Each source its props name, a file or a
//! base64 `data:` URI, is read before the edit runs, typed by its extension
//! and checked against its magic bytes as OfficeCLI's ImageSource does; its
//! pixel size gives the frame's missing side.

use std::collections::HashMap;

use super::Fail;
use super::package::{Pkg, relative};
use super::tree::{self, Kid, Tree};
use crate::request::{Opening, Request, failed, failure_text};
use crate::task::Host;

/// An image as a picture embeds it.
pub(super) struct Image {
    pub(super) bytes: Vec<u8>,
    /// The extension its media part takes.
    pub(super) ext: &'static str,
    pub(super) content_type: &'static str,
    pub(super) size: Option<(u32, u32)>,
}

impl Image {
    pub(super) fn svg(&self) -> bool {
        self.ext == "svg"
    }
}

/// The images an `add` names, read before it runs, by source.
pub(super) type Media = HashMap<String, Result<Image, String>>;

pub(super) const IMAGE_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/// The element types that make a picture.
pub(super) const PICTURE: [&str; 3] = ["picture", "image", "img"];

/// The 1x1 transparent PNG an SVG picture carries for viewers that do not
/// draw SVG.
pub(super) const TRANSPARENT_PNG: [u8; 67] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

/// The blip extension that points a picture at its SVG part.
pub(super) const SVG_EXTENSION: &str = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}";
pub(super) const SVG_NS: &str = "http://schemas.microsoft.com/office/drawing/2016/SVG/main";

/// The last value `props` gives `key`.
pub(super) fn value<'p>(props: &'p [(String, String)], key: &str) -> Option<&'p String> {
    props
        .iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v)
}

/// The picture's source: `path`, else `src`.
pub(super) fn source(props: &[(String, String)]) -> Option<&String> {
    value(props, "path").or_else(|| value(props, "src"))
}

/// The sources an `add` of `kind` with `props` reads: a picture's image and
/// the fallback an SVG names.
pub(super) fn sources(kind: &str, props: &[(String, String)]) -> Vec<String> {
    if !PICTURE.iter().any(|p| kind.eq_ignore_ascii_case(p)) {
        return Vec::new();
    }
    let mut out: Vec<String> = source(props).cloned().into_iter().collect();
    if let Some(f) = value(props, "fallback").filter(|f| !f.trim().is_empty()) {
        out.push(f.clone());
    }
    out
}

/// Each of `sources` resolved through the host.
pub(super) async fn gather(host: &Host, sources: Vec<String>) -> Media {
    let mut media = Media::new();
    for s in sources {
        if let std::collections::hash_map::Entry::Vacant(slot) = media.entry(s) {
            let image = resolve(host, slot.key()).await;
            slot.insert(image);
        }
    }
    media
}

/// The image `src` names, or the refusal reading it gave.
pub(super) fn take<'m>(media: &'m Media, src: &str) -> Result<&'m Image, Fail> {
    match media.get(src) {
        Some(Ok(image)) => Ok(image),
        Some(Err(why)) => Err(Fail::of(why.clone())),
        None => Err(Fail::of(format!("Image file not found: {src}"))),
    }
}

async fn resolve(host: &Host, src: &str) -> Result<Image, String> {
    if src.trim().is_empty() {
        return Err("Image source cannot be empty".to_string());
    }
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("data:") {
        return data_uri(src);
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Err(format!(
            "Image URLs are not fetched: {src}. Save the image to a file and pass its path."
        ));
    }
    let bytes = read(host, src).await?;
    let ext = extension(src);
    let (part_ext, content_type) = by_extension(&ext)?;
    if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "tif" | "tiff"
    ) {
        match sniff(&bytes) {
            Some((sniffed, name)) if sniffed != content_type => {
                return Err(format!(
                    "Image file '{src}' has extension .{ext} but magic bytes indicate {name}. Rename or convert the file."
                ));
            }
            Some(_) => {}
            None => {
                return Err(format!(
                    "Image file '{src}' does not appear to be a valid {ext} file (magic bytes mismatch)."
                ));
            }
        }
    }
    Ok(image(bytes, part_ext, content_type))
}

fn image(bytes: Vec<u8>, ext: &'static str, content_type: &'static str) -> Image {
    let size = dimensions(&bytes);
    Image {
        bytes,
        ext,
        content_type,
        size,
    }
}

/// The file `name` names, read whole through the host.
async fn read(host: &Host, name: &str) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    let mut open = Some((name.as_bytes().to_vec(), Opening::File));
    loop {
        let (reply, mut chunk) = host
            .ask(Request::Read {
                fd: 11,
                open: open.take(),
                least: u64::MAX,
            })
            .await;
        if failed(&reply) {
            if reply.names(&["ENOENT", "ENOTDIR", "EISDIR"]) {
                return Err(format!("Image file not found: {name}"));
            }
            return Err(String::from_utf8_lossy(&failure_text(&reply)).into_owned());
        }
        data.append(&mut chunk);
        if reply.end {
            return Ok(data);
        }
    }
}

/// The extension of the last name in `path`, lowercased, without its dot.
fn extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((_, ext)) => ext.to_ascii_lowercase(),
        None => String::new(),
    }
}

fn by_extension(ext: &str) -> Result<(&'static str, &'static str), String> {
    Ok(match ext {
        "png" => ("png", "image/png"),
        "jpg" | "jpeg" => ("jpg", "image/jpeg"),
        "gif" => ("gif", "image/gif"),
        "bmp" => ("bmp", "image/bmp"),
        "tif" | "tiff" => ("tiff", "image/tiff"),
        "emf" => ("emf", "image/x-emf"),
        "wmf" => ("wmf", "image/x-wmf"),
        "svg" => ("svg", "image/svg+xml"),
        _ => {
            return Err(format!(
                "Unsupported image format: .{ext}. Supported: png, jpg, gif, bmp, tiff, emf, wmf, svg"
            ));
        }
    })
}

fn by_mime(mime: &str) -> Option<(&'static str, &'static str)> {
    Some(match mime.to_ascii_lowercase().as_str() {
        "image/png" => ("png", "image/png"),
        "image/jpeg" | "image/jpg" => ("jpg", "image/jpeg"),
        "image/gif" => ("gif", "image/gif"),
        "image/bmp" => ("bmp", "image/bmp"),
        "image/tiff" | "image/tif" => ("tiff", "image/tiff"),
        "image/svg+xml" => ("svg", "image/svg+xml"),
        "image/emf" | "image/x-emf" => ("emf", "image/x-emf"),
        "image/wmf" | "image/x-wmf" => ("wmf", "image/x-wmf"),
        _ => return None,
    })
}

/// The raster type the first bytes announce, and its name.
fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.len() < 4 {
        return None;
    }
    if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some(("image/png", "PNG"))
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "JPEG"))
    } else if b.starts_with(b"GIF8") {
        Some(("image/gif", "GIF"))
    } else if b.starts_with(b"BM") {
        Some(("image/bmp", "BMP"))
    } else if b.starts_with(b"II*\0") || b.starts_with(b"MM\0*") {
        Some(("image/tiff", "TIFF"))
    } else {
        None
    }
}

fn data_uri(uri: &str) -> Result<Image, String> {
    let Some((header, data)) = uri.split_once(',') else {
        return Err("Invalid data URI: missing comma separator".to_string());
    };
    if !header.to_ascii_lowercase().contains("base64") {
        return Err("Only base64-encoded data URIs are supported".to_string());
    }
    let start = header.find(':').map_or(0, |i| i + 1);
    let mime = match header.find(';') {
        Some(end) if end > start => &header[start..end],
        _ => &header[start..],
    };
    let (ext, content_type) = by_mime(mime).ok_or_else(|| {
        format!(
            "Unsupported MIME type: {mime}. Supported: image/png, image/jpeg, image/gif, image/bmp, image/tiff, image/svg+xml"
        )
    })?;
    let bytes = base64(data).ok_or_else(|| {
        "The input is not a valid Base-64 string as it contains a non-base 64 character, more than two padding characters, or an illegal character among the padding characters.".to_string()
    })?;
    if bytes.is_empty() {
        return Err(
            "Invalid data URI: empty base64 payload (would produce a 0-byte image).".to_string(),
        );
    }
    Ok(image(bytes, ext, content_type))
}

/// Standard base64, whitespace ignored and padding required.
fn base64(text: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = text
        .bytes()
        .filter(|c| !matches!(c, b' ' | b'\t' | b'\r' | b'\n'))
        .collect();
    if clean.len() % 4 != 0 {
        return None;
    }
    let pad = clean.iter().rev().take_while(|c| **c == b'=').count();
    if pad > 2 {
        return None;
    }
    let digit = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let body = &clean[..clean.len() - pad];
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in body.chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= digit(*c)? << (18 - 6 * i);
        }
        let bytes = acc.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

fn be32(b: &[u8], at: usize) -> i32 {
    i32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn le32(b: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn positive(w: i64, h: i64) -> Option<(u32, u32)> {
    (w > 0 && h > 0).then_some((w as u32, h as u32))
}

/// An image's pixel size, read from a PNG, BMP, GIF or JPEG header or an
/// SVG's root.
fn dimensions(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 {
        return None;
    }
    let header = &b[..b.len().min(30)];
    if header.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return positive(i64::from(be32(b, 16)), i64::from(be32(b, 20)));
    }
    if header.starts_with(b"BM") && header.len() >= 26 {
        let h = i64::from(le32(b, 22));
        return positive(i64::from(le32(b, 18)), h.abs());
    }
    if header.starts_with(b"GIF8") {
        let w = i64::from(b[6]) | i64::from(b[7]) << 8;
        let h = i64::from(b[8]) | i64::from(b[9]) << 8;
        return positive(w, h);
    }
    if header.starts_with(&[0xFF, 0xD8]) {
        return jpeg_size(b);
    }
    if looks_like_svg(header) {
        return svg_size(b);
    }
    None
}

/// A JPEG's size, from the first start-of-frame marker before its scan.
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 2 < b.len() {
        if b[at] != 0xFF {
            return None;
        }
        at += 1;
        let mut marker;
        loop {
            marker = *b.get(at)?;
            at += 1;
            if !(marker == 0xFF && at < b.len()) {
                break;
            }
        }
        let frame = matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF);
        if frame {
            let f = b.get(at..at + 7)?;
            let h = i64::from(f[3]) << 8 | i64::from(f[4]);
            let w = i64::from(f[5]) << 8 | i64::from(f[6]);
            return positive(w, h);
        }
        if marker == 0xDA {
            return None;
        }
        let len = b.get(at..at + 2)?;
        let len = usize::from(len[0]) << 8 | usize::from(len[1]);
        if len < 2 {
            return None;
        }
        at += len;
    }
    None
}

fn looks_like_svg(header: &[u8]) -> bool {
    let mut i = if header.starts_with(&[0xEF, 0xBB, 0xBF]) {
        3
    } else {
        0
    };
    while i < header.len() && matches!(header[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    if i >= header.len() || header[i] != b'<' {
        return false;
    }
    let text = String::from_utf8_lossy(&header[i..]).to_lowercase();
    text.starts_with("<svg") || text.starts_with("<?xml") || text.starts_with("<!doctype svg")
}

/// An SVG's size in pixels at 96 dpi, from its root's width and height or
/// else its viewBox.
fn svg_size(b: &[u8]) -> Option<(u32, u32)> {
    let t: Tree = tree::parse(b).ok()?;
    let mut stack = vec![t.root];
    let svg = loop {
        let id = stack.pop()?;
        if t.nodes[id].name == "svg" {
            break id;
        }
        for k in t.nodes[id].kids.iter().rev() {
            if let Kid::El(c) = k {
                stack.push(*c);
            }
        }
    };
    let e = t.root().handle(svg);
    let mut w = e.attr("width").and_then(svg_length);
    let mut h = e.attr("height").and_then(svg_length);
    if w.is_none() || h.is_none() {
        if let Some(vb) = e.attr("viewBox") {
            let parts: Vec<&str> = vb
                .split([' ', ',', '\t', '\n', '\r'])
                .filter(|p| !p.is_empty())
                .collect();
            if let [_, _, vw, vh] = parts.as_slice() {
                if let (Ok(vw), Ok(vh)) = (vw.parse::<f64>(), vh.parse::<f64>()) {
                    w = w.or(Some(vw));
                    h = h.or(Some(vh));
                }
            }
        }
    }
    match (w, h) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => {
            Some((w.round_ties_even() as u32, h.round_ties_even() as u32))
        }
        _ => None,
    }
}

fn svg_length(value: &str) -> Option<f64> {
    let v = value.trim();
    let split = v
        .find(|c: char| !(c.is_ascii_digit() || matches!(c, '+' | '-' | '.')))
        .unwrap_or(v.len());
    let (number, unit) = v.split_at(split);
    let unit = unit.trim().to_ascii_lowercase();
    let digits = number.trim_start_matches(['+', '-']);
    let (int, frac) = digits.split_once('.').unwrap_or((digits, ""));
    if int.is_empty()
        || !int.bytes().all(|c| c.is_ascii_digit())
        || (digits.contains('.') && (frac.is_empty() || !frac.bytes().all(|c| c.is_ascii_digit())))
        || number.len() - digits.len() > 1
    {
        return None;
    }
    let n: f64 = number.parse().ok()?;
    Some(match unit.as_str() {
        "" | "px" => n,
        "pt" => n * 96.0 / 72.0,
        "in" => n * 96.0,
        "cm" => n * 96.0 / 2.54,
        "mm" => n * 96.0 / 25.4,
        "pc" | "em" | "ex" => n * 16.0,
        _ => return None,
    })
}

/// A picture's frame: the side not given follows the image's aspect, and
/// with neither given the default width keeps it.
pub(super) fn fit(image: &Image, cx: i64, cy: i64, has_w: bool, has_h: bool) -> (i64, i64) {
    if has_w && has_h {
        return (cx, cy);
    }
    let Some((w, h)) = image.size else {
        return (cx, cy);
    };
    let ratio = f64::from(h) / f64::from(w);
    if !has_w && has_h {
        ((cy as f64 / ratio) as i64, cy)
    } else {
        (cx, (cx as f64 * ratio) as i64)
    }
}

/// The `<a:srcRect>` attributes a crop gives, in thousandths of a percent,
/// left, top, right and bottom.
pub(super) fn src_rect(sides: [Option<i64>; 4]) -> String {
    ["l", "t", "r", "b"]
        .iter()
        .zip(sides)
        .filter_map(|(k, v)| v.map(|v| format!(" {k}=\"{v}\"")))
        .collect()
}

/// `image` stored as a media part related from `owner`: the relationship
/// the blip embeds, and for an SVG the SVG part's, the blip then pointing
/// at the `fallback` image or a transparent PNG.
pub(super) fn embed(
    pkg: &mut Pkg<'_>,
    owner: &str,
    image: &Image,
    props: &[(String, String)],
    media: &Media,
    took: &mut Vec<String>,
) -> Result<(String, Option<String>), Fail> {
    let store = |pkg: &mut Pkg<'_>, bytes: Vec<u8>, ext: &str, content_type: &str| {
        let name = pkg.media_name(owner, ext);
        pkg.add_binary(&name, bytes, content_type);
        pkg.add_rel(owner, IMAGE_REL, &relative(owner, &name), false)
    };
    if !image.svg() {
        let rid = store(pkg, image.bytes.clone(), image.ext, image.content_type);
        return Ok((rid, None));
    }
    let svg = store(pkg, image.bytes.clone(), "svg", image.content_type);
    let rid = match props
        .iter()
        .rev()
        .find(|(k, v)| k.eq_ignore_ascii_case("fallback") && !v.trim().is_empty())
    {
        Some((k, v)) => {
            took.push(k.clone());
            let fallback = take(media, v)?;
            store(
                pkg,
                fallback.bytes.clone(),
                fallback.ext,
                fallback.content_type,
            )
        }
        None => store(pkg, TRANSPARENT_PNG.to_vec(), "png", "image/png"),
    };
    Ok((rid, Some(svg)))
}

/// The blip extension list naming the SVG part `rid`.
pub(super) fn svg_blip(rid: &str) -> String {
    format!(
        "<a:extLst><a:ext uri=\"{SVG_EXTENSION}\"><asvg:svgBlip xmlns:asvg=\"{SVG_NS}\" r:embed=\"{rid}\"/></a:ext></a:extLst>"
    )
}

/// The parsed number OfficeCLI's SafeParseDouble takes, or its refusal.
pub(super) fn number(value: &str, prop: &str) -> Result<f64, Fail> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .ok_or_else(|| {
            Fail::of(format!(
                "Invalid '{prop}' value '{value}'. Expected a finite number."
            ))
        })
}

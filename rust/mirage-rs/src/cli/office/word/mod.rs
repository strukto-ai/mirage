// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A Word document as OfficeCLI 1.0.161's Word handler reads it: its paths
//! (`/body/p[@paraId=X]/r[N]`, tables, sections, styles, headers and
//! footers), each node's properties with what a run and paragraph inherit
//! from the document defaults and the style chain, and the document,
//! section and style nodes. Divergence: an inline equation's text is
//! plain, not LaTeX.

mod doc;
pub(super) mod edit;
mod paragraph;
mod paths;
mod query;
mod root;
mod run;
mod table;
mod things;

use super::node::{Node, Value, number_text};
use super::package::Pkg;
use super::tree::{E, M, MC, W, W14, is_on, on_off};
use super::units::{f2, half_points, hex_color, js_number};
use super::{Fail, SetFail};

pub(super) use self::doc::Word;

pub(super) const WPG: &str = "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup";

/// A refusal with the code and hints OfficeCLI reads off its message.
pub(super) fn fail(message: String) -> Fail {
    super::package::enriched(message)
}

/// Compatibility flags in the order OfficeCLI lists them, with their element names.
pub(super) const COMPAT_FLAGS: &[(&str, &str)] = &[
    (
        "useSingleBorderForContiguousCells",
        "useSingleBorderforContiguousCells",
    ),
    ("wpJustification", "wpJustification"),
    ("noTabHangIndent", "noTabHangInd"),
    ("noLeading", "noLeading"),
    ("spaceForUnderline", "spaceForUL"),
    ("noColumnBalance", "noColumnBalance"),
    (
        "balanceSingleByteDoubleByteWidth",
        "balanceSingleByteDoubleByteWidth",
    ),
    ("noExtraLineSpacing", "noExtraLineSpacing"),
    ("doNotLeaveBackslashAlone", "doNotLeaveBackslashAlone"),
    ("underlineTrailingSpaces", "ulTrailSpace"),
    ("doNotExpandShiftReturn", "doNotExpandShiftReturn"),
    ("spacingInWholePoints", "spacingInWholePoints"),
    ("lineWrapLikeWord6", "lineWrapLikeWord6"),
    ("printBodyTextBeforeHeader", "printBodyTextBeforeHeader"),
    ("printColorBlackWhite", "printColBlack"),
    ("wordPerfectSpaceWidth", "wpSpaceWidth"),
    ("showBreaksInFrames", "showBreaksInFrames"),
    ("subFontBySize", "subFontBySize"),
    ("suppressBottomSpacing", "suppressBottomSpacing"),
    ("suppressTopSpacing", "suppressTopSpacing"),
    ("suppressSpacingAtTopOfPage", "suppressSpacingAtTopOfPage"),
    ("suppressTopSpacingWordPerfect", "suppressTopSpacingWP"),
    (
        "suppressSpacingBeforeAfterPageBreak",
        "suppressSpBfAfterPgBrk",
    ),
    ("swapBordersFacingPages", "swapBordersFacingPages"),
    ("convertMailMergeEscape", "convMailMergeEsc"),
    (
        "truncateFontHeightsLikeWordPerfect",
        "truncateFontHeightsLikeWP",
    ),
    ("macWordSmallCaps", "mwSmallCaps"),
    ("usePrinterMetrics", "usePrinterMetrics"),
    (
        "doNotSuppressParagraphBorders",
        "doNotSuppressParagraphBorders",
    ),
    ("wrapTrailSpaces", "wrapTrailSpaces"),
    ("footnoteLayoutLikeWord8", "footnoteLayoutLikeWW8"),
    ("shapeLayoutLikeWord8", "shapeLayoutLikeWW8"),
    ("alignTablesRowByRow", "alignTablesRowByRow"),
    ("forgetLastTabAlignment", "forgetLastTabAlignment"),
    ("adjustLineHeightInTable", "adjustLineHeightInTable"),
    ("autoSpaceLikeWord95", "autoSpaceLikeWord95"),
    ("noSpaceRaiseLower", "noSpaceRaiseLower"),
    (
        "doNotUseHTMLParagraphAutoSpacing",
        "doNotUseHTMLParagraphAutoSpacing",
    ),
    ("layoutRawTableWidth", "layoutRawTableWidth"),
    ("layoutTableRowsApart", "layoutTableRowsApart"),
    ("useWord97LineBreakRules", "useWord97LineBreakRules"),
    ("doNotBreakWrappedTables", "doNotBreakWrappedTables"),
    ("doNotSnapToGridInCell", "doNotSnapToGridInCell"),
    (
        "selectFieldWithFirstOrLastChar",
        "selectFldWithFirstOrLastChar",
    ),
    ("applyBreakingRules", "applyBreakingRules"),
    ("doNotWrapTextWithPunctuation", "doNotWrapTextWithPunct"),
    ("doNotUseEastAsianBreakRules", "doNotUseEastAsianBreakRules"),
    ("useWord2002TableStyleRules", "useWord2002TableStyleRules"),
    ("growAutofit", "growAutofit"),
    ("useFarEastLayout", "useFELayout"),
    ("useNormalStyleForList", "useNormalStyleForList"),
    (
        "doNotUseIndentAsNumberingTabStop",
        "doNotUseIndentAsNumberingTabStop",
    ),
    ("useAltKinsokuLineBreakRules", "useAltKinsokuLineBreakRules"),
    (
        "allowSpaceOfSameStyleInTable",
        "allowSpaceOfSameStyleInTable",
    ),
    ("doNotSuppressIndentation", "doNotSuppressIndentation"),
    (
        "doNotAutofitConstrainedTables",
        "doNotAutofitConstrainedTables",
    ),
    (
        "autofitToFirstFixedWidthCell",
        "autofitToFirstFixedWidthCell",
    ),
    ("underlineTabInNumberingList", "underlineTabInNumList"),
    ("displayHangulFixedWidth", "displayHangulFixedWidth"),
    ("splitPageBreakAndParagraphMark", "splitPgBreakAndParaMark"),
    (
        "doNotVerticallyAlignCellWithShape",
        "doNotVertAlignCellWithSp",
    ),
    (
        "doNotBreakConstrainedForcedTable",
        "doNotBreakConstrainedForcedTable",
    ),
    ("doNotVerticallyAlignInTextBox", "doNotVertAlignInTxbx"),
    ("useAnsiKerningPairs", "useAnsiKerningPairs"),
    ("cachedColumnBalance", "cachedColBalance"),
];

/// Run-property children `FillUnknownChildProps` leaves to the curated readers.
const CURATED: &[&str] = &[
    "b",
    "bCs",
    "i",
    "iCs",
    "sz",
    "szCs",
    "u",
    "color",
    "strike",
    "rFonts",
    "highlight",
    "caps",
    "smallCaps",
    "dstrike",
    "vanish",
    "outline",
    "shadow",
    "emboss",
    "imprint",
    "noProof",
    "rtl",
    "vertAlign",
    "spacing",
    "shd",
    "bdr",
    "eastAsianLayout",
    "jc",
    "ind",
    "outlineLvl",
    "widowControl",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "contextualSpacing",
    "pBdr",
    "numPr",
    "tabs",
    "pStyle",
    "bidi",
    "rPr",
    "lang",
];

/// On/off elements whose single `w:val` FillUnknownChildProps reads as a boolean.
const ON_OFF: &[&str] = &[
    "webHidden",
    "specVanish",
    "oMath",
    "snapToGrid",
    "suppressAutoHyphens",
    "suppressLineNumbers",
    "suppressOverlap",
    "adjustRightInd",
    "autoSpaceDE",
    "autoSpaceDN",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "mirrorIndents",
    "keepNext",
    "keepLines",
    "cs",
    "noProof",
];

/// Keys a field, instruction or break run sheds as typography noise.
pub(super) const TYPOGRAPHY_ONLY: &[&str] = &[
    "font.ascii",
    "font.eastAsia",
    "font.hAnsi",
    "font.cs",
    "size",
    "bold",
    "italic",
    "color",
    "underline",
    "underline.color",
    "strike",
    "dstrike",
    "highlight",
    "caps",
    "smallcaps",
    "vanish",
    "outline",
    "shadow",
    "emboss",
    "imprint",
    "noproof",
    "rtl",
    "superscript",
    "subscript",
    "charSpacing",
    "shading",
    "effective.size",
    "effective.size.src",
    "effective.font.ascii",
    "effective.font.ascii.src",
    "effective.font.eastAsia",
    "effective.font.eastAsia.src",
    "effective.font.hAnsi",
    "effective.font.hAnsi.src",
    "effective.font.cs",
    "effective.font.cs.src",
    "effective.bold",
    "effective.bold.src",
    "effective.italic",
    "effective.italic.src",
    "effective.color",
    "effective.color.src",
    "effective.underline",
    "effective.underline.src",
];

pub(super) const FIELD_KEEP: &[&str] = &[
    "size",
    "bold",
    "italic",
    "color",
    "underline",
    "strike",
    "font.ascii",
    "font.hAnsi",
    "font.eastAsia",
    "font.cs",
];

/// One segment of a Word path.
#[derive(Clone, Debug)]
pub(super) struct Segment {
    pub(super) name: String,
    pub(super) index: Option<usize>,
    pub(super) predicate: Option<String>,
}

fn alias(n: &str) -> Option<&'static str> {
    Some(match n.to_lowercase().as_str() {
        "paragraph" => "p",
        "run" => "r",
        "table" => "tbl",
        "row" => "tr",
        "cell" => "tc",
        _ => return None,
    })
}

/// A path as OfficeCLI's Word handler splits it.
pub(super) fn parse_path(path: &str) -> Result<Vec<Segment>, Fail> {
    if path.starts_with("//") {
        return Err(fail(format!(
            "Malformed path '{path}'. Path must start with exactly one '/'."
        )));
    }
    if path.len() > 1 && path.ends_with('/') {
        return Err(fail(format!(
            "Malformed path '{path}'. Trailing '/' is not allowed."
        )));
    }
    let trimmed = path.trim_matches('/');
    let mut out = Vec::new();
    let mut prev = String::new();
    for part in trimmed.split('/') {
        let after_styles = prev == "styles";
        if part.is_empty() {
            return Err(fail(format!(
                "Malformed path '{path}'. Empty path segment (check for trailing or duplicate '/')."
            )));
        }
        let resolve = |n: &str| -> String {
            if after_styles {
                n.to_string()
            } else {
                alias(n).map_or_else(|| n.to_string(), str::to_string)
            }
        };
        let Some(open) = part.find('[') else {
            let name = resolve(part);
            prev = name.clone();
            out.push(Segment {
                name,
                index: None,
                predicate: None,
            });
            continue;
        };
        if !part.ends_with(']') {
            return Err(fail(format!(
                "Malformed path segment '{part}'. Expected 'name[index]' or 'name[@attr=value]'."
            )));
        }
        if part.find(']') != Some(part.len() - 1) {
            return Err(fail(format!(
                "Malformed path segment '{part}'. Multiple predicates are not supported — use a single 'name[...]' form."
            )));
        }
        let name = resolve(&part[..open]);
        let inner = &part[open + 1..part.len() - 1];
        if inner.is_empty() {
            return Err(fail(format!(
                "Malformed path segment '{part}'. Empty predicate — expected 'name[index]' or 'name[@attr=value]'."
            )));
        }
        let t = inner.trim();
        let body = t.strip_prefix(['+', '-']).unwrap_or(t);
        if !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit()) {
            let idx: i64 = t.parse().unwrap_or(0);
            if idx <= 0 {
                return Err(fail(format!(
                    "Malformed path segment '{part}'. Index predicate must be a positive integer (1-based), got '{inner}'."
                )));
            }
            out.push(Segment {
                name: name.clone(),
                index: Some(idx as usize),
                predicate: None,
            });
        } else {
            out.push(Segment {
                name: name.clone(),
                index: None,
                predicate: Some(normalize_predicate(part, inner)?),
            });
        }
        prev = name;
    }
    Ok(out)
}

fn normalize_predicate(part: &str, predicate: &str) -> Result<String, Fail> {
    if predicate == "last()" {
        return Ok(predicate.to_string());
    }
    let Some(rest) = predicate.strip_prefix('@') else {
        return Err(fail(format!(
            "Malformed path segment '{part}'. Predicate must be a positive integer, 'last()', or '[@attr=value]'."
        )));
    };
    let Some(eq) = rest.find('=').filter(|e| *e >= 1) else {
        return Err(fail(format!(
            "Malformed path segment '{part}'. Attribute predicate must be '[@name=value]' with a non-empty attribute name."
        )));
    };
    let attr = &rest[..eq];
    let simple = attr
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && attr.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !simple {
        return Err(fail(format!(
            "Malformed path segment '{part}'. Attribute name '{attr}' is not a simple identifier (no prefixes/colons)."
        )));
    }
    let value = &rest[eq + 1..];
    if value.is_empty() {
        return Err(fail(format!(
            "Malformed path segment '{part}'. Attribute predicate value is empty."
        )));
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        let inner = &value[1..value.len() - 1];
        if inner.contains('"') {
            return Err(fail(format!(
                "Malformed path segment '{part}'. Quoted attribute value must not contain embedded double quotes."
            )));
        }
        return Ok(format!("@{attr}={inner}"));
    }
    if value.starts_with(['@', '\'', '"']) {
        return Err(fail(format!(
            "Malformed path segment '{part}'. Attribute value must be bare-word or double-quoted."
        )));
    }
    if value.chars().any(char::is_whitespace) {
        return Err(fail(format!(
            "Malformed path segment '{part}'. Attribute value must not contain whitespace (use double quotes)."
        )));
    }
    Ok(predicate.to_string())
}

pub(super) fn w_child<'t>(e: Option<E<'t>>, name: &str) -> Option<E<'t>> {
    e?.child(W, name)
}

pub(super) fn w_val<'t>(e: Option<E<'t>>) -> Option<&'t str> {
    e?.w("val")
}

pub(super) fn para_id<'t>(p: E<'t>) -> Option<&'t str> {
    p.attr_ns("paraId", W14).filter(|v| !v.is_empty())
}

/// `p[@paraId=X]`, or `p[N]` for a paragraph with none.
pub(super) fn para_segment(p: E<'_>, index: usize) -> String {
    match para_id(p) {
        Some(id) => format!("p[@paraId={id}]"),
        None => format!("p[{index}]"),
    }
}

pub(super) fn sdt_segment(sdt: E<'_>, index: usize) -> String {
    match w_val(w_child(w_child(Some(sdt), "sdtPr"), "id")) {
        Some(id) => format!("sdt[@sdtId={id}]"),
        None => format!("sdt[{index}]"),
    }
}

pub(super) fn is_math_wrapper(p: E<'_>) -> bool {
    let kids: Vec<E<'_>> = p.elements().filter(|k| !k.is(W, "pPr")).collect();
    !kids.is_empty() && kids.iter().all(|k| k.is(M, "oMathPara"))
}

/// A run that holds a whole field, begin to end, in one `w:r`.
pub(super) fn packed_field(run: E<'_>) -> bool {
    let chars: Vec<String> = run
        .children(W, "fldChar")
        .iter()
        .filter_map(|f| f.w("fldCharType").map(str::to_lowercase))
        .collect();
    chars.iter().any(|c| c == "begin") && chars.iter().any(|c| c == "end")
}

/// A run's own text: text, tabs, line breaks, symbols.
pub(super) fn run_text(run: E<'_>) -> String {
    if let Some(ruby) = run.child(W, "ruby") {
        return ruby
            .child(W, "rubyBase")
            .map(|b| {
                b.descendants_named(W, "t")
                    .iter()
                    .map(|t| t.text())
                    .collect()
            })
            .unwrap_or_default();
    }
    let mut out = String::new();
    for c in run.elements() {
        if c.ns() != W {
            continue;
        }
        match c.name() {
            "t" | "delText" => out.push_str(&c.text()),
            "tab" => out.push('\t'),
            "br" => {
                if matches!(c.w("type"), None | Some("textWrapping")) {
                    out.push('\u{b}');
                }
            }
            "cr" => out.push('\u{b}'),
            "sym" => {
                if let Some(ch) = c
                    .w("char")
                    .and_then(|v| u32::from_str_radix(hex_prefix(v), 16).ok())
                    .and_then(char::from_u32)
                {
                    out.push(ch);
                }
            }
            "noBreakHyphen" => out.push('\u{2011}'),
            "softHyphen" => out.push('\u{ad}'),
            "dayLong" => out.push_str("[dayLong]"),
            "dayShort" => out.push_str("[dayShort]"),
            "monthLong" => out.push_str("[monthLong]"),
            "monthShort" => out.push_str("[monthShort]"),
            "yearLong" => out.push_str("[yearLong]"),
            "yearShort" => out.push_str("[yearShort]"),
            _ => {}
        }
    }
    out
}

/// The leading hex digits of `s`, as `parseInt(s, 16)` reads them.
fn hex_prefix(s: &str) -> &str {
    let t = s.trim_start();
    let end = t.bytes().take_while(u8::is_ascii_hexdigit).count();
    &t[..end]
}

pub(super) fn math_text(e: E<'_>) -> String {
    let w: String = e
        .descendants_named(W, "t")
        .iter()
        .map(|t| t.text())
        .collect();
    let m: String = e
        .descendants_named(M, "t")
        .iter()
        .map(|t| t.text())
        .collect();
    w + &m
}

fn wrapper_text(wrapper: E<'_>) -> String {
    let mut out = String::new();
    for c in wrapper.elements() {
        if c.is(W, "r") {
            out.push_str(&run_text(c));
        } else if c.is(W, "hyperlink") {
            out.push_str(&hyperlink_text(c));
        } else if c.is(W, "ins") || c.is(W, "moveTo") || c.is(W, "smartTag") || c.is(W, "customXml")
        {
            out.push_str(&wrapper_text(c));
        } else if c.is(M, "oMath") {
            out.push_str(&math_text(c));
        }
    }
    out
}

fn hyperlink_text(h: E<'_>) -> String {
    let mut out = String::new();
    for c in h.elements() {
        if c.is(W, "r") {
            out.push_str(&run_text(c));
        } else if c.is(W, "hyperlink") {
            out.push_str(&hyperlink_text(c));
        } else if c.is(W, "ins") || c.is(W, "moveTo") {
            out.push_str(&wrapper_text(c));
        } else if c.is(M, "oMath") {
            out.push_str(&math_text(c));
        }
    }
    out
}

/// A paragraph's text as OfficeCLI reads it.
pub(super) fn paragraph_text(p: E<'_>) -> String {
    let mut out = String::new();
    for c in p.elements() {
        if c.is(W, "r") {
            out.push_str(&run_text(c));
        } else if c.is(W, "hyperlink") {
            out.push_str(&hyperlink_text(c));
        } else if c.is(M, "oMath") {
            out.push_str(&math_text(c));
        } else if c.is(W, "smartTag") || c.is(W, "customXml") || c.is(W, "ins") || c.is(W, "moveTo")
        {
            out.push_str(&wrapper_text(c));
        }
    }
    out
}

pub(super) fn has_ancestor_within(e: E<'_>, stop: E<'_>, test: impl Fn(E<'_>) -> bool) -> bool {
    for a in e.ancestors() {
        if a == stop {
            return false;
        }
        if test(a) {
            return true;
        }
    }
    false
}

fn mc_wrapper(a: E<'_>) -> bool {
    a.ns() == MC && matches!(a.name(), "AlternateContent" | "Choice" | "Fallback")
}

/// The runs a paragraph lists as its children.
pub(super) fn all_runs<'t>(p: E<'t>) -> Vec<E<'t>> {
    p.descendants_named(W, "r")
        .into_iter()
        .filter(|r| {
            if r.child(W, "commentReference").is_some() {
                return false;
            }
            let inside = |name: &str| has_ancestor_within(*r, p, |a| a.is(W, name));
            if inside("ruby") && !inside("ins") && !inside("del") {
                return false;
            }
            if ["bdo", "dir", "sdt", "fldSimple", "txbxContent"]
                .iter()
                .any(|n| inside(n))
            {
                return false;
            }
            !has_ancestor_within(*r, p, mc_wrapper)
        })
        .collect()
}

pub(super) fn table_rows<'t>(table: E<'t>) -> Vec<E<'t>> {
    let mut rows = Vec::new();
    for c in table.elements() {
        if c.is(W, "tr") {
            rows.push(c);
        } else if c.is(W, "sdt") {
            rows.extend(
                c.descendants_named(W, "tr")
                    .into_iter()
                    .filter(|r| r.ancestor(W, "tbl") == Some(table)),
            );
        }
    }
    rows
}

pub(super) fn row_cells<'t>(row: E<'t>) -> Vec<E<'t>> {
    let mut cells = Vec::new();
    for c in row.elements() {
        if c.is(W, "tc") {
            cells.push(c);
        } else if c.is(W, "sdt") {
            cells.extend(
                c.descendants_named(W, "tc")
                    .into_iter()
                    .filter(|x| x.ancestor(W, "tr") == Some(row)),
            );
        }
    }
    cells
}

/// A width attribute as a whole number, as OfficeCLI reads one.
pub(super) fn safe_width(raw: Option<&str>) -> Option<i64> {
    let raw = raw?;
    if raw.trim().is_empty() {
        return None;
    }
    let n = js_number(raw)?;
    n.is_finite().then(|| n.trunc() as i64)
}

pub(super) fn pct_width(fiftieths: i64) -> String {
    format!("{}%", f2(fiftieths as f64 / 50.0))
}

/// A JavaScript number as a property value.
pub(super) fn float_value(n: f64) -> Value {
    if n.is_nan() {
        Value::Str("NaN".to_string())
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        Value::Int(n as i64)
    } else {
        Value::Num(n)
    }
}

/// `Number(v)` as a property value.
pub(super) fn num_value(v: &str) -> Value {
    float_value(jsn(v))
}

/// `Number(v)`, NaN when it does not read.
pub(super) fn jsn(v: &str) -> f64 {
    js_number(v).unwrap_or(f64::NAN)
}

/// `String(Number(v))`.
pub(super) fn num_text(v: &str) -> String {
    match js_number(v) {
        Some(n) => number_text(n),
        None => "NaN".to_string(),
    }
}

/// Whether `s` is a signed whole number, as `/^[+-]?\d+$/` reads it.
pub(super) fn is_int(s: &str) -> bool {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    is_digits(body)
}

/// Whether `s` is all ASCII digits and not empty.
pub(super) fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `s` cut to `n` UTF-16 units with `...`, as JavaScript's `slice` cuts it.
pub(super) fn clip(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() > n {
        format!("{}...", String::from_utf16_lossy(&units[..n]))
    } else {
        s.to_string()
    }
}

/// An element's text joined from its `w:t` descendants.
pub(super) fn t_text(e: E<'_>) -> String {
    e.descendants_named(W, "t")
        .iter()
        .map(|t| t.text())
        .collect()
}

pub(super) fn read_border(border: Option<E<'_>>, key: &str, node: &mut Node) {
    let Some(border) = border else { return };
    let Some(val) = border.w("val") else { return };
    node.str(key, val);
    if let Some(sz) = border.w("sz") {
        node.set(&format!("{key}.sz"), num_value(sz));
    }
    if let Some(c) = border.w("color") {
        node.str(&format!("{key}.color"), hex_color(c));
    }
    if let Some(s) = border.w("space") {
        node.set(&format!("{key}.space"), num_value(s));
    }
    if let Some(s) = border.w("shadow") {
        node.set(
            &format!("{key}.shadow"),
            Value::Bool(on_off(Some(s)) == Some(true)),
        );
    }
    if let Some(f) = border.w("frame") {
        node.set(
            &format!("{key}.frame"),
            Value::Bool(on_off(Some(f)) == Some(true)),
        );
    }
    for (attr, suffix) in [
        ("themeColor", "themeColor"),
        ("themeShade", "themeShade"),
        ("themeTint", "themeTint"),
    ] {
        if let Some(v) = border.w(attr) {
            node.str(&format!("{key}.{suffix}"), v);
        }
    }
}

const SHADING_THEME: [(&str, &str); 6] = [
    ("themeFill", "shading.themeFill"),
    ("themeFillShade", "shading.themeFillShade"),
    ("themeFillTint", "shading.themeFillTint"),
    ("themeColor", "shading.themeColor"),
    ("themeShade", "shading.themeShade"),
    ("themeTint", "shading.themeTint"),
];

pub(super) fn shading_theme(shd: E<'_>, node: &mut Node) {
    for (a, k) in SHADING_THEME {
        if let Some(v) = shd.w(a) {
            node.str(k, v);
        }
    }
}

pub(super) fn has_shading_theme(shd: E<'_>) -> bool {
    SHADING_THEME.iter().any(|(a, _)| shd.w(a).is_some())
}

pub(super) fn shading_canonical(shd: E<'_>, node: &mut Node) {
    let val = shd.w("val");
    let fill = shd.w("fill");
    let color = shd.w("color");
    let has_fill = fill.is_some_and(|f| !f.is_empty() && !f.eq_ignore_ascii_case("auto"));
    let solid = val.is_none_or(|v| {
        v.is_empty() || v.eq_ignore_ascii_case("clear") || v.eq_ignore_ascii_case("solid")
    });
    let has_pattern = color.is_some_and(|c| !c.is_empty());
    let theme = has_shading_theme(shd);
    if solid && !has_fill && !has_pattern && !theme {
        return;
    }
    if solid && has_fill && !has_pattern && !theme {
        node.str("fill", hex_color(fill.unwrap_or_default()));
        return;
    }
    if let Some(v) = val.filter(|v| !v.is_empty()) {
        node.str("shading.val", v);
    }
    if let Some(f) = fill.filter(|f| !f.is_empty()) {
        node.str("shading.fill", hex_color(f));
    }
    if has_pattern {
        node.str("shading.color", hex_color(color.unwrap_or_default()));
    }
    shading_theme(shd, node);
}

pub(super) fn color_with_theme_tail(color: E<'_>) -> Option<String> {
    let val = color.w("val");
    let base = val.map(hex_color);
    let theme = color.w("themeColor");
    let shade = color.w("themeShade");
    let tint = color.w("themeTint");
    if theme.is_none() && shade.is_none() && tint.is_none() {
        return base;
    }
    if val.is_some_and(|v| v.eq_ignore_ascii_case("auto"))
        && theme.is_some()
        && shade.is_none()
        && tint.is_none()
    {
        return theme.map(str::to_string);
    }
    let mut tail = base.unwrap_or_default();
    if let Some(t) = theme {
        tail.push_str(&format!(";themeColor={t}"));
    }
    if let Some(s) = shade {
        tail.push_str(&format!(";themeShade={s}"));
    }
    if let Some(t) = tint {
        tail.push_str(&format!(";themeTint={t}"));
    }
    Some(tail.strip_prefix(';').map_or(tail.clone(), str::to_string))
}

pub(super) fn complex_script(primary: Option<E<'_>>, fallback: Option<E<'_>>, node: &mut Node) {
    let cs_of = |e: Option<E<'_>>| {
        w_child(e, "rFonts")
            .and_then(|f| f.w("cs"))
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    if let Some(cs) = cs_of(primary).or_else(|| cs_of(fallback)) {
        if !node.has("font.cs") {
            node.str("font.cs", cs);
        }
    }
    let pick = |name: &str| w_child(primary, name).or_else(|| w_child(fallback, name));
    if let Some(sz) = half_points(pick("szCs").and_then(|s| s.w("val"))) {
        if !node.has("size.cs") {
            node.str("size.cs", sz);
        }
    }
    if let Some(b) = pick("bCs") {
        if !node.has("bold.cs") {
            node.set("bold.cs", Value::Bool(is_on(Some(b))));
        }
    }
    if let Some(i) = pick("iCs") {
        if !node.has("italic.cs") {
            node.set("italic.cs", Value::Bool(is_on(Some(i))));
        }
    }
}

/// The property children OfficeCLI names past those it reads itself.
pub(super) fn fill_unknown(container: Option<E<'_>>, node: &mut Node) {
    let Some(container) = container else { return };
    for child in container.elements() {
        let name = child.name();
        if CURATED.contains(&name) || child.elements().next().is_some() {
            continue;
        }
        if name == "cnfStyle" {
            if let Some(v) = child.w("val").filter(|v| !v.is_empty()) {
                if !node.has(name) {
                    node.str(name, v);
                }
            }
            continue;
        }
        let attrs = child.attrs();
        if attrs.is_empty() {
            if !node.has(name) {
                node.set(name, Value::Bool(true));
            }
            continue;
        }
        if attrs.len() == 1 && attrs[0].name.eq_ignore_ascii_case("val") {
            if !node.has(name) {
                let v = &attrs[0].value;
                if ON_OFF.contains(&name) {
                    node.set(name, Value::Bool(on_off(Some(v)) == Some(true)));
                } else {
                    node.str(name, v.clone());
                }
            }
            continue;
        }
        for a in attrs {
            let key = format!("{name}.{}", a.name);
            if !node.has(&key) {
                node.str(&key, a.value.clone());
            }
        }
    }
}

pub(super) fn get(pkg: &Pkg<'_>, path: &str, depth: usize) -> Result<Node, Fail> {
    Word::new(pkg).get(path, depth)
}

pub(super) fn query(pkg: &Pkg<'_>, selector: &str) -> Result<Vec<Node>, Fail> {
    Word::new(pkg).query(selector)
}

pub(super) fn set(
    pkg: &mut Pkg<'_>,
    path: &str,
    props: &[(String, String)],
) -> Result<(String, Vec<String>), SetFail> {
    edit::set(pkg, path, props)
}

pub(super) fn remove(pkg: &mut Pkg<'_>, path: &str) -> Result<(String, Vec<String>), Fail> {
    edit::remove(pkg, path)
}

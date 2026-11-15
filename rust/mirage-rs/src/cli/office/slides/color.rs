// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! Colors, gradients and effects as OfficeCLI's PowerPoint handler writes
//! them: `#RRGGBB` with alpha last, scheme names in their long form, color
//! transforms after a `+`, a gradient as `linear;c1;c2;deg`, a shadow as
//! `color-blur-angle-distance-opacity`.

use super::super::tree::{A, E};
use super::super::units::{EMU_PER_PT, f2, fmt, hex_color, round_even};
use super::{int, long};

const SCHEME_NAMES: [&str; 30] = [
    "dark1",
    "light1",
    "dark2",
    "light2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hyperlink",
    "followedHyperlink",
    "text1",
    "text2",
    "background1",
    "background2",
    "windowText",
    "windowBackground",
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    "tx1",
    "tx2",
    "bg1",
    "bg2",
    "hlink",
    "folHlink",
    "none",
    "auto",
];

/// A scheme color's name in the form OfficeCLI shows: `tx1` -> `text1`.
pub(super) fn scheme_name(value: &str) -> Option<String> {
    if value.starts_with('#') || !SCHEME_NAMES.iter().any(|n| n.eq_ignore_ascii_case(value)) {
        return None;
    }
    let v = value.to_lowercase();
    Some(
        match v.as_str() {
            "windowtext" => "dark1",
            "windowbackground" => "light1",
            "dk1" => "dark1",
            "dk2" => "dark2",
            "lt1" => "light1",
            "lt2" => "light2",
            "tx1" => "text1",
            "tx2" => "text2",
            "bg1" => "background1",
            "bg2" => "background2",
            "hlink" => "hyperlink",
            "folhlink" => "followedHyperlink",
            other => return Some(other.to_string()),
        }
        .to_string(),
    )
}

/// CSS's named colors, which a preset color (`prstClr`) names.
const NAMED_COLORS: &str = "aliceblue:F0F8FF antiquewhite:FAEBD7 aqua:00FFFF aquamarine:7FFFD4 \
azure:F0FFFF beige:F5F5DC bisque:FFE4C4 black:000000 blanchedalmond:FFEBCD blue:0000FF \
blueviolet:8A2BE2 brown:A52A2A burlywood:DEB887 cadetblue:5F9EA0 chartreuse:7FFF00 \
chocolate:D2691E coral:FF7F50 cornflowerblue:6495ED cornsilk:FFF8DC crimson:DC143C cyan:00FFFF \
darkblue:00008B darkcyan:008B8B darkgoldenrod:B8860B darkgray:A9A9A9 darkgrey:A9A9A9 \
darkgreen:006400 darkkhaki:BDB76B darkmagenta:8B008B darkolivegreen:556B2F darkorange:FF8C00 \
darkorchid:9932CC darkred:8B0000 darksalmon:E9967A darkseagreen:8FBC8F darkslateblue:483D8B \
darkslategray:2F4F4F darkslategrey:2F4F4F darkturquoise:00CED1 darkviolet:9400D3 \
deeppink:FF1493 deepskyblue:00BFFF dimgray:696969 dimgrey:696969 dodgerblue:1E90FF \
firebrick:B22222 floralwhite:FFFAF0 forestgreen:228B22 fuchsia:FF00FF gainsboro:DCDCDC \
ghostwhite:F8F8FF gold:FFD700 goldenrod:DAA520 gray:808080 grey:808080 green:008000 \
greenyellow:ADFF2F honeydew:F0FFF0 hotpink:FF69B4 indianred:CD5C5C indigo:4B0082 ivory:FFFFF0 \
khaki:F0E68C lavender:E6E6FA lavenderblush:FFF0F5 lawngreen:7CFC00 lemonchiffon:FFFACD \
lightblue:ADD8E6 lightcoral:F08080 lightcyan:E0FFFF lightgoldenrodyellow:FAFAD2 \
lightgray:D3D3D3 lightgrey:D3D3D3 lightgreen:90EE90 lightpink:FFB6C1 lightsalmon:FFA07A \
lightseagreen:20B2AA lightskyblue:87CEFA lightslategray:778899 lightslategrey:778899 \
lightsteelblue:B0C4DE lightyellow:FFFFE0 lime:00FF00 limegreen:32CD32 linen:FAF0E6 \
magenta:FF00FF maroon:800000 mediumaquamarine:66CDAA mediumblue:0000CD mediumorchid:BA55D3 \
mediumpurple:9370DB mediumseagreen:3CB371 mediumslateblue:7B68EE mediumspringgreen:00FA9A \
mediumturquoise:48D1CC mediumvioletred:C71585 midnightblue:191970 mintcream:F5FFFA \
mistyrose:FFE4E1 moccasin:FFE4B5 navajowhite:FFDEAD navy:000080 oldlace:FDF5E6 olive:808000 \
olivedrab:6B8E23 orange:FFA500 orangered:FF4500 orchid:DA70D6 palegoldenrod:EEE8AA \
palegreen:98FB98 paleturquoise:AFEEEE palevioletred:DB7093 papayawhip:FFEFD5 peachpuff:FFDAB9 \
peru:CD853F pink:FFC0CB plum:DDA0DD powderblue:B0E0E6 purple:800080 rebeccapurple:663399 \
red:FF0000 rosybrown:BC8F8F royalblue:4169E1 saddlebrown:8B4513 salmon:FA8072 \
sandybrown:F4A460 seagreen:2E8B57 seashell:FFF5EE sienna:A0522D silver:C0C0C0 skyblue:87CEEB \
slateblue:6A5ACD slategray:708090 slategrey:708090 snow:FFFAFA springgreen:00FF7F \
steelblue:4682B4 tan:D2B48C teal:008080 thistle:D8BFD8 tomato:FF6347 turquoise:40E0D0 \
violet:EE82EE wheat:F5DEB3 white:FFFFFF whitesmoke:F5F5F5 yellow:FFFF00 yellowgreen:9ACD32 \
transparent:000000";

fn named_color(name: &str) -> Option<&'static str> {
    let want = name.trim().to_lowercase();
    NAMED_COLORS.split(' ').find_map(|pair| {
        pair.split_once(':')
            .filter(|(n, _)| *n == want)
            .map(|(_, h)| h)
    })
}

const TRANSFORMS: [&str; 9] = [
    "lumMod", "lumOff", "shade", "tint", "satMod", "satOff", "hueMod", "hueOff", "alpha",
];

fn with_transforms(base: String, color: E<'_>) -> String {
    let rgb = color.is(A, "srgbClr");
    let mut out = base;
    for c in color.elements() {
        if !TRANSFORMS.contains(&c.name()) || (c.name() == "alpha" && rgb) {
            continue;
        }
        let Some(v) = c.attr("val").filter(|v| !v.is_empty()) else {
            continue;
        };
        match int(Some(v)) {
            Some(n) => out.push_str(&format!("+{}{}", c.name(), n / 1000)),
            None => out.push_str(&format!("+{}{v}", c.name())),
        }
    }
    out
}

fn alpha_byte(alpha: i64) -> i64 {
    round_even(alpha as f64 / 100_000.0 * 255.0).clamp(0.0, 255.0) as i64
}

fn hex_with_alpha(rgb: E<'_>) -> String {
    let hex = hex_color(rgb.attr("val").unwrap_or_default());
    match int(rgb.child(A, "alpha").and_then(|a| a.attr("val"))) {
        Some(alpha) if alpha < 100_000 => format!("{hex}{:02X}", alpha_byte(alpha)),
        _ => hex,
    }
}

/// A color child of `parent` as OfficeCLI writes one.
pub(super) fn read_color(parent: Option<E<'_>>) -> Option<String> {
    let parent = parent?;
    if let Some(rgb) = parent
        .child(A, "srgbClr")
        .filter(|r| r.attr("val").is_some())
    {
        return Some(with_transforms(hex_with_alpha(rgb), rgb));
    }
    if let Some(scheme) = parent.child(A, "schemeClr") {
        if let Some(raw) = scheme.attr("val").filter(|v| !v.is_empty()) {
            return Some(with_transforms(
                scheme_name(raw).unwrap_or_else(|| raw.to_string()),
                scheme,
            ));
        }
    }
    if let Some(sys) = parent.child(A, "sysClr") {
        let hex = match (
            sys.attr("lastClr").filter(|v| !v.is_empty()),
            sys.attr("val"),
        ) {
            (Some(last), _) => Some(last.to_string()),
            (None, Some("window")) => Some("FFFFFF".to_string()),
            (None, Some("windowText")) => Some("000000".to_string()),
            _ => None,
        };
        if let Some(hex) = hex {
            return Some(with_transforms(hex.to_uppercase(), sys));
        }
    }
    if let Some(preset) = parent.child(A, "prstClr") {
        if let Some(name) = preset.attr("val").filter(|v| !v.is_empty()) {
            let base = named_color(name).map_or_else(|| name.to_string(), str::to_string);
            return Some(with_transforms(base, preset));
        }
    }
    None
}

/// A highlight's color, read from its RGB or scheme child.
pub(super) fn read_highlight(h: Option<E<'_>>) -> Option<String> {
    let h = h?;
    if h.child(A, "srgbClr").is_none() && h.child(A, "schemeClr").is_none() {
        return None;
    }
    read_color(Some(h))
}

/// An effect's color with the `#` OfficeCLI adds to a bare hex.
pub(super) fn effect_color(color: &str) -> String {
    if color.is_empty() {
        return String::new();
    }
    let (head, tail) = match color.find('+') {
        Some(at) => (&color[..at], &color[at..]),
        None => (color, ""),
    };
    let hex = head.strip_prefix('#').unwrap_or(head);
    if hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        if hex.len() == 6 {
            return format!("#{}{tail}", hex.to_uppercase());
        }
        if hex.len() == 8 {
            return format!("#{}{tail}", hex[..6].to_uppercase());
        }
    }
    color.to_string()
}

fn gradient_stop_color(gs: E<'_>) -> String {
    if let Some(rgb) = gs.child(A, "srgbClr") {
        if let Some(val) = rgb.attr("val") {
            let hex = hex_color(val);
            let mut base = hex.clone();
            let mut suffix = None;
            if let Some(alpha) = int(rgb.child(A, "alpha").and_then(|a| a.attr("val"))) {
                if alpha < 100_000 {
                    let byte = alpha_byte(alpha);
                    if (byte as f64 / 255.0 * 100_000.0) as i64 == alpha {
                        base = format!("{hex}{byte:02X}");
                    } else {
                        suffix = Some(format!("+alpha={alpha}"));
                    }
                }
            }
            let out = with_transforms(base, rgb);
            return match suffix {
                Some(s) => out + &s,
                None => out,
            };
        }
    }
    if let Some(scheme) = gs.child(A, "schemeClr") {
        if let Some(v) = scheme.attr("val") {
            return with_transforms(scheme_name(v).unwrap_or_else(|| v.to_string()), scheme);
        }
    }
    if let Some(v) = gs.child(A, "sysClr").and_then(|c| c.attr("val")) {
        return v.to_string();
    }
    if let Some(v) = gs.child(A, "prstClr").and_then(|c| c.attr("val")) {
        return v.to_string();
    }
    "?".to_string()
}

/// Where a path gradient focuses.
pub(super) fn focus_of(path: E<'_>) -> &'static str {
    let Some(rect) = path.child(A, "fillToRect") else {
        return "center";
    };
    let l = long(rect.attr("l")).unwrap_or(50_000);
    let t = long(rect.attr("t")).unwrap_or(50_000);
    match (l, t) {
        (0, 0) => "tl",
        (l, 0) if l >= 100_000 => "tr",
        (0, t) if t >= 100_000 => "bl",
        (l, t) if l >= 100_000 && t >= 100_000 => "br",
        _ => "center",
    }
}

/// An angle in 60000ths of a degree, whole when it is one.
pub(super) fn degrees(angle: i64) -> String {
    let deg = angle as f64 / 60_000.0;
    if deg.fract() == 0.0 {
        format!("{}", deg as i64)
    } else {
        f2(deg)
    }
}

pub(super) fn gradient_string(grad: E<'_>) -> String {
    let stops = grad
        .child(A, "gsLst")
        .map(|l| l.children(A, "gs"))
        .unwrap_or_default();
    if stops.is_empty() {
        return "gradient".to_string();
    }
    let data: Vec<(String, Option<i64>)> = stops
        .iter()
        .map(|gs| (gradient_stop_color(*gs), int(gs.attr("pos"))))
        .collect();
    let n = data.len() as i64;
    let custom = data.iter().enumerate().any(|(i, (_, pos))| {
        let expected = if n == 1 {
            0
        } else {
            i as i64 * 100_000 / (n - 1)
        };
        pos.unwrap_or(0) != expected
    });
    let parts: Vec<String> = data
        .iter()
        .map(|(c, pos)| match pos {
            Some(p) if custom => format!("{c}@p{p}"),
            _ => c.clone(),
        })
        .collect();
    if let Some(path) = grad.child(A, "path") {
        let prefix = if path.attr("path") == Some("shape") {
            "path"
        } else {
            "radial"
        };
        return format!("{prefix}:{}-{}", parts.join("-"), focus_of(path));
    }
    let angle = int(grad.child(A, "lin").and_then(|l| l.attr("ang"))).unwrap_or(0);
    format!("linear;{};{}", parts.join(";"), degrees(angle))
}

/// Whether a gradient carries tuning its string form cannot write back.
pub(super) fn gradient_tuned(grad: E<'_>) -> bool {
    if grad.attr("flip").is_some() || grad.child(A, "tileRect").is_some() {
        return true;
    }
    if let Some(rect) = grad.child(A, "path").and_then(|p| p.child(A, "fillToRect")) {
        return ["l", "t", "r", "b"]
            .iter()
            .any(|k| long(rect.attr(k)).unwrap_or(50_000) != 50_000);
    }
    false
}

/// An EMU length in points, to two places.
pub(super) fn points_of(emu: i64) -> String {
    f2(emu as f64 / EMU_PER_PT)
}

fn alpha_of(e: E<'_>) -> Option<i64> {
    int(e
        .descendants()
        .into_iter()
        .find(|d| d.is(A, "alpha"))
        .and_then(|a| a.attr("val")))
}

pub(super) fn shadow_spec(e: E<'_>, fallback_opacity: &str) -> String {
    let color = effect_color(&read_color(Some(e)).unwrap_or_else(|| "000000".to_string()));
    let blur = long(e.attr("blurRad")).map_or_else(|| "4".to_string(), points_of);
    let angle = long(e.attr("dir")).map_or_else(|| "45".to_string(), |d| f2(d as f64 / 60_000.0));
    let dist = long(e.attr("dist")).map_or_else(|| "3".to_string(), points_of);
    let opacity =
        alpha_of(e).map_or_else(|| fallback_opacity.to_string(), |a| f2(a as f64 / 1000.0));
    format!("{color}-{blur}-{angle}-{dist}-{opacity}")
}

pub(super) fn glow_spec(e: E<'_>, fallback_opacity: &str) -> String {
    let color = effect_color(&read_color(Some(e)).unwrap_or_else(|| "000000".to_string()));
    let rad = long(e.attr("rad")).map_or_else(|| "8".to_string(), points_of);
    let opacity =
        alpha_of(e).map_or_else(|| fallback_opacity.to_string(), |a| f2(a as f64 / 1000.0));
    format!("{color}-{rad}-{opacity}")
}

pub(super) fn reflection_name(e: E<'_>) -> String {
    match int(e.attr("endPos")).unwrap_or(0) {
        55_000 => "tight".to_string(),
        90_000 => "half".to_string(),
        100_000 => "full".to_string(),
        end => (end / 1000).to_string(),
    }
}

fn shadow_color_tuned(shadow: E<'_>) -> bool {
    let Some(color) = shadow
        .child(A, "srgbClr")
        .or_else(|| shadow.child(A, "schemeClr"))
    else {
        return false;
    };
    color.elements().any(|t| {
        matches!(
            t.name(),
            "lumMod" | "lumOff" | "shade" | "tint" | "satMod" | "satOff" | "hueMod" | "hueOff"
        )
    })
}

/// Whether a shadow is one `shadow=` writes back whole.
pub(super) fn plain_outer_shadow(s: E<'_>) -> bool {
    if ["sx", "sy", "kx", "ky"].iter().any(|k| s.attr(k).is_some()) {
        return false;
    }
    if s.attr("algn").is_some_and(|a| a != "tl") {
        return false;
    }
    if super::boolean(s.attr("rotWithShape")) == Some(true) {
        return false;
    }
    !shadow_color_tuned(s)
}

pub(super) fn plain_inner_shadow(s: E<'_>) -> bool {
    !shadow_color_tuned(s)
}

pub(super) fn plain_reflection(r: E<'_>) -> bool {
    if long(r.attr("blurRad")) != Some(6350)
        || int(r.attr("stA")) != Some(52_000)
        || int(r.attr("stPos")).is_some_and(|p| p != 0)
        || int(r.attr("endA")) != Some(300)
    {
        return false;
    }
    if !matches!(
        int(r.attr("endPos")).unwrap_or(0),
        55_000 | 90_000 | 100_000
    ) {
        return false;
    }
    if long(r.attr("dist")).is_some_and(|d| d != 0)
        || int(r.attr("dir")) != Some(5_400_000)
        || int(r.attr("sy")) != Some(-100_000)
        || r.attr("algn") != Some("bl")
        || super::boolean(r.attr("rotWithShape")) == Some(true)
    {
        return false;
    }
    !["fadeDir", "sx", "kx", "ky"]
        .iter()
        .any(|k| r.attr(k).is_some())
}

pub(super) const HANDLED_EFFECTS: [&str; 7] = [
    "outerShdw",
    "innerShdw",
    "glow",
    "fillOverlay",
    "reflection",
    "softEdge",
    "blur",
];

pub(super) fn bevel_spec(b: E<'_>) -> String {
    let preset = b.attr("prst").unwrap_or("circle");
    let w = long(b.attr("w")).unwrap_or(76_200);
    let h = long(b.attr("h")).unwrap_or(76_200);
    if w == 76_200 && h == 76_200 {
        preset.to_string()
    } else if w == h {
        format!("{preset}-{}", points_of(w))
    } else {
        format!("{preset}-{}-{}", points_of(w), points_of(h))
    }
}

/// A rotation in 60000ths of a degree, to `places` decimals.
pub(super) fn rotation(rot: i64, places: usize) -> String {
    fmt(rot as f64 / 60_000.0, places)
}

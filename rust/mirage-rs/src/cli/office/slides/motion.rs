// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A slide's transition and a shape's animations, named as OfficeCLI
//! names them: `fade`, `push-left`, `morph`, and `fly-entrance-left-500`
//! with any repeat, delay or auto-reverse after.

use std::sync::LazyLock;

use fancy_regex::Regex;

use super::super::node::{Node, Value};
use super::super::tree::{A, E, P, P14, outer_xml};
use super::{boolean, id_of, int, long};

fn expand_direction(dir: &str) -> String {
    match dir {
        "l" => "left",
        "r" => "right",
        "u" => "up",
        "d" => "down",
        other => other,
    }
    .to_string()
}

fn default_p14_direction(t: &str, dir: &str) -> bool {
    match t {
        "vortex" | "glitter" | "pan" | "prism" | "switch" | "flip" | "ferris" | "gallery"
        | "conveyor" | "reveal" => dir == "l",
        "doors" | "window" => dir == "horz",
        "warp" | "flythrough" | "shred" => dir == "in",
        "ripple" => dir == "center",
        _ => false,
    }
}

fn transition_direction(t: E<'_>) -> Option<String> {
    let dir = t.attr("dir");
    if t.ns() == P {
        match t.name() {
            "fade" if boolean(t.attr("thruBlk")) == Some(true) => {
                return Some("thru-black".to_string());
            }
            "wipe" | "push" if dir.is_some() => {
                return Some(
                    match dir {
                        Some("r") => "right",
                        Some("u") => "up",
                        Some("d") => "down",
                        _ => "left",
                    }
                    .to_string(),
                );
            }
            "cover" | "pull" if dir.is_some() => {
                return Some(expand_direction(&dir?.to_lowercase()));
            }
            "zoom" if dir.is_some() => return (dir == Some("out")).then(|| "out".to_string()),
            "split" => {
                let dir = dir?;
                let orient = if t.attr("orient") == Some("vert") {
                    "vertical"
                } else {
                    "horizontal"
                };
                let inout = if dir == "out" { "out" } else { "in" };
                return Some(format!("{orient}-{inout}"));
            }
            "blinds" | "checker" | "comb" | "randomBar" if dir.is_some() => {
                return (dir == Some("vert")).then(|| "vertical".to_string());
            }
            "wheel" => {
                if let Some(spokes) = long(t.attr("spokes")).filter(|s| *s != 4) {
                    return Some(spokes.to_string());
                }
            }
            "strips" if dir.is_some() => match dir {
                Some("rd") => return None,
                Some("lu") => return Some("leftup".to_string()),
                Some("ru") => return Some("rightup".to_string()),
                Some("ld") => return Some("leftdown".to_string()),
                _ => {}
            },
            _ => {}
        }
    }
    if let Some(d) = dir.filter(|d| !d.is_empty()) {
        let d = d.to_lowercase();
        return (d != "l").then(|| expand_direction(&d));
    }
    t.attr("option")
        .filter(|o| !o.is_empty() && *o != "byObject")
        .map(str::to_string)
}

/// A typed `p:transition` as OfficeCLI names it.
fn typed_transition(trans: E<'_>, node: &mut Node) {
    let tail = |node: &mut Node| {
        if let Some(spd) = trans.attr("spd") {
            node.str("transitionSpeed", spd);
        }
        if let Some(dur) = trans.attr_ns("dur", P14) {
            node.str("transitionDuration", dur);
        }
        if let Some(adv) = trans.attr("advTm") {
            node.str("advanceTime", adv);
        }
        if let Some(click) = boolean(trans.attr("advClick")) {
            node.set("advanceClick", Value::Bool(click));
        }
    };
    if let Some(t) = trans.elements().find(|c| c.name() != "extLst") {
        if t.name() == "prstTrans" {
            if let Some(prst) = t.attr("prst").filter(|p| !p.is_empty()) {
                let inv = t
                    .attr("invX")
                    .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
                node.str(
                    "transition",
                    if inv {
                        format!("{prst}-out")
                    } else {
                        prst.to_string()
                    },
                );
                tail(node);
                return;
            }
        }
        let mut name = t.name().to_lowercase();
        if name == "randombar" {
            name = "bars".to_string();
        }
        match transition_direction(t) {
            Some(d) => node.str("transition", format!("{name}-{d}")),
            None => node.str("transition", name),
        }
    }
    tail(node);
}

fn transition_scope(xml: &str) -> Option<String> {
    let at = xml.find("<p:transition")?;
    if let Some(wrap) = xml[..at].rfind("<mc:AlternateContent") {
        if let Some(end) = xml[wrap..].find("</mc:AlternateContent>") {
            if wrap + end > at {
                return Some(xml[wrap..wrap + end + "</mc:AlternateContent>".len()].to_string());
            }
        }
    }
    let open = at + xml[at..].find('>')?;
    if xml.as_bytes()[open - 1] == b'/' {
        return Some(xml[at..=open].to_string());
    }
    let close = open + xml[open..].find("</p:transition>")?;
    Some(xml[at..close + "</p:transition>".len()].to_string())
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid pattern")
}

static MC: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?s)<mc:AlternateContent[^>]*>(.*?)</mc:AlternateContent>"));
static MORPH: LazyLock<Regex> = LazyLock::new(|| re(r"<p159:morph(?:\s+([^/]*))?/?>"));
static P15: LazyLock<Regex> = LazyLock::new(|| re(r"<p15:prstTrans(?:\s+([^/]*))?/?>"));
static P14_EL: LazyLock<Regex> = LazyLock::new(|| re(r"<p14:(\w+)(?:\s+([^/]*))?/?>"));
static OPEN: LazyLock<Regex> = LazyLock::new(|| re(r"<p:transition([^>]*?)(?:/>|>)"));
static TYPED: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?s)<p:transition([^>]*?)(?:/>|>(.*?)</p:transition>)"));
static CHILD: LazyLock<Regex> = LazyLock::new(|| re(r"<(?:p|p14|p159):(\w+)([^/>]*)[\s/>]"));

fn capture(re: &Regex, text: &str, group: usize) -> Option<String> {
    re.captures(text)
        .ok()
        .flatten()
        .and_then(|c| c.get(group).map(|m| m.as_str().to_string()))
}

fn first(pattern: &str, text: &str) -> Option<String> {
    capture(&re(pattern), text, 1)
}

fn transition_attrs(attrs: &str, node: &mut Node, duration: bool) {
    if let Some(spd) = first(r#"spd="(\w+)""#, attrs) {
        node.str("transitionSpeed", spd);
    }
    if duration {
        if let Some(dur) = first(r#"(?:p14:)?dur="(\d+)""#, attrs) {
            node.str("transitionDuration", dur);
        }
    }
    if let Some(adv) = first(r#"advTm="(\d+)""#, attrs) {
        node.str("advanceTime", adv);
    }
    if let Some(click) = first(r#"advClick="(\d+)""#, attrs) {
        node.set("advanceClick", Value::Bool(click == "1"));
    }
}

/// A transition read off the slide's XML, as OfficeCLI reads one wrapped
/// in markup compatibility.
fn xml_transition(xml: &str, node: &mut Node) {
    let Some(scope) = transition_scope(xml) else {
        return;
    };
    if let Some(inner) = capture(&MC, &scope, 1) {
        if let Ok(Some(m)) = MORPH.captures(&inner) {
            let attrs = m.get(1).map_or("", |g| g.as_str());
            let option = first(r#"option="(\w+)""#, attrs);
            node.str(
                "transition",
                match option.filter(|o| o != "byObject") {
                    Some(o) => format!("morph-{o}"),
                    None => "morph".to_string(),
                },
            );
            if let Some(a) = capture(&OPEN, &inner, 1) {
                transition_attrs(&a, node, true);
            }
            return;
        }
        if let Ok(Some(m)) = P15.captures(&inner) {
            let attrs = m.get(1).map_or("", |g| g.as_str()).to_string();
            if let Some(prst) = first(r#"prst="(\w+)""#, &attrs) {
                let inv = re(r#"invX="(1|true)""#).is_match(&attrs).unwrap_or(false);
                node.str("transition", if inv { format!("{prst}-out") } else { prst });
                if let Some(a) = capture(&OPEN, &inner, 1) {
                    transition_attrs(&a, node, true);
                }
                return;
            }
        }
        if let Ok(Some(m)) = P14_EL.captures(&inner) {
            let mut name = m.get(1).map_or("", |g| g.as_str()).to_lowercase();
            let attrs = m.get(2).map_or("", |g| g.as_str()).to_string();
            if name == "prism" {
                let content = re(r#"isContent="(1|true)""#)
                    .is_match(&attrs)
                    .unwrap_or(false);
                let inverted = re(r#"isInverted="(1|true)""#)
                    .is_match(&attrs)
                    .unwrap_or(false);
                if content && inverted {
                    name = "orbit".to_string();
                } else if content {
                    name = "rotate".to_string();
                }
            } else if let Some(dir) = first(r#"dir="(\w+)""#, &attrs) {
                let dir = dir.to_lowercase();
                if !default_p14_direction(&name, &dir) {
                    name = format!("{name}-{}", expand_direction(&dir));
                }
            }
            node.str("transition", name);
            if let Some(a) = capture(&OPEN, &inner, 1) {
                transition_attrs(&a, node, false);
            }
            return;
        }
    }
    let Ok(Some(typed)) = TYPED.captures(&scope) else {
        return;
    };
    let attrs = typed.get(1).map_or("", |g| g.as_str()).to_string();
    let inner = typed.get(2).map_or("", |g| g.as_str()).to_string();
    if let Ok(Some(child)) = CHILD.captures(&inner) {
        let mut name = child.get(1).map_or("", |g| g.as_str()).to_lowercase();
        if name == "randombar" {
            name = "bars".to_string();
        }
        let child_attrs = child.get(2).map_or("", |g| g.as_str());
        if let Some(dir) = first(r#"dir="(\w+)""#, child_attrs) {
            name = format!("{name}-{}", dir.to_lowercase());
        }
        if name == "fade"
            && re(r#"thruBlk="(1|true)""#)
                .is_match(child_attrs)
                .unwrap_or(false)
        {
            name = "fade-thru-black".to_string();
        }
        node.str("transition", name);
    }
    transition_attrs(&attrs, node, false);
}

/// The slide's transition onto `node`.
pub(super) fn transition(slide: E<'_>, node: &mut Node) {
    match slide.child(P, "transition") {
        Some(trans) if trans.elements().any(|c| c.name() != "extLst") => {
            typed_transition(trans, node)
        }
        _ => xml_transition(&outer_xml(slide), node),
    }
}

fn effect_name(filter: &str, preset: i64, cls: &str) -> String {
    if cls == "emphasis" {
        let name = match preset {
            1 => Some("fillColor"),
            6 => Some("grow"),
            7 => Some("lineColor"),
            8 => Some("spin"),
            9 => Some("transparency"),
            10 => Some("fade"),
            14 => Some("wave"),
            19 => Some("objectColor"),
            21 => Some("complementaryColor"),
            22 => Some("complementaryColor2"),
            23 => Some("contrastingColor"),
            24 => Some("darken"),
            25 => Some("desaturate"),
            26 => Some("pulse"),
            27 => Some("colorPulse"),
            30 => Some("lighten"),
            32 => Some("teeter"),
            _ => None,
        };
        if let Some(n) = name {
            return n.to_string();
        }
    }
    for prefix in ["blinds", "checkerboard", "crawl", "strips", "wheel", "wipe"] {
        if filter.starts_with(prefix) {
            return prefix.to_string();
        }
    }
    if filter.starts_with("barn") {
        return "split".to_string();
    }
    if matches!(
        filter,
        "box" | "circle" | "diamond" | "dissolve" | "flash" | "plus" | "random" | "wedge"
    ) {
        return filter.to_string();
    }
    if filter == "fade" && preset != 17 {
        return "fade".to_string();
    }
    if cls == "emphasis" {
        return "unknown".to_string();
    }
    match preset {
        1 => "appear",
        2 => "fly",
        3 => "blinds",
        4 => "box",
        5 => "checkerboard",
        6 => "circle",
        7 => "crawl",
        8 => "diamond",
        9 => "dissolve",
        10 => "fade",
        11 => "flash",
        12 => "float",
        13 => "plus",
        14 => "random",
        15 => "split",
        16 => "strips",
        17 => "swivel",
        18 => "wedge",
        19 => "wheel",
        20 => "wipe",
        21 => "zoom",
        24 => "bounce",
        _ => "unknown",
    }
    .to_string()
}

fn duration_of(ctn: E<'_>, name: &str) -> Option<i64> {
    let e = ctn.first_named(P, name)?;
    int(e
        .child(P, "cBhvr")
        .and_then(|b| b.child(P, "cTn"))
        .and_then(|c| c.attr("dur")))
}

/// A shape's animations, as `animation`, `animation2`, …, and its motion path.
pub(super) fn animations(slide: E<'_>, target: E<'_>, node: &mut Node, chart: bool) {
    let Some(id) = id_of(target) else { return };
    let Some(timing) = slide.child(P, "timing") else {
        return;
    };
    let spid = id.to_string();
    let targets: Vec<E<'_>> = timing
        .descendants_named(P, "spTgt")
        .into_iter()
        .filter(|t| t.attr("spid") == Some(spid.as_str()))
        .collect();
    if targets.is_empty() {
        return;
    }
    let mut seen: Vec<E<'_>> = Vec::new();
    let mut index = 0;
    for t in &targets {
        let mut effect = None;
        let mut cur = Some(*t);
        while let Some(c) = cur {
            if c.is(P, "cTn") && c.attr("presetID").is_some() && c.attr("presetClass").is_some() {
                let raw = c.attr("presetClass").unwrap_or_default();
                let motion =
                    c.first_named(P, "animMotion").is_some() && matches!(raw, "path" | "motion");
                if !motion {
                    effect = Some(c);
                    break;
                }
            }
            cur = c.parent();
        }
        let Some(effect) = effect else { continue };
        if seen.contains(&effect) {
            continue;
        }
        seen.push(effect);
        let raw = effect.attr("presetClass").unwrap_or_default();
        let cls = match raw {
            "exit" => "exit",
            "emphasis" | "emph" => "emphasis",
            _ => "entrance",
        };
        let dur = duration_of(effect, "animEffect")
            .or_else(|| duration_of(effect, "animScale"))
            .or_else(|| duration_of(effect, "animRot"))
            .or_else(|| duration_of(effect, "anim"))
            .or_else(|| int(effect.attr("dur")))
            .unwrap_or(500);
        let filter = effect
            .first_named(P, "animEffect")
            .and_then(|a| a.attr("filter"))
            .unwrap_or_default();
        let name = effect_name(filter, int(effect.attr("presetID")).unwrap_or(0), cls);
        let sub = int(effect.attr("presetSubtype")).unwrap_or(0);
        let travels = matches!(name.as_str(), "fly" | "wipe" | "crawl");
        let dir = match sub {
            8 => Some("left"),
            2 => Some("right"),
            1 if travels => Some("up"),
            4 if travels => Some("down"),
            _ => None,
        };
        let mut suffix = String::new();
        if let Some(repeat) = effect
            .attr("repeatCount")
            .filter(|r| !r.is_empty() && *r != "1000")
        {
            if repeat == "indefinite" {
                suffix.push_str("-repeat=indefinite");
            } else if let Some(rc) = int(Some(repeat)) {
                suffix.push_str(&format!("-repeat={}", rc / 1000));
            }
        }
        let mut walk = effect.parent();
        while let Some(w) = walk {
            if w.is(P, "cTn") {
                let delay = w
                    .child(P, "stCondLst")
                    .and_then(|l| l.children(P, "cond").into_iter().next())
                    .and_then(|c| c.attr("delay"));
                if let Some(d) = delay
                    .filter(|d| !d.is_empty() && *d != "0")
                    .and_then(|d| int(Some(d)))
                {
                    if d > 0 {
                        suffix.push_str(&format!("-delay={d}"));
                        break;
                    }
                }
            }
            walk = w.parent();
        }
        if boolean(effect.attr("autoRev")) == Some(true) {
            suffix.push_str("-autoreverse");
        }
        index += 1;
        let key = if index == 1 {
            "animation".to_string()
        } else {
            format!("animation{index}")
        };
        let body = match dir {
            Some(d) => format!("{name}-{cls}-{d}-{dur}"),
            None => format!("{name}-{cls}-{dur}"),
        };
        node.str(&key, body + &suffix);
    }
    for t in &targets {
        let mut cur = Some(*t);
        while let Some(c) = cur {
            if c.is(P, "cTn") {
                let raw = c.attr("presetClass").unwrap_or_default();
                if matches!(raw, "path" | "motion") {
                    if let Some(m) = c.first_named(P, "animMotion") {
                        if let Some(path) = m.attr("path") {
                            node.str("motionPath", path);
                        }
                        break;
                    }
                }
            }
            cur = c.parent();
        }
    }
    if chart {
        let bld = timing
            .child(P, "bldLst")
            .map(|l| l.children(P, "bldGraphic"))
            .unwrap_or_default()
            .into_iter()
            .find(|b| b.attr("spid") == Some(spid.as_str()));
        if let Some(bld) = bld {
            let v = bld
                .child(P, "bldSub")
                .and_then(|s| s.child_of(A, &["bldChart"]))
                .and_then(|c| c.attr("bld"))
                .filter(|v| !v.is_empty());
            node.str("chartBuild", v.unwrap_or("asWhole"));
        }
    }
}

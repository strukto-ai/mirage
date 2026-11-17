// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! Paths into a Word document: what each names and how a path that misses
//! says what is there.

use super::super::errors::Fail;
use super::super::node::{Node, number_text};
use super::super::tree::{E, Id, MC, W, W14};
use super::doc::Word;
use super::{
    Segment, fail, has_ancestor_within, is_math_wrapper, jsn, para_id, parse_path, row_cells,
    table_rows, w_child, w_val,
};

/// The element a path names, the path it resolved to, or what is there instead.
struct Found<'t> {
    element: Option<E<'t>>,
    path: String,
    context: Option<String>,
}

fn miss<'t>(context: Option<String>) -> Found<'t> {
    Found {
        element: None,
        path: String::new(),
        context,
    }
}

fn available_context(parent: E<'_>, parent_path: &str, requested: &str, count: usize) -> String {
    if count > 0 {
        return format!("Available at {parent_path}: {requested}[1]..{requested}[{count}]");
    }
    let at_body = parent.is(W, "body");
    let mut groups: Vec<(String, usize)> = Vec::new();
    for c in parent.elements() {
        let key = if at_body && c.is(W, "p") && is_math_wrapper(c) {
            "oMathPara".to_string()
        } else {
            c.name().to_string()
        };
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 += 1,
            None => groups.push((key, 1)),
        }
    }
    let types: Vec<String> = groups
        .iter()
        .take(10)
        .map(|(k, n)| format!("{k}({n})"))
        .collect();
    if types.is_empty() {
        format!("No children at {parent_path}")
    } else {
        format!(
            "No {requested} found at {parent_path}. Available children: {}",
            types.join(", ")
        )
    }
}

/// `/name[N]` with `name` one of `names`, matched without case: the name as written and N.
fn indexed<'s>(path: &'s str, names: &[&str], last: bool) -> Option<(&'s str, &'s str)> {
    let rest = path.strip_prefix('/')?;
    let open = rest.find('[')?;
    let name = &rest[..open];
    if !names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        return None;
    }
    let inner = rest[open + 1..].strip_suffix(']')?;
    let ok = super::is_digits(inner) || (last && inner.eq_ignore_ascii_case("last()"));
    ok.then_some((name, inner))
}

fn starts_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

impl<'p> Word<'p> {
    /// The node at `path`, `depth` levels of children deep.
    pub(crate) fn get(&self, path: &str, depth: usize) -> Result<Node, Fail> {
        if path.is_empty() {
            return Err(fail("Path cannot be empty.".to_string()));
        }
        if path == "/" {
            return Ok(self.root());
        }
        if let Some((name, _)) = indexed(
            path,
            &[
                "watermark",
                "settings",
                "styles",
                "numbering",
                "docDefaults",
            ],
            false,
        ) {
            return Err(fail(format!(
                "{name} is a singleton; use /{name} (no index)."
            )));
        }
        if let Some((_, inner)) = indexed(path, &["section"], true) {
            let sects = self.sections();
            let idx = if inner.eq_ignore_ascii_case("last()") {
                sects.len() as f64
            } else {
                jsn(inner)
            };
            if idx < 1.0 || idx > sects.len() as f64 {
                return Err(fail(format!(
                    "Section {} not found (total: {})",
                    number_text(idx),
                    sects.len()
                )));
            }
            let at = idx as usize;
            return Ok(self.section(sects[at - 1], &format!("/section[{at}]")));
        }
        if path == "/docDefaults" {
            let mut node = Node::new(path, "docDefaults");
            self.doc_defaults(&mut node);
            return Ok(node);
        }
        if let Some(id) = path
            .strip_prefix("/styles/")
            .filter(|id| !id.is_empty() && !id.contains('/'))
        {
            let style = self.styles().and_then(|s| {
                s.children(W, "style")
                    .into_iter()
                    .find(|x| x.w("styleId") == Some(id) || w_val(x.child(W, "name")) == Some(id))
            });
            return Ok(match style {
                Some(style) => self.style_node(style, path, id),
                None => {
                    let mut err = Node::new(path, "error");
                    err.text = Some(format!("Style '{id}' not found"));
                    err
                }
            });
        }
        let segments = parse_path(path)?;
        if let [first] = segments.as_slice() {
            let lname = first.name.to_lowercase();
            if lname == "header" || lname == "footer" {
                let parts = if lname == "header" {
                    &self.header_parts
                } else {
                    &self.footer_parts
                };
                let idx = if first.predicate.as_deref() == Some("last()") {
                    parts.len().checked_sub(1)
                } else {
                    first.index.unwrap_or(1).checked_sub(1)
                };
                let part = idx.and_then(|i| parts.get(i));
                let tree = part.and_then(|p| self.part_root(p));
                return Ok(match (part, tree) {
                    (Some(part), Some(tree)) => self.header_footer_node(tree, part, path, depth),
                    _ => {
                        let mut err = Node::new(path, "error");
                        err.text = Some(format!("Path not found: {path}"));
                        err
                    }
                });
            }
        }
        let found = self.navigate(&segments)?;
        let Some(element) = found.element else {
            let mut msg = format!("Path not found: {path}");
            if let Some(c) = found.context {
                msg.push_str(&format!(". {c}"));
            }
            return Err(fail(msg));
        };
        let at = if found.path.is_empty() {
            path
        } else {
            &found.path
        };
        Ok(self.element(element, at, depth))
    }

    /// The part and element `path` names for a command that changes it,
    /// with the path as the navigator spells it.
    pub(crate) fn locate(&self, path: &str) -> Result<(String, Id, String), Fail> {
        let (element, at) = if path == "/" || path.eq_ignore_ascii_case("/body") {
            (self.body(), "/body".to_string())
        } else {
            let segments = parse_path(path)?;
            let found = self.navigate(&segments)?;
            let Some(element) = found.element else {
                let mut msg = format!("Path not found: {path}");
                if let Some(c) = found.context {
                    msg.push_str(&format!(". {c}"));
                }
                return Err(fail(msg));
            };
            let at = if found.path.is_empty() {
                path.to_string()
            } else {
                found.path
            };
            (Some(element), at)
        };
        let Some(element) = element else {
            return Err(fail(format!("Path not found: {path}")));
        };
        let part = self
            .part_holding(element)
            .ok_or_else(|| fail(format!("Path not found: {path}")))?;
        Ok((part, element.id, at))
    }

    /// The part whose tree holds `e`.
    pub(crate) fn part_holding(&self, e: E<'_>) -> Option<String> {
        let mut parts = vec![self.main_part.clone()];
        parts.extend(self.header_parts.iter().cloned());
        parts.extend(self.footer_parts.iter().cloned());
        parts.extend(self.styles_part.iter().cloned());
        parts.extend(self.numbering_part.iter().cloned());
        parts.extend(self.settings_part.iter().cloned());
        for kind in ["comments", "footnotes", "endnotes"] {
            parts.extend(self.pkg.related(&self.main_part, kind));
        }
        parts
            .into_iter()
            .find(|p| self.pkg.xml(p).is_some_and(|t| std::ptr::eq(t, e.t)))
    }

    pub(super) fn sections(&self) -> Vec<E<'p>> {
        let body = self.body();
        let mut out: Vec<E<'p>> = body
            .map(|b| b.children(W, "p"))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| w_child(p.child(W, "pPr"), "sectPr"))
            .collect();
        if let Some(last) = w_child(body, "sectPr") {
            out.push(last);
        }
        out
    }

    fn body_index(body: E<'p>) -> (Vec<E<'p>>, Vec<E<'p>>) {
        fn collect<'t>(e: E<'t>, flat: &mut Vec<E<'t>>) {
            for c in e.elements() {
                if c.is(W, "customXml") {
                    collect(c, flat);
                } else {
                    flat.push(c);
                }
            }
        }
        let mut flat = Vec::new();
        collect(body, &mut flat);
        let paras = flat
            .iter()
            .copied()
            .filter(|e| e.is(W, "p") && !is_math_wrapper(*e))
            .collect();
        let tables = flat.iter().copied().filter(|e| e.is(W, "tbl")).collect();
        (paras, tables)
    }

    fn nav_runs(container: E<'p>) -> Vec<E<'p>> {
        container
            .descendants_named(W, "r")
            .into_iter()
            .filter(|r| {
                r.child(W, "commentReference").is_none()
                    && !has_ancestor_within(*r, container, |a| {
                        a.is(W, "sdt") || a.is(W, "fldSimple") || a.is(W, "txbxContent")
                    })
                    && !has_ancestor_within(*r, container, |a| {
                        a.ns() == MC
                            && matches!(a.name(), "AlternateContent" | "Choice" | "Fallback")
                    })
            })
            .collect()
    }

    fn navigate(&self, segments: &[Segment]) -> Result<Found<'p>, Fail> {
        let Some(first) = segments.first() else {
            return Ok(miss(None));
        };
        let lname = first.name.to_lowercase();
        let predicate = first.predicate.as_deref();
        if lname == "bookmark" {
            if let Some(target) = predicate
                .filter(|p| starts_ci(p, "@name="))
                .map(|p| &p[6..])
            {
                let hit = self.body().and_then(|b| {
                    b.descendants_named(W, "bookmarkStart")
                        .into_iter()
                        .find(|x| x.w("name") == Some(target))
                });
                return Ok(match hit {
                    Some(h) => Found {
                        element: Some(h),
                        path: String::new(),
                        context: None,
                    },
                    None => miss(None),
                });
            }
            if segments.len() == 1 {
                if let Some(index) = first.index {
                    let bks: Vec<E<'p>> = self
                        .body()
                        .map(|b| b.descendants_named(W, "bookmarkStart"))
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|b| !b.w("name").unwrap_or_default().starts_with('_'))
                        .collect();
                    if let Some(hit) = bks.get(index - 1) {
                        return Ok(Found {
                            element: Some(*hit),
                            path: String::new(),
                            context: None,
                        });
                    }
                }
            }
        }
        let part_index = |count: usize| -> Option<usize> {
            if predicate == Some("last()") {
                count.checked_sub(1)
            } else {
                first.index.unwrap_or(1).checked_sub(1)
            }
        };
        let mut current: Option<E<'p>> = match lname.as_str() {
            "body" => self.body(),
            "styles" => self.styles(),
            "header" => part_index(self.header_parts.len())
                .and_then(|i| self.header_parts.get(i))
                .and_then(|p| self.part_root(p)),
            "footer" => part_index(self.footer_parts.len())
                .and_then(|i| self.footer_parts.get(i))
                .and_then(|p| self.part_root(p)),
            "numbering" => self.numbering(),
            "settings" => self.settings(),
            "comments" => self.part_of("comments"),
            "footnotes" => self.part_of("footnotes"),
            "endnotes" => self.part_of("endnotes"),
            _ => None,
        };
        let mut parent_path = match first.index {
            Some(i) => format!("/{}[{i}]", first.name),
            None => format!("/{}", first.name),
        };
        for seg in &segments[1..] {
            let Some(mut cur) = current else { break };
            if cur.is(W, "sdt") {
                cur = cur.child(W, "sdtContent").unwrap_or(cur);
            }
            let name = seg.name.to_lowercase();
            let children: Vec<E<'p>> = if cur.is(W, "body") && (name == "p" || name == "tbl") {
                let (paras, tables) = Self::body_index(cur);
                if name == "p" { paras } else { tables }
            } else if name == "p" {
                cur.children(W, "p")
            } else if name == "r" {
                Self::nav_runs(cur)
            } else if name == "tbl" {
                cur.children(W, "tbl")
            } else if name == "tr" {
                if cur.is(W, "tbl") {
                    table_rows(cur)
                } else {
                    cur.children(W, "tr")
                }
            } else if name == "tc" {
                if cur.is(W, "tr") {
                    row_cells(cur)
                } else {
                    cur.children(W, "tc")
                }
            } else if name == "sdt" {
                cur.elements().filter(|e| e.is(W, "sdt")).collect()
            } else if cur.is(W, "styles") {
                cur.children(W, "style")
                    .into_iter()
                    .filter(|s| {
                        s.w("styleId") == Some(seg.name.as_str())
                            || w_val(s.child(W, "name")) == Some(seg.name.as_str())
                    })
                    .collect()
            } else if name == "footnote" && cur.is(W, "footnotes") {
                cur.children(W, "footnote")
                    .into_iter()
                    .filter(|x| jsn(x.w("id").unwrap_or("0")) > 0.0)
                    .collect()
            } else if name == "endnote" && cur.is(W, "endnotes") {
                cur.children(W, "endnote")
                    .into_iter()
                    .filter(|x| jsn(x.w("id").unwrap_or("0")) > 0.0)
                    .collect()
            } else {
                cur.elements().filter(|e| e.name() == seg.name).collect()
            };
            let pred = seg.predicate.as_deref();
            let after = |p: &str, n: usize| p[n..].to_string();
            let next: Option<E<'p>> = if let Some(i) = seg.index {
                children.get(i - 1).copied()
            } else if pred == Some("last()") {
                children.last().copied()
            } else if let Some(p) = pred.filter(|p| starts_ci(p, "@paraid=")) {
                let target = after(p, 8).to_lowercase();
                children
                    .iter()
                    .copied()
                    .find(|x| {
                        x.is(W, "p")
                            && para_id(*x).map(str::to_lowercase).as_deref()
                                == Some(target.as_str())
                    })
                    .or_else(|| {
                        cur.descendants_named(W, "p").into_iter().find(|x| {
                            para_id(*x).map(str::to_lowercase).as_deref() == Some(target.as_str())
                        })
                    })
            } else if let Some(p) = pred.filter(|p| starts_ci(p, "@textid=")) {
                let target = after(p, 8).to_lowercase();
                let text_id = |x: &E<'p>| x.attr_ns("textId", W14).map(str::to_lowercase);
                children
                    .iter()
                    .copied()
                    .find(|x| text_id(x).as_deref() == Some(target.as_str()))
                    .or_else(|| {
                        cur.descendants_named(W, "p")
                            .into_iter()
                            .find(|x| text_id(x).as_deref() == Some(target.as_str()))
                    })
            } else if let Some(p) = pred.filter(|p| starts_ci(p, "@commentid=")) {
                let target = after(p, 11);
                children
                    .iter()
                    .copied()
                    .find(|c| c.is(W, "comment") && c.w("id") == Some(target.as_str()))
            } else if let Some(p) = pred.filter(|p| starts_ci(p, "@name=")) {
                let target = after(p, 6);
                children
                    .iter()
                    .copied()
                    .find(|e| e.is(W, "bookmarkStart") && e.w("name") == Some(target.as_str()))
            } else if let Some(p) = pred.filter(|p| starts_ci(p, "@sdtid=")) {
                let target = after(p, 7);
                children.iter().copied().find(|e| {
                    e.is(W, "sdt")
                        && w_val(w_child(e.child(W, "sdtPr"), "id")) == Some(target.as_str())
                })
            } else if let Some(p) = pred.filter(|p| starts_ci(p, "@id=")) {
                let target = Some(after(p, 4));
                let target = target.as_deref();
                children.iter().copied().find(|e| {
                    (e.is(W, "abstractNum") && e.w("abstractNumId") == target)
                        || (e.is(W, "num") && e.w("numId") == target)
                        || ((e.is(W, "bookmarkEnd") || e.is(W, "bookmarkStart"))
                            && e.w("id") == target)
                })
            } else if let Some(p) = pred.filter(|p| p.starts_with('@')) {
                let attr = match p.find('=') {
                    Some(eq) if eq > 0 => &p[1..eq],
                    _ => &p[1..],
                };
                return Err(fail(format!(
                    "Attribute predicate '@{attr}' is not a recognized Word path attribute. Supported attributes: @paraId, @textId, @commentId, @sdtId, @id, @name."
                )));
            } else {
                children.first().copied()
            };
            let Some(next) = next else {
                return Ok(miss(Some(available_context(
                    cur,
                    &parent_path,
                    &seg.name,
                    children.len(),
                ))));
            };
            let mut canon = if next.is(W, "style") {
                seg.name.as_str()
            } else {
                next.name()
            };
            if canon == "txbxContent" || canon == "wsp" {
                canon = &seg.name;
            }
            let position = children
                .iter()
                .position(|c| *c == next)
                .map_or(0, |i| i + 1);
            if let Some(id) = next.is(W, "p").then(|| para_id(next)).flatten() {
                parent_path.push_str(&format!("/{canon}[@paraId={id}]"));
            } else if next.is(W, "comment") && next.w("id").is_some() {
                parent_path.push_str(&format!(
                    "/{canon}[@commentId={}]",
                    next.w("id").unwrap_or_default()
                ));
            } else if next.is(W, "style") {
                parent_path.push_str(&format!("/{}", next.w("styleId").unwrap_or(&seg.name)));
            } else if next.is(W, "sdt") {
                match w_val(w_child(next.child(W, "sdtPr"), "id")) {
                    Some(sid) => parent_path.push_str(&format!("/{canon}[@sdtId={sid}]")),
                    None => parent_path.push_str(&format!("/{canon}[{position}]")),
                }
            } else {
                parent_path.push_str(&format!("/{canon}[{position}]"));
            }
            current = Some(next);
        }
        Ok(match current {
            None => miss(None),
            Some(e) => Found {
                element: Some(e),
                path: parent_path,
                context: None,
            },
        })
    }
}

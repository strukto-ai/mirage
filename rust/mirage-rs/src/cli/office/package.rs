// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! office on a Word document or a PowerPoint deck: the package as its
//! XML parts, each parsed into a tree the first time a command reads it,
//! and the `get`, `query`, `set`, `remove` and `batch` commands over them,
//! answered as OfficeCLI 1.0.161 answers them. A save rewrites only the
//! parts a command changed and copies every other part as it stands.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

use super::batch::{self, Item};
use super::book::{Book, Refusal};
use super::media::{self, Media};
use super::node::{Json, Node, Value, lines, matches};
use super::query::{Warning, filter_selector, text_matches};
use super::tree::{self, A, CP, CT, DC, DCTERMS, E, EP, REL, Tree, W, outer_xml};
use super::units::{hex_color, int_or_text, round_trip_date};
use super::{
    Config, Fail, Out, Outcome, Output, SetFail, VERBS, batch_source, item_warnings, pairs,
    print_batch, text, unsupported_text,
};
use super::{slides, word};
use crate::request::failure_text;
use crate::task::Host;

/// One relationship a part declares.
#[derive(Clone, Debug)]
pub(super) struct Rel {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) target: String,
    pub(super) external: bool,
}

struct Slot {
    name: String,
    bytes: Vec<u8>,
    tree: OnceCell<Option<Tree>>,
}

const CONTENT_TYPES: &str = "/[Content_Types].xml";

fn key(name: &str) -> String {
    name.trim_start_matches('/').to_ascii_lowercase()
}

/// Where a relationship part for `owner` lives: `/a/b.xml` -> `/a/_rels/b.xml.rels`.
pub(super) fn rels_name(owner: &str) -> String {
    match owner.rfind('/') {
        Some(at) => format!("{}/_rels/{}.rels", &owner[..at], &owner[at + 1..]),
        None => format!("/_rels/{owner}.rels"),
    }
}

/// A relationship target resolved against the part that owns it.
pub(super) fn resolve_target(owner: &str, target: &str) -> String {
    if target.starts_with('/') {
        return target.to_string();
    }
    let mut parts: Vec<&str> = owner.split('/').collect();
    parts.pop();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    if joined.starts_with('/') {
        joined
    } else {
        format!("/{joined}")
    }
}

/// An opened package: its XML parts fetched whole, each parsed on first
/// read; every other part left in the host's spool.
pub(super) struct Pkg<'h> {
    book: Book<'h>,
    slots: HashMap<String, Slot>,
    names: Vec<String>,
    changed: HashSet<String>,
    /// Parts a command took out, by key.
    dropped: HashSet<String>,
    /// Parts a command added that are not XML, as written.
    binaries: Vec<(String, Vec<u8>)>,
    pub(super) main: String,
}

/// A package's parsed parts at one point, to go back to when a batch item fails.
pub(super) struct Snapshot {
    trees: Vec<(String, Option<Tree>)>,
    changed: HashSet<String>,
    names: Vec<String>,
    dropped: HashSet<String>,
    binaries: Vec<(String, Vec<u8>)>,
}

impl<'h> Pkg<'h> {
    /// The package `typed` names, its XML parts read.
    pub(super) async fn open(host: &'h Host, config: &Config) -> Result<Pkg<'h>, Fail> {
        let mut book = match Book::open(host, &config.file).await {
            Ok(book) => book,
            Err(Refusal::Missing) => return Err(Fail::missing(&config.absolute)),
            Err(Refusal::Unreadable) => {
                return Err(Fail::of(format!(
                    "Not a document 'office' reads: {} (not-zip)",
                    text(&config.file)
                )));
            }
            Err(Refusal::Host(why)) => return Err(Fail::of(text(&why))),
        };
        let names: Vec<String> = book.names().into_iter().map(|n| format!("/{n}")).collect();
        let mut slots = HashMap::new();
        for name in &names {
            let lower = name.to_ascii_lowercase();
            if !(lower.ends_with(".xml") || lower.ends_with(".rels")) {
                continue;
            }
            if let Some(bytes) = book.part(name).await {
                slots.insert(
                    key(name),
                    Slot {
                        name: name.clone(),
                        bytes,
                        tree: OnceCell::new(),
                    },
                );
            }
        }
        let mut pkg = Pkg {
            book,
            slots,
            names,
            changed: HashSet::new(),
            dropped: HashSet::new(),
            binaries: Vec::new(),
            main: String::new(),
        };
        if !pkg.slots.contains_key(&key(CONTENT_TYPES)) {
            return Err(Fail::of(format!(
                "Not a document 'office' reads: {} (no-content-types)",
                text(&config.file)
            )));
        }
        if let Some((line, col)) = pkg
            .slots
            .get(&key(CONTENT_TYPES))
            .and_then(|s| types_tag_missing(&s.bytes))
        {
            return Err(enriched(format!(
                "Malformed XML in document part: Required Types tag not found. Line {line}, position {col}. (the file appears to have a corrupted OOXML part)."
            )));
        }
        let Some(main) = pkg
            .rels("/")
            .into_iter()
            .find(|r| !r.external && r.kind.ends_with("/officeDocument"))
        else {
            return Err(Fail::of(format!(
                "Not a document 'office' reads: {} (no-main-document)",
                text(&config.file)
            )));
        };
        pkg.main = resolve_target("/", &main.target);
        Ok(pkg)
    }

    pub(super) fn has(&self, name: &str) -> bool {
        let k = key(name);
        !self.dropped.contains(&k) && self.names.iter().any(|n| key(n) == k)
    }

    /// The part's tree to change, parsed first if no command read it yet;
    /// the part is then written on save.
    pub(super) fn xml_mut(&mut self, name: &str) -> Option<&mut Tree> {
        let k = key(name);
        if self.dropped.contains(&k) {
            return None;
        }
        let slot = self.slots.get_mut(&k)?;
        if slot.tree.get().is_none() {
            let _ = slot.tree.set(tree::parse(&slot.bytes).ok());
        }
        let t = slot.tree.get_mut()?.as_mut()?;
        self.changed.insert(k);
        Some(t)
    }

    /// A new XML part with its content type, written on save.
    pub(super) fn add_part(&mut self, name: &str, t: Tree, content_type: &str) {
        let k = key(name);
        let cell = OnceCell::new();
        let _ = cell.set(Some(t));
        self.slots.insert(
            k.clone(),
            Slot {
                name: name.to_string(),
                bytes: Vec::new(),
                tree: cell,
            },
        );
        self.dropped.remove(&k);
        if !self.names.iter().any(|n| key(n) == k) {
            self.names.push(name.to_string());
        }
        self.changed.insert(k);
        self.set_override(name, Some(content_type));
    }

    /// The part taken out of the package with its relationships part and
    /// content type.
    pub(super) fn drop_part(&mut self, name: &str) {
        let rels = rels_name(name);
        for n in [name.to_string(), rels] {
            let k = key(&n);
            if self.has(&n) {
                self.dropped.insert(k.clone());
                self.changed.remove(&k);
                self.binaries.retain(|(b, _)| key(b) != k);
            }
        }
        self.set_override(name, None);
    }

    /// `part` taken out with every part only it reaches, directly or
    /// through parts it takes, as a removed slide takes its notes and media.
    pub(super) fn drop_owned(&mut self, part: &str) {
        let same = |a: &str, b: &str| key(a) == key(b);
        let targets = |pkg: &Pkg<'_>, owner: &str| -> Vec<String> {
            pkg.rels(owner)
                .into_iter()
                .filter(|r| !r.external)
                .map(|r| resolve_target(owner, &r.target))
                .filter(|t| pkg.has(t))
                .collect()
        };
        let mut gone = vec![part.to_string()];
        let mut at = 0;
        while at < gone.len() {
            let current = gone[at].clone();
            at += 1;
            for t in targets(self, &current) {
                if !gone.iter().any(|g| same(g, &t)) {
                    gone.push(t);
                }
            }
        }
        let mut queue: Vec<String> = self
            .names
            .iter()
            .filter(|n| n.ends_with(".rels") && self.has(n))
            .filter_map(|n| n.rsplit_once("/_rels/"))
            .map(|(dir, file)| format!("{dir}/{}", file.trim_end_matches(".rels")))
            .filter(|o| !gone.iter().any(|g| same(g, o)))
            .collect();
        let mut kept: Vec<String> = Vec::new();
        while let Some(owner) = queue.pop() {
            for t in targets(self, &owner) {
                if same(&t, part) || kept.iter().any(|k| same(k, &t)) {
                    continue;
                }
                if gone.iter().any(|g| same(g, &t)) {
                    queue.push(t.clone());
                }
                kept.push(t);
            }
        }
        for name in gone
            .iter()
            .enumerate()
            .filter_map(|(i, g)| (i == 0 || !kept.iter().any(|k| same(k, g))).then_some(g.clone()))
        {
            self.drop_part(&name);
        }
    }

    /// A new part that is not XML, its extension given the content type
    /// `content_type` unless one is, written on save.
    pub(super) fn add_binary(&mut self, name: &str, data: Vec<u8>, content_type: &str) {
        let k = key(name);
        self.binaries.retain(|(b, _)| key(b) != k);
        self.binaries.push((name.to_string(), data));
        self.dropped.remove(&k);
        if !self.names.iter().any(|n| key(n) == k) {
            self.names.push(name.to_string());
        }
        let ext = name.rsplit_once('.').map_or("", |(_, e)| e).to_string();
        let Some(ct) = self.xml_mut(CONTENT_TYPES) else {
            return;
        };
        let root = ct.root;
        let defaults = ct.root().children(CT, "Default");
        if defaults.iter().any(|d| {
            d.attr("Extension")
                .is_some_and(|e| e.eq_ignore_ascii_case(&ext))
        }) {
            return;
        }
        let at = ct.nodes[root]
            .kids
            .iter()
            .position(|k| matches!(k, tree::Kid::El(c) if ct.nodes[*c].name != "Default"));
        let prefix = ct.nodes[root].prefix.clone();
        let d = ct.create(CT, "Default", &prefix);
        tree::set_attr(ct, d, "Extension", &ext);
        tree::set_attr(ct, d, "ContentType", content_type);
        tree::insert_at(ct, root, at, d);
    }

    /// The name a new image part of `ext` related from `owner` takes: in
    /// the media folder beside the owner's, the first of `image.ext`,
    /// `image2.ext`, ... not in the package.
    pub(super) fn media_name(&self, owner: &str, ext: &str) -> String {
        let mut dir: Vec<&str> = owner.trim_start_matches('/').split('/').collect();
        dir.pop();
        dir.pop();
        let dir = dir.iter().map(|s| format!("/{s}")).collect::<String>();
        (1..)
            .map(|n| {
                let seq = if n == 1 { String::new() } else { n.to_string() };
                format!("{dir}/media/image{seq}.{ext}")
            })
            .find(|name| !self.has(name))
            .unwrap_or_default()
    }

    /// The content types part's override for `name` set, or removed.
    fn set_override(&mut self, name: &str, content_type: Option<&str>) {
        let Some(ct) = self.xml_mut(CONTENT_TYPES) else {
            return;
        };
        let root = ct.root;
        let found: Vec<tree::Id> = ct
            .root()
            .children(CT, "Override")
            .into_iter()
            .filter(|o| {
                o.attr("PartName")
                    .is_some_and(|p| p.eq_ignore_ascii_case(name))
            })
            .map(|o| o.id)
            .collect();
        for id in &found {
            ct.detach(*id);
        }
        if let Some(kind) = content_type {
            let prefix = ct.nodes[root].prefix.clone();
            let o = ct.create(CT, "Override", &prefix);
            tree::set_attr(ct, o, "PartName", name);
            tree::set_attr(ct, o, "ContentType", kind);
            ct.append(root, o);
        }
    }

    /// A relationship from `owner` to `target` (as the relationship writes
    /// it) of type `kind`, made unless one already says the same; its id.
    pub(super) fn add_rel(
        &mut self,
        owner: &str,
        kind: &str,
        target: &str,
        external: bool,
    ) -> String {
        if let Some(r) = self
            .rels(owner)
            .into_iter()
            .find(|r| !external && !r.external && r.kind == kind && r.target == target)
        {
            return r.id;
        }
        let rels = rels_name(owner);
        if !self.has(&rels) {
            let mut t = Tree::fragment(REL, "Relationships", "");
            t.declaration =
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n".to_string();
            let root = t.root;
            t.nodes[root].prefix = String::new();
            t.nodes[root].decls.push((String::new(), REL.to_string()));
            let k = key(&rels);
            let cell = OnceCell::new();
            let _ = cell.set(Some(t));
            self.slots.insert(
                k.clone(),
                Slot {
                    name: rels.clone(),
                    bytes: Vec::new(),
                    tree: cell,
                },
            );
            self.dropped.remove(&k);
            if !self.names.iter().any(|n| key(n) == k) {
                self.names.push(rels.clone());
            }
        }
        let used: Vec<String> = self.rels(owner).into_iter().map(|r| r.id).collect();
        let id = (1..)
            .map(|n| format!("rId{n}"))
            .find(|id| !used.contains(id))
            .unwrap_or_default();
        if let Some(t) = self.xml_mut(&rels) {
            let root = t.root;
            let prefix = t.nodes[root].prefix.clone();
            let r = t.create(REL, "Relationship", &prefix);
            tree::set_attr(t, r, "Id", &id);
            tree::set_attr(t, r, "Type", kind);
            tree::set_attr(t, r, "Target", target);
            if external {
                tree::set_attr(t, r, "TargetMode", "External");
            }
            t.append(root, r);
        }
        id
    }

    /// The relationship `id` of `owner` taken out.
    pub(super) fn drop_rel(&mut self, owner: &str, id: &str) {
        let rels = rels_name(owner);
        if let Some(t) = self.xml_mut(&rels) {
            let gone: Vec<tree::Id> = t
                .root()
                .children(REL, "Relationship")
                .into_iter()
                .filter(|r| r.attr("Id") == Some(id))
                .map(|r| r.id)
                .collect();
            for g in gone {
                t.detach(g);
            }
        }
    }

    /// A part's size in bytes.
    pub(super) fn size(&self, name: &str) -> Option<u64> {
        if let Some((_, data)) = self.binaries.iter().find(|(b, _)| key(b) == key(name)) {
            return Some(data.len() as u64);
        }
        if let Some(slot) = self.slots.get(&key(name)) {
            if !self.changed.contains(&key(name)) {
                return Some(slot.bytes.len() as u64);
            }
        }
        self.book.size(name)
    }

    /// The part's tree, or none when it is absent or not XML.
    pub(super) fn xml(&self, name: &str) -> Option<&Tree> {
        if self.dropped.contains(&key(name)) {
            return None;
        }
        let slot = self.slots.get(&key(name))?;
        slot.tree
            .get_or_init(|| tree::parse(&slot.bytes).ok())
            .as_ref()
    }

    pub(super) fn content_type(&self, name: &str) -> Option<String> {
        let ct = self.xml(CONTENT_TYPES)?.root();
        for o in ct.children(CT, "Override") {
            if o.attr("PartName")
                .is_some_and(|p| p.eq_ignore_ascii_case(name))
            {
                return o.attr("ContentType").map(str::to_string);
            }
        }
        let ext = name
            .rsplit_once('.')
            .map_or("", |(_, e)| e)
            .to_ascii_lowercase();
        for d in ct.children(CT, "Default") {
            if d.attr("Extension")
                .is_some_and(|e| e.eq_ignore_ascii_case(&ext))
            {
                return d.attr("ContentType").map(str::to_string);
            }
        }
        None
    }

    /// Relationships `owner` declares, in authored order.
    pub(super) fn rels(&self, owner: &str) -> Vec<Rel> {
        let Some(t) = self.xml(&rels_name(owner)) else {
            return Vec::new();
        };
        t.root()
            .children(REL, "Relationship")
            .into_iter()
            .map(|r| Rel {
                id: r.attr("Id").unwrap_or_default().to_string(),
                kind: r.attr("Type").unwrap_or_default().to_string(),
                target: r.attr("Target").unwrap_or_default().to_string(),
                external: r.attr("TargetMode") == Some("External"),
            })
            .collect()
    }

    pub(super) fn rel(&self, owner: &str, id: &str) -> Option<Rel> {
        self.rels(owner).into_iter().find(|r| r.id == id)
    }

    /// The part a relationship of `owner` names.
    pub(super) fn rel_part(&self, owner: &str, id: &str) -> Option<String> {
        let r = self.rel(owner, id)?;
        (!r.external).then(|| resolve_target(owner, &r.target))
    }

    /// Parts `owner` relates to with a type ending in `/kind`, in relationship order.
    pub(super) fn related(&self, owner: &str, kind: &str) -> Vec<String> {
        let suffix = format!("/{kind}");
        self.rels(owner)
            .into_iter()
            .filter(|r| !r.external && r.kind.ends_with(&suffix))
            .map(|r| resolve_target(owner, &r.target))
            .collect()
    }

    pub(super) fn dirty(&self) -> bool {
        !self.changed.is_empty() || !self.dropped.is_empty() || !self.binaries.is_empty()
    }

    pub(super) fn snapshot(&self) -> Snapshot {
        Snapshot {
            trees: self
                .changed
                .iter()
                .filter_map(|k| {
                    self.slots
                        .get(k)
                        .map(|s| (k.clone(), s.tree.get().cloned().flatten()))
                })
                .collect(),
            changed: self.changed.clone(),
            names: self.names.clone(),
            dropped: self.dropped.clone(),
            binaries: self.binaries.clone(),
        }
    }

    pub(super) fn restore(&mut self, snap: Snapshot) {
        let known: HashSet<String> = snap.names.iter().map(|n| key(n)).collect();
        self.slots.retain(|k, _| known.contains(k));
        self.names = snap.names;
        self.dropped = snap.dropped;
        self.binaries = snap.binaries;
        for k in self
            .changed
            .difference(&snap.changed)
            .cloned()
            .collect::<Vec<_>>()
        {
            if let Some(slot) = self.slots.get_mut(&k) {
                slot.tree = OnceCell::new();
            }
        }
        for (k, t) in snap.trees {
            if let Some(slot) = self.slots.get_mut(&k) {
                let cell = OnceCell::new();
                let _ = cell.set(t);
                slot.tree = cell;
            }
        }
        self.changed = snap.changed;
    }

    /// The changed parts written into the package, which is saved to `path`.
    pub(super) async fn save(mut self, host: &Host, path: &[u8]) -> Option<crate::request::Reply> {
        let mut changed: Vec<String> = self.changed.iter().cloned().collect();
        changed.sort();
        for k in changed {
            if let Some(slot) = self.slots.get(&k) {
                if let Some(Some(t)) = slot.tree.get() {
                    let name = slot.name.trim_start_matches('/').to_string();
                    self.book.put(&name, tree::serialize(t));
                }
            }
        }
        for (name, data) in std::mem::take(&mut self.binaries) {
            self.book.put(name.trim_start_matches('/'), data);
        }
        let mut dropped: Vec<String> = self.dropped.iter().cloned().collect();
        dropped.sort();
        for k in dropped {
            self.book.drop_part(&k);
        }
        self.book.save(host, path).await
    }
}

/// `to` as a relationship target from `from`.
pub(super) fn relative(from: &str, to: &str) -> String {
    let from_dir: Vec<&str> = from.trim_start_matches('/').split('/').collect();
    let from_dir = &from_dir[..from_dir.len().saturating_sub(1)];
    let to_parts: Vec<&str> = to.trim_start_matches('/').split('/').collect();
    let common = from_dir
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<String> = vec!["..".to_string(); from_dir.len() - common];
    out.extend(to_parts[common..].iter().map(|s| s.to_string()));
    out.join("/")
}

/// Where the content types part's root starts, when it is not an
/// unprefixed `Types` of the content types namespace, as .NET's package
/// reader refuses one: its line and the column its name starts at.
fn types_tag_missing(bytes: &[u8]) -> Option<(usize, usize)> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}');
    let mut at = 0;
    let open = loop {
        let lt = at + text[at..].find('<')?;
        let rest = &text[lt..];
        let skip = if rest.starts_with("<?") {
            rest.find("?>").map(|e| e + 2)
        } else if rest.starts_with("<!--") {
            rest.find("-->").map(|e| e + 3)
        } else if rest.starts_with("<!") {
            rest.find('>').map(|e| e + 1)
        } else {
            break lt;
        };
        at = lt + skip?;
    };
    let name: String = text[open + 1..]
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '/' && *c != '>')
        .collect();
    let foreign = tree::parse(bytes).is_ok_and(|t| t.root().ns() != CT);
    if name == "Types" && !foreign {
        return None;
    }
    let before = &text[..open];
    let line = before.matches('\n').count() + 1;
    let col = before[before.rfind('\n').map_or(0, |n| n + 1)..]
        .encode_utf16()
        .count()
        + 2;
    Some((line, col))
}

/// What OfficeCLI reads off a refusal's message: its code and any hints.
pub(super) fn enriched(message: String) -> Fail {
    let mut f = Fail::of(message);
    f.code = None;
    let m = f.message.clone();
    let set = |f: &mut Fail, code: &'static str| f.code = Some(code);
    let total = regex_total(&m);
    if let Some((kind, count)) = total {
        f.suggestion = Some(if count == 0 {
            format!("No {kind} elements exist. Add one first.")
        } else {
            format!("Valid {kind} index range: 1-{count}")
        });
        set(&mut f, "not_found");
        return f;
    }
    let words: Vec<&str> = m.split_whitespace().collect();
    if words.len() == 4
        && words[2] == "not"
        && words[3] == "found"
        && words[1].bytes().all(|b| b.is_ascii_digit())
        && words[0].chars().all(|c| c.is_alphanumeric() || c == '_')
    {
        set(&mut f, "not_found");
        return f;
    }
    if m.starts_with("Path not found:") || m.starts_with("Sheet not found:") {
        set(&mut f, "not_found");
        return f;
    }
    if let Some(at) = m.find("Unknown part: ") {
        if let Some(av) = m[at..].find(". Available: ") {
            let list = &m[at + av + ". Available: ".len()..];
            f.valid = Some(list.split(", ").map(str::to_string).collect());
            set(&mut f, "invalid_path");
            return f;
        }
    }
    if m.contains("Unsupported file type") {
        set(&mut f, "unsupported_type");
    } else if m.contains(": parent must be ") {
        set(&mut f, "invalid_value");
    } else if m.contains("Cannot resolve @name=") {
        set(&mut f, "invalid_path");
    } else if m.starts_with("invalid ") {
        set(&mut f, "invalid_value");
    } else if m.contains("XPath matched no elements") {
        set(&mut f, "not_found");
    } else if m.starts_with("Cannot clone '")
        || m.starts_with("Cannot move '")
        || m.starts_with("Cannot swap elements")
    {
        set(&mut f, "invalid_value");
    } else if m.contains(" not found") {
        set(&mut f, "not_found");
    } else if m.starts_with("Invalid ") || m.starts_with("Unknown ") {
        if let Some(at) = m.find("Valid value") {
            let rest = &m[at..];
            if let Some(colon) = rest.find(':') {
                let list = rest[colon + 1..].trim().trim_end_matches('.');
                f.valid = Some(list.split(", ").map(str::to_string).collect());
            }
        }
        set(&mut f, "invalid_value");
    } else if m.contains("already exists") {
        set(&mut f, "duplicate_name");
    } else if m.starts_with("UNSUPPORTED props:") {
        f.help = Some("office help <format>-set".to_string());
        set(&mut f, "unsupported_property");
    } else if m.contains("property is required")
        || m.contains("property required")
        || m.contains("requires data")
        || m.contains("missing required")
    {
        set(&mut f, "missing_property");
    } else if m.contains("unknown field") || m.starts_with("Batch input must be") {
        set(&mut f, "invalid_input");
    } else if m.starts_with("No ") && m.contains(" found with ") {
        set(&mut f, "not_found");
    }
    f
}

/// `Kind N not found (total: M)`, as its kind and total.
fn regex_total(m: &str) -> Option<(String, usize)> {
    let mut words = m.splitn(4, ' ');
    let kind = words.next()?;
    let n = words.next()?;
    if words.next()? != "not" {
        return None;
    }
    let rest = words.next()?;
    let rest = rest.strip_prefix("found (total:")?;
    let count: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if kind.is_empty()
        || !kind.chars().all(|c| c.is_alphanumeric() || c == '_')
        || n.is_empty()
        || !n.bytes().all(|b| b.is_ascii_digit())
        || count.is_empty()
    {
        return None;
    }
    Some((kind.to_string(), count.parse().ok()?))
}

/// The package's core properties onto `node`, as OfficeCLI names them.
pub(super) fn core_properties(core: Option<E<'_>>, node: &mut Node) {
    let Some(core) = core else { return };
    let pairs: [(&str, &str, &str); 8] = [
        ("title", DC, "title"),
        ("author", DC, "creator"),
        ("subject", DC, "subject"),
        ("keywords", CP, "keywords"),
        ("description", DC, "description"),
        ("category", CP, "category"),
        ("lastModifiedBy", CP, "lastModifiedBy"),
        ("revisionNumber", CP, "revision"),
    ];
    for (k, ns, name) in pairs {
        if let Some(v) = core.child(ns, name) {
            node.str(k, v.text());
        }
    }
    for k in ["created", "modified"] {
        if let Some(date) = core
            .child(DCTERMS, k)
            .and_then(|v| round_trip_date(&v.text()))
        {
            node.str(k, date);
        }
    }
}

/// The theme part's name, colors and fonts onto `node`.
pub(super) fn theme_properties(theme: Option<E<'_>>, node: &mut Node) {
    let Some(theme) = theme else { return };
    if let Some(name) = theme.attr("name") {
        node.str("theme.name", name);
    }
    let elements = theme.child(A, "themeElements");
    if let Some(scheme) = elements.and_then(|e| e.child(A, "clrScheme")) {
        if let Some(n) = scheme.attr("name") {
            node.str("theme.colorScheme", n);
        }
        for slot in [
            "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5",
            "accent6", "hlink", "folHlink",
        ] {
            let c = scheme.child(A, slot).and_then(|s| s.elements().next());
            let v = c.and_then(|c| {
                if c.is(A, "srgbClr") {
                    c.attr("val")
                } else if c.is(A, "sysClr") {
                    c.attr("lastClr")
                } else {
                    None
                }
            });
            if let Some(v) = v {
                node.str(&format!("theme.color.{slot}"), hex_color(v));
            }
        }
    }
    if let Some(fonts) = elements.and_then(|e| e.child(A, "fontScheme")) {
        if let Some(n) = fonts.attr("name") {
            node.str("theme.fontScheme", n);
        }
        for group in ["major", "minor"] {
            let Some(g) = fonts.child(A, &format!("{group}Font")) else {
                continue;
            };
            for (child, k) in [("latin", "latin"), ("ea", "eastAsia")] {
                if let Some(face) = g.child(A, child).and_then(|c| c.attr("typeface")) {
                    node.str(&format!("theme.font.{group}.{k}"), face);
                }
            }
        }
    }
    if let Some(n) = elements
        .and_then(|e| e.child(A, "fmtScheme"))
        .and_then(|f| f.attr("name"))
    {
        node.str("theme.formatScheme", n);
    }
}

/// The extended (app) properties onto `node`.
pub(super) fn extended_properties(app: Option<E<'_>>, node: &mut Node) {
    let Some(app) = app else { return };
    let fields: [(&str, &str, bool); 11] = [
        ("template", "Template", false),
        ("manager", "Manager", false),
        ("company", "Company", false),
        ("application", "Application", false),
        ("applicationVersion", "AppVersion", false),
        ("pages", "Pages", true),
        ("words", "Words", true),
        ("characters", "Characters", true),
        ("lines", "Lines", true),
        ("paragraphs", "Paragraphs", true),
        ("totalTime", "TotalTime", true),
    ];
    for (k, name, int) in fields {
        let Some(e) = app.child(EP, name) else {
            continue;
        };
        let v = e.text();
        node.set(
            &format!("extended.{k}"),
            if int { int_or_text(&v) } else { Value::Str(v) },
        );
    }
}

/// The trailing positional `[N]` of a selector applied to its results.
pub(super) fn take_nth(selector: &str, results: Vec<Node>) -> Vec<Node> {
    if results.is_empty() || selector.is_empty() {
        return results;
    }
    let t = selector.trim_end();
    let Some(body) = t.strip_suffix(']') else {
        return results;
    };
    let Some(open) = body.rfind('[') else {
        return results;
    };
    let digits = &body[open + 1..];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return results;
    }
    let n: usize = digits.parse().unwrap_or(0);
    if n < 1 || n > results.len() {
        return Vec::new();
    }
    vec![results.into_iter().nth(n - 1).expect("an index in range")]
}

pub(super) fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

pub(super) fn contains_ci(text: &str, find: &str) -> bool {
    text.to_lowercase().contains(&find.to_lowercase())
}

/// `:contains(text)`, quotes around the text dropped.
pub(super) fn contains_text(s: &str) -> Option<String> {
    let at = s.find(":contains(")?;
    let rest = &s[at + 10..];
    let inner = match rest.strip_prefix(['\'', '"']) {
        Some(r) if r.chars().nth(1).is_some() || r.contains(')') => r,
        _ => rest,
    };
    let chars: Vec<(usize, char)> = inner.char_indices().collect();
    for k in 1..chars.len() {
        let (pos, c) = chars[k];
        if c == ')' {
            return Some(inner[..pos].to_string());
        }
        if (c == '\'' || c == '"') && chars.get(k + 1).is_some_and(|(_, n)| *n == ')') {
            return Some(inner[..pos].to_string());
        }
    }
    None
}

/// Every `[key op value]` predicate, as `\[(\w+)(~=|\\?!?=)([^\]]*)\]` finds them.
pub(super) fn predicates(s: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(at) = s[i..].find('[').map(|x| i + x) {
        let rest = &s[at + 1..];
        let key_len: usize = rest
            .chars()
            .take_while(|c| word_char(*c))
            .map(char::len_utf8)
            .sum();
        let after_key = &rest[key_len..];
        let op = if after_key.starts_with("~=") {
            Some("~=")
        } else {
            let t = after_key.strip_prefix('\\').unwrap_or(after_key);
            if t.starts_with("!=") {
                Some(if after_key.starts_with('\\') {
                    "\\!="
                } else {
                    "!="
                })
            } else if t.starts_with('=') {
                Some(if after_key.starts_with('\\') {
                    "\\="
                } else {
                    "="
                })
            } else {
                None
            }
        };
        if let (true, Some(op)) = (key_len > 0, op) {
            let value_start = &after_key[op.len()..];
            if let Some(end) = value_start.find(']') {
                out.push((
                    rest[..key_len].to_string(),
                    op.replace('\\', ""),
                    value_start[..end].to_string(),
                ));
                i = at + 1 + key_len + op.len() + end + 1;
                continue;
            }
        }
        i = at + 1;
    }
    out
}

/// `GenericXmlQuery.ElementToNode` at depth 0.
fn generic_node(e: E<'_>, path: String) -> Node {
    let mut node = Node::new(path, e.name());
    node.child_count = e.elements().count();
    let inner = e.text();
    let clip = |s: &str| {
        let units: Vec<u16> = s.encode_utf16().collect();
        if units.len() > 200 {
            format!("{}...", String::from_utf16_lossy(&units[..200]))
        } else {
            s.to_string()
        }
    };
    if inner.is_empty() {
        node.preview = Some(clip(&outer_xml(e)));
    } else {
        node.text = Some(clip(&inner));
    }
    for a in e.attrs() {
        node.str(&a.name, a.value.clone());
    }
    for c in e.elements() {
        if c.elements().next().is_none() {
            if let Some(v) = c
                .attrs()
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case("val"))
            {
                node.str(c.name(), v.value.clone());
            }
        }
    }
    node
}

pub(super) fn generic_attr(e: E<'_>, name: &str) -> Option<String> {
    if let Some(a) = e.attrs().iter().find(|a| a.name.eq_ignore_ascii_case(name)) {
        return Some(a.value.clone());
    }
    let c = e.elements().find(|c| c.name().eq_ignore_ascii_case(name))?;
    if let Some(v) = c
        .attrs()
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case("val"))
    {
        return Some(v.value.clone());
    }
    Some(c.text())
}

/// `GenericXmlQuery`: elements of a local name anywhere under `root`.
pub(super) fn generic_query(root: E<'_>, selector: &str, out: &mut Vec<Node>) {
    let first = [
        selector.find('['),
        selector.find(":contains("),
        selector.find(":empty"),
        selector.find(":no-alt"),
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or(selector.len());
    let element = selector[..first].trim();
    let (prefix, local) = match element.find(':').filter(|i| *i > 0) {
        Some(i) => (Some(&element[..i]), &element[i + 1..]),
        None => (None, element),
    };
    let ns = prefix.and_then(|p| match p {
        "w" => Some(W),
        "r" => Some(tree::R),
        "a" => Some(A),
        "p" => Some(tree::P),
        "mc" => Some(tree::MC),
        "c" => Some(tree::C),
        _ => None,
    });
    let attrs: Vec<(String, String, bool)> = predicates(selector)
        .into_iter()
        .filter(|(_, op, v)| op != "~=" && !v.is_empty())
        .map(|(k, op, v)| (k, v.trim_matches(['\'', '"']).to_string(), op == "!="))
        .collect();
    let contains = contains_text(selector);
    fn walk(
        e: E<'_>,
        local: &str,
        ns: Option<&str>,
        attrs: &[(String, String, bool)],
        contains: Option<&str>,
        path: &str,
        out: &mut Vec<Node>,
    ) {
        let hit = e.name().eq_ignore_ascii_case(local)
            && ns.is_none_or(|n| e.ns() == n)
            && attrs.iter().all(|(k, v, neg)| {
                let same = generic_attr(e, k).is_some_and(|a| a.eq_ignore_ascii_case(v));
                same != *neg
            })
            && contains.is_none_or(|c| contains_ci(&e.text(), c));
        if hit {
            out.push(generic_node(e, path.to_string()));
        }
        let mut counters: Vec<(String, usize)> = Vec::new();
        for c in e.elements() {
            let idx = match counters.iter_mut().find(|(n, _)| n == c.name()) {
                Some(slot) => {
                    slot.1 += 1;
                    slot.1
                }
                None => {
                    counters.push((c.name().to_string(), 1));
                    1
                }
            };
            walk(
                c,
                local,
                ns,
                attrs,
                contains,
                &format!("{path}/{}[{idx}]", c.name()),
                out,
            );
        }
    }
    walk(
        root,
        local,
        ns,
        &attrs,
        contains.as_deref(),
        &format!("/{}[1]", root.name()),
        out,
    );
}

/// Which handler reads the document.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Word,
    Slides,
}

impl Kind {
    pub(super) fn of(file: &str) -> Option<Kind> {
        let lower = file.to_ascii_lowercase();
        if lower.ends_with(".docx") {
            Some(Kind::Word)
        } else if lower.ends_with(".pptx") {
            Some(Kind::Slides)
        } else {
            None
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Kind::Word => "docx",
            Kind::Slides => "pptx",
        }
    }

    fn get(self, pkg: &Pkg<'_>, path: &str, depth: usize) -> Result<Node, Fail> {
        let node = match self {
            Kind::Word => word::get(pkg, path, depth)?,
            Kind::Slides => slides::get(pkg, path, depth)?,
        };
        if node.kind == "error" {
            return Err(enriched(
                node.text
                    .unwrap_or_else(|| format!("Path not found: {path}")),
            ));
        }
        Ok(node)
    }

    /// The handler's own pass over a selector.
    fn dispatch(self, pkg: &Pkg<'_>, selector: &str) -> Result<Vec<Node>, Fail> {
        let found = match self {
            Kind::Word => word::query(pkg, selector)?,
            Kind::Slides => return slides::query(pkg, selector),
        };
        Ok(if selector.is_empty() || selector.starts_with('/') {
            found
        } else {
            take_nth(selector, found)
        })
    }

    fn query(
        self,
        pkg: &Pkg<'_>,
        selector: &str,
        find: Option<&str>,
    ) -> Result<(Vec<Node>, Vec<Warning>), Fail> {
        let (results, warnings) = filter_selector(selector, &|s| self.dispatch(pkg, s), false)?;
        let kept = match find.filter(|f| !f.is_empty()) {
            None => results,
            Some(f) => {
                let mut kept = Vec::new();
                for n in results {
                    if let Some(t) = &n.text {
                        if text_matches(t, f)? {
                            kept.push(n);
                        }
                    }
                }
                kept
            }
        };
        Ok((kept, warnings))
    }

    fn set(
        self,
        pkg: &mut Pkg<'_>,
        path: &str,
        props: &[(String, String)],
    ) -> Result<(String, Vec<String>), SetFail> {
        match self {
            Kind::Word => word::set(pkg, path, props),
            Kind::Slides => slides::set(pkg, path, props),
        }
    }

    fn remove(self, pkg: &mut Pkg<'_>, path: &str) -> Result<(String, Vec<String>), Fail> {
        match self {
            Kind::Word => word::remove(pkg, path),
            Kind::Slides => slides::remove(pkg, path),
        }
    }

    fn hydrate(self, pkg: &Pkg<'_>, results: &mut [Node]) {
        for n in results.iter_mut() {
            if n.child_count == 0 || !n.children.is_empty() || n.path.is_empty() {
                continue;
            }
            if let Ok(full) = self.get(pkg, &n.path, 1) {
                n.children = full.children;
            }
        }
    }
}

/// What a placed shape's position line and overlap check read: the
/// shape's own properties and those of the other shapes on its slide.
struct PlacementView {
    own: Option<(String, Vec<(String, String)>)>,
    siblings: Vec<(String, Vec<(String, String)>)>,
}

/// The view `placement` reads, taken before the package is saved: empty
/// unless `wanted` and the deck placed a shape at `path`.
fn placement_view(kind: Kind, pkg: &Pkg<'_>, wanted: bool, path: &str) -> PlacementView {
    let empty = PlacementView {
        own: None,
        siblings: Vec::new(),
    };
    if !wanted || !matches!(kind, Kind::Slides) {
        return empty;
    }
    let props = |n: &Node| -> Vec<(String, String)> {
        n.format
            .iter()
            .map(|(k, v)| (k.clone(), v.text()))
            .collect()
    };
    let Ok(node) = kind.get(pkg, path, 1) else {
        return empty;
    };
    if matches!(
        node.kind.as_str(),
        "slide" | "paragraph" | "run" | "cell" | "row" | "tc" | "tr"
    ) {
        return empty;
    }
    let slide = path
        .strip_prefix("/slide[")
        .and_then(|r| r.split_once(']'))
        .map(|(n, _)| format!("/slide[{n}]"));
    let siblings = slide
        .and_then(|s| kind.get(pkg, &s, 1).ok())
        .map(|s| {
            s.children
                .iter()
                .filter(|c| c.path != path && c.path != node.path)
                .map(|c| (c.path.clone(), props(c)))
                .collect()
        })
        .unwrap_or_default();
    PlacementView {
        own: Some((node.path.clone(), props(&node))),
        siblings,
    }
}

/// A placed shape's position line, `x: X  y: Y  width: W  height: H`, and
/// a warning for each other shape at exactly its spot.
fn placement(
    _kind: Kind,
    view: &PlacementView,
    _path: &str,
) -> (Option<String>, Vec<super::Advice>) {
    let Some((_, own)) = &view.own else {
        return (None, Vec::new());
    };
    let get =
        |p: &[(String, String)], k: &str| p.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let (Some(x), Some(y)) = (get(own, "x"), get(own, "y")) else {
        return (None, Vec::new());
    };
    let line = format!(
        "x: {x}  y: {y}  width: {}  height: {}",
        get(own, "width").unwrap_or_else(|| "?".to_string()),
        get(own, "height").unwrap_or_else(|| "?".to_string())
    );
    let names: Vec<String> = view
        .siblings
        .iter()
        .filter(|(_, p)| {
            get(p, "x").as_deref() == Some(x.as_str())
                && get(p, "y").as_deref() == Some(y.as_str())
                && !(x == "0cm" && y == "0cm")
        })
        .map(|(path, p)| get(p, "name").unwrap_or_else(|| path.clone()))
        .collect();
    let advice = if names.is_empty() {
        Vec::new()
    } else {
        vec![super::Advice {
            message: format!("Same position as {}", names.join(", ")),
            code: "position_overlap",
            suggestion: Some("Use --prop x=... y=... to set distinct positions".to_string()),
        }]
    };
    (Some(line), advice)
}

/// The properties `get` shows on the node at `path`, as text, or none
/// when it does not resolve.
fn snapshot(kind: Kind, pkg: &Pkg<'_>, path: &str) -> Option<Vec<(String, String)>> {
    if !path.starts_with('/') {
        return None;
    }
    let node = kind.get(pkg, path, 1).ok()?;
    Some(
        node.format
            .iter()
            .map(|(k, v)| (k.clone(), v.text()))
            .collect(),
    )
}

/// What `set` echoes after its line when a value landed in another form
/// than it was given: each property the change touched that a requested
/// key accounts for, as `get` now shows it.
fn applied_suffix(
    applied: &[(String, String)],
    before: Option<&[(String, String)]>,
    after: Option<&[(String, String)]>,
) -> String {
    let Some(after) = after else {
        return String::new();
    };
    if applied.is_empty() {
        return String::new();
    }
    let camel = |key: &str, req: &str| {
        key.len() > req.len()
            && key[..req.len()].eq_ignore_ascii_case(req)
            && key[req.len()..].starts_with(|c: char| c.is_ascii_uppercase())
    };
    let prefix = |a: &str, b: &str| {
        a.len() > b.len() + 1
            && a[..b.len()].eq_ignore_ascii_case(b)
            && a.as_bytes()[b.len()] == b'.'
    };
    let diff_attributable = |key: &str, req: &(String, String)| {
        key.eq_ignore_ascii_case(&req.0)
            || prefix(key, &req.0)
            || prefix(&req.0, key)
            || camel(key, &req.0)
    };
    let segment = |req: &str, value: &str| {
        req.contains(':') && {
            let v = value.trim().trim_start_matches('#');
            req.split(':')
                .any(|s| s.trim().trim_start_matches('#').eq_ignore_ascii_case(v))
        }
    };
    let fallback = |kv: &(String, String), req: &(String, String)| {
        kv.0.eq_ignore_ascii_case(&req.0)
            || (prefix(&kv.0, &req.0) && kv.1 == req.1)
            || (camel(&kv.0, &req.0) && segment(&req.1, &kv.1))
    };
    let diff: Vec<&(String, String)> = match before {
        Some(before) => after
            .iter()
            .filter(|kv| {
                !before
                    .iter()
                    .any(|b| b.0.eq_ignore_ascii_case(&kv.0) && b.1 == kv.1)
            })
            .collect(),
        None => Vec::new(),
    };
    let mut picked: Vec<(String, String)> = Vec::new();
    for req in applied {
        let from_diff: Vec<&(String, String)> = diff
            .iter()
            .copied()
            .filter(|kv| diff_attributable(&kv.0, req))
            .collect();
        let chosen: Vec<&(String, String)> = if from_diff.is_empty() {
            after.iter().filter(|kv| fallback(kv, req)).collect()
        } else {
            from_diff
        };
        for kv in chosen {
            match picked.iter_mut().find(|p| p.0.eq_ignore_ascii_case(&kv.0)) {
                Some(p) => p.1 = kv.1.clone(),
                None => picked.push(kv.clone()),
            }
        }
    }
    if picked.is_empty() {
        return String::new();
    }
    picked.sort_by_key(|(k, _)| k.to_lowercase());
    let identical = applied.iter().all(|r| {
        picked
            .iter()
            .any(|d| d.0.eq_ignore_ascii_case(&r.0) && d.1 == r.1)
    }) && picked.iter().all(|d| {
        applied
            .iter()
            .any(|r| d.0.eq_ignore_ascii_case(&r.0) && d.1 == r.1)
    });
    if identical {
        return String::new();
    }
    let shown: Vec<String> = picked.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!(" (applied: {})", shown.join(", "))
}

/// One office command on a Word document or a PowerPoint deck.
pub(super) async fn run(host: &Host, config: &Config, kind: Kind) -> i32 {
    let out = Out {
        host,
        json: config.json,
    };
    let path = config.path.clone().unwrap_or_else(|| "/".to_string());
    match config.command.as_str() {
        "get" => {
            let pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            let depth = config.depth.unwrap_or(1);
            if depth < 0 {
                return out.fail(&Fail::coded(
                    format!("Invalid --depth {depth}: must be >= 0."),
                    "invalid_value",
                ));
            }
            match kind.get(&pkg, &path, (depth as usize).max(1)) {
                Ok(mut node) => {
                    if depth == 0 {
                        node.children.clear();
                    }
                    node.strip_internal();
                    if out.json {
                        out.data(matches(&[node]), None, true);
                    } else {
                        host.print(node.tree().as_bytes());
                    }
                    0
                }
                Err(f) => out.fail(&f),
            }
        }
        "query" => {
            if path.trim().is_empty() {
                return out.fail(&Fail::coded(
                    "'query' requires a selector (e.g. paragraph, shape, row[Score>80])."
                        .to_string(),
                    "invalid_input",
                ));
            }
            let pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            match kind.query(&pkg, &path, config.find.as_deref()) {
                Ok((mut results, warnings)) => {
                    if out.json {
                        kind.hydrate(&pkg, &mut results);
                        for n in &mut results {
                            n.strip_internal();
                        }
                        let w = (!warnings.is_empty())
                            .then(|| Json::Arr(warnings.iter().map(Warning::json).collect()));
                        out.data(matches(&results), w, true);
                    } else {
                        for w in &warnings {
                            host.warn(format!("{}\n", w.message).as_bytes());
                        }
                        for n in &mut results {
                            n.strip_internal();
                        }
                        if results.is_empty() {
                            host.warn(
                                format!(
                                    "No matches. Run 'office help {} query' for selector syntax.\n",
                                    kind.ext()
                                )
                                .as_bytes(),
                            );
                        } else {
                            host.print(format!("{}\n", lines(&results)).as_bytes());
                        }
                    }
                    0
                }
                Err(f) => out.fail(&f),
            }
        }
        "set" | "remove" => {
            if config.command == "set" && config.props.is_empty() {
                return out.fail(&Fail::of(format!(
                    "No properties to set at {path}. Pass at least one --prop key=value."
                )));
            }
            let mut pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            let props = pairs(&config.props);
            let before = (config.command == "set")
                .then(|| snapshot(kind, &pkg, &path))
                .flatten();
            let done = if config.command == "set" {
                kind.set(&mut pkg, &path, &props)
            } else {
                kind.remove(&mut pkg, &path).map_err(SetFail::Fail)
            };
            let (message, warnings, left) = match done {
                Ok((message, warnings)) => (message, warnings, None),
                Err(SetFail::Partial {
                    message,
                    warnings,
                    keys,
                    element,
                    valid,
                }) => (message, warnings, Some((keys, element, valid))),
                Err(SetFail::Fail(f)) => return out.fail(&f),
                Err(SetFail::Unsupported {
                    keys,
                    element,
                    valid,
                }) => return out.unsupported(&path, &keys, element, valid),
            };
            let message = if config.command == "set" {
                let after = snapshot(kind, &pkg, &path);
                let applied: Vec<(String, String)> = props
                    .iter()
                    .filter(|(k, _)| left.as_ref().is_none_or(|(keys, ..)| !keys.contains(k)))
                    .cloned()
                    .collect();
                format!(
                    "{message}{}",
                    applied_suffix(&applied, before.as_deref(), after.as_deref())
                )
            } else {
                message
            };
            for w in &warnings {
                host.warn(format!("{w}\n").as_bytes());
            }
            let moved = config.command == "set"
                && props.iter().any(|(k, _)| {
                    ["x", "left", "y", "top", "width", "w", "height", "h"]
                        .iter()
                        .any(|p| k.eq_ignore_ascii_case(p))
                });
            let view = placement_view(kind, &pkg, moved, &path);
            if pkg.dirty() {
                if let Some(reply) = pkg.save(host, &config.absolute).await {
                    return out.fail(&Fail::of(text(&failure_text(&reply))));
                }
            }
            let (spatial, advice) = placement(kind, &view, &path);
            let message = match &spatial {
                Some(line) => format!("{message}\n  {line}"),
                None => message,
            };
            if let Some((keys, element, valid)) = left {
                return out.partly(&message, &keys, element, valid);
            }
            match spatial {
                Some(_) if !out.json => {
                    host.print(format!("{message}\n").as_bytes());
                    for a in &advice {
                        host.warn(format!("  WARNING: {}\n", a.message).as_bytes());
                    }
                    0
                }
                _ => out.done(&message),
            }
        }
        "batch" => run_batch(&out, config, kind).await,
        "create" => super::create(&out, config).await,
        "add" | "move" | "swap" => {
            if config.command == "add" {
                if let Some(fail) = super::add_usage(config) {
                    return out.fail(&fail);
                }
            }
            let mut pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            let place = word::edit::Place {
                index: config.index,
                after: config.after.as_deref(),
                before: config.before.as_deref(),
            };
            let kind_name = config.kind.clone().unwrap_or_default();
            let props = pairs(&config.props);
            let images = if config.command == "add" {
                media::gather(host, media::sources(&kind_name, &props)).await
            } else {
                Media::new()
            };
            let done: Result<(String, Vec<String>, Vec<String>), Fail> =
                match (kind, config.command.as_str()) {
                    (Kind::Word, "add") => {
                        word::edit::add(&mut pkg, &path, &kind_name, &place, &props, &images)
                    }
                    (Kind::Word, "move") => {
                        word::edit::move_to(&mut pkg, &path, config.to.as_deref(), &place)
                            .map(|m| (m, Vec::new(), Vec::new()))
                    }
                    (Kind::Word, "swap") => word::edit::swap(
                        &mut pkg,
                        &path,
                        config.path2.as_deref().unwrap_or_default(),
                    )
                    .map(|m| (m, Vec::new(), Vec::new())),
                    (Kind::Slides, "add") => {
                        slides::edit::add(&mut pkg, &path, &kind_name, &place, &props, &images)
                    }
                    (Kind::Slides, "move") => {
                        slides::edit::move_to(&mut pkg, &path, config.to.as_deref(), &place)
                            .map(|m| (m, Vec::new(), Vec::new()))
                    }
                    (Kind::Slides, "swap") => slides::edit::swap(
                        &mut pkg,
                        &path,
                        config.path2.as_deref().unwrap_or_default(),
                    )
                    .map(|m| (m, Vec::new(), Vec::new())),
                    _ => Err(Fail::of(format!("Unknown command: {}", config.command))),
                };
            let (line, unread, warnings) = match done {
                Ok(d) => d,
                Err(f) => return out.fail(&f),
            };
            for w in &warnings {
                host.warn(format!("{w}\n").as_bytes());
            }
            let pkg_view = placement_view(kind, &pkg, config.command == "add", &line);
            if pkg.dirty() {
                if let Some(reply) = pkg.save(host, &config.absolute).await {
                    return out.fail(&Fail::of(text(&failure_text(&reply))));
                }
            }
            if config.command == "add" {
                let (spatial, advice) = placement(kind, &pkg_view, &line);
                super::added(
                    &out,
                    &kind_name,
                    &line,
                    &unread,
                    spatial.as_deref(),
                    &advice,
                )
            } else {
                out.done(&line)
            }
        }
        other => out.fail(&Fail::of(format!("Unknown command: {other}"))),
    }
}

fn run_item(
    pkg: &mut Pkg<'_>,
    kind: Kind,
    item: &Item,
    json: bool,
    notes: &mut Vec<String>,
    images: &Media,
) -> Result<Output, (String, Option<&'static str>)> {
    let fail = |f: Fail| (f.message, f.code);
    let verb = item.command.to_ascii_lowercase();
    match verb.as_str() {
        "meta" => Ok(Output::Text("meta".to_string())),
        "get" => {
            let path = item.path.clone().unwrap_or_else(|| "/".to_string());
            let depth = item.depth.unwrap_or(1).max(0) as usize;
            let mut node = kind.get(pkg, &path, depth).map_err(fail)?;
            node.strip_internal();
            Ok(if json {
                Output::Data(matches(&[node]))
            } else {
                Output::Text(node.tree())
            })
        }
        "query" => {
            let selector = item
                .selector
                .clone()
                .or_else(|| item.path.clone())
                .unwrap_or_default();
            if selector.is_empty() {
                return Err(("'query' command requires 'selector' field. Example: {\"command\": \"query\", \"selector\": \"row[Score>80]\"}".to_string(), None));
            }
            let (mut results, warnings) = kind
                .query(pkg, &selector, item.text.as_deref())
                .map_err(fail)?;
            notes.extend(warnings.into_iter().map(|w| w.message));
            for n in &mut results {
                n.strip_internal();
            }
            Ok(if json {
                Output::Data(matches(&results))
            } else {
                Output::Text(lines(&results))
            })
        }
        "set" => {
            let Some(path) = item.path.clone().filter(|p| !p.is_empty()) else {
                return Err(("'set' command requires 'path' field. Example: {\"command\": \"set\", \"path\": \"/slide[1]\", \"props\": {\"bold\": \"true\"}}".to_string(), None));
            };
            let props = item.props.clone().unwrap_or_default();
            if props.is_empty() {
                return Err(("'set' command requires 'props' field with at least one key=value. Got empty/missing props.".to_string(), None));
            }
            match kind.set(pkg, &path, &props) {
                Ok((message, warnings)) => {
                    notes.extend(warnings);
                    Ok(Output::Text(message))
                }
                Err(SetFail::Partial {
                    message,
                    warnings,
                    keys,
                    element,
                    valid,
                }) => {
                    notes.extend(warnings);
                    Ok(Output::Text(format!(
                        "{message}\n{}",
                        unsupported_text(&keys, element, valid)
                    )))
                }
                Err(SetFail::Fail(f)) => Err(fail(f)),
                Err(SetFail::Unsupported {
                    keys,
                    element,
                    valid,
                }) => Err((unsupported_text(&keys, element, valid), None)),
            }
        }
        "remove" => {
            let Some(path) = item.path.clone().filter(|p| !p.is_empty()) else {
                return Err(("'remove' command requires 'path' field. Example: {\"command\": \"remove\", \"path\": \"/slide[1]/shape[2]\"}".to_string(), None));
            };
            let (message, warnings) = kind.remove(pkg, &path).map_err(fail)?;
            notes.extend(warnings);
            Ok(Output::Text(message))
        }
        "add" => {
            let Some(parent) = item
                .field("parent")
                .or_else(|| item.path.clone())
                .filter(|p| !p.is_empty())
            else {
                return Err(("'add' command requires 'parent' field. Example: {\"command\": \"add\", \"parent\": \"/slide[1]\", \"type\": \"shape\", \"props\": {\"text\": \"Hello\"}}".to_string(), None));
            };
            let kind_name = item.field("type").unwrap_or_default();
            if kind_name.is_empty() && item.field("from").is_none_or(|f| f.is_empty()) {
                return Err(("'add' command requires 'type' or 'from' field. Example: {\"command\": \"add\", \"parent\": \"/\", \"type\": \"slide\"}".to_string(), None));
            }
            let (after, before) = (item.field("after"), item.field("before"));
            let index = item.index();
            let place = word::edit::Place {
                index,
                after: if index.is_none() {
                    after.as_deref().filter(|a| !a.is_empty())
                } else {
                    None
                },
                before: if index.is_none() && after.as_deref().is_none_or(str::is_empty) {
                    before.as_deref().filter(|b| !b.is_empty())
                } else {
                    None
                },
            };
            let props = item.props.clone().unwrap_or_default();
            let (at, unread, warnings) = match kind {
                Kind::Word => word::edit::add(pkg, &parent, &kind_name, &place, &props, images),
                Kind::Slides => slides::edit::add(pkg, &parent, &kind_name, &place, &props, images),
            }
            .map_err(fail)?;
            notes.extend(warnings);
            let at = at.split('\n').next().unwrap_or_default().to_string();
            let mut message = format!("Added {kind_name} at {at}");
            if !unread.is_empty() {
                message.push_str(&match kind {
                    Kind::Word => format!(
                        "\nWARNING: UNSUPPORTED props on {at}: {}",
                        unread
                            .iter()
                            .map(|k| format!("{k} (not supported)"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    Kind::Slides => format!(
                        "\nWARNING: UNSUPPORTED props: {}. Run 'office help <format> <element>' to see valid props, or raw-set for raw XML.",
                        unread.join(", ")
                    ),
                });
            }
            Ok(Output::Text(message))
        }
        "move" => {
            let path = item.path.clone().unwrap_or_else(|| "/".to_string());
            let (after, before) = (item.field("after"), item.field("before"));
            let index = item.index();
            let place = word::edit::Place {
                index,
                after: if index.is_none() {
                    after.as_deref().filter(|a| !a.is_empty())
                } else {
                    None
                },
                before: if index.is_none() && after.as_deref().is_none_or(str::is_empty) {
                    before.as_deref().filter(|b| !b.is_empty())
                } else {
                    None
                },
            };
            let to = item.field("to");
            match kind {
                Kind::Word => word::edit::move_to(pkg, &path, to.as_deref(), &place),
                Kind::Slides => slides::edit::move_to(pkg, &path, to.as_deref(), &place),
            }
            .map(Output::Text)
            .map_err(fail)
        }
        "swap" => {
            let second = item
                .field("path2")
                .filter(|p| !p.is_empty())
                .or_else(|| item.field("to"));
            let (Some(first), Some(second)) = (
                item.path.clone().filter(|p| !p.is_empty()),
                second.filter(|p| !p.is_empty()),
            ) else {
                return Err(("'swap' command requires 'path' and 'path2' (or 'to') fields. Example: {\"command\": \"swap\", \"path\": \"/slide[1]\", \"path2\": \"/slide[2]\"}".to_string(), None));
            };
            match kind {
                Kind::Word => word::edit::swap(pkg, &first, &second),
                Kind::Slides => slides::edit::swap(pkg, &first, &second),
            }
            .map(Output::Text)
            .map_err(fail)
        }
        v if VERBS.contains(&v) => Err((
            format!(
                "Command '{}' is not supported here. Supported commands: meta, get, query, set, add, remove, move, swap.",
                item.command
            ),
            None,
        )),
        _ => Err((
            format!(
                "Unknown command: '{}'. Valid commands: {}",
                item.command,
                VERBS.join(", ")
            ),
            None,
        )),
    }
}

async fn run_batch(out: &Out<'_>, config: &Config, kind: Kind) -> i32 {
    let host = out.host;
    let source = match batch_source(host, config).await {
        Ok(s) => s,
        Err(f) => return out.fail(&f),
    };
    let items: Vec<Item> = match batch::items(&source) {
        Ok(items) => items
            .into_iter()
            .filter(|i| !i.command.eq_ignore_ascii_case("meta"))
            .collect(),
        Err(message) => return out.fail(&Fail::of(message)),
    };
    if items.is_empty() {
        if host.stat(&config.absolute).await.is_none() {
            return out.fail(&Fail::missing(&config.absolute));
        }
        print_batch(out, &items, &[], false, &[]);
        return 0;
    }
    let mut pkg = match Pkg::open(host, config).await {
        Ok(p) => p,
        Err(f) => return out.fail(&f),
    };
    let atomic = !config.best_effort
        && items.iter().any(|i| {
            !matches!(
                i.command.to_ascii_lowercase().as_str(),
                "get" | "query" | "view" | "validate" | "meta"
            )
        });
    let mut outcomes = Vec::new();
    let mut stderr = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let warnings = item_warnings(item);
        let snap = pkg.snapshot();
        let mut notes = Vec::new();
        let images = if item.command.eq_ignore_ascii_case("add") {
            let kind_name = item.field("type").unwrap_or_default();
            let props = item.props.clone().unwrap_or_default();
            media::gather(host, media::sources(&kind_name, &props)).await
        } else {
            Media::new()
        };
        let result = run_item(&mut pkg, kind, item, config.json, &mut notes, &images);
        if result.is_err() {
            pkg.restore(snap);
        }
        if config.json {
            stderr.extend(notes);
        } else {
            for n in &notes {
                host.warn(format!("{n}\n").as_bytes());
            }
        }
        let stop = result.is_err() && config.stop_on_error;
        outcomes.push(Outcome {
            index,
            result,
            warnings,
        });
        if stop {
            break;
        }
    }
    let any_failed = outcomes.iter().any(|o| o.result.is_err());
    let rolled_back = atomic && any_failed;
    if !rolled_back && pkg.dirty() {
        if let Some(reply) = pkg.save(host, &config.absolute).await {
            return out.fail(&Fail::of(text(&failure_text(&reply))));
        }
    }
    print_batch(out, &items, &outcomes, rolled_back, &stderr);
    i32::from(any_failed)
}

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

use super::book::{Book, Refusal};
use super::errors::Fail;
use super::node::{Node, Value};
use super::tree::{self, A, CP, CT, DC, DCTERMS, E, EP, REL, Tree, W, outer_xml};
use super::types::Config;
use super::units::{hex_color, int_or_text, round_trip_date};
use super::xml::text;
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
/// What one parsed element costs, as measured on a document of empty
/// paragraphs, rounded up.
const TAG_COST: u64 = 300;

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
        book.tag_cost = TAG_COST;
        let mut pkg = Pkg {
            book,
            slots: HashMap::new(),
            names,
            changed: HashSet::new(),
            dropped: HashSet::new(),
            binaries: Vec::new(),
            main: String::new(),
        };
        pkg.load_reachable().await;
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

    /// The content types part and every XML part a relationship reaches
    /// from the package root, each kept as it inflates; a part nothing
    /// links to stays in the spool and is copied as it stands on save.
    async fn load_reachable(&mut self) {
        self.load(CONTENT_TYPES).await;
        let mut seen: HashSet<String> = HashSet::new();
        let mut owners = vec!["/".to_string()];
        while let Some(owner) = owners.pop() {
            self.load(&rels_name(&owner)).await;
            for r in self.rels(&owner).into_iter().filter(|r| !r.external) {
                let target = resolve_target(&owner, &r.target);
                if seen.insert(key(&target)) {
                    self.load(&target).await;
                    owners.push(target);
                }
            }
        }
    }

    /// The part `name` inflated into its slot when it is XML the package holds.
    async fn load(&mut self, name: &str) {
        let k = key(name);
        if !(k.ends_with(".xml") || k.ends_with(".rels")) || self.slots.contains_key(&k) {
            return;
        }
        let Some(stored) = self.names.iter().find(|n| key(n) == k).cloned() else {
            return;
        };
        if let Some(bytes) = self.book.keep(&stored).await {
            self.slots.insert(
                k,
                Slot {
                    name: stored,
                    bytes,
                    tree: OnceCell::new(),
                },
            );
        }
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

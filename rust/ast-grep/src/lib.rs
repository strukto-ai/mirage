// Outline text rendering adapted from ast-grep 0.51.3 (MIT). See licenses/third_party/ast-grep.txt.
use std::{cell::RefCell, fmt::Write};

use ast_grep_config::{
    CombinedScan, GlobalRules, LabelStyle, Rule, RuleCollection, RuleConfig,
    SerializableRuleConfig, Severity, from_multiple, parse_selector,
};
use ast_grep_core::source::Edit;
use ast_grep_core::{AstGrep, Pattern, tree_sitter::StrDoc};
use ast_grep_language::{LanguageExt, SupportLang};
use ast_grep_outline::{
    DEFAULT_OUTLINE_RULES,
    combined_extractor::CombinedExtractors,
    extractor::parse_outline_rules,
    options::{OutlineExtractorOptions, OutlineFlagFilter, OutlineMemberOptions},
};
use codespan_reporting::{
    diagnostic::{Diagnostic, Label},
    files::SimpleFile,
    term::{self, Config, DisplayStyle},
};
use serde::Deserialize;
use serde_json::{Value, json};
use similar::{ChangeTag, TextDiff};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
struct Request {
    verb: String,
    language: SupportLang,
    path: String,
    rule_path: Option<String>,
    pattern: Option<String>,
    rewrite: Option<String>,
    rules: Option<String>,
    filter: Option<String>,
    symbol: Option<String>,
    view: String,
    items: Option<String>,
    pub_members: bool,
    directory: bool,
    files_only: bool,
    update: bool,
    kind: Option<String>,
    style: Option<String>,
}

fn outline(req: &Request, doc: &AstGrep<StrDoc<SupportLang>>) -> Result<String> {
    let lang_line = format!("language: {}", req.language);
    let yaml = DEFAULT_OUTLINE_RULES
        .split("\n---")
        .filter(|rule| rule.lines().any(|s| s == lang_line))
        .collect::<Vec<_>>()
        .join("\n---\n");
    let rules = parse_outline_rules::<SupportLang>(&yaml)?;
    let items = match req.items.as_deref() {
        None | Some("auto") if req.directory => "exports",
        None | Some("auto") => "structure",
        Some(items) => items,
    };
    let (imports, exported) = match items {
        "structure" => (OutlineFlagFilter::No, OutlineFlagFilter::Any),
        "exports" => (OutlineFlagFilter::Any, OutlineFlagFilter::Yes),
        "imports" => (OutlineFlagFilter::Yes, OutlineFlagFilter::Any),
        "all" => (OutlineFlagFilter::Any, OutlineFlagFilter::Any),
        other => return Err(format!("invalid outline items: {other}").into()),
    };
    let options = OutlineExtractorOptions {
        imports,
        exported,
        members: Some(OutlineMemberOptions {
            public: if req.pub_members {
                OutlineFlagFilter::Yes
            } else {
                OutlineFlagFilter::Any
            },
            ..Default::default()
        }),
        item_regex: req.filter.as_deref().map(regex::Regex::new).transpose()?,
        symbol_types: req
            .symbol
            .as_ref()
            .map(|s| {
                s.split(',')
                    .map(|v| serde_json::from_value(json!(v)))
                    .collect()
            })
            .transpose()?,
        ..Default::default()
    };
    let extractors = CombinedExtractors::try_from_rules(rules, options, &GlobalRules::default())?;
    let items: Vec<_> = extractors.extract(doc.root()).collect();
    if req.directory && items.is_empty() {
        return Ok(String::new());
    }
    let mut output = format!("{}\n", req.path);
    if items.is_empty() {
        output.push_str("nothing found\n");
        return Ok(output);
    }
    let view = if req.view == "auto" {
        if req.directory { "names" } else { "digest" }
    } else {
        &req.view
    };
    if view == "names" {
        groups(
            &mut output,
            items
                .iter()
                .map(|i| (i.entry.symbol_type, i.entry.name.as_ref())),
            0,
        )?;
        return Ok(output);
    }
    let width = items
        .iter()
        .flat_map(|i| std::iter::once(&i.entry).chain(i.members.iter().map(|m| &m.entry)))
        .map(|e| e.range.start.line + 1)
        .max()
        .unwrap_or(1)
        .to_string()
        .len();
    for item in items {
        let entry = &item.entry;
        writeln!(
            output,
            "{:>width$}: {}",
            entry.range.start.line + 1,
            entry.signature
        )?;
        if view == "expanded" {
            for m in &item.members {
                writeln!(
                    output,
                    "{:>width$}:   {}",
                    m.entry.range.start.line + 1,
                    m.entry.signature
                )?;
            }
        } else if view == "digest" {
            let members = [true, false]
                .into_iter()
                .flat_map(|public| item.members.iter().filter(move |m| m.is_public == public))
                .map(|m| (m.entry.symbol_type, m.entry.name.as_ref()));
            groups(&mut output, members, width + 4)?;
        }
    }
    Ok(output)
}

fn groups<'a>(
    out: &mut String,
    entries: impl Iterator<Item = (ast_grep_outline::model::SymbolType, &'a str)>,
    indent: usize,
) -> Result<()> {
    use std::collections::BTreeMap;
    let order = "file module namespace package class struct enum interface function method constructor property field enumMember variable constant string number boolean array object key null event operator typeParameter";
    let mut groups = BTreeMap::new();
    for (kind, name) in entries {
        let kind = serde_json::to_value(kind)?;
        let kind = kind.as_str().ok_or("invalid symbol type")?;
        let rank = order
            .split(' ')
            .position(|k| k == kind)
            .unwrap_or(usize::MAX);
        let (_, names, counts) = groups.entry(rank).or_insert_with(|| {
            (
                kind.to_owned(),
                Vec::new(),
                std::collections::HashMap::new(),
            )
        });
        let count = counts.entry(name).or_insert(0);
        if *count == 0 {
            names.push(name);
        }
        *count += 1;
    }
    for (_, (kind, names, counts)) in groups {
        let names = names
            .into_iter()
            .map(|name| {
                if counts[name] == 1 {
                    name.to_owned()
                } else {
                    format!("{name} ×{}", counts[name])
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(out, "{:indent$}{kind}: {names}", "")?;
    }
    Ok(())
}

fn preview(out: &mut String, original: &str, updated: &str) -> Result<()> {
    let diff = TextDiff::from_lines(original, updated);
    for group in diff.grouped_ops(3) {
        let first = &group[0];
        let last = &group[group.len() - 1];
        let old = first.old_range().start..last.old_range().end;
        let new = first.new_range().start..last.new_range().end;
        writeln!(
            out,
            "@@ -{},{} +{},{} @@",
            old.start,
            old.len(),
            new.start,
            new.len()
        )?;
        let width = old.end.max(new.end).to_string().len();
        for change in group.iter().flat_map(|op| diff.iter_changes(op)) {
            let number = |i: Option<usize>| i.map(|v| (v + 1).to_string()).unwrap_or_default();
            let marker = match change.tag() {
                ChangeTag::Equal => ' ',
                ChangeTag::Delete => '-',
                ChangeTag::Insert => '+',
            };
            writeln!(
                out,
                "{:width$} {:width$}│{marker}{}",
                number(change.old_index()),
                number(change.new_index()),
                change.value().trim_end_matches('\n')
            )?;
        }
    }
    Ok(())
}

fn apply_edits(source: &str, mut edits: Vec<Edit<String>>) -> Result<(String, usize)> {
    edits.sort_by_key(|e| e.position);
    let mut bytes = Vec::with_capacity(source.len());
    let mut last = 0;
    let mut applied = 0;
    for edit in edits {
        if edit.position < last {
            continue;
        }
        bytes.extend_from_slice(&source.as_bytes()[last..edit.position]);
        bytes.extend_from_slice(&edit.inserted_text);
        last = edit.position + edit.deleted_length;
        applied += 1;
    }
    bytes.extend_from_slice(&source.as_bytes()[last..]);
    Ok((String::from_utf8(bytes)?, applied))
}

fn scan_rules(yaml: &str) -> Result<RuleCollection<SupportLang>> {
    let globals = GlobalRules::default();
    let mut rules = Vec::new();
    for rule in from_multiple::<SerializableRuleConfig<SupportLang>>(yaml)? {
        if !matches!(
            rule.language,
            SupportLang::Python
                | SupportLang::Rust
                | SupportLang::TypeScript
                | SupportLang::Tsx
                | SupportLang::JavaScript
        ) {
            return Err(format!("unsupported language: {}", rule.language).into());
        }
        rules.push(RuleConfig::try_from(rule, &globals)?);
    }
    Ok(RuleCollection::try_new(rules)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    rule_dirs: Vec<String>,
    #[serde(default)]
    util_dirs: Vec<String>,
    custom_languages: Option<Value>,
    language_globs: Option<Value>,
}

fn dispatch(options: &[u8], data: &[u8]) -> Result<Value> {
    #[derive(Deserialize)]
    struct Operation {
        verb: String,
    }
    let source = std::str::from_utf8(data)?;
    match serde_json::from_slice::<Operation>(options)?.verb.as_str() {
        "config" => {
            let project: Project = ast_grep_config::from_str(source)?;
            if !project.util_dirs.is_empty()
                || project.custom_languages.is_some()
                || project.language_globs.is_some()
            {
                return Err("this build supports project ruleDirs only".into());
            }
            Ok(json!({"values":project.rule_dirs}))
        }
        "rules" => {
            let collection = scan_rules(source)?;
            let mut languages = std::collections::BTreeSet::new();
            collection.for_each_rule(|rule| {
                languages.insert(rule.language.to_string());
            });
            Ok(json!({"values":languages}))
        }
        _ => execute(serde_json::from_slice(options)?, source),
    }
}

fn execute(req: Request, source: &str) -> Result<Value> {
    let doc = req.language.ast_grep(source);
    let root = doc.root();
    let mut output = String::new();
    let mut count = 0;
    let mut errors = 0;
    let mut applied = 0;
    let mut updated = None;
    match req.verb.as_str() {
        "outline" => output = outline(&req, &doc)?,
        "run" => {
            let matcher = match (req.kind.as_deref(), req.pattern.as_deref()) {
                (Some(kind), None) => parse_selector(kind, req.language)?,
                (None, Some(pattern)) => Rule::Pattern(Pattern::try_new(pattern, req.language)?),
                _ => return Err("specify either --pattern or --kind".into()),
            };
            if let Some(rewrite) = &req.rewrite {
                let edits = root.replace_all(&matcher, rewrite.as_str());
                count = edits.len();
                if count > 0 {
                    let (new, n) = apply_edits(source, edits)?;
                    if req.update {
                        updated = Some(new);
                        applied = n;
                    } else {
                        writeln!(output, "{}", req.path)?;
                        preview(&mut output, source, &new)?;
                    }
                }
            } else {
                let lines: Vec<_> = source.split('\n').collect();
                let mut next = 0;
                for found in root.find_all(&matcher) {
                    count += 1;
                    if req.files_only {
                        writeln!(output, "{}", req.path)?;
                        break;
                    }
                    let first = found.start_pos().line().max(next);
                    let end = found.end_pos().line();
                    for (line, text) in lines.iter().enumerate().take(end + 1).skip(first) {
                        writeln!(output, "{}:{}:{text}", req.path, line + 1)?;
                    }
                    next = next.max(end + 1);
                }
            }
        }
        "scan" => {
            let rules = scan_rules(req.rules.as_deref().ok_or("a rule is required")?)?;
            let file = SimpleFile::new(req.path.as_str(), source);
            let config = Config {
                display_style: match req.style.as_deref() {
                    Some("short") => DisplayStyle::Short,
                    Some("medium") => DisplayStyle::Medium,
                    _ => DisplayStyle::Rich,
                },
                ..Config::default()
            };
            let path = std::path::Path::new(req.rule_path.as_deref().unwrap_or(&req.path));
            let scan = CombinedScan::new(rules.get_rule_from_lang(path, req.language));
            let mut findings = scan.scan(&doc, false);
            let mut edits = Vec::new();
            findings
                .matches
                .sort_unstable_by(|(a, _), (b, _)| a.id.cmp(&b.id));
            for (rule, matches) in findings.matches {
                for found in matches {
                    count += 1;
                    if matches!(rule.severity, Severity::Error)
                        && (!req.update || rule.fixer.is_empty())
                    {
                        errors += 1;
                    }
                    let severity = match rule.severity {
                        Severity::Hint => codespan_reporting::diagnostic::Severity::Help,
                        Severity::Info => codespan_reporting::diagnostic::Severity::Note,
                        Severity::Warning => codespan_reporting::diagnostic::Severity::Warning,
                        Severity::Error => codespan_reporting::diagnostic::Severity::Error,
                        Severity::Off => continue,
                    };
                    if let Some(fix) = rule.fixer.first() {
                        let edit = found.make_edit(&rule.matcher, fix);
                        if req.update {
                            edits.push(edit);
                            continue;
                        }
                        if matches!(config.display_style, DisplayStyle::Rich) {
                            writeln!(
                                output,
                                "{}\n{}[{}]: {}",
                                req.path,
                                format!("{severity:?}").to_ascii_lowercase(),
                                rule.id,
                                rule.get_message(&found)
                            )?;
                            preview(&mut output, source, &apply_edits(source, vec![edit])?.0)?;
                            continue;
                        }
                    }
                    let labels = rule.get_labels(&found).into_iter().map(|label| {
                        let l = match label.style {
                            LabelStyle::Primary => Label::primary((), label.range()),
                            LabelStyle::Secondary => Label::secondary((), label.range()),
                        };
                        l.with_message(label.message.unwrap_or_default())
                    });
                    let diagnostic = Diagnostic::new(severity)
                        .with_code(&rule.id)
                        .with_message(rule.get_message(&found))
                        .with_labels_iter(labels)
                        .with_notes_iter(rule.note.iter().cloned());
                    term::emit_to_string(&mut output, &config, &file, &diagnostic)?;
                }
            }
            if !edits.is_empty() {
                let (new, n) = apply_edits(source, edits)?;
                updated = Some(new);
                applied = n;
            }
        }
        _ => return Err("unknown command".into()),
    }
    Ok(json!({"output":output,"updated":updated,"count":count,"errors":errors,"applied":applied}))
}

thread_local! { static BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) }; }

#[unsafe(no_mangle)]
pub extern "C" fn input(len: usize) -> *mut u8 {
    BUFFER.with_borrow_mut(|b| {
        b.resize(len, 0);
        b.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn process(header: usize) -> usize {
    BUFFER.with_borrow_mut(|b| {
        let run = || -> Result<Value> {
            let (options, source) = b.split_at_checked(header).ok_or("invalid request")?;
            dispatch(options, source)
        };
        let reply = run().unwrap_or_else(|e| json!({"error":e.to_string()}));
        *b = serde_json::to_vec(&reply).expect("serializable reply");
        b.len()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn output() -> *const u8 {
    BUFFER.with_borrow(|b| b.as_ptr())
}

// Follows gh 2.85.0's pkg/cmd/search and pkg/search (MIT; see
// licenses/third_party/gh.txt).

use std::collections::BTreeMap;

use super::accessor::{Flags, Out, csv_values, json_fields, typed_out, web_host};
use super::constants::{
    GITHUB_HOST, SEARCH_BOOLEAN, SEARCH_MULTIPLE, search_alias, search_fields, search_flags,
    search_shape, search_sorted,
};
use super::template::render_template;
use crate::core::github::client::{
    Account, ApiError, Failure, Result, github_request, usage, value,
};
use crate::core::github::json::{Json, Obj, quoted};
use crate::core::github::repo::graphql_data;
use crate::core::github::search::search;

const SEARCH_TYPES: &str = "query SearchType_enumValues{SearchType: __type(name: \"SearchType\"){enumValues(includeDeprecated: true){name}}}";
const ADVANCED_SEARCH_SINCE: [u64; 3] = [3, 18, 0];

/// Which issue search a host takes, as gh's SearchFeatures finds out.
#[derive(Clone, Copy, Default)]
pub(crate) struct SearchFeatures {
    pub(crate) advanced: bool,
    pub(crate) opt_in: bool,
}

impl SearchFeatures {
    /// The GraphQL search type these features call for.
    pub(crate) fn search_type(self) -> &'static str {
        if self.advanced && self.opt_in {
            "ISSUE_ADVANCED"
        } else {
            "ISSUE"
        }
    }
}

/// Whether gh counts a host as a GitHub Enterprise Server.
fn is_enterprise(host: &str) -> bool {
    let host = host.to_lowercase();
    !(host == GITHUB_HOST
        || host.ends_with(&format!(".{GITHUB_HOST}"))
        || host == "github.localhost"
        || host.ends_with(".github.localhost")
        || host.ends_with(".ghe.com"))
}

/// Whether a server's version reaches `floor`, a pre-release falling short
/// of the release it leads to.
fn version_reaches(text: &str, floor: [u64; 3]) -> Result<bool> {
    let bare = text.strip_prefix('v').unwrap_or(text);
    let core = bare
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .map_or(bare, |end| &bare[..end]);
    let Some(numbers) = core
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<Vec<u64>>>()
    else {
        return value(format!("Malformed version: {text}"));
    };
    let mut parts = [0u64; 3];
    for (part, number) in parts.iter_mut().zip(numbers) {
        *part = number;
    }
    Ok(parts > floor || (parts == floor && core == bare))
}

/// What the host says about issue search: an Enterprise Server below 3.18
/// has only the standard search, and any other host opts in while its
/// schema still lists `ISSUE_ADVANCED`.
pub(crate) async fn search_features(account: &Account) -> Result<SearchFeatures> {
    if is_enterprise(&web_host(account)?) {
        let meta = github_request(account, "GET", "/meta", None).await?;
        if !version_reaches(meta.get("installed_version").text(), ADVANCED_SEARCH_SINCE)? {
            return Ok(SearchFeatures::default());
        }
    }
    let data = graphql_data(account, SEARCH_TYPES, Obj::new()).await?;
    let opt_in = data
        .get("SearchType")
        .get("enumValues")
        .items()
        .iter()
        .any(|found| found.get("name").text() == "ISSUE_ADVANCED");
    Ok(SearchFeatures {
        advanced: true,
        opt_in,
    })
}

fn quote(text: &str) -> String {
    if text.chars().any(|c| c.is_whitespace() || c == '"') {
        quoted(text)
    } else {
        text.to_owned()
    }
}

fn dest(name: &str) -> String {
    name.replace('-', "_")
}

fn boolean(flags: &Flags, name: &str) -> bool {
    flags.gh_bool(&dest(name))
}

fn qualifiers_of(kind: &str, flags: &Flags) -> Result<BTreeMap<String, Vec<String>>> {
    let mut qualifiers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for name in search_flags(kind) {
        let key = dest(name);
        let Some(raw) = flags.raw(&key) else { continue };
        if matches!(name, "app" | "include-prs" | "locked" | "merged") || name.starts_with("no-") {
            continue;
        }
        let mut qualifier = search_alias(name).to_owned();
        if name == "review-requested" && raw.as_str().is_some_and(|text| text.contains('/')) {
            qualifier = "team-review-requested".to_owned();
        }
        let values = if SEARCH_BOOLEAN.contains(&name) {
            vec![boolean(flags, name).to_string()]
        } else if SEARCH_MULTIPLE.contains(&name) {
            csv_values(&flags.as_list(&key))
        } else {
            vec![flags.as_str(&key).unwrap_or("").to_owned()]
        };
        qualifiers
            .entry(qualifier)
            .or_default()
            .extend(values.into_iter().filter(|value| !value.is_empty()));
    }
    if matches!(kind, "issues" | "prs") {
        if kind == "prs" || !boolean(flags, "include-prs") {
            qualifiers.insert(
                "type".to_owned(),
                vec![if kind == "prs" { "pr" } else { "issue" }.to_owned()],
            );
        }
        if let Some(app) = flags.as_str("app") {
            if flags.as_str("author").is_some() {
                return usage("specify only `--author` or `--app`");
            }
            qualifiers.insert("author".to_owned(), vec![format!("app/{app}")]);
        }
        let states: &[&str] = if kind == "prs" {
            &["locked", "merged"]
        } else {
            &["locked"]
        };
        for name in states {
            if flags.raw(name).is_some() {
                let value = if boolean(flags, name) {
                    (*name).to_owned()
                } else {
                    format!("un{name}")
                };
                qualifiers.entry("is".to_owned()).or_default().push(value);
            }
        }
        qualifiers.insert(
            "no".to_owned(),
            ["assignee", "label", "milestone", "project"]
                .into_iter()
                .filter(|name| flags.gh_bool(&format!("no_{name}")))
                .map(str::to_owned)
                .collect(),
        );
    }
    Ok(qualifiers)
}

fn query_text(
    words: &[String],
    qualifiers: &BTreeMap<String, Vec<String>>,
    advanced: bool,
) -> String {
    let keywords = words
        .iter()
        .map(|word| match word.split_once(':') {
            Some((head, tail)) => format!("{head}:{}", quote(tail)),
            None => quote(word),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let tail = qualifiers
        .iter()
        .filter(|(_, values)| !values.is_empty())
        .flat_map(|(key, values)| {
            if advanced {
                advanced_terms(key, values)
            } else {
                plain_terms(key, values)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    match (keywords.is_empty(), tail.is_empty()) {
        (false, false) if advanced => format!("( {keywords} ) {tail}"),
        (false, false) => format!("{keywords} {tail}"),
        (false, true) => keywords,
        _ => tail,
    }
}

fn plain_terms(key: &str, values: &[String]) -> Vec<String> {
    let mut terms: Vec<String> = values
        .iter()
        .map(|value| format!("{key}:{}", quote(value)))
        .collect();
    terms.sort();
    terms
}

fn any_of(key: &str, values: &[String]) -> String {
    let terms = plain_terms(key, values);
    match terms.as_slice() {
        [only] => only.clone(),
        _ => format!("({})", terms.join(" OR ")),
    }
}

/// One qualifier as gh's AdvancedIssueSearchString writes it: values that
/// cannot hold together are joined with OR.
fn advanced_terms(key: &str, values: &[String]) -> Vec<String> {
    let groups: &[&[&str]] = match key {
        "in" => &[&["title", "body", "comments"]],
        "is" => &[
            &["blocked", "blocking"],
            &["closed", "open"],
            &["issue", "pr"],
            &["locked", "unlocked"],
            &["merged", "unmerged"],
            &["private", "public"],
        ],
        "user" | "repo" => return vec![any_of(key, values)],
        _ => return plain_terms(key, values),
    };
    let member = |value: &String, group: &[&str]| group.contains(&value.as_str());
    let mut terms: Vec<String> = groups
        .iter()
        .filter_map(|group| {
            let held: Vec<String> = values
                .iter()
                .filter(|value| member(value, group))
                .cloned()
                .collect();
            (!held.is_empty()).then(|| any_of(key, &held))
        })
        .collect();
    let rest: Vec<String> = values
        .iter()
        .filter(|value| !groups.iter().any(|group| member(value, group)))
        .cloned()
        .collect();
    terms.extend(plain_terms(key, &rest));
    terms.sort();
    terms
}

/// The narrowing `gh pr list` and `gh issue list` ask GitHub's search for.
#[derive(Default)]
pub(crate) struct ListQuery<'a> {
    pub(crate) entity: &'a str,
    pub(crate) state: &'a str,
    pub(crate) assignee: Option<&'a str>,
    pub(crate) author: Option<&'a str>,
    pub(crate) base: Option<&'a str>,
    pub(crate) head: Option<&'a str>,
    pub(crate) draft: Option<bool>,
    pub(crate) labels: &'a [String],
    pub(crate) mention: Option<&'a str>,
    pub(crate) milestone: Option<&'a str>,
    pub(crate) search: Option<&'a str>,
}

/// The query gh's SearchQueryBuild writes: qualifiers sorted by name, the
/// keywords in front of them, bracketed for the advanced issue search.
pub(crate) fn list_query(filter: &ListQuery<'_>, repo: &str, advanced: bool) -> String {
    let mut qualifiers: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (key, value) in [
        ("assignee", filter.assignee),
        ("author", filter.author),
        ("base", filter.base),
        ("head", filter.head),
        ("mentions", filter.mention),
        ("milestone", filter.milestone),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            qualifiers.entry(key).or_default().push(value.to_owned());
        }
    }
    if let Some(draft) = filter.draft {
        qualifiers
            .entry("draft")
            .or_default()
            .push(draft.to_string());
    }
    match filter.state {
        "open" | "closed" => qualifiers
            .entry("state")
            .or_default()
            .push(filter.state.to_owned()),
        "merged" => qualifiers
            .entry("is")
            .or_default()
            .push("merged".to_owned()),
        _ => {}
    }
    qualifiers
        .entry("label")
        .or_default()
        .extend(filter.labels.iter().cloned());
    qualifiers.entry("repo").or_default().push(repo.to_owned());
    qualifiers
        .entry("type")
        .or_default()
        .push(filter.entity.to_owned());
    let mut tail = Vec::new();
    for (key, values) in &qualifiers {
        let mut formatted: Vec<String> = values
            .iter()
            .filter(|value| !value.is_empty())
            .map(|value| format!("{key}:{}", quote(value)))
            .collect();
        formatted.sort();
        tail.extend(formatted);
    }
    let tail = tail.join(" ");
    match filter.search.filter(|words| !words.is_empty()) {
        Some(words) if advanced => format!("( {words} ) {tail}"),
        Some(words) => format!("{words} {tail}"),
        None => tail,
    }
}

/// Whether a `--search` query already says which state it wants.
pub(crate) fn has_state_clause(query: &str) -> bool {
    query.split_whitespace().any(|word| {
        matches!(
            word,
            "is:closed" | "is:merged" | "state:closed" | "state:merged"
        ) || word.starts_with("merged:")
            || word.starts_with("closed:")
    })
}

/// How gh search words a failed search: a 422 naming its errors says the
/// query is invalid, anything else is the status, GitHub's message and
/// the request URL.
fn search_error(error: &ApiError, query: &str) -> String {
    let data = error.data.as_obj();
    if let Some(found) = data.and_then(|obj| obj.find("errors")) {
        if error.status == 422 && !found.items().is_empty() {
            let reason = found.items()[0].get("message").text();
            return format!("Invalid search query {}.\n{reason}", quoted(query.trim()));
        }
    }
    let message = match data {
        None => format!("{} {}", error.status, error.message),
        Some(obj) => obj.get("message").text().to_owned(),
    };
    format!("HTTP {}: {message} ({})", error.status, error.url)
}

fn shape(kind: &str, raw: &Json) -> Json {
    if let Some(inner) = kind.strip_prefix('*') {
        return if raw.is_null() {
            Json::Null
        } else {
            shape(inner, raw)
        };
    }
    if let Some(inner) = kind.strip_prefix("[]") {
        return match raw {
            Json::Arr(items) => Json::Arr(items.iter().map(|item| shape(inner, item)).collect()),
            _ => Json::Null,
        };
    }
    let or = |fallback: Json| if raw.truthy() { raw.clone() } else { fallback };
    match kind {
        "time.Time" => or("0001-01-01T00:00:00Z".into()),
        "string" => or("".into()),
        "bool" => raw.truthy().into(),
        "int" => or(0i64.into()),
        _ => {
            let mut out = Obj::new();
            for (name, key, typ) in search_shape(kind) {
                out.set(*name, shape(typ, raw.get(key)));
            }
            Json::Obj(out)
        }
    }
}

fn user(raw: &Json) -> Json {
    let node = raw.get("node_id");
    let bot = !node.truthy();
    let mut out = Obj::new();
    out.set("id", node.as_str().unwrap_or(""));
    let login = raw.get("login").as_str().unwrap_or("");
    out.set(
        "login",
        if bot {
            format!("app/{login}")
        } else {
            login.to_owned()
        },
    );
    out.set("type", raw.get("type").as_str().unwrap_or(""));
    out.set("url", raw.get("html_url").as_str().unwrap_or(""));
    out.set("is_bot", bot);
    Json::Obj(out)
}

fn exported(kind: &str, raw: &Json) -> Obj {
    let name = match kind {
        "repos" => "Repository",
        "issues" | "prs" => "Issue",
        "code" => "Code",
        _ => "Commit",
    };
    let Json::Obj(mut row) = shape(name, raw) else {
        return Obj::new();
    };
    match kind {
        "repos" => row.set("owner", user(raw.get("owner"))),
        "issues" | "prs" => {
            row.set("author", user(raw.get("user")));
            row.set(
                "assignees",
                raw.get("assignees")
                    .items()
                    .iter()
                    .map(user)
                    .collect::<Vec<_>>(),
            );
            let labels = row.get("labels").clone();
            row.set(
                "labels",
                if labels.truthy() {
                    labels
                } else {
                    Json::Arr(Vec::new())
                },
            );
            let pull = raw.get("pull_request");
            row.set("isPullRequest", pull.get("html_url").truthy());
            row.set(
                "state",
                if pull.get("merged_at").truthy() {
                    Json::from("merged")
                } else {
                    raw.as_obj()
                        .and_then(|obj| obj.find("state"))
                        .cloned()
                        .unwrap_or_else(|| "".into())
                },
            );
            let url = raw.get("repository_url").show();
            let parts: Vec<&str> = url.trim_end_matches('/').split('/').collect();
            let mut repository = Obj::new();
            repository.set("name", parts[parts.len() - 1]);
            repository.set(
                "nameWithOwner",
                parts[parts.len().saturating_sub(2)..].join("/"),
            );
            row.set("repository", repository);
        }
        "code" => {
            let repo = raw.get("repository");
            let mut repository = Obj::new();
            repository.set("id", repo.get("node_id").as_str().unwrap_or(""));
            repository.set(
                "nameWithOwner",
                repo.get("full_name").as_str().unwrap_or(""),
            );
            repository.set("url", repo.get("html_url").as_str().unwrap_or(""));
            repository.set("isPrivate", repo.get("private").truthy());
            repository.set("isFork", repo.get("fork").truthy());
            row.set("repository", repository);
            let matches: Vec<Json> = raw
                .get("text_matches")
                .items()
                .iter()
                .map(|item| {
                    let mut out = Obj::new();
                    let text = |key: &str| {
                        item.as_obj()
                            .and_then(|obj| obj.find(key))
                            .cloned()
                            .unwrap_or_else(|| "".into())
                    };
                    out.set("fragment", text("fragment"));
                    out.set("matches", item.get("matches").clone());
                    out.set("type", text("object_type"));
                    out.set("property", text("property"));
                    Json::Obj(out)
                })
                .collect();
            row.set("textMatches", matches);
        }
        _ => {
            row.set("author", user(raw.get("author")));
            row.set("committer", user(raw.get("committer")));
            let info = raw.get("commit");
            let mut commit = Obj::new();
            commit.set("author", shape("CommitUser", info.get("author")));
            commit.set("committer", shape("CommitUser", info.get("committer")));
            commit.set("comment_count", shape("int", info.get("comment_count")));
            commit.set("message", shape("string", info.get("message")));
            commit.set("tree", shape("Tree", info.get("tree")));
            row.set("commit", commit);
            let parents = row.get("parents").clone();
            row.set(
                "parents",
                if parents.truthy() {
                    parents
                } else {
                    Json::Arr(Vec::new())
                },
            );
            let repo = exported("repos", raw.get("repository"));
            let mut repository = Obj::new();
            for key in [
                "description",
                "fullName",
                "name",
                "id",
                "isFork",
                "isPrivate",
                "owner",
                "url",
            ] {
                repository.set(key, repo.get(key).clone());
            }
            row.set("repository", repository);
        }
    }
    row
}

fn squeezed(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn human(kind: &str, rows: &[Obj], values: &[Json], both: bool) -> String {
    let mut lines = String::new();
    for (row, raw) in rows.iter().zip(values) {
        let cells: Vec<String> = match kind {
            "issues" | "prs" => {
                let mut cells = Vec::new();
                if both {
                    cells.push(
                        if row.get("isPullRequest").truthy() {
                            "pr"
                        } else {
                            "issue"
                        }
                        .to_owned(),
                    );
                }
                cells.push(row.get("repository").get("nameWithOwner").show());
                cells.push(row.get("number").show());
                cells.push(row.get("state").show());
                cells.push(squeezed(row.get("title").text()));
                cells.push(
                    row.get("labels")
                        .items()
                        .iter()
                        .map(|label| label.get("name").show())
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                cells.push(row.get("updatedAt").show());
                cells
            }
            "repos" => {
                let mut tags = vec![if row.get("visibility").truthy() {
                    row.get("visibility").show()
                } else if row.get("isPrivate").truthy() {
                    "private".to_owned()
                } else {
                    "public".to_owned()
                }];
                if row.get("isFork").truthy() {
                    tags.push("fork".to_owned());
                }
                if row.get("isArchived").truthy() {
                    tags.push("archived".to_owned());
                }
                vec![
                    row.get("fullName").show(),
                    squeezed(row.get("description").text()),
                    tags.join(", "),
                    row.get("updatedAt").show(),
                ]
            }
            "commits" => vec![
                row.get("repository").get("fullName").show(),
                row.get("sha").show(),
                squeezed(row.get("commit").get("message").text()),
                raw.get("author").get("login").show(),
                row.get("commit").get("author").get("date").show(),
            ],
            _ => {
                let name = row.get("repository").get("nameWithOwner").show();
                let path = row.get("path").show();
                for found in row.get("textMatches").items() {
                    let mut offset = 0usize;
                    for line in found.get("fragment").text().split('\n') {
                        let end = offset + line.len();
                        let hit = found.get("matches").items().iter().any(|item| {
                            let start = item
                                .get("indices")
                                .items()
                                .first()
                                .and_then(Json::as_int)
                                .unwrap_or(-1);
                            (offset as i128) <= start && start < end as i128
                        });
                        if hit {
                            lines.push_str(&format!("{name}:{path}: {}\n", line.trim()));
                        }
                        offset = end + 1;
                    }
                }
                continue;
            }
        };
        lines.push_str(&cells.join("\t"));
        lines.push('\n');
    }
    lines
}

pub(crate) async fn search_cmd(
    kind: &str,
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let allowed = search_fields(kind);
    let fields = json_fields(flags, &allowed)?;
    let limit = flags
        .as_int("limit")
        .filter(|limit| (1..=1000).contains(limit));
    let Some(limit) = limit else {
        return usage("`--limit` must be between 1 and 1000");
    };
    if texts.is_empty() && account.argv_len <= 2 {
        return usage("specify search keywords or flags");
    }
    let program = flags.as_str("jq");
    let template = flags.as_str("template");
    if fields.is_none() && program.is_some() {
        return value("cannot use `--jq` without specifying `--json`");
    }
    if fields.is_none() && template.is_some() {
        return value("cannot use `--template` without specifying `--json`");
    }
    let qualifiers = qualifiers_of(kind, flags)?;
    let features = if matches!(kind, "issues" | "prs") {
        search_features(account).await?
    } else {
        SearchFeatures::default()
    };
    let query = query_text(texts, &qualifiers, features.advanced);
    let resource = match kind {
        "repos" => "repositories",
        "prs" => "issues",
        other => other,
    };
    let sorted = search_sorted(kind);
    let values = match search(
        account,
        resource,
        &query,
        limit,
        flags.as_str("sort").filter(|_| sorted),
        flags.as_str("order").filter(|_| sorted),
        features.advanced && features.opt_in,
    )
    .await
    {
        Ok(values) => values,
        Err(Failure::Api(error)) => {
            return Ok(Out::failed(format!("{}\n", search_error(&error, &query))));
        }
        Err(failure) => return Err(failure),
    };
    let rows: Vec<Obj> = values.iter().map(|value| exported(kind, value)).collect();
    if let Some(template) = template.filter(|_| program.is_none()) {
        let mut keys = fields.clone().unwrap_or_default();
        keys.sort();
        let selected: Vec<Json> = rows
            .iter()
            .map(|row| {
                let mut out = Obj::new();
                for key in &keys {
                    out.set(key.as_str(), row.get(key).clone());
                }
                Json::Obj(out)
            })
            .collect();
        return Ok(Out::text(render_template(template, &Json::Arr(selected))?));
    }
    let text = human(
        kind,
        &rows,
        &values,
        kind == "issues" && boolean(flags, "include-prs"),
    );
    let data = Json::Arr(rows.into_iter().map(Json::Obj).collect());
    typed_out(account, &data, flags, text, &allowed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enterprise_hosts_are_told_as_gh_tells_them() {
        assert!(is_enterprise("ghe.example.com"));
        assert!(is_enterprise("127.0.0.1"));
        for host in [
            "github.com",
            "GitHub.com",
            "api.github.com",
            "github.localhost",
            "acme.ghe.com",
        ] {
            assert!(!is_enterprise(host), "{host}");
        }
    }

    #[test]
    fn a_server_version_is_compared_by_its_numbers() {
        let floor = ADVANCED_SEARCH_SINCE;
        assert!(version_reaches("3.18.0", floor).unwrap());
        assert!(version_reaches("3.18", floor).unwrap());
        assert!(version_reaches("v3.20.1", floor).unwrap());
        assert!(!version_reaches("3.9.4", floor).unwrap());
        assert!(!version_reaches("3.16.0", floor).unwrap());
        assert!(!version_reaches("3.18.0-rc1", floor).unwrap());
        assert!(version_reaches("", floor).is_err());
    }

    #[test]
    fn list_keywords_are_bracketed_only_for_the_advanced_search() {
        let filter = ListQuery {
            entity: "issue",
            state: "open",
            search: Some("a OR b"),
            ..ListQuery::default()
        };
        assert_eq!(
            list_query(&filter, "o/r", true),
            "( a OR b ) repo:o/r state:open type:issue"
        );
        assert_eq!(
            list_query(&filter, "o/r", false),
            "a OR b repo:o/r state:open type:issue"
        );
    }

    #[test]
    fn the_search_type_follows_the_features() {
        let opted = SearchFeatures {
            advanced: true,
            opt_in: true,
        };
        assert_eq!(opted.search_type(), "ISSUE_ADVANCED");
        let plain = SearchFeatures {
            advanced: true,
            opt_in: false,
        };
        assert_eq!(plain.search_type(), "ISSUE");
        assert_eq!(SearchFeatures::default().search_type(), "ISSUE");
    }

    fn words(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn advanced_terms_join_what_cannot_hold_together() {
        assert_eq!(
            advanced_terms("repo", &words(&["b/c", "a/b"])),
            ["(repo:a/b OR repo:b/c)"]
        );
        assert_eq!(advanced_terms("repo", &words(&["a/b"])), ["repo:a/b"]);
        assert_eq!(
            advanced_terms("is", &words(&["closed", "open", "locked"])),
            ["(is:closed OR is:open)", "is:locked"]
        );
        assert_eq!(
            advanced_terms("label", &words(&["z", "a"])),
            ["label:a", "label:z"]
        );
    }
}

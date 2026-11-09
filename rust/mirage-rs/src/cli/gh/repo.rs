// Follows gh 2.85.0's pkg/cmd/repo (MIT; see licenses/third_party/gh.txt).

use super::accessor::{
    Flags, Out, csv_values, gh_repo, instant, json_fields, limit_or_refuse, one_line, time_field,
    tsv, typed_out, web_host,
};
use super::constants::{EditKind, REPO_EDIT_FIELDS};
use super::shape::{Shape, exported, list_of, pointer, strukt};
use crate::core::github::client::{Account, Failure, Result, usage, value};
use crate::core::github::json::{Json, Obj};
use crate::core::github::repo::{
    NewRepo, RepoRef, create_repo, current_login, delete_repo, edit_repo, fork_repo,
    list_repository_fields, parse_repo, read_readme, rename_repo, repo_topics, repository_fields,
    set_repo_topics,
};
use crate::request::Request;

#[derive(Clone, Copy, PartialEq)]
enum Unwrap {
    Nodes,
    Edges,
    Topics,
}

/// One `--json` field: the GraphQL selection gh sends for it and how the
/// answer prints.
struct RepoField {
    select: String,
    shape: Shape,
    unwrap: Option<Unwrap>,
}

type RepoTable = Vec<(&'static str, RepoField)>;

fn plain(name: &'static str, shape: Shape) -> (&'static str, RepoField) {
    (
        name,
        RepoField {
            select: name.to_owned(),
            shape,
            unwrap: None,
        },
    )
}

fn field(
    name: &'static str,
    select: &str,
    shape: Shape,
    unwrap: Option<Unwrap>,
) -> (&'static str, RepoField) {
    (
        name,
        RepoField {
            select: select.to_owned(),
            shape,
            unwrap,
        },
    )
}

fn owner() -> Shape {
    strukt(vec![("id", Shape::Str), ("login", Shape::Str)])
}

fn user() -> Shape {
    strukt(vec![
        ("id", Shape::Str),
        ("login", Shape::Str),
        ("name", Shape::Str),
        ("databaseId", Shape::Int),
    ])
}

fn count() -> Shape {
    strukt(vec![("totalCount", Shape::Int)])
}

fn related() -> Shape {
    pointer(vec![
        ("id", Shape::Str),
        ("name", Shape::Str),
        ("owner", owner()),
    ])
}

/// Every field `gh repo view --json` and `gh repo list --json` accept in
/// gh 2.85, with the selection gh puts on the wire for it.
fn repo_field_table() -> RepoTable {
    use Shape::{Bool, Int, Raw, Str, Time};
    vec![
        plain("archivedAt", Raw),
        field(
            "assignableUsers",
            "assignableUsers(first:100){nodes{id,login,name}}",
            list_of(user()),
            Some(Unwrap::Nodes),
        ),
        field(
            "codeOfConduct",
            "codeOfConduct{key,name,url}",
            pointer(vec![("key", Str), ("name", Str), ("url", Str)]),
            None,
        ),
        field(
            "contactLinks",
            "contactLinks{about,name,url}",
            list_of(strukt(vec![("about", Str), ("name", Str), ("url", Str)])),
            None,
        ),
        plain("createdAt", Time),
        field(
            "defaultBranchRef",
            "defaultBranchRef{name}",
            strukt(vec![("name", Str)]),
            None,
        ),
        plain("deleteBranchOnMerge", Bool),
        plain("description", Str),
        plain("diskUsage", Int),
        plain("forkCount", Int),
        field(
            "fundingLinks",
            "fundingLinks{platform,url}",
            list_of(strukt(vec![("platform", Str), ("url", Str)])),
            None,
        ),
        plain("hasDiscussionsEnabled", Bool),
        plain("hasIssuesEnabled", Bool),
        plain("hasProjectsEnabled", Bool),
        plain("hasWikiEnabled", Bool),
        plain("homepageUrl", Str),
        plain("id", Str),
        plain("isArchived", Bool),
        plain("isBlankIssuesEnabled", Bool),
        plain("isEmpty", Bool),
        plain("isFork", Bool),
        plain("isInOrganization", Bool),
        plain("isMirror", Bool),
        plain("isPrivate", Bool),
        plain("isSecurityPolicyEnabled", Bool),
        plain("isTemplate", Bool),
        plain("isUserConfigurationRepository", Bool),
        field(
            "issueTemplates",
            "issueTemplates{name,title,body,about}",
            list_of(strukt(vec![
                ("name", Str),
                ("title", Str),
                ("body", Str),
                ("about", Str),
            ])),
            None,
        ),
        field("issues", "issues(states:OPEN){totalCount}", count(), None),
        field(
            "labels",
            "labels(first:100){nodes{id,color,name,description}}",
            list_of(strukt(vec![
                ("id", Str),
                ("name", Str),
                ("description", Str),
                ("color", Str),
            ])),
            Some(Unwrap::Nodes),
        ),
        field(
            "languages",
            "languages(first:100){edges{size,node{name}}}",
            list_of(strukt(vec![
                ("size", Int),
                ("node", strukt(vec![("name", Str)])),
            ])),
            Some(Unwrap::Edges),
        ),
        field(
            "latestRelease",
            "latestRelease{publishedAt,tagName,name,url}",
            pointer(vec![
                ("name", Str),
                ("tagName", Str),
                ("url", Str),
                ("publishedAt", Time),
            ]),
            None,
        ),
        field(
            "licenseInfo",
            "licenseInfo{key,name,nickname}",
            pointer(vec![("key", Str), ("name", Str), ("nickname", Str)]),
            None,
        ),
        field(
            "mentionableUsers",
            "mentionableUsers(first:100){nodes{id,login,name}}",
            list_of(user()),
            Some(Unwrap::Nodes),
        ),
        plain("mergeCommitAllowed", Bool),
        field(
            "milestones",
            "milestones(first:100,states:OPEN){nodes{number,title,description,dueOn}}",
            list_of(strukt(vec![
                ("number", Int),
                ("title", Str),
                ("description", Str),
                ("dueOn", Raw),
            ])),
            Some(Unwrap::Nodes),
        ),
        plain("mirrorUrl", Str),
        plain("name", Str),
        plain("nameWithOwner", Str),
        plain("openGraphImageUrl", Str),
        field("owner", "owner{id,login}", owner(), None),
        field("parent", "parent{id,name,owner{id,login}}", related(), None),
        field(
            "primaryLanguage",
            "primaryLanguage{name}",
            pointer(vec![("name", Str)]),
            None,
        ),
        field(
            "projects",
            "projects(first:100,states:OPEN){nodes{id,name,number,body,resourcePath}}",
            list_of(strukt(vec![
                ("id", Str),
                ("name", Str),
                ("number", Int),
                ("resourcePath", Str),
            ])),
            Some(Unwrap::Nodes),
        ),
        field(
            "projectsV2",
            "projectsV2(first:100,query:\"is:open\"){nodes{id,number,title,resourcePath,closed,url}}",
            Shape::Struct(
                vec![(
                    "Nodes",
                    list_of(strukt(vec![
                        ("id", Str),
                        ("title", Str),
                        ("number", Int),
                        ("resourcePath", Str),
                        ("closed", Bool),
                        ("url", Str),
                    ])),
                    Some("nodes"),
                )],
                false,
            ),
            None,
        ),
        field(
            "pullRequestTemplates",
            "pullRequestTemplates{body,filename}",
            list_of(strukt(vec![("filename", Str), ("body", Str)])),
            None,
        ),
        field(
            "pullRequests",
            "pullRequests(states:OPEN){totalCount}",
            count(),
            None,
        ),
        plain("pushedAt", Raw),
        plain("rebaseMergeAllowed", Bool),
        field(
            "repositoryTopics",
            "repositoryTopics(first:100){nodes{topic{name}}}",
            list_of(strukt(vec![("name", Str)])),
            Some(Unwrap::Topics),
        ),
        plain("securityPolicyUrl", Str),
        plain("squashMergeAllowed", Bool),
        plain("sshUrl", Str),
        plain("stargazerCount", Int),
        field(
            "templateRepository",
            "templateRepository{id,name,owner{id,login}}",
            related(),
            None,
        ),
        plain("updatedAt", Time),
        plain("url", Str),
        plain("usesCustomOpenGraphImage", Bool),
        plain("viewerCanAdminister", Bool),
        plain("viewerDefaultCommitEmail", Str),
        plain("viewerDefaultMergeMethod", Str),
        plain("viewerHasStarred", Bool),
        plain("viewerPermission", Str),
        plain("viewerPossibleCommitEmails", list_of(Str)),
        plain("viewerSubscription", Str),
        plain("visibility", Str),
        field("watchers", "watchers{totalCount}", count(), None),
    ]
}

fn names(table: &RepoTable) -> Vec<&'static str> {
    table.iter().map(|(name, _)| *name).collect()
}

fn spec<'a>(table: &'a RepoTable, name: &str) -> &'a RepoField {
    &table
        .iter()
        .find(|(field, _)| *field == name)
        .expect("a field json_fields checked")
        .1
}

fn selection(table: &RepoTable, fields: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    fields
        .iter()
        .filter(|name| seen.insert(name.as_str()))
        .map(|name| spec(table, name).select.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

fn exported_repo(table: &RepoTable, node: &Json, fields: &[String]) -> Json {
    let mut row = Obj::new();
    for name in fields {
        let field = spec(table, name);
        let raw = node.get(name);
        let unwrapped = match field.unwrap {
            Some(Unwrap::Nodes) => raw.get("nodes").clone(),
            Some(Unwrap::Edges) => raw.get("edges").clone(),
            Some(Unwrap::Topics) => {
                let topics: Vec<Json> = raw
                    .get("nodes")
                    .items()
                    .iter()
                    .map(|item| item.get("topic").clone())
                    .collect();
                if topics.is_empty() {
                    Json::Null
                } else {
                    Json::Arr(topics)
                }
            }
            None => raw.clone(),
        };
        row.set(name.as_str(), exported(&unwrapped, &field.shape));
    }
    Json::Obj(row)
}

pub(crate) async fn view(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let target = match texts.first() {
        None => gh_repo(account, flags.as_str("repo"))?,
        Some(word) => {
            let named = if word.contains('/') {
                word.clone()
            } else {
                format!("{}/{word}", current_login(account).await?)
            };
            parse_repo(&named)
                .map_err(|failure| Failure::Value(format!("argument error: {}", failure.text())))?;
            gh_repo(account, Some(&named))?
        }
    };
    let table = repo_field_table();
    let allowed = names(&table);
    if let Some(fields) = json_fields(flags, &allowed)? {
        let node = repository_fields(account, &target, &selection(&table, &fields)).await?;
        let row = exported_repo(&table, &Json::Obj(node), &fields);
        return typed_out(account, &row, flags, String::new(), &allowed).await;
    }
    let node = repository_fields(account, &target, "name,owner{id,login},description").await?;
    let readme = read_readme(account, &target).await?;
    let mut text = format!(
        "name:\t{}/{}\ndescription:\t{}\n",
        target.owner,
        target.repo,
        node.get("description").text()
    );
    if let Some(readme) = readme {
        text.push_str("--\n");
        text.push_str(&readme);
        text.push('\n');
    }
    Ok(Out::text(text))
}

const FORK_IS_NEW_NANOS: i128 = 60_000_000_000;
const REPO_LIST_FIELDS: &str =
    "nameWithOwner,description,isPrivate,isFork,isArchived,createdAt,pushedAt,visibility";

fn repo_info(node: &Json) -> String {
    let visibility = match node.get("visibility").text() {
        "" if node.get("isPrivate").truthy() => "private".to_owned(),
        "" => "public".to_owned(),
        named => named.to_lowercase(),
    };
    let mut tags = vec![visibility];
    if node.get("isFork").truthy() {
        tags.push("fork".to_owned());
    }
    if node.get("isArchived").truthy() {
        tags.push("archived".to_owned());
    }
    tags.join(", ")
}

pub(crate) async fn list_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let owner_name = texts.first().map(String::as_str);
    let limit = limit_or_refuse(flags, 30)?;
    let table = repo_field_table();
    let allowed = names(&table);
    if let Some(fields) = json_fields(flags, &allowed)? {
        let (nodes, _) =
            list_repository_fields(account, owner_name, limit, &selection(&table, &fields)).await?;
        let rows: Vec<Json> = nodes
            .iter()
            .map(|node| exported_repo(&table, node, &fields))
            .collect();
        return typed_out(account, &Json::Arr(rows), flags, String::new(), &allowed).await;
    }
    let (nodes, _) = list_repository_fields(account, owner_name, limit, REPO_LIST_FIELDS).await?;
    Ok(Out::text(
        nodes
            .iter()
            .map(|node| {
                let pushed = node.get("pushedAt");
                let when = if pushed.truthy() {
                    pushed
                } else {
                    node.get("createdAt")
                };
                tsv(&[
                    node.get("nameWithOwner").show(),
                    one_line(node.get("description").text()),
                    repo_info(node),
                    time_field(when),
                ])
            })
            .collect::<String>(),
    ))
}

pub(crate) async fn create_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let name_text = texts.first().map_or("", String::as_str);
    if texts.is_empty() && account.argv_len <= 2 {
        return usage("at least one argument required in non-interactive mode");
    }
    let chosen: Vec<&str> = ["public", "private", "internal"]
        .into_iter()
        .filter(|name| flags.gh_bool(name))
        .collect();
    let visibility = match chosen.as_slice() {
        [] => {
            return usage(
                "`--public`, `--private`, or `--internal` required when not running interactively",
            );
        }
        ["public"] => "PUBLIC",
        ["private"] => "PRIVATE",
        ["internal"] => "INTERNAL",
        _ => return usage("expected exactly one of `--public`, `--private`, or `--internal`"),
    };
    if name_text.is_empty() {
        return usage("name argument required to create new remote repository");
    }
    let named = if name_text.contains('/') {
        let parsed = gh_repo(account, Some(name_text))
            .map_err(|failure| Failure::Value(format!("argument error: {}", failure.text())))?;
        Some(parsed)
    } else {
        None
    };
    let new = NewRepo {
        name: named.as_ref().map_or(name_text, |repo| repo.repo.as_str()),
        owner: named.as_ref().map(|repo| repo.owner.as_str()),
        visibility,
        description: flags.as_nonempty("description"),
        homepage: flags.as_nonempty("homepage"),
        has_issues: !flags.gh_bool("disable_issues"),
        has_wiki: !flags.gh_bool("disable_wiki"),
        gitignore: flags.as_nonempty("gitignore"),
        license: flags.as_nonempty("license"),
        add_readme: flags.gh_bool("add_readme"),
    };
    let url = create_repo(account, &new).await?;
    Ok(Out::text(format!("{url}\n")))
}

/// `gh repo fork`: a workspace has no checkout to clone into or add a
/// remote to, so `--clone` is refused, as is `--remote` with no
/// repository.
pub(crate) async fn fork(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let operand = texts.first().map(String::as_str);
    let org = flags.as_str("org");
    if org == Some("") {
        return usage("--org cannot be blank");
    }
    if flags.as_str("remote_name") == Some("") {
        return usage("--remote-name cannot be blank");
    }
    if flags.gh_bool("clone") {
        return value("--clone is not supported: there is no local checkout to clone into");
    }
    if flags.gh_bool("remote") && operand.is_none() {
        return value("--remote is not supported: there is no local checkout to add a remote to");
    }
    let source: RepoRef = match gh_repo(account, operand) {
        Ok(source) => source,
        Err(failure)
            if operand.is_some_and(|word| parse_repo(word).is_err())
                && matches!(failure, Failure::Value(_)) =>
        {
            let word = operand.unwrap_or_default();
            let lead = if ["http:/", "https:/", "git@"]
                .iter()
                .any(|prefix| word.starts_with(prefix))
            {
                "did not understand argument"
            } else {
                "argument error"
            };
            return value(format!("{lead}: {}", failure.text()));
        }
        Err(failure) => return Err(failure),
    };
    let name = flags.as_nonempty("fork_name");
    let mut body = Obj::new();
    if let Some(name) = name {
        body.set("name", name);
    }
    if let Some(org) = org {
        body.set("organization", org);
    }
    if flags.gh_bool("default_branch_only") {
        body.set("default_branch_only", true);
    }
    let forked = fork_repo(account, &source, body)
        .await
        .map_err(|failure| Failure::Value(format!("failed to fork: {}", failure.text())))?;
    let full = match forked.get("full_name").as_str() {
        Some(full) => full.to_owned(),
        None => format!(
            "{}/{}",
            current_login(account).await?,
            name.unwrap_or(&source.repo)
        ),
    };
    let (reply, _) = account.host.ask(Request::Now).await;
    let now = (reply.now.unwrap_or(0.0) * 1e9) as i128;
    let created = forked.get("created_at").as_str().and_then(instant);
    if created.is_some_and(|created| now - created > FORK_IS_NEW_NANOS) {
        return Ok(Out::warned(format!("{full} already exists\n")));
    }
    Ok(Out::text(format!(
        "https://{}/{full}\n",
        web_host(account)?
    )))
}

/// `gh repo rename`: the operand is the new name, `-R` the repository.
pub(crate) async fn rename(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let target = gh_repo(account, flags.as_str("repo"))?;
    let name = texts.first().map_or("", String::as_str);
    if name.is_empty() {
        return usage("new name argument required when not running interactively");
    }
    if name.contains('/') {
        return value(
            "New repository name cannot contain '/' character - to transfer a repository to a new owner, see <https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository>.",
        );
    }
    rename_repo(account, &target, name).await?;
    Ok(Out::default())
}

/// `gh repo edit`: the settings named in one PATCH, and topics read and
/// replaced whole. Success prints nothing.
pub(crate) async fn edit_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let target = gh_repo(account, texts.first().map(String::as_str))?;
    let mut body = Obj::new();
    let mut security = Obj::new();
    for (dest, api, kind) in REPO_EDIT_FIELDS {
        if flags.raw(dest).is_none() {
            continue;
        }
        match kind {
            EditKind::Value => body.set(api, flags.as_str(dest).map_or(Json::Null, Json::from)),
            EditKind::Toggle => body.set(api, flags.gh_bool(dest)),
            EditKind::Security => {
                let mut status = Obj::new();
                status.set(
                    "status",
                    if flags.gh_bool(dest) {
                        "enabled"
                    } else {
                        "disabled"
                    },
                );
                security.set(api, status);
            }
        }
    }
    let adds = csv_values(&flags.as_list("add_topic"));
    let removes = csv_values(&flags.as_list("remove_topic"));
    let accepted = flags.gh_bool("accept_visibility_change_consequences");
    if body.is_empty() && security.is_empty() && adds.is_empty() && removes.is_empty() && !accepted
    {
        return usage("specify properties to edit when not running interactively");
    }
    if body.has("visibility") && !accepted {
        return usage(
            "use of --visibility flag requires --accept-visibility-change-consequences flag",
        );
    }
    if !security.is_empty() {
        let node = repository_fields(account, &target, "viewerCanAdminister").await?;
        if node.get("viewerCanAdminister").as_bool() != Some(true) {
            return value(
                "you do not have sufficient permissions to edit repository security and analysis features",
            );
        }
        body.set("security_and_analysis", security);
    }
    if !body.is_empty() {
        edit_repo(account, &target, body).await?;
    }
    if !adds.is_empty() || !removes.is_empty() {
        let old = repo_topics(account, &target).await?;
        let mut new: Vec<String> = Vec::new();
        for topic in old.iter().chain(adds.iter()) {
            if !new.contains(topic) && !removes.contains(topic) {
                new.push(topic.clone());
            }
        }
        if new.len() != old.len() || new.iter().any(|topic| !old.contains(topic)) {
            set_repo_topics(account, &target, &new).await?;
        }
    }
    Ok(Out::default())
}

/// `gh repo delete REPO --yes`: a name with no owner is the viewer's,
/// and the current repository is never deleted by default.
pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let confirmed = flags.gh_bool("yes") || flags.gh_bool("confirm");
    let spec_text = texts.first().map(String::as_str);
    if spec_text.is_none() && confirmed {
        return usage(
            "cannot non-interactively delete current repository. Please specify a repository or run interactively",
        );
    }
    if !confirmed {
        return usage("--yes required when not running interactively");
    }
    let mut named = spec_text.unwrap_or("").to_owned();
    if !named.contains('/') {
        named = format!("{}/{named}", current_login(account).await?);
    }
    delete_repo(account, &gh_repo(account, Some(&named))?).await?;
    Ok(if flags.gh_bool("confirm") {
        Out::warned("Flag --confirm has been deprecated, use `--yes` instead\n")
    } else {
        Out::default()
    })
}

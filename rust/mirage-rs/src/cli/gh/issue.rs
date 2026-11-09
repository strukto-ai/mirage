// Follows gh 2.85.0's pkg/cmd/issue (MIT; see licenses/third_party/gh.txt).

use super::accessor::{
    Flags, Out, body_value, csv_values, export_out, json_fields, limit_or_refuse, named_repo,
    one_line, repo_for, repo_number, subject_number, time_field, tsv, typed_out,
};
use super::constants::SEARCH_CAPPED;
use super::editable::Editable;
use super::fields::{
    Fetch, FieldTable, exported_node, names, nodes_of, plain, read_rest, references, selection,
    shared_fields,
};
use super::pull::{assignee_list, close_pull, project_list, sorted_labels};
use super::search::{ListQuery, has_state_clause, list_query, search_features};
use super::shape::Shape;
use crate::core::github::client::{Account, Failure, Result, usage, value};
use crate::core::github::issue::{
    IssueListFilter, IssueSelections, issue_comments, issue_fields, list_issue_fields,
    milestone_title, require_issue, search_issue_fields,
};
use crate::core::github::json::{Json, Obj, quoted};
use crate::core::github::metadata::{Wanted, repo_metadata};
use crate::core::github::repo::{RepoRef, current_login, github_repo, graphql_data, mutate};

/// Every field `gh issue view --json` and `gh issue list --json` accept
/// in gh 2.85.
fn issue_field_table() -> FieldTable {
    let mut table = shared_fields();
    table.extend([
        plain("isPinned", Shape::Bool),
        plain("stateReason", Shape::Str),
        references("closedByPullRequestsReferences"),
    ]);
    table
}

const LOCK_REASONS: [&str; 4] = ["off_topic", "resolved", "spam", "too_heated"];
const ISSUE_ONLY: [&str; 3] = ["isPinned", "stateReason", "closedByPullRequestsReferences"];

fn states(state: &str) -> Vec<&'static str> {
    match state {
        "closed" => vec!["CLOSED"],
        "all" => vec!["OPEN", "CLOSED"],
        _ => vec!["OPEN"],
    }
}

/// One issue as `gh issue view --json` reads it: the number read as an
/// issue or a pull request, every connection gh pages read to its end.
async fn viewed_issue(
    account: &Account,
    table: &FieldTable,
    repo: &RepoRef,
    number: i128,
    fields: &[String],
) -> Result<Obj> {
    let mut wanted = fields.to_vec();
    wanted.push("id".to_owned());
    if fields.iter().any(|field| field == "projectItems") {
        wanted.push("number".to_owned());
    }
    let pulls: Vec<String> = wanted
        .iter()
        .filter(|name| !ISSUE_ONLY.contains(&name.as_str()))
        .cloned()
        .collect();
    let halves = IssueSelections {
        issue: selection(table, &wanted, true),
        pull: selection(table, &pulls, true),
    };
    let node = issue_fields(account, repo, number, &halves, None).await?;
    let pull = node.get("__typename").as_str() == Some("PullRequest");
    if pull && fields.iter().any(|field| field == "projectItems") {
        require_issue(account, repo, number).await?;
    }
    let fetch = Fetch::Issue {
        target: repo,
        number,
        pull,
    };
    read_rest(account, table, node, fields, &fetch).await
}

/// The issues `gh issue edit` names: at least one, each parsed before
/// anything is asked, the repository a URL names the one every issue is
/// in.
fn targets(account: &Account, texts: &[String], flags: &Flags) -> Result<(RepoRef, Vec<i128>)> {
    let mut named: Option<RepoRef> = None;
    let mut numbers = Vec::new();
    for text in texts {
        if let Some(number) = subject_number(text) {
            numbers.push(number);
            continue;
        }
        let (repo, found) = repo_number(account, flags, text, "issue", "issues")?;
        let name = format!("{}/{}", repo.owner, repo.repo);
        if let Some(named) = &named {
            let expected = format!("{}/{}", named.owner, named.repo);
            if name.to_lowercase() != expected.to_lowercase() {
                return value(format!(
                    "multiple issues must be in same repo: found {}, expected {}",
                    quoted(&name),
                    quoted(&expected)
                ));
            }
        }
        named.get_or_insert(repo);
        numbers.push(found);
    }
    Ok((
        match named {
            Some(repo) => repo,
            None => repo_for(account, flags)?,
        },
        numbers,
    ))
}

fn target(account: &Account, texts: &[String], flags: &Flags) -> Result<(RepoRef, i128)> {
    repo_number(account, flags, &texts[0], "issue", "issues")
}

const LIST_DEFAULT_FIELDS: [&str; 7] = [
    "number",
    "title",
    "url",
    "state",
    "updatedAt",
    "labels",
    "stateReason",
];

/// `gh issue list`: GitHub's search when a filter only it has is given,
/// the repository's own list otherwise, where `@me` is read here.
pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let table = issue_field_table();
    let allowed = names(&table);
    let exported_fields = json_fields(flags, &allowed)?;
    let limit = limit_or_refuse(flags, 30)?;
    if flags.raw("author").is_some() && flags.raw("app").is_some() {
        return usage("specify only `--author` or `--app`");
    }
    let app = flags.as_str("app").map(|app| format!("app/{app}"));
    let author = app.as_deref().or(flags.as_nonempty("author"));
    let keywords = flags.as_nonempty("search");
    let labels = csv_values(&flags.as_list("label"));
    let milestone = flags.as_nonempty("milestone");
    let assignee = flags.as_nonempty("assignee");
    let mention = flags.as_nonempty("mention");
    let mut state = flags.as_nonempty("state").unwrap_or("open");
    if state == "open" && keywords.is_some_and(has_state_clause) {
        state = "";
    }
    let repo = repo_for(account, flags)?;
    let fields: Vec<String> = exported_fields
        .clone()
        .unwrap_or_else(|| LIST_DEFAULT_FIELDS.map(str::to_owned).to_vec());
    let select_text = selection(&table, &fields, false);
    let searching = keywords.is_some() || !labels.is_empty() || milestone.is_some();
    let answers = if searching {
        let title = match milestone.and_then(|text| text.parse::<i32>().ok()) {
            Some(number) => Some(milestone_title(account, &repo, i64::from(number)).await?),
            None => milestone.map(str::to_owned),
        };
        let features = search_features(account).await?;
        let query = list_query(
            &ListQuery {
                entity: "issue",
                state,
                assignee,
                author,
                labels: &labels,
                mention,
                milestone: title.as_deref(),
                search: keywords,
                ..ListQuery::default()
            },
            &format!("{}/{}", repo.owner, repo.repo),
            features.advanced,
        );
        search_issue_fields(
            account,
            &repo,
            &query,
            limit,
            &select_text,
            features.search_type(),
        )
        .await?
    } else {
        let me = Me::resolve(account, [assignee, author, mention]).await?;
        let filter = IssueListFilter {
            states: states(state),
            assignee: me.swap(assignee),
            author: me.swap(author),
            mention: me.swap(mention),
        };
        list_issue_fields(account, &repo, &filter, limit, &select_text).await?
    };
    if exported_fields.is_some() {
        let rows: Vec<Json> = answers
            .iter()
            .map(|node| exported_node(&table, node.as_obj().unwrap_or(&Obj::new()), &fields))
            .collect();
        return typed_out(account, &Json::Arr(rows), flags, String::new(), &allowed).await;
    }
    let mut out = Out::text(
        answers
            .iter()
            .map(|node| {
                let labels: Vec<&str> = nodes_of(node.get("labels"))
                    .iter()
                    .map(|label| label.get("name").text())
                    .collect();
                tsv(&[
                    node.get("number").show(),
                    node.get("state").text().to_owned(),
                    one_line(node.get("title").text()),
                    labels.join(", "),
                    time_field(node.get("updatedAt")),
                ])
            })
            .collect::<String>(),
    );
    if searching && limit > 1000 && !answers.is_empty() {
        out.stderr = SEARCH_CAPPED.as_bytes().to_vec();
    }
    Ok(out)
}

/// The login `@me` stands for, a failure in MeReplacer's words.
async fn me_login(account: &Account) -> Result<String> {
    current_login(account).await.map_err(|failure| {
        Failure::Value(format!(
            "failed resolving `@me` to your user handle: {}",
            failure.text()
        ))
    })
}

/// A list of handles with `@me` read as the account's login.
pub(crate) async fn with_me(account: &Account, handles: Vec<String>) -> Result<Vec<String>> {
    if !handles.iter().any(|handle| handle == "@me") {
        return Ok(handles);
    }
    let login = me_login(account).await?;
    Ok(handles
        .into_iter()
        .map(|handle| {
            if handle == "@me" {
                login.clone()
            } else {
                handle
            }
        })
        .collect())
}

/// Assignee handles with `@me` and `@copilot` read as logins.
pub(crate) async fn with_special_names(
    account: &Account,
    handles: Vec<String>,
) -> Result<Vec<String>> {
    Ok(with_me(account, handles)
        .await?
        .into_iter()
        .map(|handle| {
            if handle.eq_ignore_ascii_case("@copilot") {
                COPILOT_LOGIN.to_owned()
            } else {
                handle
            }
        })
        .collect())
}

/// `@me`, read once however many flags name it.
pub(crate) struct Me(Option<String>);

impl Me {
    pub(crate) async fn resolve<const N: usize>(
        account: &Account,
        handles: [Option<&str>; N],
    ) -> Result<Me> {
        if handles.contains(&Some("@me")) {
            return Ok(Me(Some(me_login(account).await?)));
        }
        Ok(Me(None))
    }

    pub(crate) fn swap(&self, handle: Option<&str>) -> Option<String> {
        match (handle, &self.0) {
            (Some("@me"), Some(login)) => Some(login.clone()),
            (handle, _) => handle.map(str::to_owned),
        }
    }
}

const VIEW_FIELDS: [&str; 12] = [
    "number",
    "url",
    "state",
    "createdAt",
    "title",
    "body",
    "author",
    "milestone",
    "assignees",
    "labels",
    "projectItems",
    "comments",
];

fn view_text(row: &Json, author: &str) -> String {
    format!(
        "title:\t{}\nstate:\t{}\nauthor:\t{}\nlabels:\t{}\ncomments:\t{}\nassignees:\t{}\nprojects:\t{}\nmilestone:\t{}\nnumber:\t{}\n--\n{}\n",
        row.get("title").text(),
        row.get("state").text(),
        author,
        sorted_labels(row),
        row.get("comments").items().len(),
        assignee_list(row),
        project_list(row),
        row.get("milestone").get("title").text(),
        row.get("number").show(),
        row.get("body").text(),
    )
}

pub(crate) async fn view_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number) = target(account, texts, flags)?;
    let table = issue_field_table();
    let allowed = names(&table);
    if let Some(fields) = json_fields(flags, &allowed)? {
        let node = viewed_issue(account, &table, &repo, number, &fields).await?;
        let row = exported_node(&table, &node, &fields);
        return typed_out(account, &row, flags, String::new(), &allowed).await;
    }
    let fields = VIEW_FIELDS.map(str::to_owned).to_vec();
    let node = viewed_issue(account, &table, &repo, number, &fields).await?;
    if let Some(comments) = comments_for(account, flags, &repo, number).await? {
        return Ok(Out::text(comments_text(&comments)));
    }
    let author = node.get("author").get("login").text();
    Ok(Out::text(view_text(
        &exported_node(&table, &node, &fields),
        author,
    )))
}

const ISSUE_CREATE: &str = "\n\tmutation IssueCreate($input: CreateIssueInput!) {\n\t\tcreateIssue(input: $input) {\n\t\t\tissue {\n\t\t\t\tid\n\t\t\t\turl\n\t\t\t}\n\t\t}\n\t}";

/// A list of node ids as a mutation's input holds it, nothing being null.
pub(crate) fn ids_or_null(ids: Vec<String>) -> Json {
    if ids.is_empty() {
        Json::Null
    } else {
        Json::from(ids.as_slice())
    }
}

/// `gh issue create`: both `--title` and `--body` are required when nothing
/// can prompt, and what the flags name is resolved before anything is made.
pub(crate) async fn create_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let body = body_value(account, flags, "body", "body_file", false, None).await?;
    let (Some(title), Some(body)) = (flags.as_str("title"), body) else {
        return usage("must provide `--title` and `--body` when not running interactively");
    };
    let repo = repo_for(account, flags)?;
    let assignees = with_special_names(account, csv_values(&flags.as_list("assignee"))).await?;
    let labels = csv_values(&flags.as_list("label"));
    let milestone = flags.as_nonempty("milestone");
    let info = github_repo(account, &repo).await?;
    if !info.get("hasIssuesEnabled").truthy() {
        return value(format!(
            "the '{}' repository has disabled issues",
            full(&repo)
        ));
    }
    let mut input = Obj::new();
    input.set("repositoryId", info.get("id").text());
    input.set("title", title);
    input.set("body", body);
    if !assignees.is_empty() || !labels.is_empty() || milestone.is_some() {
        let wanted = Wanted {
            actor_assignees: true,
            assignees: !assignees.is_empty(),
            labels: !labels.is_empty(),
            milestones: milestone.is_some(),
            ..Wanted::default()
        };
        let meta = repo_metadata(account, &repo, &wanted).await?;
        let ids = meta.members_to_ids(&assignees).map_err(|failure| {
            Failure::Value(format!("could not assign user: {}", failure.text()))
        })?;
        input.set("assigneeIds", ids_or_null(ids));
        let ids = meta.labels_to_ids(&labels).map_err(|failure| {
            Failure::Value(format!("could not add label: {}", failure.text()))
        })?;
        input.set("labelIds", ids_or_null(ids));
        input.set("projectIds", Json::Null);
        if let Some(title) = milestone {
            let id = meta.milestone_to_id(title).map_err(|failure| {
                Failure::Value(format!(
                    "could not add to milestone '{title}': {}",
                    failure.text()
                ))
            })?;
            input.set("milestoneId", id);
        }
    }
    let mut variables = Obj::new();
    variables.set("input", input);
    let data = graphql_data(account, ISSUE_CREATE, variables).await?;
    Ok(Out::text(format!(
        "{}\n",
        data.get("createIssue").get("issue").get("url").text()
    )))
}

/// `gh issue edit`: every issue named is read first, which ends the line at
/// the first one missing; each is then edited, the URLs of those edited
/// printed in order and any that failed named on stderr.
pub(crate) async fn edit_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, numbers) = targets(account, texts, flags)?;
    let editable = Editable::from_flags(account, flags).await?;
    if !editable.dirty() {
        return usage("field to edit flag required when not running interactively");
    }
    let lookup = editable.lookup();
    let mut rows = Vec::new();
    for number in &numbers {
        rows.push(find_subject(account, &repo, *number, &lookup, "").await?);
    }
    let meta = repo_metadata(account, &repo, &editable.wanted()).await?;
    let mut edited = Vec::new();
    let mut failed = Vec::new();
    for row in &rows {
        let url = row.get("url").text().to_owned();
        match editable
            .apply(account, row.get("id").text(), is_pull(row), &meta, row)
            .await
        {
            Ok(()) => edited.push(url),
            Err(failure) => failed.push(format!("failed to update {url}: {}", failure.text())),
        }
    }
    edited.sort();
    let mut out = Out::text(
        edited
            .iter()
            .map(|url| format!("{url}\n"))
            .collect::<String>(),
    );
    if failed.is_empty() {
        return Ok(out);
    }
    failed.sort();
    let count = if failed.len() == 1 {
        "1 issue".to_owned()
    } else {
        format!("{} issues", failed.len())
    };
    failed.push(format!("failed to update {count}"));
    out.exit = 1;
    out.stderr = failed
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<String>()
        .into_bytes();
    Ok(out)
}

pub(crate) async fn reopen_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number) = target(account, texts, flags)?;
    let node = find_subject(account, &repo, number, "id,number,title,state", "").await?;
    let name = format!(
        "{}#{} ({})",
        full(&repo),
        node.get("number").show(),
        node.get("title").text()
    );
    if node.get("state").as_str() == Some("OPEN") {
        return Ok(Out::warned(format!("! Issue {name} is already open\n")));
    }
    let id = node.get("id").text();
    if let Some(comment) = flags.as_nonempty("comment") {
        add_comment(account, id, comment).await?;
    }
    if is_pull(&node) {
        reopen_pull(account, id).await?;
    } else {
        let mut input = Obj::new();
        input.set("issueId", id);
        mutate(
            account,
            "IssueReopen",
            "ReopenIssueInput",
            "reopenIssue",
            "issue{id}",
            input,
        )
        .await?;
    }
    Ok(Out::warned(format!("✓ Reopened issue {name}\n")))
}

pub(crate) async fn reopen_pull(account: &Account, id: &str) -> Result<Obj> {
    let mut input = Obj::new();
    input.set("pullRequestId", id);
    mutate(
        account,
        "PullRequestReopen",
        "ReopenPullRequestInput",
        "reopenPullRequest",
        "pullRequest{id}",
        input,
    )
    .await
}

pub(crate) async fn comment_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    check_comment_flags(flags)?;
    let (repo, number) = target(account, texts, flags)?;
    let text = comment_body(account, flags).await?;
    let node = find_subject(account, &repo, number, "id,url", "").await?;
    let comments = if flags.gh_bool("edit_last") || flags.gh_bool("delete_last") {
        issue_comments(account, &repo, number).await?
    } else {
        Vec::new()
    };
    comment_run(account, flags, node.get("id").text(), &comments, &text).await
}

/// The comments `--comments` asks for, None without it.
pub(crate) async fn comments_for(
    account: &Account,
    flags: &Flags,
    repo: &RepoRef,
    number: i128,
) -> Result<Option<Vec<Json>>> {
    if !flags.gh_bool("comments") {
        return Ok(None);
    }
    issue_comments(account, repo, number).await.map(Some)
}

pub(crate) fn comments_text(rows: &[Json]) -> String {
    rows.iter()
        .map(|row| {
            let status = if row.get("isMinimized").truthy() {
                row.get("minimizedReason").text().to_lowercase()
            } else {
                "none".to_owned()
            };
            format!(
                "author:\t{}\nassociation:\t{}\nedited:\t{}\nstatus:\t{status}\n--\n{}\n--\n",
                row.get("author").get("login").show(),
                row.get("authorAssociation").text().to_lowercase(),
                row.get("includesCreatedEdit").truthy(),
                row.get("body").show()
            )
        })
        .collect()
}

/// An issue or pull request by number, as gh's FindIssueOrPR reads it.
pub(crate) async fn find_subject(
    account: &Account,
    repo: &RepoRef,
    number: i128,
    fields: &str,
    issue_only: &str,
) -> Result<Obj> {
    let halves = IssueSelections {
        issue: if issue_only.is_empty() {
            fields.to_owned()
        } else {
            format!("{fields},{issue_only}")
        },
        pull: fields.to_owned(),
    };
    issue_fields(account, repo, number, &halves, None).await
}

const COPILOT_LOGIN: &str = "copilot-swe-agent";

fn full(repo: &RepoRef) -> String {
    format!("{}/{}", repo.owner, repo.repo)
}

fn is_pull(node: &Obj) -> bool {
    node.get("__typename").as_str() == Some("PullRequest")
}

/// Post a comment on what `id` names, its URL back.
pub(crate) async fn add_comment(account: &Account, id: &str, body: &str) -> Result<String> {
    let mut input = Obj::new();
    input.set("body", body);
    input.set("subjectId", id);
    let data = mutate(
        account,
        "CommentCreate",
        "AddCommentInput",
        "addComment",
        "commentEdge{node{url}}",
        input,
    )
    .await?;
    Ok(data
        .get("addComment")
        .get("commentEdge")
        .get("node")
        .get("url")
        .text()
        .to_owned())
}

pub(crate) async fn close_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number) = target(account, texts, flags)?;
    let node = find_subject(account, &repo, number, "id,number,title,state", "").await?;
    let name = format!(
        "{}#{} ({})",
        full(&repo),
        node.get("number").show(),
        node.get("title").text()
    );
    if node.get("state").as_str() == Some("CLOSED") {
        return Ok(Out::warned(format!("! Issue {name} is already closed\n")));
    }
    let id = node.get("id").text();
    if let Some(comment) = flags.as_nonempty("comment") {
        add_comment(account, id, comment).await?;
    }
    if is_pull(&node) {
        close_pull(account, id).await?;
    } else {
        let mut input = Obj::new();
        input.set("issueId", id);
        match flags.as_nonempty("reason") {
            Some("not planned") => input.set("stateReason", "NOT_PLANNED"),
            Some(_) => input.set("stateReason", "COMPLETED"),
            None => {}
        }
        mutate(
            account,
            "IssueClose",
            "CloseIssueInput",
            "closeIssue",
            "issue{id}",
            input,
        )
        .await?;
    }
    Ok(Out::warned(format!("✓ Closed issue {name}\n")))
}

pub(crate) async fn pin_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number) = target(account, texts, flags)?;
    let node = find_subject(account, &repo, number, "id,number,title", "isPinned").await?;
    let name = format!(
        "{}#{} ({})",
        full(&repo),
        node.get("number").show(),
        node.get("title").text()
    );
    if node.get("isPinned").truthy() {
        return Ok(Out::warned(format!("! Issue {name} is already pinned\n")));
    }
    let mut input = Obj::new();
    input.set("issueId", node.get("id").text());
    mutate(
        account,
        "IssuePin",
        "PinIssueInput",
        "pinIssue",
        "issue{id}",
        input,
    )
    .await?;
    Ok(Out::warned(format!("✓ Pinned issue {name}\n")))
}

pub(crate) async fn unpin_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number) = target(account, texts, flags)?;
    let node = find_subject(account, &repo, number, "id,number,title", "isPinned").await?;
    let name = format!(
        "{}#{} ({})",
        full(&repo),
        node.get("number").show(),
        node.get("title").text()
    );
    if !node.get("isPinned").truthy() {
        return Ok(Out::warned(format!("! Issue {name} is not pinned\n")));
    }
    let mut input = Obj::new();
    input.set("issueId", node.get("id").text());
    mutate(
        account,
        "IssueUnpin",
        "UnpinIssueInput",
        "unpinIssue",
        "issue{id}",
        input,
    )
    .await?;
    Ok(Out::warned(format!("✓ Unpinned issue {name}\n")))
}

pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number) = target(account, texts, flags)?;
    let node = find_subject(account, &repo, number, "id,number,title", "").await?;
    if is_pull(&node) {
        return value(format!(
            "issue {}#{} is a pull request and cannot be deleted",
            full(&repo),
            node.get("number").show()
        ));
    }
    let mut input = Obj::new();
    input.set("issueId", node.get("id").text());
    mutate(
        account,
        "IssueDelete",
        "DeleteIssueInput",
        "deleteIssue",
        "repository{id}",
        input,
    )
    .await?;
    Ok(Out::default())
}

pub(crate) async fn transfer_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let [selector, destination] = texts else {
        return usage("issue and destination repository are required");
    };
    let (repo, number) = repo_number(account, flags, selector, "issue", "issues")?;
    let node = find_subject(account, &repo, number, "id,number", "").await?;
    if is_pull(&node) {
        return value(format!(
            "issue {}#{} is a pull request and cannot be transferred",
            full(&repo),
            node.get("number").show()
        ));
    }
    let destination = named_repo(account, destination)?;
    let mut variables = Obj::new();
    variables.set("owner", destination.owner.as_str());
    variables.set("name", destination.repo.as_str());
    let found = graphql_data(
        account,
        "query RepositoryInfo($owner: String!, $name: String!) {\n\t\trepository(owner: $owner, name: $name) {\n\t\t\tid\n\t\t\tname\n\t\t\towner { login }\n\t\t\thasIssuesEnabled\n\t\t\tdescription\n\t\t\thasWikiEnabled\n\t\t\tviewerPermission\n\t\t\tdefaultBranchRef {\n\t\t\t\tname\n\t\t\t}\n\t\t}\n\t}",
        variables,
    )
    .await?;
    let mut input = Obj::new();
    input.set("issueId", node.get("id").text());
    input.set("repositoryId", found.get("repository").get("id").text());
    let data = mutate(
        account,
        "IssueTransfer",
        "TransferIssueInput",
        "transferIssue",
        "issue{url}",
        input,
    )
    .await?;
    Ok(Out::text(format!(
        "{}\n",
        data.get("transferIssue").get("issue").get("url").text()
    )))
}

/// `gh issue lock` and `gh pr lock`, and their unlocks.
pub(crate) async fn lock_run(
    account: &Account,
    flags: &Flags,
    texts: &[String],
    pull: bool,
    locking: bool,
) -> Result<Out> {
    let reason = flags.as_nonempty("reason");
    if let Some(reason) = reason.filter(|reason| !LOCK_REASONS.contains(reason)) {
        return value(format!("invalid reason {reason}"));
    }
    let (repo, number) = repo_number(account, flags, &texts[0], "issue", "issues")?;
    let node = find_subject(
        account,
        &repo,
        number,
        "activeLockReason,id,locked,number,title,url",
        "",
    )
    .await?;
    let kind = |is_pull: bool| if is_pull { "Pull request" } else { "Issue" };
    let seen = is_pull(&node);
    if seen != pull {
        let (name, verb) = (
            if seen { "pr" } else { "issue" },
            if locking { "lock" } else { "unlock" },
        );
        return value(format!(
            "X {} {}#{number} not found, but found {} {}#{number}.  Use `gh {name} {verb} {number}` instead",
            kind(pull),
            full(&repo),
            kind(seen).to_lowercase(),
            full(&repo),
        ));
    }
    let id = node.get("id").text();
    let locked = node.get("locked").truthy();
    if locking {
        if locked {
            return value("already locked");
        }
        let mut input = Obj::new();
        input.set("lockableId", id);
        if let Some(reason) = reason {
            input.set("lockReason", reason.to_uppercase());
        }
        mutate(
            account,
            "LockLockable",
            "LockLockableInput",
            "lockLockable",
            "lockedRecord{locked}",
            input,
        )
        .await?;
    } else if locked {
        let mut input = Obj::new();
        input.set("lockableId", id);
        mutate(
            account,
            "UnlockLockable",
            "UnlockLockableInput",
            "unlockLockable",
            "unlockedRecord{locked}",
            input,
        )
        .await?;
    }
    Ok(Out::default())
}

const STATUS_QUERY: &str = "\n\tquery IssueStatus($owner: String!, $repo: String!, $viewer: String!, $per_page: Int = 10) {\n\t\trepository(owner: $owner, name: $repo) {\n\t\t\thasIssuesEnabled\n\t\t\tassigned: issues(filterBy: {assignee: $viewer, states: OPEN}, first: $per_page, orderBy: {field: UPDATED_AT, direction: DESC}) {\n\t\t\t\ttotalCount\n\t\t\t\tnodes {\n\t\t\t\t\t...issue\n\t\t\t\t}\n\t\t\t}\n\t\t\tmentioned: issues(filterBy: {mentioned: $viewer, states: OPEN}, first: $per_page, orderBy: {field: UPDATED_AT, direction: DESC}) {\n\t\t\t\ttotalCount\n\t\t\t\tnodes {\n\t\t\t\t\t...issue\n\t\t\t\t}\n\t\t\t}\n\t\t\tauthored: issues(filterBy: {createdBy: $viewer, states: OPEN}, first: $per_page, orderBy: {field: UPDATED_AT, direction: DESC}) {\n\t\t\t\ttotalCount\n\t\t\t\tnodes {\n\t\t\t\t\t...issue\n\t\t\t\t}\n\t\t\t}\n\t\t}\n    }";

fn status_section(out: &mut String, title: &str, none: &str, page: &Json) {
    out.push_str(title);
    out.push('\n');
    let total = page.get("totalCount").as_int().unwrap_or(0);
    let rows = page.get("nodes").items();
    if total > 0 {
        for node in rows {
            let labels: Vec<&str> = nodes_of(node.get("labels"))
                .iter()
                .map(|label| label.get("name").text())
                .collect();
            out.push_str(&tsv(&[
                format!("  {}", node.get("number").show()),
                node.get("state").text().to_owned(),
                one_line(node.get("title").text()),
                labels.join(", "),
                time_field(node.get("updatedAt")),
            ]));
        }
        let left = total - rows.len() as i128;
        if left > 0 {
            out.push_str(&format!("  And {left} more\n"));
        }
    } else {
        out.push_str(none);
        out.push('\n');
    }
    out.push('\n');
}

pub(crate) async fn status_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    if !texts.is_empty() {
        return usage(format!("unknown argument {}", quoted(&texts[0])));
    }
    let table = issue_field_table();
    let allowed = names(&table);
    let exported_fields = json_fields(flags, &allowed)?;
    let repo = repo_for(account, flags)?;
    let viewer = current_login(account).await?;
    let fields: Vec<String> = exported_fields.clone().unwrap_or_else(|| {
        ["number", "title", "url", "state", "updatedAt", "labels"]
            .map(str::to_owned)
            .to_vec()
    });
    let query = format!(
        "fragment issue on Issue {{{}}}{STATUS_QUERY}",
        selection(&table, &fields, false)
    );
    let mut variables = Obj::new();
    variables.set("owner", repo.owner.as_str());
    variables.set("repo", repo.repo.as_str());
    variables.set("viewer", viewer);
    let data = graphql_data(account, &query, variables).await?;
    let repository = data.get("repository");
    if !repository.get("hasIssuesEnabled").truthy() {
        return value(format!(
            "the '{}' repository has disabled issues",
            full(&repo)
        ));
    }
    if exported_fields.is_some() {
        let export = |page: &Json| {
            Json::Arr(
                page.get("nodes")
                    .items()
                    .iter()
                    .map(|node| {
                        exported_node(&table, node.as_obj().unwrap_or(&Obj::new()), &fields)
                    })
                    .collect(),
            )
        };
        let mut row = Obj::new();
        row.set("assigned", export(repository.get("assigned")));
        row.set("createdBy", export(repository.get("authored")));
        row.set("mentioned", export(repository.get("mentioned")));
        return export_out(account, &Json::Obj(row), flags).await;
    }
    let mut out = format!("\nRelevant issues in {}\n\n", full(&repo));
    status_section(
        &mut out,
        "Issues assigned to you",
        "  There are no issues assigned to you",
        repository.get("assigned"),
    );
    status_section(
        &mut out,
        "Issues mentioning you",
        "  There are no issues mentioning you",
        repository.get("mentioned"),
    );
    status_section(
        &mut out,
        "Issues opened by you",
        "  There are no issues opened by you",
        repository.get("authored"),
    );
    Ok(Out::text(out))
}

/// `--edit-last`, `--delete-last` and a plain new comment, for the issue
/// or pull request `id` names. `comments` are its comments, oldest first.
pub(crate) async fn comment_run(
    account: &Account,
    flags: &Flags,
    id: &str,
    comments: &[Json],
    text: &str,
) -> Result<Out> {
    let edit_last = flags.gh_bool("edit_last");
    let delete_last = flags.gh_bool("delete_last");
    let create_if_none = flags.gh_bool("create_if_none");
    let mine: Vec<&Json> = comments
        .iter()
        .filter(|row| row.get("viewerDidAuthor").truthy())
        .collect();
    if delete_last {
        let Some(last) = mine.last() else {
            return value("no comments found for current user");
        };
        let mut input = Obj::new();
        input.set("id", last.get("id").text());
        mutate(
            account,
            "CommentDelete",
            "DeleteIssueCommentInput",
            "deleteIssueComment",
            "clientMutationId",
            input,
        )
        .await?;
        return Ok(Out::warned("Comment deleted\n"));
    }
    if edit_last {
        if let Some(last) = mine.last() {
            let mut input = Obj::new();
            input.set("body", text);
            input.set("id", last.get("id").text());
            let data = mutate(
                account,
                "CommentUpdate",
                "UpdateIssueCommentInput",
                "updateIssueComment",
                "issueComment{url}",
                input,
            )
            .await?;
            return Ok(Out::text(format!(
                "{}\n",
                data.get("updateIssueComment")
                    .get("issueComment")
                    .get("url")
                    .text()
            )));
        }
        if !create_if_none {
            return value("no comments found for current user");
        }
    }
    Ok(Out::text(format!(
        "{}\n",
        add_comment(account, id, text).await?
    )))
}

/// The text of a comment, read before anything is asked of GitHub.
pub(crate) async fn comment_body(account: &Account, flags: &Flags) -> Result<String> {
    if flags.gh_bool("delete_last") {
        return Ok(String::new());
    }
    Ok(body_value(
        account,
        flags,
        "body",
        "body_file",
        true,
        Some("specify only one of `--body`, `--body-file`, `--editor`, or `--web`"),
    )
    .await?
    .unwrap_or_default())
}

/// Refuse the combinations gh's comment flags refuse.
pub(crate) fn check_comment_flags(flags: &Flags) -> Result<()> {
    let inputs =
        usize::from(flags.as_str("body").is_some()) + usize::from(flags.raw("body_file").is_some());
    if flags.gh_bool("create_if_none") && !flags.gh_bool("edit_last") {
        return usage("`--create-if-none` can only be used with `--edit-last`");
    }
    if flags.gh_bool("yes") && !flags.gh_bool("delete_last") {
        return usage("`--yes` should only be used with `--delete-last`");
    }
    if flags.gh_bool("delete_last") {
        if inputs > 0 {
            return usage("should not provide comment body when using `--delete-last`");
        }
        if !flags.gh_bool("yes") {
            return usage("should provide `--yes` to confirm deletion in non-interactive mode");
        }
        return Ok(());
    }
    if inputs == 0 {
        return usage("flags required when not running interactively");
    }
    if inputs > 1 {
        return usage("specify only one of `--body`, `--body-file`, `--editor`, or `--web`");
    }
    Ok(())
}

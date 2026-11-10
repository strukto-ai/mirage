// Follows gh 2.85.0's pkg/cmd/pr (MIT; see licenses/third_party/gh.txt).

use std::collections::HashSet;

use super::accessor::{
    Flags, Out, body_value, csv_values, current_branch, exact_one, export_out, go_duration,
    instant, json_fields, list_limit, numbered_subject, one_line, repo_for, time_field, tsv,
    typed_out,
};
use super::constants::{PR_INVALID_LIMIT, SEARCH_CAPPED};
use super::editable::{Editable, PR_EDIT_FIELDS};
use super::fields::{
    At, Fetch, Field, FieldTable, Pages, Select, View, contexts, custom, exported_node, login,
    names, nodes, nodes_of, paged, plain, plain_as, read_rest, references, selection,
    shared_fields,
};
use super::issue::{
    add_comment, check_comment_flags, comment_body, comment_run, comments_for, comments_text,
    reopen_pull, with_special_names,
};
use super::search::{ListQuery, has_state_clause, list_query, search_features};
use super::shape::{Shape, exported, or_null, pointer, strukt};
use crate::core::github::client::{
    Account, Failure, Result, github_request, quote_ref, usage, value,
};
use crate::core::github::issue::issue_comments;
use crate::core::github::json::{Json, Obj, quoted};
use crate::core::github::metadata::{Wanted, repo_metadata};
use crate::core::github::pull::{
    BranchFilter, PullListFilter, diff_pull, head_branch, list_pull_request_fields,
    pull_for_branch, pull_request_fields, search_pull_request_fields, status_contexts,
};
use crate::core::github::repo::{RepoRef, github_repo, graphql_data, mutate};

fn oid() -> Shape {
    pointer(vec![("oid", Shape::Str)])
}

fn review() -> Shape {
    strukt(vec![
        ("id", Shape::Str),
        ("author", login()),
        ("authorAssociation", Shape::Str),
        ("body", Shape::Str),
        ("submittedAt", Shape::Raw),
        ("includesCreatedEdit", Shape::Bool),
        ("reactionGroups", Shape::Reactions),
        ("state", Shape::Str),
        ("commit", strukt(vec![("oid", Shape::Str)])),
    ])
}

fn file() -> Shape {
    strukt(vec![
        ("path", Shape::Str),
        ("additions", Shape::Int),
        ("deletions", Shape::Int),
    ])
}

fn reviews(after: &str) -> String {
    format!(
        "reviews(first: 100{after}) {{nodes {{id,author{{login}},authorAssociation,submittedAt,body,state,commit{{oid}},reactionGroups{{content,users{{totalCount}}}}}}pageInfo{{hasNextPage,endCursor}}totalCount}}"
    )
}

fn checks(after: &str) -> String {
    format!(
        "statusCheckRollup: commits(last: 1) {{nodes {{commit {{statusCheckRollup {{contexts(first:100{after}) {{nodes {{__typename...on StatusContext {{context,state,targetUrl,createdAt,description}},...on CheckRun {{name,checkSuite{{workflowRun{{workflow{{name}}}}}},status,conclusion,startedAt,completedAt,detailsUrl}}}},pageInfo{{hasNextPage,endCursor}}}}}}}}}}}}"
    )
}

fn commits_of(node: &Obj) -> Json {
    let shape = |value: &Json, kind: &Shape| exported(value, kind);
    Json::Arr(
        nodes_of(node.get("commits"))
            .iter()
            .map(|item| {
                let commit = item.get("commit");
                let authors: Vec<Json> = nodes_of(commit.get("authors"))
                    .iter()
                    .map(|row| {
                        let user = row.get("user");
                        let mut out = Obj::new();
                        out.set("email", shape(row.get("email"), &Shape::Str));
                        out.set("id", shape(user.get("id"), &Shape::Str));
                        out.set("login", shape(user.get("login"), &Shape::Str));
                        out.set("name", shape(row.get("name"), &Shape::Str));
                        Json::Obj(out)
                    })
                    .collect();
                let mut out = Obj::new();
                out.set(
                    "authoredDate",
                    shape(commit.get("authoredDate"), &Shape::Time),
                );
                out.set("authors", authors);
                out.set(
                    "committedDate",
                    shape(commit.get("committedDate"), &Shape::Time),
                );
                out.set("messageBody", shape(commit.get("messageBody"), &Shape::Str));
                out.set(
                    "messageHeadline",
                    shape(commit.get("messageHeadline"), &Shape::Str),
                );
                out.set("oid", shape(commit.get("oid"), &Shape::Str));
                Json::Obj(out)
            })
            .collect(),
    )
}

/// gh's status rollup: null with no commit behind it, and an empty list
/// for a commit that carries no rollup.
fn checks_of(node: &Obj) -> Json {
    if nodes_of(node.get("statusCheckRollup")).is_empty() {
        return Json::Null;
    }
    let text = |row: &Json, key: &str| exported(row.get(key), &Shape::Str);
    let time = |row: &Json, key: &str| exported(row.get(key), &Shape::Time);
    Json::Arr(
        nodes_of(contexts(node))
            .iter()
            .map(|row| {
                let mut out = Obj::new();
                if row.get("__typename").as_str() == Some("CheckRun") {
                    let workflow = row.get("checkSuite").get("workflowRun").get("workflow");
                    out.set("__typename", "CheckRun");
                    out.set("completedAt", time(row, "completedAt"));
                    out.set("conclusion", text(row, "conclusion"));
                    out.set("detailsUrl", text(row, "detailsUrl"));
                    out.set("name", text(row, "name"));
                    out.set("startedAt", time(row, "startedAt"));
                    out.set("status", text(row, "status"));
                    out.set("workflowName", exported(workflow.get("name"), &Shape::Str));
                } else {
                    out.set("__typename", text(row, "__typename"));
                    out.set("context", text(row, "context"));
                    out.set("startedAt", time(row, "createdAt"));
                    out.set("state", text(row, "state"));
                    out.set("targetUrl", text(row, "targetUrl"));
                }
                Json::Obj(out)
            })
            .collect(),
    )
}

/// gh's review requests: users and teams only, a team as org/slug.
fn requests_of(node: &Obj) -> Json {
    let mut rows = Vec::new();
    for item in nodes_of(node.get("reviewRequests")) {
        let reviewer = item.get("requestedReviewer");
        let mut out = Obj::new();
        match reviewer.get("__typename").as_str() {
            Some("User") => {
                out.set("__typename", "User");
                out.set("login", exported(reviewer.get("login"), &Shape::Str));
            }
            Some("Team") => {
                let org = reviewer.get("organization").get("login").text();
                out.set("__typename", "Team");
                out.set("name", exported(reviewer.get("name"), &Shape::Str));
                out.set("slug", format!("{org}/{}", reviewer.get("slug").text()));
            }
            _ => continue,
        }
        rows.push(Json::Obj(out));
    }
    Json::Arr(rows)
}

/// Every field `gh pr view --json` and `gh pr list --json` accept in gh
/// 2.85. `pr view` never asks github.com for `projectCards`, which is
/// gone there, so the field prints null.
fn pull_field_table() -> FieldTable {
    let mut table = shared_fields();
    for (name, field) in &mut table {
        if *name == "projectCards" {
            let Field { view, .. } = field;
            *view = Some(View::Never);
        }
    }
    table.extend([
        plain("additions", Shape::Int),
        plain_as(
            "autoMergeRequest",
            pointer(vec![
                ("authorEmail", Shape::Raw),
                ("commitBody", Shape::Raw),
                ("commitHeadline", Shape::Raw),
                ("mergeMethod", Shape::Str),
                ("enabledAt", Shape::Time),
                ("enabledBy", Shape::Author),
            ]),
            "autoMergeRequest {authorEmail,commitBody,commitHeadline,mergeMethod,enabledAt,enabledBy{login,...on User{id,name}}}",
        ),
        plain("baseRefName", Shape::Str),
        plain("baseRefOid", Shape::Str),
        plain("changedFiles", Shape::Int),
        references("closingIssuesReferences"),
        custom(
            "commits",
            "commits(first: 100) {nodes {commit {authors(first:100) {nodes {name,email,user{id,login}}},messageHeadline,messageBody,oid,committedDate,authoredDate}}}",
            commits_of,
            None,
        ),
        plain("deletions", Shape::Int),
        nodes(
            "files",
            "files(first: 100) {nodes {additions,deletions,path}}",
            file(),
            None,
        ),
        plain("fullDatabaseId", Shape::Str),
        plain("headRefName", Shape::Str),
        plain("headRefOid", Shape::Str),
        plain_as(
            "headRepository",
            pointer(vec![
                ("id", Shape::Str),
                ("name", Shape::Str),
                ("nameWithOwner", Shape::Str),
            ]),
            "headRepository{id,name}",
        ),
        plain_as(
            "headRepositoryOwner",
            Shape::Owner,
            "headRepositoryOwner{id,login,...on User{name}}",
        ),
        plain("isCrossRepository", Shape::Bool),
        plain("isDraft", Shape::Bool),
        nodes(
            "latestReviews",
            "latestReviews(first: 100) {nodes {author{login},authorAssociation,submittedAt,body,state}}",
            review(),
            None,
        ),
        plain("maintainerCanModify", Shape::Bool),
        plain_as("mergeCommit", oid(), "mergeCommit{oid}"),
        plain("mergeStateStatus", Shape::Str),
        plain("mergeable", Shape::Str),
        plain("mergedAt", Shape::Raw),
        plain_as(
            "mergedBy",
            or_null(Shape::Author),
            "mergedBy{login,...on User{id,name}}",
        ),
        plain_as(
            "potentialMergeCommit",
            oid(),
            "potentialMergeCommit{oid}",
        ),
        plain("reviewDecision", Shape::Str),
        custom(
            "reviewRequests",
            "reviewRequests(first: 100) {nodes {requestedReviewer {__typename,...on User{login},...on Team{organization{login}name,slug}}}}",
            requests_of,
            None,
        ),
        nodes(
            "reviews",
            &reviews(""),
            review(),
            Some(paged("reviews", reviews)),
        ),
        custom(
            "statusCheckRollup",
            &checks(""),
            checks_of,
            Some(Pages {
                select: Select::Of(checks),
                at: At::Contexts,
            }),
        ),
    ]);
    table
}

const CHECK_FIELDS: [&str; 9] = [
    "bucket",
    "completedAt",
    "description",
    "event",
    "link",
    "name",
    "startedAt",
    "state",
    "workflow",
];

fn states(wanted: &str) -> Vec<&'static str> {
    match wanted {
        "closed" => vec!["CLOSED", "MERGED"],
        "merged" => vec!["MERGED"],
        "all" => vec!["OPEN", "CLOSED", "MERGED"],
        _ => vec!["OPEN"],
    }
}

fn bucket(state: &str) -> &'static str {
    match state {
        "SUCCESS" => "pass",
        "NEUTRAL" | "SKIPPED" => "skipping",
        "ACTION_REQUIRED" | "ERROR" | "FAILURE" | "TIMED_OUT" => "fail",
        "CANCELLED" => "cancel",
        _ => "pending",
    }
}

/// The pull request a line names: a number or URL outright, anything
/// else a branch whose pull request is looked up, none the install's
/// `branch`.
async fn target(account: &Account, texts: &[String], flags: &Flags) -> Result<(RepoRef, i128)> {
    let selector = texts.first().map_or("", String::as_str);
    if let Some(named) = numbered_subject(account, flags, selector, "pull")? {
        return Ok(named);
    }
    let repo = repo_for(account, flags)?;
    let head = if selector.is_empty() {
        match current_branch(account) {
            Some(branch) => branch.to_owned(),
            None => {
                return value("could not determine current branch: no `branch` on the install");
            }
        }
    } else {
        selector.to_owned()
    };
    match pull_for_branch(account, &repo, &head, BranchFilter::default()).await? {
        Some(found) => {
            let number = found.get("number").as_int().unwrap_or(0);
            Ok((repo, number))
        }
        None => value(format!(
            "no pull requests found for branch {}",
            quoted(&head)
        )),
    }
}

async fn viewed_pull(
    account: &Account,
    table: &FieldTable,
    repo: &RepoRef,
    number: i128,
    fields: &[String],
) -> Result<Obj> {
    if fields.iter().all(|field| field == "number") {
        let mut only = Obj::new();
        only.set("number", number);
        return Ok(only);
    }
    let mut wanted = fields.to_vec();
    wanted.extend(["id".to_owned(), "number".to_owned()]);
    let node = pull_request_fields(
        account,
        repo,
        number,
        &selection(table, &wanted, true),
        None,
    )
    .await?;
    let fetch = Fetch::Pull {
        target: repo,
        number,
    };
    read_rest(account, table, node, fields, &fetch).await
}

const LIST_DEFAULT_FIELDS: [&str; 9] = [
    "number",
    "title",
    "state",
    "url",
    "headRefName",
    "headRepositoryOwner",
    "isCrossRepository",
    "isDraft",
    "createdAt",
];

fn state_with_draft(node: &Json) -> String {
    if node.get("isDraft").truthy() && node.get("state").as_str() == Some("OPEN") {
        "DRAFT".to_owned()
    } else {
        node.get("state").text().to_owned()
    }
}

fn head_label(node: &Json) -> String {
    let branch = node.get("headRefName").text();
    if node.get("isCrossRepository").truthy() {
        format!(
            "{}:{branch}",
            node.get("headRepositoryOwner").get("login").text()
        )
    } else {
        branch.to_owned()
    }
}

/// `gh pr list`: GitHub's search when a filter only it has is given, the
/// repository's own list otherwise.
pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let table = pull_field_table();
    let allowed = names(&table);
    let exported_fields = json_fields(flags, &allowed)?;
    let limit = list_limit(flags, 30, Some(PR_INVALID_LIMIT))?;
    if flags.raw("author").is_some() && flags.raw("app").is_some() {
        return usage("specify only `--author` or `--app`");
    }
    let app = flags.as_str("app").map(|app| format!("app/{app}"));
    let author = app.as_deref().or(flags.as_nonempty("author"));
    let keywords = flags.as_nonempty("search");
    let labels = csv_values(&flags.as_list("label"));
    let draft = flags.raw("draft").map(|_| flags.gh_bool("draft"));
    let assignee = flags.as_nonempty("assignee");
    let mut state = flags.as_nonempty("state").unwrap_or("open");
    if state == "open" && keywords.is_some_and(has_state_clause) {
        state = "";
    }
    let repo = repo_for(account, flags)?;
    let fields: Vec<String> = exported_fields
        .clone()
        .unwrap_or_else(|| LIST_DEFAULT_FIELDS.map(str::to_owned).to_vec());
    let select_text = selection(&table, &fields, false);
    let searching = draft.is_some()
        || author.is_some()
        || assignee.is_some()
        || keywords.is_some()
        || !labels.is_empty();
    let answers = if searching {
        let features = search_features(account).await?;
        let query = list_query(
            &ListQuery {
                entity: "pr",
                state,
                assignee,
                author,
                base: flags.as_nonempty("base"),
                head: flags.as_nonempty("head"),
                draft,
                labels: &labels,
                search: keywords,
                ..ListQuery::default()
            },
            &repo.full(),
            features.advanced,
        );
        search_pull_request_fields(account, &query, limit, &select_text, features.search_type())
            .await?
    } else {
        let filter = PullListFilter {
            states: states(state),
            base: flags.as_nonempty("base").map(str::to_owned),
            head: flags.as_nonempty("head").map(str::to_owned),
        };
        list_pull_request_fields(account, &repo, &filter, limit, &select_text).await?
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
                tsv(&[
                    node.get("number").show(),
                    one_line(node.get("title").text()),
                    head_label(node),
                    state_with_draft(node),
                    time_field(node.get("createdAt")),
                ])
            })
            .collect::<String>(),
    );
    if searching && limit > 1000 && !answers.is_empty() {
        out.stderr = SEARCH_CAPPED.as_bytes().to_vec();
    }
    Ok(out)
}

const VIEW_FIELDS: [&str; 19] = [
    "url",
    "number",
    "title",
    "state",
    "body",
    "author",
    "autoMergeRequest",
    "isDraft",
    "additions",
    "deletions",
    "reviewRequests",
    "reviews",
    "assignees",
    "labels",
    "projectItems",
    "milestone",
    "comments",
    "baseRefName",
    "headRefName",
];

/// A label list sorted as gh's view sorts one, ignoring case.
pub(crate) fn sorted_labels(row: &Json) -> String {
    let mut names: Vec<String> = row
        .get("labels")
        .items()
        .iter()
        .map(|label| label.get("name").text().to_owned())
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names.join(", ")
}

pub(crate) fn assignee_list(row: &Json) -> String {
    row.get("assignees")
        .items()
        .iter()
        .map(|person| person.get("login").text().to_owned())
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn project_list(row: &Json) -> String {
    row.get("projectItems")
        .items()
        .iter()
        .map(|item| {
            let status = item.get("status").get("name").text();
            let column = if status.is_empty() {
                "No Status"
            } else {
                status
            };
            format!("{} ({column})", item.get("title").text())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn reviewer_list(row: &Json, author: &str) -> String {
    let mut states: Vec<(String, String)> = Vec::new();
    let mut put =
        |name: String, state: String| match states.iter_mut().find(|(known, _)| *known == name) {
            Some(slot) => slot.1 = state,
            None => states.push((name, state)),
        };
    for review in row.get("reviews").items() {
        let login = review.get("author").get("login").text();
        if login != author {
            let name = if login.is_empty() { "ghost" } else { login };
            put(name.to_owned(), review.get("state").text().to_owned());
        }
    }
    for request in row.get("reviewRequests").items() {
        let name = match request.as_obj().and_then(|obj| obj.find("slug")) {
            Some(slug) => slug.text(),
            None => request.get("login").text(),
        };
        put(name.to_owned(), "REQUESTED".to_owned());
    }
    states.retain(|(_, state)| state != "PENDING");
    states.sort_by(|a, b| {
        (a.1 == "REQUESTED")
            .cmp(&(b.1 == "REQUESTED"))
            .then_with(|| a.0.cmp(&b.0))
    });
    states
        .iter()
        .map(|(name, state)| {
            let shown = match state.as_str() {
                "REQUESTED" => "Requested".to_owned(),
                "APPROVED" => "Approved".to_owned(),
                "CHANGES_REQUESTED" => "Changes requested".to_owned(),
                "COMMENTED" | "DISMISSED" => "Commented".to_owned(),
                other => title_case(other),
            };
            format!("{name} ({shown})")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn title_case(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first
            .to_uppercase()
            .chain(chars.flat_map(char::to_lowercase))
            .collect(),
        None => String::new(),
    }
}

fn view_text(row: &Json, author: &str) -> String {
    let auto_merge = row.get("autoMergeRequest");
    let merging = if auto_merge.is_null() {
        "disabled".to_owned()
    } else {
        format!(
            "enabled\t{}\t{}",
            auto_merge.get("enabledBy").get("login").text(),
            auto_merge.get("mergeMethod").text().to_lowercase()
        )
    };
    format!(
        "title:\t{}\nstate:\t{}\nauthor:\t{}\nlabels:\t{}\nassignees:\t{}\nreviewers:\t{}\nprojects:\t{}\nmilestone:\t{}\nnumber:\t{}\nurl:\t{}\nadditions:\t{}\ndeletions:\t{}\nauto-merge:\t{merging}\n--\n{}\n",
        row.get("title").text(),
        state_with_draft(row),
        author,
        sorted_labels(row),
        assignee_list(row),
        reviewer_list(row, author),
        project_list(row),
        row.get("milestone").get("title").text(),
        row.get("number").show(),
        row.get("url").text(),
        row.get("additions").show(),
        row.get("deletions").show(),
        row.get("body").text(),
    )
}

pub(crate) async fn view_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let table = pull_field_table();
    let allowed = names(&table);
    let exported_fields = json_fields(flags, &allowed)?;
    let (repo, number) = target(account, texts, flags).await?;
    if let Some(fields) = exported_fields {
        let node = viewed_pull(account, &table, &repo, number, &fields).await?;
        let row = exported_node(&table, &node, &fields);
        return typed_out(account, &row, flags, String::new(), &allowed).await;
    }
    if let Some(comments) = comments_for(account, flags, &repo, number).await? {
        return Ok(Out::text(comments_text(&comments)));
    }
    let fields = VIEW_FIELDS.map(str::to_owned).to_vec();
    let node = viewed_pull(account, &table, &repo, number, &fields).await?;
    let author = node.get("author").get("login").text();
    Ok(Out::text(view_text(
        &exported_node(&table, &node, &fields),
        author,
    )))
}

const PR_CREATE: &str = "\n\t\tmutation PullRequestCreate($input: CreatePullRequestInput!) {\n\t\t\tcreatePullRequest(input: $input) {\n\t\t\t\tpullRequest {\n\t\t\t\t\tid\n\t\t\t\t\turl\n\t\t\t\t}\n\t\t\t}\n\t}";
const PR_CREATE_METADATA: &str = "\n\t\tmutation PullRequestCreateMetadata($input: UpdatePullRequestInput!) {\n\t\t\tupdatePullRequest(input: $input) { clientMutationId }\n\t\t}";
const PR_CREATE_REVIEWS: &str = "\n\t\tmutation PullRequestCreateRequestReviews($input: RequestReviewsInput!) {\n\t\t\trequestReviews(input: $input) { clientMutationId }\n\t\t}";

async fn send_input(account: &Account, query: &str, input: Obj) -> Result<Obj> {
    let mut variables = Obj::new();
    variables.set("input", input);
    graphql_data(account, query, variables).await
}

fn reviewer_failure(failure: Failure) -> Failure {
    Failure::Value(format!("could not request reviewer: {}", failure.text()))
}

/// `gh pr create`: what the flags name is resolved before anything is made;
/// a pull request made but not finished still prints its URL.
pub(crate) async fn create_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let body_text = body_value(account, flags, "body", "body_file", false, None).await?;
    let (Some(title), Some(body_text)) = (flags.as_str("title"), body_text) else {
        return usage(
            "must provide `--title` and `--body` (or `--fill` or `fill-first` or `--fillverbose`) when not running interactively",
        );
    };
    let repo = repo_for(account, flags)?;
    let Some(head) = flags.as_nonempty("head").or(current_branch(account)) else {
        return value("could not determine the current branch: no `branch` on the install");
    };
    head_branch(head)?;
    let assignees = with_special_names(account, csv_values(&flags.as_list("assignee"))).await?;
    let info = github_repo(account, &repo).await?;
    let base = match flags.as_nonempty("base") {
        Some(base) => base.to_owned(),
        None => info.get("defaultBranchRef").get("name").text().to_owned(),
    };
    let existing = pull_for_branch(
        account,
        &repo,
        head,
        BranchFilter {
            states: Some(vec!["OPEN"]),
            base: Some(base.clone()),
        },
    )
    .await
    .map_err(|failure| {
        Failure::Value(format!(
            "error checking for existing pull request: {}",
            failure.text()
        ))
    })?;
    if let Some(existing) = existing {
        return value(format!(
            "a pull request for branch {} into branch {} already exists:\n{}",
            quoted(head),
            quoted(&base),
            existing.get("url").show()
        ));
    }
    if title.is_empty() {
        return value("pull request title must not be blank");
    }
    let labels = csv_values(&flags.as_list("label"));
    let reviewers = csv_values(&flags.as_list("reviewer"));
    let milestone = flags.as_nonempty("milestone");
    let (teams, users): (Vec<String>, Vec<String>) = reviewers
        .iter()
        .cloned()
        .partition(|name| name.contains('/'));
    let mut update = Obj::new();
    let mut review = Obj::new();
    if !assignees.is_empty() || !labels.is_empty() || !reviewers.is_empty() || milestone.is_some() {
        let wanted = Wanted {
            actor_assignees: false,
            assignees: !assignees.is_empty(),
            reviewers: !reviewers.is_empty(),
            team_reviewers: !teams.is_empty(),
            labels: !labels.is_empty(),
            milestones: milestone.is_some(),
        };
        let meta = repo_metadata(account, &repo, &wanted).await?;
        let ids = meta.members_to_ids(&assignees).map_err(|failure| {
            Failure::Value(format!("could not assign user: {}", failure.text()))
        })?;
        if !ids.is_empty() {
            update.set("assigneeIds", ids.as_slice());
        }
        let ids = meta.labels_to_ids(&labels).map_err(|failure| {
            Failure::Value(format!("could not add label: {}", failure.text()))
        })?;
        if !ids.is_empty() {
            update.set("labelIds", ids.as_slice());
        }
        if let Some(title) = milestone {
            let id = meta.milestone_to_id(title).map_err(|failure| {
                Failure::Value(format!(
                    "could not add to milestone '{title}': {}",
                    failure.text()
                ))
            })?;
            update.set("milestoneId", id);
        }
        let ids = meta.members_to_ids(&users).map_err(reviewer_failure)?;
        if !ids.is_empty() {
            review.set("userIds", ids.as_slice());
        }
        let ids = meta.teams_to_ids(&teams).map_err(reviewer_failure)?;
        if !ids.is_empty() {
            review.set("teamIds", ids.as_slice());
        }
    }
    let mut input = Obj::new();
    input.set("repositoryId", info.get("id").text());
    input.set("title", title);
    input.set("body", body_text);
    input.set("draft", flags.gh_bool("draft"));
    input.set("baseRefName", base);
    input.set("headRefName", head);
    input.set("maintainerCanModify", !flags.gh_bool("no_maintainer_edit"));
    let created = send_input(account, PR_CREATE, input)
        .await
        .map_err(|failure| {
            Failure::Value(format!("pull request create failed: {}", failure.text()))
        })?;
    let made = created.get("createPullRequest").get("pullRequest");
    let id = made.get("id").text();
    let line = format!("{}\n", made.get("url").text());
    let finished = async {
        if !update.is_empty() {
            update.set("pullRequestId", id);
            send_input(account, PR_CREATE_METADATA, update).await?;
        }
        if !review.is_empty() {
            review.set("pullRequestId", id);
            review.set("union", true);
            send_input(account, PR_CREATE_REVIEWS, review).await?;
        }
        Ok::<(), Failure>(())
    }
    .await;
    match finished {
        Ok(()) => Ok(Out::text(line)),
        Err(failure) => Err(Failure::Printed {
            output: line.into_bytes(),
            message: format!("pull request update failed: {}", failure.text()),
        }),
    }
}

pub(crate) async fn edit_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let editable = Editable::from_flags(account, flags).await?;
    if !editable.dirty() {
        return usage(
            "--title, --body, --reviewer, --assignee, --label, --project, or --milestone required when not running interactively",
        );
    }
    let (repo, number, node) = find(account, flags, texts, PR_EDIT_FIELDS).await?;
    let fetch = Fetch::Pull {
        target: &repo,
        number,
    };
    read_rest(
        account,
        &pull_field_table(),
        Obj::new(),
        &["projectItems".to_owned()],
        &fetch,
    )
    .await?;
    let meta = repo_metadata(account, &repo, &editable.wanted()).await?;
    editable
        .apply(account, node.get("id").text(), true, &meta, &node)
        .await?;
    if editable.reviewers_edited {
        update_reviews(account, &repo, number, &editable, &node).await?;
    }
    Ok(Out::text(format!("{}\n", node.get("url").text())))
}

pub(crate) async fn reopen_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number, node) = find(account, flags, texts, "id,number,state,title").await?;
    let name = format!("{}#{number} ({})", repo.full(), node.get("title").text());
    match node.get("state").as_str() {
        Some("MERGED") => {
            return Ok(Out::failed(format!(
                "X Pull request {name} can't be reopened because it was already merged\n"
            )));
        }
        Some("OPEN") => {
            return Ok(Out::warned(format!(
                "! Pull request {name} is already open\n"
            )));
        }
        _ => {}
    }
    let id = node.get("id").text();
    if let Some(comment) = flags.as_nonempty("comment") {
        add_comment(account, id, comment).await?;
    }
    reopen_pull(account, id)
        .await
        .map_err(|failure| Failure::Value(format!("API call failed: {}", failure.text())))?;
    Ok(Out::warned(format!("✓ Reopened pull request {name}\n")))
}

const DIFF_SPACE: &[u8] = b"\t\n\x0c\r ";

/// The files a diff changes, as `gh pr diff --name-only` reads them: the
/// `b/` side of each `diff --git` header, quotes and all.
fn changed_names(diff: &str) -> Vec<String> {
    let bytes = diff.as_bytes();
    let mut names = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let start = if at == 0 && bytes.starts_with(b"diff") {
            0
        } else if bytes[at] == b'\n' {
            at + 1
        } else {
            at += 1;
            continue;
        };
        let header = &bytes[start..];
        if !(header.starts_with(b"diff")
            && header.len() > 4
            && DIFF_SPACE.contains(&header[4])
            && header[5..].starts_with(b"--git"))
        {
            at = if start == 0 { 1 } else { at + 1 };
            continue;
        }
        let line = start + 10;
        let end = bytes[line..]
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |offset| line + offset);
        let last = (end + 1).min(bytes.len());
        let found = (line..last).rev().find_map(|space| {
            if !DIFF_SPACE.contains(&bytes[space]) {
                return None;
            }
            let after = &bytes[space + 1..];
            let quote = after.first() == Some(&b'"');
            let name = if quote { &after[1..] } else { after };
            name.starts_with(b"b/").then_some((space + 1, quote))
        });
        let Some((mark, quote)) = found else {
            at = end;
            continue;
        };
        let name_start = mark + usize::from(quote) + 2;
        let name_end = bytes[name_start..]
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |offset| name_start + offset);
        let name = String::from_utf8_lossy(&bytes[name_start..name_end]);
        let joined = format!("{}{name}", if quote { "\"" } else { "" });
        names.push(joined.trim().to_owned());
        at = name_end;
    }
    names
}

pub(crate) async fn diff_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number) = target(account, texts, flags).await?;
    let name_only = flags.gh_bool("name_only");
    let text = diff_pull(account, &repo, number, flags.gh_bool("patch") && !name_only)
        .await
        .map_err(|failure| {
            Failure::Value(format!(
                "could not find pull request diff: {}",
                failure.text()
            ))
        })?;
    if name_only {
        return Ok(Out::text(
            changed_names(&text)
                .into_iter()
                .map(|name| format!("{name}\n"))
                .collect::<String>(),
        ));
    }
    Ok(Out::text(if text.ends_with('\n') {
        text
    } else {
        format!("{text}\n")
    }))
}

const ZERO_TIME: &str = "0001-01-01T00:00:00Z";

/// Only the latest of each repeated check, as gh's eliminateDuplicates
/// keeps them.
fn newest_checks(mut contexts: Vec<Json>) -> Vec<Json> {
    contexts.sort_by_key(|context| {
        std::cmp::Reverse(instant(context.get("startedAt").text()).unwrap_or(i128::MIN))
    });
    let mut seen = HashSet::new();
    contexts.retain(|context| {
        let status = context.get("context").text();
        seen.insert(if status.is_empty() {
            let run = context.get("checkSuite").get("workflowRun");
            format!(
                "check\0{}/{}/{}",
                context.get("name").text(),
                run.get("workflow").get("name").text(),
                run.get("event").text()
            )
        } else {
            format!("status\0{status}")
        })
    });
    contexts
}

fn check(context: &Json) -> Obj {
    let state = match context.get("state").text() {
        "" if context.get("status").text() == "COMPLETED" => context.get("conclusion").text(),
        "" => context.get("status").text(),
        state => state,
    };
    let either = |first: &str, second: &str| -> String {
        let found = context.get(first).text();
        if found.is_empty() {
            context.get(second).text().to_owned()
        } else {
            found.to_owned()
        }
    };
    let time = |key: &str| -> String {
        let found = context.get(key).text();
        if found.is_empty() {
            ZERO_TIME.to_owned()
        } else {
            found.to_owned()
        }
    };
    let run = context.get("checkSuite").get("workflowRun");
    let mut row = Obj::new();
    row.set("name", either("name", "context"));
    row.set("state", state);
    row.set("startedAt", time("startedAt"));
    row.set("completedAt", time("completedAt"));
    row.set("link", either("detailsUrl", "targetUrl"));
    row.set("bucket", bucket(state));
    row.set("event", run.get("event").text());
    row.set("workflow", run.get("workflow").get("name").text());
    row.set("description", context.get("description").text());
    row
}

/// Whether gh's table puts `a` before `b`: same bucket by name then link,
/// else failures, then what is pending ahead of what passed.
fn check_before(a: &Obj, b: &Obj) -> bool {
    let (left, right) = (a.get("bucket").text(), b.get("bucket").text());
    if left == right {
        let (first, second) = (a.get("name").text(), b.get("name").text());
        if first == second {
            return a.get("link").text() < b.get("link").text();
        }
        return first < second;
    }
    left == "fail" || (left == "pending" && right == "success")
}

pub(crate) async fn checks_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    json_fields(flags, &CHECK_FIELDS)?;
    let (_, _, node) = find(account, flags, texts, "number,headRefName,id").await?;
    let contexts = status_contexts(
        account,
        node.get("id").text(),
        node.get("headRefName").text(),
    )
    .await?;
    let rows: Vec<Obj> = newest_checks(contexts).iter().map(check).collect();
    let mut sorted: Vec<&Obj> = rows.iter().collect();
    for start in 1..sorted.len() {
        let mut at = start;
        while at > 0 && check_before(sorted[at], sorted[at - 1]) {
            sorted.swap(at, at - 1);
            at -= 1;
        }
    }
    let human: String = sorted
        .iter()
        .map(|row| {
            let span = match (
                row.get("startedAt").as_str().and_then(instant),
                row.get("completedAt").as_str().and_then(instant),
            ) {
                (Some(start), Some(end)) if end > start => go_duration(end - start),
                _ => "0".to_owned(),
            };
            let bucket = row.get("bucket").text();
            tsv(&[
                row.get("name").show(),
                if bucket == "cancel" {
                    "fail".to_owned()
                } else {
                    bucket.to_owned()
                },
                span,
                row.get("link").text().to_owned(),
                row.get("description").text().to_owned(),
            ])
        })
        .collect();
    let failing = rows
        .iter()
        .any(|row| row.get("bucket").as_str() == Some("fail"));
    let pending = rows
        .iter()
        .any(|row| row.get("bucket").as_str() == Some("pending"));
    let data = Json::Arr(rows.into_iter().map(Json::Obj).collect());
    let mut out = typed_out(account, &data, flags, human, &CHECK_FIELDS).await?;
    if failing {
        out.exit = 1;
    } else if pending {
        out.exit = 8;
    }
    Ok(out)
}

/// A selector's pull request, its fields as gh's Finder reads them.
async fn find(
    account: &Account,
    flags: &Flags,
    texts: &[String],
    fields: &str,
) -> Result<(RepoRef, i128, Obj)> {
    if flags.as_nonempty("repo").is_some() && texts.is_empty() {
        return usage("argument required when using the --repo flag");
    }
    let (repo, number) = target(account, texts, flags).await?;
    let node = pull_request_fields(account, &repo, number, fields, None).await?;
    Ok((repo, number, node))
}

pub(crate) async fn close_pull(account: &Account, id: &str) -> Result<()> {
    let mut input = Obj::new();
    input.set("pullRequestId", id);
    mutate(
        account,
        "PullRequestClose",
        "ClosePullRequestInput",
        "closePullRequest",
        "pullRequest{id}",
        input,
    )
    .await
    .map(|_| ())
}

async fn delete_remote_branch(account: &Account, repo: &RepoRef, branch: &str) -> Result<Json> {
    github_request(
        account,
        "DELETE",
        &format!(
            "/repos/{}/{}/git/refs/heads/{}",
            repo.owner,
            repo.repo,
            quote_ref(branch)
        ),
        None,
    )
    .await
}

pub(crate) async fn close_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    exact_one(
        texts,
        "cannot close pull request: number, url, or branch required",
    )?;
    let (repo, number, node) = find(
        account,
        flags,
        texts,
        "state,number,title,isCrossRepository,headRefName,id",
    )
    .await?;
    let name = format!("{}#{number} ({})", repo.full(), node.get("title").text());
    if node.get("state").as_str() == Some("MERGED") {
        return Ok(Out::failed(format!(
            "X Pull request {name} can't be closed because it was already merged\n"
        )));
    }
    if node.get("state").as_str() != Some("OPEN") {
        return Ok(Out::warned(format!(
            "! Pull request {name} is already closed\n"
        )));
    }
    let id = node.get("id").text();
    if let Some(comment) = flags.as_nonempty("comment") {
        add_comment(account, id, comment).await?;
    }
    close_pull(account, id)
        .await
        .map_err(|failure| Failure::Value(format!("API call failed: {}", failure.text())))?;
    let mut note = format!("✓ Closed pull request {name}\n");
    if flags.gh_bool("delete_branch") {
        let branch = node.get("headRefName").text();
        note.push_str(
            "! Skipped deleting the local branch since current directory is not a git repository\n",
        );
        if node.get("isCrossRepository").truthy() {
            note.push_str("! Skipped deleting the remote branch of a pull request from fork\n");
            return Ok(Out::warned(note));
        }
        delete_remote_branch(account, &repo, branch)
            .await
            .map_err(|failure| {
                Failure::Value(format!(
                    "{note}failed to delete remote branch {branch}: {}",
                    failure.text()
                ))
            })?;
        note.push_str(&format!("✓ Deleted branch {branch}\n"));
    }
    Ok(Out::warned(note))
}

pub(crate) async fn review_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    if flags.as_nonempty("repo").is_some() && texts.is_empty() {
        return usage("argument required when using the --repo flag");
    }
    let body = body_value(
        account,
        flags,
        "body",
        "body_file",
        false,
        Some("specify only one of `--body` or `--body-file`"),
    )
    .await?
    .unwrap_or_default();
    let chosen: Vec<&str> = ["approve", "request_changes", "comment"]
        .into_iter()
        .filter(|name| flags.gh_bool(name))
        .collect();
    if flags.gh_bool("request_changes") && body.is_empty() {
        return usage("body cannot be blank for request-changes review");
    }
    if flags.gh_bool("comment") && body.is_empty() {
        return usage("body cannot be blank for comment review");
    }
    if chosen.is_empty() && body.is_empty() {
        return usage(
            "--approve, --request-changes, or --comment required when not running interactively",
        );
    }
    if chosen.is_empty() {
        return usage("--body unsupported without --approve, --request-changes, or --comment");
    }
    if chosen.len() > 1 {
        return usage("need exactly one of --approve, --request-changes, or --comment");
    }
    let event = match chosen[0] {
        "approve" => "APPROVE",
        "request_changes" => "REQUEST_CHANGES",
        _ => "COMMENT",
    };
    let (_, _, node) = find(account, flags, texts, "id,number").await?;
    let mut input = Obj::new();
    input.set("body", body);
    input.set("event", event);
    input.set("pullRequestId", node.get("id").text());
    let mut variables = Obj::new();
    variables.set("input", input);
    graphql_data(
        account,
        "mutation PullRequestReviewAdd($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){clientMutationId}}",
        variables,
    )
    .await
    .map_err(|failure| Failure::Value(format!("failed to create review: {}", failure.text())))?;
    Ok(Out::default())
}

pub(crate) async fn ready_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (repo, number, node) = find(account, flags, texts, "id,number,state,isDraft").await?;
    let name = format!("{}#{number}", repo.full());
    if node.get("state").as_str() != Some("OPEN") {
        return Ok(Out::failed(format!(
            "X Pull request {name} is closed. Only draft pull requests can be marked as \"ready for review\"\n"
        )));
    }
    let draft = node.get("isDraft").truthy();
    let mut input = Obj::new();
    input.set("pullRequestId", node.get("id").text());
    let failed = |failure: Failure| Failure::Value(format!("API call failed: {}", failure.text()));
    if flags.gh_bool("undo") {
        if draft {
            return Ok(Out::warned(format!(
                "! Pull request {name} is already \"in draft\"\n"
            )));
        }
        mutate(
            account,
            "ConvertPullRequestToDraft",
            "ConvertPullRequestToDraftInput",
            "convertPullRequestToDraft",
            "pullRequest{id}",
            input,
        )
        .await
        .map_err(failed)?;
        return Ok(Out::warned(format!(
            "✓ Pull request {name} is converted to \"draft\"\n"
        )));
    }
    if !draft {
        return Ok(Out::warned(format!(
            "! Pull request {name} is already \"ready for review\"\n"
        )));
    }
    mutate(
        account,
        "PullRequestReadyForReview",
        "MarkPullRequestReadyForReviewInput",
        "markPullRequestReadyForReview",
        "pullRequest{id}",
        input,
    )
    .await
    .map_err(failed)?;
    Ok(Out::warned(format!(
        "✓ Pull request {name} is marked as \"ready for review\"\n"
    )))
}

pub(crate) async fn update_branch_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let (repo, number, node) = find(
        account,
        flags,
        texts,
        "id,number,headRefName,headRefOid,headRepositoryOwner{id,login,...on User{name}},mergeable",
    )
    .await?;
    if node.get("mergeable").as_str() == Some("CONFLICTING") {
        return Ok(Out::failed("X Cannot update PR branch due to conflicts\n"));
    }
    let owner = node.get("headRepositoryOwner").get("login").text();
    let mut head = node.get("headRefName").text().to_owned();
    if owner != repo.owner {
        head = format!("{owner}:{head}");
    }
    let mut variables = Obj::new();
    variables.set("owner", repo.owner.as_str());
    variables.set("repo", repo.repo.as_str());
    variables.set("pullRequestNumber", number);
    variables.set("headRef", head);
    let data = graphql_data(
        account,
        "query ComparePullRequestBaseBranchWith($owner: String!, $repo: String!, $pullRequestNumber: Int!, $headRef: String!) {\n\t\trepository(owner: $owner, name: $repo) {\n\t\t\tpullRequest(number: $pullRequestNumber) {\n\t\t\t\tbaseRef {\n\t\t\t\t\tcompare (headRef: $headRef) {\n\t\t\t\t\t\taheadBy, behindBy, status\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}",
        variables,
    )
    .await?;
    let compare = data
        .get("repository")
        .get("pullRequest")
        .get("baseRef")
        .get("compare");
    if compare.get("behindBy").as_int() == Some(0) {
        return Ok(Out::text("✓ PR branch already up-to-date\n"));
    }
    let mut input = Obj::new();
    input.set("expectedHeadOid", node.get("headRefOid").text());
    input.set("pullRequestId", node.get("id").text());
    input.set(
        "updateMethod",
        if flags.gh_bool("rebase") {
            "REBASE"
        } else {
            "MERGE"
        },
    );
    match mutate(
        account,
        "PullRequestUpdateBranch",
        "UpdatePullRequestBranchInput",
        "updatePullRequestBranch",
        "pullRequest{id}",
        input,
    )
    .await
    {
        Err(failure)
            if failure
                .text()
                .contains("merge conflict between base and head") =>
        {
            Ok(Out::failed("X Cannot update PR branch due to conflicts\n"))
        }
        Err(failure) => Err(failure),
        Ok(_) => Ok(Out::text("✓ PR branch updated\n")),
    }
}

pub(crate) async fn revert_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    exact_one(
        texts,
        "cannot revert pull request: number, url, or branch required",
    )?;
    let body = body_value(
        account,
        flags,
        "body",
        "body_file",
        false,
        Some("specify only one of `--body` or `--body-file`"),
    )
    .await?;
    let (repo, number, node) = find(account, flags, texts, "id,number,state,title").await?;
    if node.get("state").as_str() != Some("MERGED") {
        return Ok(Out::failed(format!(
            "X Pull request {}#{number} ({}) can't be reverted because it has not been merged\n",
            repo.full(),
            node.get("title").text()
        )));
    }
    let mut input = Obj::new();
    if let Some(body) = body {
        input.set("body", body);
    }
    input.set("draft", flags.gh_bool("draft"));
    input.set("pullRequestId", node.get("id").text());
    if let Some(title) = flags.as_nonempty("title") {
        input.set("title", title);
    }
    let data = mutate(
        account,
        "PullRequestRevert",
        "RevertPullRequestInput",
        "revertPullRequest",
        "pullRequest{id},revertPullRequest{id,number,url}",
        input,
    )
    .await
    .map_err(|failure| {
        let text = failure.text();
        Failure::Value(format!("X {text}\nAPI call failed: {text}"))
    })?;
    let url = data
        .get("revertPullRequest")
        .get("revertPullRequest")
        .get("url")
        .text();
    if url.is_empty() {
        return Ok(Out::default());
    }
    Ok(Out::text(format!("{url}\n")))
}

const MERGE_FIELDS: &str = "id,number,state,title,commits(last:1){nodes{commit{oid}}},mergeStateStatus,headRepositoryOwner{id,login,...on User{name}},headRefName,baseRefName,headRefOid,isInMergeQueue,isMergeQueueEnabled";

pub(crate) async fn merge_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    if flags.as_nonempty("repo").is_some() && texts.is_empty() {
        return usage("argument required when using the --repo flag");
    }
    let methods: Vec<&str> = ["merge", "rebase", "squash"]
        .into_iter()
        .filter(|name| flags.gh_bool(name))
        .collect();
    if methods.len() > 1 {
        return usage("only one of --merge, --rebase, or --squash can be enabled");
    }
    let (auto, disable, admin) = (
        flags.gh_bool("auto"),
        flags.gh_bool("disable_auto"),
        flags.gh_bool("admin"),
    );
    if usize::from(auto) + usize::from(disable) + usize::from(admin) > 1 {
        return usage("specify only one of `--auto`, `--disable-auto`, or `--admin`");
    }
    let body_text = body_value(
        account,
        flags,
        "body",
        "body_file",
        false,
        Some("specify only one of `--body` or `--body-file`"),
    )
    .await?;
    let (repo, number, node) = find(account, flags, texts, MERGE_FIELDS).await?;
    let name = format!("{}#{number}", repo.full());
    if node.get("isInMergeQueue").truthy() {
        return Ok(Out::warned(format!(
            "! Pull request {name} is already queued to merge\n"
        )));
    }
    let id = node.get("id").text();
    if disable {
        let mut variables = Obj::new();
        variables.set("prID", id);
        graphql_data(
            account,
            "mutation PullRequestAutoMergeDisable($prID:ID!){disablePullRequestAutoMerge(input: {pullRequestId: $prID}){clientMutationId}}",
            variables,
        )
        .await?;
        return Ok(Out::default());
    }
    let status = node.get("mergeStateStatus").text();
    let merged = node.get("state").as_str() == Some("MERGED");
    let queue = node.get("isMergeQueueEnabled").truthy();
    let delete_branch = flags.gh_bool("delete_branch");
    let cross_repo = node.get("headRepositoryOwner").get("login").text() != repo.owner;
    let auto_merge = auto && !matches!(status, "CLEAN" | "HAS_HOOKS" | "UNSTABLE");
    if queue && delete_branch {
        return value("X Cannot use `-d` or `--delete-branch` when merge queue enabled");
    }
    let blocked = match status {
        "BLOCKED" if !admin => "the base branch policy prohibits the merge",
        "BEHIND" if !admin => "the head branch is not up to date with the base branch",
        "DIRTY" => "the merge commit cannot be cleanly created",
        _ => "",
    };
    if !queue && !blocked.is_empty() && !auto_merge && !merged {
        let mut note = format!(
            "X Pull request {name} is not mergeable: {blocked}.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\n"
        );
        if !admin && matches!(status, "BLOCKED" | "BEHIND") {
            note.push_str("To use administrator privileges to immediately merge the pull request, add the `--admin` flag.\n");
        }
        return Ok(Out::failed(note));
    }
    let mut note = String::new();
    if !merged {
        let adding_to_queue = queue && !admin;
        if adding_to_queue && !methods.is_empty() {
            note.push_str(&format!(
                "! The merge strategy for {} is set by the merge queue\n",
                node.get("baseRefName").text()
            ));
        }
        if !adding_to_queue && methods.is_empty() {
            return usage("--merge, --rebase, or --squash required when not running interactively");
        }
        let method = methods.first().copied().unwrap_or("merge");
        let mut input = Obj::new();
        if let Some(email) = flags.as_nonempty("author_email") {
            input.set("authorEmail", email);
        }
        if let Some(text) = &body_text {
            input.set("commitBody", text.as_str());
        }
        if let Some(subject) = flags.as_nonempty("subject") {
            input.set("commitHeadline", subject);
        }
        if let Some(sha) = flags.as_nonempty("match_head_commit") {
            input.set("expectedHeadOid", sha);
        }
        if !adding_to_queue {
            input.set("mergeMethod", method.to_uppercase());
        }
        input.set("pullRequestId", id);
        if auto_merge || adding_to_queue {
            mutate(
                account,
                "PullRequestAutoMerge",
                "EnablePullRequestAutoMergeInput",
                "enablePullRequestAutoMerge",
                "clientMutationId",
                input,
            )
            .await?;
        } else {
            mutate(
                account,
                "PullRequestMerge",
                "MergePullRequestInput",
                "mergePullRequest",
                "clientMutationId",
                input,
            )
            .await?;
        }
        if adding_to_queue || auto_merge {
            return Ok(Out::warned(note));
        }
    } else {
        note.push_str(&format!("! Pull request {name} was already merged\n"));
    }
    if delete_branch && !cross_repo && !auto_merge {
        let branch = node.get("headRefName").text();
        if !merged {
            match delete_remote_branch(account, &repo, branch).await {
                Err(Failure::Api(error)) if matches!(error.status, 404 | 422) => {}
                Err(failure) => {
                    return value(format!(
                        "{note}failed to delete remote branch {branch}: {}",
                        failure.text()
                    ));
                }
                Ok(_) => {}
            }
        }
    }
    Ok(Out::warned(note))
}

pub(crate) async fn comment_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    check_comment_flags(flags)?;
    if flags.as_nonempty("repo").is_some() && texts.is_empty() {
        return usage("argument required when using the --repo flag");
    }
    let text = comment_body(account, flags).await?;
    let (repo, number) = target(account, texts, flags).await?;
    let node = pull_request_fields(account, &repo, number, "id,url", None).await?;
    let comments = if flags.gh_bool("edit_last") || flags.gh_bool("delete_last") {
        issue_comments(account, &repo, number).await?
    } else {
        Vec::new()
    };
    comment_run(account, flags, node.get("id").text(), &comments, &text).await
}

const PR_STATUS_FIELDS: [&str; 10] = [
    "number",
    "title",
    "state",
    "url",
    "isDraft",
    "isCrossRepository",
    "headRefName",
    "headRepositoryOwner",
    "mergeable",
    "reviewDecision",
];

fn status_rows(out: &mut String, total: i128, rows: &[Json]) {
    for row in rows {
        out.push_str(&format!(
            "  #{}  {} [{}]",
            row.get("number").show(),
            truncate_title(&one_line(row.get("title").text())),
            head_label(row)
        ));
        if row.get("state").as_str() == Some("OPEN") {
            let decision = row.get("reviewDecision").text();
            let review = match decision {
                "CHANGES_REQUESTED" => "+ Changes requested",
                "REVIEW_REQUIRED" => "- Review required",
                "APPROVED" => "✓ 0 Approved",
                _ => "",
            };
            if !review.is_empty() {
                out.push_str("\n  ");
                out.push_str(review);
            }
            match row.get("mergeable").text() {
                "MERGEABLE" => out.push_str(" ✓ No merge conflicts"),
                "CONFLICTING" => out.push_str(" × Merge conflicts"),
                "UNKNOWN" => out.push_str(" ! Merge conflict status unknown"),
                _ => {}
            }
        } else {
            let state = if row.get("state").as_str() == Some("MERGED") {
                "Merged"
            } else {
                "Closed"
            };
            out.push_str(&format!(" - {state}"));
        }
        out.push('\n');
    }
    let left = total - rows.len() as i128;
    if left > 0 {
        out.push_str(&format!("  And {left} more\n"));
    }
}

fn truncate_title(title: &str) -> String {
    const MAX: usize = 50;
    if title.chars().count() <= MAX {
        return title.to_owned();
    }
    let kept: String = title.chars().take(MAX - 3).collect();
    format!("{kept}...")
}

const PR_STATUS_QUERY: &str = "\n\tquery PullRequestStatus($owner: String!, $repo: String!, $viewerQuery: String!, $reviewerQuery: String!, $per_page: Int = 10) {\n\t\trepository(owner: $owner, name: $repo) {\n\t\t\tdefaultBranchRef {\n\t\t\t\tname\n\t\t\t}\n\t\t}\n\t\tviewerCreated: search(query: $viewerQuery, type: ISSUE, first: $per_page) {\n\t\t\ttotalCount: issueCount\n\t\t\tedges {\n\t\t\t\tnode {\n\t\t\t\t\t...prWithReviews\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t\treviewRequested: search(query: $reviewerQuery, type: ISSUE, first: $per_page) {\n\t\t\ttotalCount: issueCount\n\t\t\tedges {\n\t\t\t\tnode {\n\t\t\t\t\t...pr\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}";

pub(crate) async fn status_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let table = pull_field_table();
    let allowed = names(&table);
    let exported_fields = json_fields(flags, &allowed)?;
    let repo = repo_for(account, flags)?;
    let fields: Vec<String> = exported_fields
        .clone()
        .unwrap_or_else(|| PR_STATUS_FIELDS.map(str::to_owned).to_vec());
    let select_text = selection(&table, &fields, false);
    let query = format!(
        "fragment pr on PullRequest{{{select_text}}}fragment prWithReviews on PullRequest{{...pr}}{PR_STATUS_QUERY}"
    );
    let name = repo.full();
    let mut variables = Obj::new();
    variables.set("owner", repo.owner.as_str());
    variables.set("repo", repo.repo.as_str());
    variables.set(
        "viewerQuery",
        format!("repo:{name} state:open is:pr author:@me"),
    );
    variables.set(
        "reviewerQuery",
        format!("repo:{name} state:open is:pr review-requested:@me"),
    );
    let data = graphql_data(account, &query, variables).await?;
    let nodes = |page: &Json| -> Vec<Json> {
        page.get("edges")
            .items()
            .iter()
            .map(|edge| edge.get("node").clone())
            .collect()
    };
    let created = nodes(data.get("viewerCreated"));
    let requested = nodes(data.get("reviewRequested"));
    let current = match current_branch(account).filter(|_| flags.as_nonempty("repo").is_none()) {
        Some(branch) => pull_for_branch(account, &repo, branch, BranchFilter::default()).await?,
        None => None,
    };
    if exported_fields.is_some() {
        let export = |rows: &[Json]| {
            Json::Arr(
                rows.iter()
                    .map(|node| {
                        exported_node(&table, node.as_obj().unwrap_or(&Obj::new()), &fields)
                    })
                    .collect(),
            )
        };
        let mut row = Obj::new();
        row.set("createdBy", export(&created));
        row.set(
            "currentBranch",
            match &current {
                Some(found) => {
                    let number = found.get("number").as_int().unwrap_or(0);
                    let node =
                        pull_request_fields(account, &repo, number, &select_text, None).await?;
                    exported_node(&table, &node, &fields)
                }
                None => Json::Null,
            },
        );
        row.set("needsReview", export(&requested));
        return export_out(account, &Json::Obj(row), flags).await;
    }
    let mut out = format!("\nRelevant pull requests in {name}\n\n");
    if flags.as_nonempty("repo").is_none() {
        out.push_str("Current branch\n");
        match (&current, current_branch(account)) {
            (Some(found), _) => {
                let number = found.get("number").as_int().unwrap_or(0);
                let node = pull_request_fields(account, &repo, number, &select_text, None).await?;
                status_rows(&mut out, 1, &[Json::Obj(node)]);
            }
            (None, Some(branch)) => {
                out.push_str(&format!(
                    "  There is no pull request associated with [{branch}]\n"
                ));
            }
            (None, None) => out.push_str("  There is no current branch\n"),
        }
        out.push('\n');
    }
    out.push_str("Created by you\n");
    let total = data
        .get("viewerCreated")
        .get("totalCount")
        .as_int()
        .unwrap_or(0);
    if total > 0 {
        status_rows(&mut out, total, &created);
    } else {
        out.push_str("  You have no open pull requests\n");
    }
    out.push_str("\nRequesting a code review from you\n");
    let total = data
        .get("reviewRequested")
        .get("totalCount")
        .as_int()
        .unwrap_or(0);
    if total > 0 {
        status_rows(&mut out, total, &requested);
    } else {
        out.push_str("  You have no pull requests to review\n");
    }
    out.push('\n');
    Ok(Out::text(out))
}

fn people(reviewers: &[String]) -> Json {
    let (teams, users): (Vec<&String>, Vec<&String>) =
        reviewers.iter().partition(|name| name.contains('/'));
    let mut body = Obj::new();
    body.set(
        "reviewers",
        Json::Arr(users.iter().map(|name| Json::from(name.as_str())).collect()),
    );
    body.set(
        "team_reviewers",
        Json::Arr(
            teams
                .iter()
                .map(|name| Json::from(name.rsplit('/').next().unwrap_or(name)))
                .collect(),
        ),
    );
    Json::Obj(body)
}

/// Change a pull request's requested reviewers, as gh's
/// updatePullRequestReviews does: add every reviewer it should end with,
/// remove those it should no longer have.
async fn update_reviews(
    account: &Account,
    repo: &RepoRef,
    number: i128,
    editable: &Editable,
    node: &Obj,
) -> Result<()> {
    let current: Vec<String> = node
        .get("reviewRequests")
        .get("nodes")
        .items()
        .iter()
        .map(|request| {
            let reviewer = request.get("requestedReviewer");
            match reviewer.get("__typename").as_str() {
                Some("Team") => format!(
                    "{}/{}",
                    reviewer.get("organization").get("login").text(),
                    reviewer.get("slug").text()
                ),
                _ => reviewer.get("login").text().to_owned(),
            }
        })
        .collect();
    let mut wanted: Vec<String> = Vec::new();
    for name in editable.add_reviewers.iter().chain(&current) {
        if !editable.remove_reviewers.contains(name) && !wanted.contains(name) {
            wanted.push(name.clone());
        }
    }
    let gone: Vec<String> = current
        .iter()
        .filter(|name| !wanted.contains(name))
        .cloned()
        .collect();
    let path = format!(
        "/repos/{}/{}/pulls/{number}/requested_reviewers",
        repo.owner, repo.repo
    );
    if !wanted.is_empty() {
        github_request(account, "POST", &path, Some(&people(&wanted))).await?;
    }
    if !gone.is_empty() {
        github_request(account, "DELETE", &path, Some(&people(&gone))).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_names_its_b_sides_quotes_and_all() {
        let diff = "diff --git a/x y/z b/x y/z\n+1\ndiff --git \"a/q\\t\" \"b/q\\t\"\n+2\n";
        assert_eq!(changed_names(diff), ["x y/z", "\"q\\t\""]);
    }

    #[test]
    fn conclusions_bucket_as_gh_buckets_them() {
        assert_eq!(bucket("SUCCESS"), "pass");
        assert_eq!(bucket("SKIPPED"), "skipping");
        assert_eq!(bucket("TIMED_OUT"), "fail");
        assert_eq!(bucket("CANCELLED"), "cancel");
        assert_eq!(bucket("STALE"), "pending");
    }

    #[test]
    fn a_check_reads_its_state_from_its_conclusion_first() {
        let row = check(
            &Json::parse(
                br#"{"name":"t","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"u","description":"s","checkSuite":{"workflowRun":{"event":"push","workflow":{"name":"A"}}}}"#,
            )
            .unwrap(),
        );
        assert_eq!(row.get("state"), &Json::from("FAILURE"));
        assert_eq!(row.get("bucket"), &Json::from("fail"));
        assert_eq!(row.get("link"), &Json::from("u"));
        assert_eq!(row.get("workflow"), &Json::from("A"));
        assert_eq!(row.get("description"), &Json::from("s"));
    }
}

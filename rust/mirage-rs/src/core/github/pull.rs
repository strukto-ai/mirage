// The calls in gh 2.85.0's api package and pkg/cmd/pr (MIT; see
// licenses/third_party/gh.txt).

use super::client::{Account, Result, github_request_response, value};
use super::json::{Json, Obj};
use super::repo::{RepoRef, graphql_data};

fn path(target: &RepoRef, tail: &str) -> String {
    format!("/repos/{}/{}/pulls{tail}", target.owner, target.repo)
}

/// The selected fields of one pull request, as gh's PullRequestByNumber
/// asks for them.
pub(crate) async fn pull_request_fields(
    account: &Account,
    target: &RepoRef,
    number: i128,
    selection: &str,
    end_cursor: Option<&str>,
) -> Result<Obj> {
    let mut variables = Obj::new();
    variables.set("owner", target.owner.as_str());
    variables.set("repo", target.repo.as_str());
    variables.set("pr_number", number);
    if let Some(cursor) = end_cursor {
        variables.set("endCursor", cursor);
    }
    let cursor = if end_cursor.is_none() {
        ""
    } else {
        ", $endCursor: String"
    };
    let data = graphql_data(
        account,
        &format!(
            "query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!{cursor}) {{\n    repository(owner: $owner, name: $repo) {{\n      pullRequest(number: $pr_number) {{{selection}}}\n    }}\n  }}"
        ),
        variables,
    )
    .await?;
    Ok(data
        .get("repository")
        .get("pullRequest")
        .as_obj()
        .cloned()
        .unwrap_or_default())
}

/// The narrowing `gh pr list` applies before it lists.
pub(crate) struct PullListFilter {
    pub(crate) states: Vec<&'static str>,
    pub(crate) base: Option<String>,
    pub(crate) head: Option<String>,
}

const PULL_LIST: &str = "    query PullRequestList(\n      $owner: String!,\n      $repo: String!,\n      $limit: Int!,\n      $endCursor: String,\n      $baseBranch: String,\n      $headBranch: String,\n      $state: [PullRequestState!] = OPEN\n    ) {\n      repository(owner: $owner, name: $repo) {\n        pullRequests(\n          states: $state,\n          baseRefName: $baseBranch,\n          headRefName: $headBranch,\n          first: $limit,\n          after: $endCursor,\n          orderBy: {field: CREATED_AT, direction: DESC}\n        ) {\n          totalCount\n          nodes {\n            ...pr\n          }\n          pageInfo {\n            hasNextPage\n            endCursor\n          }\n        }\n      }\n    }";

const PULL_FOR_BRANCH: &str = "query PullRequestForBranch($owner: String!, $repo: String!, $headRefName: String!, $states: [PullRequestState!]) {\n  repository(owner: $owner, name: $repo) {\n    pullRequests(headRefName: $headRefName, states: $states, first: 30, orderBy: {field: CREATED_AT, direction: DESC}) {\n      nodes {number url state baseRefName headRefName isCrossRepository headRepositoryOwner {login}}\n    }\n    defaultBranchRef {name}\n  }\n}";

/// The branch name of a head, a branch or `owner:branch`.
pub(crate) fn head_branch(head: &str) -> Result<String> {
    let parts: Vec<&str> = head.split(':').collect();
    if parts.len() > 2 {
        return value(format!("invalid qualified head ref format '{head}'"));
    }
    Ok(parts[parts.len() - 1].to_owned())
}

/// What gh's finder narrows a branch's pull requests by.
#[derive(Default)]
pub(crate) struct BranchFilter {
    pub(crate) states: Option<Vec<&'static str>>,
    pub(crate) base: Option<String>,
}

/// The pull request a branch heads, picked as gh's finder picks it: of
/// the newest 30 whose head ref is the branch's name, open ones first,
/// the first whose head is exactly `head` and whose base is the filter's,
/// passing over a closed or merged one when `head` is the default branch.
pub(crate) async fn pull_for_branch(
    account: &Account,
    target: &RepoRef,
    head: &str,
    filter: BranchFilter,
) -> Result<Option<Json>> {
    let mut variables = Obj::new();
    variables.set("owner", target.owner.as_str());
    variables.set("repo", target.repo.as_str());
    variables.set("headRefName", head_branch(head)?);
    variables.set(
        "states",
        filter.states.map_or(Json::Null, |states| {
            Json::Arr(states.into_iter().map(Json::from).collect())
        }),
    );
    let data = graphql_data(account, PULL_FOR_BRANCH, variables).await?;
    let repository = data.get("repository");
    let mut rows: Vec<&Json> = repository
        .get("pullRequests")
        .get("nodes")
        .items()
        .iter()
        .filter(|node| node.as_obj().is_some())
        .collect();
    rows.sort_by_key(|node| node.get("state").as_str() != Some("OPEN"));
    let default_branch = repository.get("defaultBranchRef").get("name").as_str();
    for node in rows {
        let login = node.get("headRepositoryOwner").get("login").text();
        let name = node.get("headRefName").text();
        let label = if node.get("isCrossRepository").as_bool() == Some(true) {
            format!("{login}:{name}")
        } else {
            name.to_owned()
        };
        if label != head {
            continue;
        }
        if let Some(base) = &filter.base {
            if node.get("baseRefName").as_str() != Some(base.as_str()) {
                continue;
            }
        }
        if node.get("state").as_str() != Some("OPEN") && default_branch == Some(head) {
            continue;
        }
        if node.get("number").as_int().is_some() {
            return Ok(Some(node.clone()));
        }
    }
    Ok(None)
}

/// The selected fields of a repository's pull requests, as gh's
/// PullRequestList asks for them: newest first, a page of up to 100 at a
/// time until `limit`. A pull request a later page repeats is listed once.
pub(crate) async fn list_pull_request_fields(
    account: &Account,
    target: &RepoRef,
    filter: &PullListFilter,
    limit: i64,
    selection: &str,
) -> Result<Vec<Json>> {
    let query = format!("fragment pr on PullRequest{{{selection}}}\n{PULL_LIST}");
    let mut rows: Vec<Json> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    let mut page_limit = limit.min(100);
    while (rows.len() as i64) < limit {
        let mut variables = Obj::new();
        variables.set("owner", target.owner.as_str());
        variables.set("repo", target.repo.as_str());
        variables.set("limit", page_limit);
        variables.set(
            "state",
            Json::Arr(
                filter
                    .states
                    .iter()
                    .map(|state| Json::from(*state))
                    .collect(),
            ),
        );
        if let Some(base) = filter.base.as_deref().filter(|base| !base.is_empty()) {
            variables.set("baseBranch", base);
        }
        if let Some(head) = filter.head.as_deref().filter(|head| !head.is_empty()) {
            variables.set("headBranch", head);
        }
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, &query, variables).await?;
        let page = data.get("repository").get("pullRequests");
        for node in page.get("nodes").items() {
            if let Some(number) = node.get("number").as_int().filter(|number| *number > 0) {
                if !seen.insert(number) {
                    continue;
                }
            }
            rows.push(node.clone());
            if rows.len() as i64 == limit {
                break;
            }
        }
        let info = page.get("pageInfo");
        let following = info.get("endCursor").as_str().map(str::to_owned);
        if !info.get("hasNextPage").truthy() || following.is_none() || following == cursor {
            break;
        }
        cursor = following;
        page_limit = page_limit.min(limit - rows.len() as i64);
    }
    Ok(rows)
}

const PULL_SEARCH: &str = "\n\t\tquery PullRequestSearch(\n\t\t\t$q: String!,\n\t\t\t$type: SearchType!,\n\t\t\t$limit: Int!,\n\t\t\t$endCursor: String,\n\t\t) {\n\t\t\tsearch(query: $q, type: $type, first: $limit, after: $endCursor) {\n\t\t\t\tissueCount\n\t\t\t\tnodes {\n\t\t\t\t\t...pr\n\t\t\t\t}\n\t\t\t\tpageInfo {\n\t\t\t\t\thasNextPage\n\t\t\t\t\tendCursor\n\t\t\t\t}\n\t\t\t}\n\t\t}";

/// The selected fields of the pull requests a query finds, as gh's
/// PullRequestSearch asks for them. A pull request a later page repeats
/// is listed once.
pub(crate) async fn search_pull_request_fields(
    account: &Account,
    query_text: &str,
    limit: i64,
    selection: &str,
    search_type: &str,
) -> Result<Vec<Json>> {
    let query = format!("fragment pr on PullRequest{{{selection}}}{PULL_SEARCH}");
    let mut rows: Vec<Json> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    let mut page_limit = limit.min(100);
    loop {
        let mut variables = Obj::new();
        variables.set("q", query_text);
        variables.set("type", search_type);
        variables.set("limit", page_limit);
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, &query, variables).await?;
        let page = data.get("search");
        for node in page.get("nodes").items() {
            if let Some(number) = node.get("number").as_int().filter(|number| *number > 0) {
                if !seen.insert(number) {
                    continue;
                }
            }
            rows.push(node.clone());
            if rows.len() as i64 == limit {
                return Ok(rows);
            }
        }
        let info = page.get("pageInfo");
        if page.get("nodes").items().is_empty() || !info.get("hasNextPage").truthy() {
            return Ok(rows);
        }
        cursor = info.get("endCursor").as_str().map(str::to_owned);
        page_limit = page_limit.min(limit - rows.len() as i64);
    }
}

pub(crate) async fn diff_pull(
    account: &Account,
    target: &RepoRef,
    number: i128,
    patch: bool,
) -> Result<String> {
    let media = if patch { "patch" } else { "diff" };
    let headers = [(
        "Accept".to_owned(),
        format!("application/vnd.github.v3.{media}"),
    )];
    let value = github_request_response(
        account,
        "GET",
        &path(target, &format!("/{number}")),
        None,
        &[],
        &headers,
    )
    .await?
    .data
    .into_json();
    Ok(value.text().to_owned())
}

const STATUS_CHECKS: &str = "\n\tquery PullRequestStatusChecks($id: ID!, $endCursor: String) {\n\t\tnode(id: $id) {\n\t\t\t...on PullRequest {\n\t\t\t\tstatusCheckRollup: commits(last: 1) {nodes {commit {statusCheckRollup {contexts(first:100,after:$endCursor) {nodes {__typename...on StatusContext {context,state,targetUrl,createdAt,description,isRequired(pullRequestId: $id)},...on CheckRun {name,checkSuite{workflowRun{event,workflow{name}}},status,conclusion,startedAt,completedAt,detailsUrl,isRequired(pullRequestId: $id)}},pageInfo{hasNextPage,endCursor}}}}}}\n\t\t\t}\n\t\t}\n\t}";

/// A pull request's head commit checks, every page, as gh's
/// populateStatusChecks reads them.
pub(crate) async fn status_contexts(
    account: &Account,
    id: &str,
    branch: &str,
) -> Result<Vec<Json>> {
    let mut contexts = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut variables = Obj::new();
        variables.set("id", id);
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, STATUS_CHECKS, variables).await?;
        let commits = data
            .get("node")
            .get("statusCheckRollup")
            .get("nodes")
            .items();
        let Some(commit) = commits.first() else {
            return value("no commit found on the pull request");
        };
        let page = commit
            .get("commit")
            .get("statusCheckRollup")
            .get("contexts");
        contexts.extend(page.get("nodes").items().iter().cloned());
        let info = page.get("pageInfo");
        if !info.get("hasNextPage").truthy() {
            break;
        }
        cursor = info.get("endCursor").as_str().map(str::to_owned);
    }
    if contexts.is_empty() {
        return value(format!("no checks reported on the '{branch}' branch"));
    }
    Ok(contexts)
}

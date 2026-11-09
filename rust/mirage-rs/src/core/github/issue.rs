// The calls in gh 2.85.0's api package and pkg/cmd/issue (MIT; see
// licenses/third_party/gh.txt).

use super::client::{Account, GRAPHQL_PATH, Result, github_request, value};
use super::json::{Json, Obj};
use super::repo::{RepoRef, graphql_data};

const COMMENTS_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      ... on Issue {
        comments(first: 100, after: $cursor) {
          nodes { ...CommentFields }
          pageInfo { hasNextPage endCursor }
        }
      }
      ... on PullRequest {
        comments(first: 100, after: $cursor) {
          nodes { ...CommentFields }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}
fragment CommentFields on IssueComment {
  id
  author { login }
  authorAssociation
  body
  createdAt
  includesCreatedEdit
  isMinimized
  minimizedReason
  reactionGroups { content users { totalCount } }
  url
  viewerDidAuthor
}
"#;

const ISSUE_ONLY: &str = "query IssueProjectItems($owner: String!, $repo: String!, $number: Int!) {\n  repository(owner: $owner, name: $repo) {\n    issue(number: $number) { id }\n  }\n}";

/// gh reads project items through `issue(number:)`, which a pull
/// request's number does not resolve.
pub(crate) async fn require_issue(account: &Account, target: &RepoRef, number: i128) -> Result<()> {
    let mut variables = Obj::new();
    variables.set("owner", target.owner.as_str());
    variables.set("repo", target.repo.as_str());
    variables.set("number", number);
    graphql_data(account, ISSUE_ONLY, variables)
        .await
        .map(|_| ())
}

pub(crate) async fn issue_comments(
    account: &Account,
    target: &RepoRef,
    number: i128,
) -> Result<Vec<Json>> {
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut variables = Obj::new();
        variables.set("owner", target.owner.as_str());
        variables.set("repo", target.repo.as_str());
        variables.set("number", number);
        variables.set("cursor", cursor.as_ref().map_or(Json::Null, Json::from));
        let mut body = Obj::new();
        body.set("query", COMMENTS_QUERY);
        body.set("variables", variables);
        let response =
            github_request(account, "POST", GRAPHQL_PATH, Some(&Json::Obj(body))).await?;
        if response.as_obj().is_none() {
            return value("Invalid GitHub comments response");
        }
        let errors = response.get("errors").items();
        if !errors.is_empty() {
            let messages: Vec<String> = errors
                .iter()
                .map(|error| error.get("message").show())
                .collect();
            return value(messages.join("; "));
        }
        let comments = response
            .get("data")
            .get("repository")
            .get("issueOrPullRequest")
            .get("comments");
        if comments.is_null() {
            return value("Could not resolve comments for this issue or pull request");
        }
        rows.extend(comments.get("nodes").items().iter().cloned());
        let page = comments.get("pageInfo");
        if !page.get("hasNextPage").truthy() {
            return Ok(rows);
        }
        let next = page.get("endCursor").as_str().map(str::to_owned);
        if next.as_deref().unwrap_or("").is_empty() || next == cursor {
            return value("GitHub returned a non-advancing comments cursor");
        }
        cursor = next;
    }
}

/// The selection for each half of gh's IssueByNumber; an empty one is
/// left out.
pub(crate) struct IssueSelections {
    pub(crate) issue: String,
    pub(crate) pull: String,
}

/// The selected fields of one issue, as gh's IssueByNumber asks for
/// them: the number read as an issue or as a pull request.
pub(crate) async fn issue_fields(
    account: &Account,
    target: &RepoRef,
    number: i128,
    selections: &IssueSelections,
    end_cursor: Option<&str>,
) -> Result<Obj> {
    let mut variables = Obj::new();
    variables.set("owner", target.owner.as_str());
    variables.set("repo", target.repo.as_str());
    variables.set("number", number);
    if let Some(cursor) = end_cursor {
        variables.set("endCursor", cursor);
    }
    let cursor = if end_cursor.is_none() {
        ""
    } else {
        ", $endCursor: String"
    };
    let mut halves = String::new();
    if !selections.issue.is_empty() {
        halves.push_str(&format!("\n        ...on Issue{{{}}}", selections.issue));
    }
    if !selections.pull.is_empty() {
        halves.push_str(&format!(
            "\n        ...on PullRequest{{{}}}",
            selections.pull
        ));
    }
    let data = graphql_data(
        account,
        &format!(
            "query IssueByNumber($owner: String!, $repo: String!, $number: Int!{cursor}) {{\n    repository(owner: $owner, name: $repo) {{\n      hasIssuesEnabled\n      issue: issueOrPullRequest(number: $number) {{\n        __typename{halves}\n      }}\n    }}\n  }}"
        ),
        variables,
    )
    .await?;
    let repository = data.get("repository");
    if let Some(issue) = repository.get("issue").as_obj() {
        return Ok(issue.clone());
    }
    if repository.get("hasIssuesEnabled").as_bool() == Some(false) {
        return value(format!(
            "the '{}/{}' repository has disabled issues",
            target.owner, target.repo
        ));
    }
    value("issue was not found but GraphQL reported no error")
}

/// The narrowing `gh issue list` applies before it lists.
pub(crate) struct IssueListFilter {
    pub(crate) states: Vec<&'static str>,
    pub(crate) assignee: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) mention: Option<String>,
}

const ISSUE_LIST: &str = "\tquery IssueList($owner: String!, $repo: String!, $limit: Int, $endCursor: String, $states: [IssueState!] = OPEN, $assignee: String, $author: String, $mention: String) {\n\t\trepository(owner: $owner, name: $repo) {\n\t\t\thasIssuesEnabled\n\t\t\tissues(first: $limit, after: $endCursor, orderBy: {field: CREATED_AT, direction: DESC}, states: $states, filterBy: {assignee: $assignee, createdBy: $author, mentioned: $mention}) {\n\t\t\t\ttotalCount\n\t\t\t\tnodes {\n\t\t\t\t\t...issue\n\t\t\t\t}\n\t\t\t\tpageInfo {\n\t\t\t\t\thasNextPage\n\t\t\t\t\tendCursor\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n\t";

/// The selected fields of a repository's issues, as gh's IssueList asks
/// for them: newest first, a page of up to 100 at a time until `limit`.
pub(crate) async fn list_issue_fields(
    account: &Account,
    target: &RepoRef,
    filter: &IssueListFilter,
    limit: i64,
    selection: &str,
) -> Result<Vec<Json>> {
    let query = format!("fragment issue on Issue {{{selection}}}\n{ISSUE_LIST}");
    let mut rows: Vec<Json> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut page_limit = limit.min(100);
    while (rows.len() as i64) < limit {
        let mut variables = Obj::new();
        variables.set("owner", target.owner.as_str());
        variables.set("repo", target.repo.as_str());
        variables.set(
            "states",
            Json::Arr(
                filter
                    .states
                    .iter()
                    .map(|state| Json::from(*state))
                    .collect(),
            ),
        );
        variables.set("limit", page_limit);
        if let Some(assignee) = filter.assignee.as_deref().filter(|name| !name.is_empty()) {
            variables.set("assignee", assignee);
        }
        if let Some(author) = filter.author.as_deref().filter(|name| !name.is_empty()) {
            variables.set("author", author);
        }
        if let Some(mention) = filter.mention.as_deref().filter(|name| !name.is_empty()) {
            variables.set("mention", mention);
        }
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, &query, variables).await?;
        let repository = data.get("repository");
        if repository.get("hasIssuesEnabled").as_bool() == Some(false) {
            return value(format!(
                "the '{}/{}' repository has disabled issues",
                target.owner, target.repo
            ));
        }
        let page = repository.get("issues");
        for node in page.get("nodes").items() {
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

const ISSUE_SEARCH: &str = "query IssueSearch($repo: String!, $owner: String!, $type: SearchType!, $limit: Int, $after: String, $query: String!) {\n\t\t\trepository(name: $repo, owner: $owner) {\n\t\t\t\thasIssuesEnabled\n\t\t\t}\n\t\t\tsearch(type: $type, last: $limit, after: $after, query: $query) {\n\t\t\t\tissueCount\n\t\t\t\tnodes { ...issue }\n\t\t\t\tpageInfo {\n\t\t\t\t\thasNextPage\n\t\t\t\t\tendCursor\n\t\t\t\t}\n\t\t\t}\n\t\t}";

/// The selected fields of the issues a query finds, as gh's IssueSearch
/// asks for them.
pub(crate) async fn search_issue_fields(
    account: &Account,
    target: &RepoRef,
    query_text: &str,
    limit: i64,
    selection: &str,
    search_type: &str,
) -> Result<Vec<Json>> {
    let query = format!("fragment issue on Issue {{{selection}}}{ISSUE_SEARCH}");
    let mut rows: Vec<Json> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut variables = Obj::new();
        variables.set("owner", target.owner.as_str());
        variables.set("repo", target.repo.as_str());
        variables.set("limit", limit.min(100));
        variables.set("query", query_text);
        variables.set("type", search_type);
        if let Some(cursor) = &cursor {
            variables.set("after", cursor);
        }
        let data = graphql_data(account, &query, variables).await?;
        if data.get("repository").get("hasIssuesEnabled").as_bool() == Some(false) {
            return value(format!(
                "the '{}/{}' repository has disabled issues",
                target.owner, target.repo
            ));
        }
        let page = data.get("search");
        for node in page.get("nodes").items() {
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
    }
}

/// A milestone's title, from its number.
pub(crate) async fn milestone_title(
    account: &Account,
    target: &RepoRef,
    number: i64,
) -> Result<String> {
    let mut variables = Obj::new();
    variables.set("owner", target.owner.as_str());
    variables.set("name", target.repo.as_str());
    variables.set("number", number);
    let data = graphql_data(
        account,
        "query RepositoryMilestoneByNumber($name:String!$number:Int!$owner:String!){repository(owner: $owner, name: $name){milestone(number: $number){id,title}}}",
        variables,
    )
    .await?;
    match data
        .get("repository")
        .get("milestone")
        .get("title")
        .as_str()
    {
        Some(title) => Ok(title.to_owned()),
        None => value(format!("no milestone found with number '{number}'")),
    }
}

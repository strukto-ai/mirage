// Values from gh 2.85.0, go-gh v2.13.0, gojq v0.12.17 and Go 1.25.5
// (MIT, MIT, MIT and BSD-3-Clause; see gh.txt, go-gh.txt, gojq.txt and
// go.txt in licenses/third_party/).

pub(crate) const API_BASE: &str = "https://api.github.com";
pub(crate) const GITHUB_HOST: &str = "github.com";
pub(crate) const INVALID_LIMIT: &str = "invalid limit";
pub(crate) const PR_INVALID_LIMIT: &str = "invalid value for --limit";
pub(crate) const SEARCH_CAPPED: &str =
    "warning: this query uses the Search API which is capped at 1000 results maximum\n";
pub(crate) const CONNECT_HINT: &str = "check your internet connection or https://githubstatus.com";

const ISSUE_PR_FLAGS: [&str; 28] = [
    "app",
    "archived",
    "assignee",
    "author",
    "closed",
    "commenter",
    "comments",
    "created",
    "interactions",
    "involves",
    "label",
    "language",
    "locked",
    "match",
    "mentions",
    "milestone",
    "no-assignee",
    "no-label",
    "no-milestone",
    "no-project",
    "owner",
    "project",
    "reactions",
    "repo",
    "state",
    "team-mentions",
    "updated",
    "visibility",
];

const PR_FLAGS: [&str; 9] = [
    "base",
    "checks",
    "draft",
    "head",
    "merged",
    "merged-at",
    "review",
    "review-requested",
    "reviewed-by",
];

const REPO_FLAGS: [&str; 17] = [
    "archived",
    "created",
    "followers",
    "forks",
    "good-first-issues",
    "help-wanted-issues",
    "include-forks",
    "language",
    "license",
    "match",
    "number-topics",
    "owner",
    "size",
    "stars",
    "topic",
    "updated",
    "visibility",
];

const CODE_FLAGS: [&str; 7] = [
    "extension",
    "filename",
    "language",
    "match",
    "owner",
    "repo",
    "size",
];

const COMMIT_FLAGS: [&str; 15] = [
    "author",
    "author-date",
    "author-email",
    "author-name",
    "committer",
    "committer-date",
    "committer-email",
    "committer-name",
    "hash",
    "merge",
    "owner",
    "parent",
    "repo",
    "tree",
    "visibility",
];

/// The search flags of a kind: every one a qualifier may come from.
pub(crate) fn search_flags(kind: &str) -> Vec<&'static str> {
    match kind {
        "issues" => {
            let mut flags = ISSUE_PR_FLAGS.to_vec();
            flags.push("include-prs");
            flags
        }
        "prs" => {
            let mut flags = ISSUE_PR_FLAGS.to_vec();
            flags.extend_from_slice(&PR_FLAGS);
            flags
        }
        "repos" => REPO_FLAGS.to_vec(),
        "code" => CODE_FLAGS.to_vec(),
        _ => COMMIT_FLAGS.to_vec(),
    }
}

pub(crate) const SEARCH_MULTIPLE: [&str; 7] = [
    "label",
    "match",
    "owner",
    "repo",
    "visibility",
    "license",
    "topic",
];

pub(crate) const SEARCH_BOOLEAN: [&str; 10] = [
    "archived",
    "draft",
    "merge",
    "locked",
    "merged",
    "include-prs",
    "no-assignee",
    "no-label",
    "no-milestone",
    "no-project",
];

pub(crate) fn search_alias(name: &str) -> &str {
    match name {
        "owner" => "user",
        "match" => "in",
        "visibility" => "is",
        "team-mentions" => "team",
        "checks" => "status",
        "merged-at" => "merged",
        "number-topics" => "topics",
        "include-forks" => "fork",
        other => other,
    }
}

pub(crate) fn search_sorted(kind: &str) -> bool {
    matches!(kind, "issues" | "prs" | "repos" | "commits")
}

const ISSUE_PR_FIELDS: [&str; 17] = [
    "assignees",
    "author",
    "authorAssociation",
    "body",
    "closedAt",
    "commentsCount",
    "createdAt",
    "id",
    "isLocked",
    "isPullRequest",
    "labels",
    "number",
    "repository",
    "state",
    "title",
    "updatedAt",
    "url",
];

const REPO_SEARCH_FIELDS: [&str; 28] = [
    "createdAt",
    "defaultBranch",
    "description",
    "forksCount",
    "fullName",
    "hasDownloads",
    "hasIssues",
    "hasPages",
    "hasProjects",
    "hasWiki",
    "homepage",
    "id",
    "isArchived",
    "isDisabled",
    "isFork",
    "isPrivate",
    "language",
    "license",
    "name",
    "openIssuesCount",
    "owner",
    "pushedAt",
    "size",
    "stargazersCount",
    "updatedAt",
    "url",
    "visibility",
    "watchersCount",
];

pub(crate) fn search_fields(kind: &str) -> Vec<&'static str> {
    match kind {
        "issues" => ISSUE_PR_FIELDS.to_vec(),
        "prs" => {
            let mut fields = ISSUE_PR_FIELDS.to_vec();
            fields.push("isDraft");
            fields
        }
        "repos" => REPO_SEARCH_FIELDS.to_vec(),
        "code" => vec!["path", "repository", "sha", "textMatches", "url"],
        _ => vec![
            "author",
            "commit",
            "committer",
            "sha",
            "id",
            "parents",
            "repository",
            "url",
        ],
    }
}

/// The fields gh's search result types decode: each one's exported name,
/// its key in the response, and its Go type.
pub(crate) fn search_shape(kind: &str) -> &'static [(&'static str, &'static str, &'static str)] {
    match kind {
        "Repository" => &[
            ("createdAt", "created_at", "time.Time"),
            ("defaultBranch", "default_branch", "string"),
            ("description", "description", "string"),
            ("forksCount", "forks_count", "int"),
            ("fullName", "full_name", "string"),
            ("hasDownloads", "has_downloads", "bool"),
            ("hasIssues", "has_issues", "bool"),
            ("hasPages", "has_pages", "bool"),
            ("hasProjects", "has_projects", "bool"),
            ("hasWiki", "has_wiki", "bool"),
            ("homepage", "homepage", "string"),
            ("id", "node_id", "string"),
            ("isArchived", "archived", "bool"),
            ("isDisabled", "disabled", "bool"),
            ("isFork", "fork", "bool"),
            ("isPrivate", "private", "bool"),
            ("language", "language", "string"),
            ("license", "license", "License"),
            ("masterBranch", "master_branch", "string"),
            ("name", "name", "string"),
            ("openIssuesCount", "open_issues_count", "int"),
            ("owner", "owner", "User"),
            ("pushedAt", "pushed_at", "time.Time"),
            ("size", "size", "int"),
            ("stargazersCount", "stargazers_count", "int"),
            ("url", "html_url", "string"),
            ("updatedAt", "updated_at", "time.Time"),
            ("visibility", "visibility", "string"),
            ("watchersCount", "watchers_count", "int"),
        ],
        "User" => &[
            ("gravatarID", "gravatar_id", "string"),
            ("id", "node_id", "string"),
            ("login", "login", "string"),
            ("siteAdmin", "site_admin", "bool"),
            ("type", "type", "string"),
            ("url", "html_url", "string"),
        ],
        "CommitInfo" => &[
            ("author", "author", "CommitUser"),
            ("commentCount", "comment_count", "int"),
            ("committer", "committer", "CommitUser"),
            ("message", "message", "string"),
            ("tree", "tree", "Tree"),
        ],
        "CommitUser" => &[
            ("date", "date", "time.Time"),
            ("email", "email", "string"),
            ("name", "name", "string"),
        ],
        "Tree" => &[("sha", "sha", "string")],
        "Parent" => &[("sha", "sha", "string"), ("url", "html_url", "string")],
        "License" => &[
            ("key", "key", "string"),
            ("name", "name", "string"),
            ("url", "url", "string"),
        ],
        "Label" => &[
            ("color", "color", "string"),
            ("description", "description", "string"),
            ("id", "node_id", "string"),
            ("name", "name", "string"),
        ],
        "Issue" => &[
            ("assignees", "assignees", "[]User"),
            ("author", "user", "User"),
            ("authorAssociation", "author_association", "string"),
            ("body", "body", "string"),
            ("closedAt", "closed_at", "time.Time"),
            ("commentsCount", "comments", "int"),
            ("createdAt", "created_at", "time.Time"),
            ("id", "node_id", "string"),
            ("labels", "labels", "[]Label"),
            ("isDraft", "draft", "*bool"),
            ("isLocked", "locked", "bool"),
            ("number", "number", "int"),
            ("pullRequest", "pull_request", "PullRequest"),
            ("repositoryURL", "repository_url", "string"),
            ("stateInternal", "state", "string"),
            ("stateReason", "state_reason", "string"),
            ("title", "title", "string"),
            ("url", "html_url", "string"),
            ("updatedAt", "updated_at", "time.Time"),
        ],
        "Code" => &[
            ("name", "name", "string"),
            ("path", "path", "string"),
            ("repository", "repository", "Repository"),
            ("sha", "sha", "string"),
            ("textMatches", "text_matches", "[]TextMatch"),
            ("url", "html_url", "string"),
        ],
        "Commit" => &[
            ("author", "author", "User"),
            ("committer", "committer", "User"),
            ("id", "node_id", "string"),
            ("info", "commit", "CommitInfo"),
            ("parents", "parents", "[]Parent"),
            ("repo", "repository", "Repository"),
            ("sha", "sha", "string"),
            ("url", "html_url", "string"),
        ],
        _ => &[],
    }
}

/// The builtins gojq writes in jq, each with jq's message and the one
/// gojq raises.
pub(crate) fn gojq_raised(text: &str) -> Option<&'static str> {
    match text {
        "limit doesn't support negative count" => Some("limit doesn't support negative count"),
        "skip doesn't support negative count" => Some("skip doesn't support negative count"),
        "nth doesn't support negative indices" => Some("nth doesn't support negative index"),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum EditKind {
    Value,
    Toggle,
    Security,
}

/// `gh repo edit`'s settings: the flag's dest, the API field and how it
/// is sent.
pub(crate) const REPO_EDIT_FIELDS: [(&str, &str, EditKind); 19] = [
    ("description", "description", EditKind::Value),
    ("homepage", "homepage", EditKind::Value),
    ("default_branch", "default_branch", EditKind::Value),
    ("visibility", "visibility", EditKind::Value),
    ("template", "is_template", EditKind::Toggle),
    ("enable_issues", "has_issues", EditKind::Toggle),
    ("enable_projects", "has_projects", EditKind::Toggle),
    ("enable_wiki", "has_wiki", EditKind::Toggle),
    ("enable_discussions", "has_discussions", EditKind::Toggle),
    (
        "enable_merge_commit",
        "allow_merge_commit",
        EditKind::Toggle,
    ),
    (
        "enable_squash_merge",
        "allow_squash_merge",
        EditKind::Toggle,
    ),
    (
        "enable_rebase_merge",
        "allow_rebase_merge",
        EditKind::Toggle,
    ),
    ("enable_auto_merge", "allow_auto_merge", EditKind::Toggle),
    (
        "enable_advanced_security",
        "advanced_security",
        EditKind::Security,
    ),
    (
        "enable_secret_scanning",
        "secret_scanning",
        EditKind::Security,
    ),
    (
        "enable_secret_scanning_push_protection",
        "secret_scanning_push_protection",
        EditKind::Security,
    ),
    (
        "delete_branch_on_merge",
        "delete_branch_on_merge",
        EditKind::Toggle,
    ),
    ("allow_forking", "allow_forking", EditKind::Toggle),
    (
        "allow_update_branch",
        "allow_update_branch",
        EditKind::Toggle,
    ),
];

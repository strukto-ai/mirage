// Repository arguments are read as go-gh v2.13.0 reads them (MIT; see
// licenses/third_party/go-gh.txt).

use super::client::{Account, Failure, GRAPHQL_PATH, Result, decode_base64, github_request, value};
use super::json::{Json, Obj};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RepoRef {
    pub(crate) owner: String,
    pub(crate) repo: String,
}

const URL_PREFIXES: [&str; 7] = [
    "git@",
    "ssh:",
    "git+ssh:",
    "git:",
    "http:",
    "git+https:",
    "https:",
];
const PROTOCOLS: [&str; 9] = [
    "ssh:",
    "git+ssh:",
    "git:",
    "http:",
    "git+https:",
    "https:",
    "ftp:",
    "ftps:",
    "file:",
];

/// A URL's parts, split as Python's `urlsplit` splits one.
#[derive(Debug, Default)]
pub(crate) struct Split {
    pub(crate) scheme: String,
    pub(crate) netloc: String,
    pub(crate) path: String,
    pub(crate) query: String,
}

const SCHEME: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

pub(crate) fn urlsplit(raw: &str) -> Option<Split> {
    let cleaned: String = raw
        .trim_start_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\r' | '\n'))
        .collect();
    let mut url = cleaned.as_str();
    let mut split = Split::default();
    if let Some(at) = url.find(':') {
        let head = &url[..at];
        if at > 0
            && head.starts_with(|c: char| c.is_ascii_alphabetic())
            && head.chars().all(|c| SCHEME.contains(c))
        {
            split.scheme = head.to_ascii_lowercase();
            url = &url[at + 1..];
        }
    }
    if let Some(rest) = url.strip_prefix("//") {
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        split.netloc = rest[..end].to_owned();
        url = &rest[end..];
        if split.netloc.contains('[') != split.netloc.contains(']') {
            return None;
        }
    }
    let url = url.split_once('#').map_or(url, |(head, _)| head);
    match url.split_once('?') {
        Some((path, query)) => {
            split.path = path.to_owned();
            split.query = query.to_owned();
        }
        None => split.path = url.to_owned(),
    }
    Some(split)
}

impl Split {
    pub(crate) fn hostname(&self) -> Option<String> {
        let info = self
            .netloc
            .rsplit_once('@')
            .map_or(self.netloc.as_str(), |(_, tail)| tail);
        let host = match info.split_once('[') {
            Some((_, bracketed)) => bracketed.split(']').next().unwrap_or(""),
            None => info.split(':').next().unwrap_or(""),
        };
        (!host.is_empty()).then(|| host.to_lowercase())
    }
}

fn starts_any(text: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|prefix| text.starts_with(prefix))
}

fn url_of(spec: &str) -> Result<(String, String, String)> {
    let raw = if !starts_any(spec, &PROTOCOLS) && spec.contains(':') && !spec.contains('\\') {
        format!("ssh://{}", spec.replacen(':', "/", 1))
    } else {
        spec.to_owned()
    };
    let url = urlsplit(&raw);
    match url.as_ref().and_then(Split::hostname) {
        Some(host) => {
            let url = url.unwrap_or_default();
            Ok((url.scheme, host, url.path))
        }
        None => value("no hostname detected"),
    }
}

/// The host a repository argument names, None for `OWNER/REPO`.
pub(crate) fn repo_host(spec: &str) -> Result<Option<String>> {
    if starts_any(spec, &URL_PREFIXES) {
        return Ok(Some(url_of(spec)?.1));
    }
    let parts: Vec<&str> = spec.split('/').collect();
    Ok((parts.len() == 3).then(|| parts[0].to_lowercase()))
}

fn repo_from_url(spec: &str) -> Result<RepoRef> {
    let (scheme, _host, path) = url_of(spec)?;
    let path = if scheme == "ssh" && path.starts_with("//") {
        path[1..].to_owned()
    } else {
        path
    };
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if parts.len() != 2 {
        return value(format!("invalid path: {path}"));
    }
    Ok(RepoRef {
        owner: parts[0].to_owned(),
        repo: parts[1].strip_suffix(".git").unwrap_or(parts[1]).to_owned(),
    })
}

/// A repository named by URL or as `[HOST/]OWNER/REPO`: the host is
/// optional and leading, so the owner and the repository are always the
/// last two segments.
pub(crate) fn parse_repo(spec: &str) -> Result<RepoRef> {
    if starts_any(spec, &URL_PREFIXES) {
        return repo_from_url(spec);
    }
    let parts: Vec<&str> = spec.split('/').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|part| part.is_empty()) {
        return value(format!(
            r#"expected the "[HOST/]OWNER/REPO" format, got "{spec}""#
        ));
    }
    Ok(RepoRef {
        owner: parts[parts.len() - 2].to_owned(),
        repo: parts[parts.len() - 1].to_owned(),
    })
}

/// One mutation as gh's GraphQL client writes it, its answer's data.
pub(crate) async fn mutate(
    account: &Account,
    operation: &str,
    input_type: &str,
    call: &str,
    selection: &str,
    input: Obj,
) -> Result<Obj> {
    let mut variables = Obj::new();
    variables.set("input", input);
    graphql_data(
        account,
        &format!(
            "mutation {operation}($input:{input_type}!){{{call}(input: $input){{{selection}}}}}"
        ),
        variables,
    )
    .await
}

/// The login `@me` stands for, as gh's CurrentLoginName asks.
pub(crate) async fn current_login(account: &Account) -> Result<String> {
    let data = graphql_data(account, "query UserCurrent{viewer{login}}", Obj::new()).await?;
    Ok(data.get("viewer").get("login").text().to_owned())
}

const GITHUB_REPO: &str = "\n\tfragment repo on Repository {\n\t\tid\n\t\tname\n\t\towner { login }\n\t\thasIssuesEnabled\n\t\tdescription\n\t\thasWikiEnabled\n\t\tviewerPermission\n\t\tdefaultBranchRef {\n\t\t\tname\n\t\t}\n\t}\n\n\tquery RepositoryInfo($owner: String!, $name: String!) {\n\t\trepository(owner: $owner, name: $name) {\n\t\t\t...repo\n\t\t\tparent {\n\t\t\t\t...repo\n\t\t\t}\n\t\t\tmergeCommitAllowed\n\t\t\trebaseMergeAllowed\n\t\t\tsquashMergeAllowed\n\t\t}\n\t}";

/// A repository as gh's GitHubRepo reads it, an unresolved name its error.
pub(crate) async fn github_repo(account: &Account, target: &RepoRef) -> Result<Obj> {
    let mut variables = Obj::new();
    variables.set("owner", target.owner.as_str());
    variables.set("name", target.repo.as_str());
    let data = graphql_data(account, GITHUB_REPO, variables).await?;
    match data.get("repository").as_obj() {
        Some(found) => Ok(found.clone()),
        None => missing_repository(target),
    }
}

fn missing_repository<T>(target: &RepoRef) -> Result<T> {
    value(format!(
        "GraphQL: Could not resolve to a Repository with the name '{}/{}'.",
        target.owner, target.repo
    ))
}

pub(crate) async fn view_repo(account: &Account, target: &RepoRef) -> Result<Json> {
    github_request(
        account,
        "GET",
        &format!("/repos/{}/{}", target.owner, target.repo),
        None,
    )
    .await
}

/// One GraphQL query's data, refused the way gh refuses it: each error
/// with the path of the field that raised it.
/// Whether gh builds `query` from a struct: its client writes the header
/// with no space or comma, where a hand-written query has them.
fn built_from_struct(query: &str) -> bool {
    let head = query.trim_start().split('{').next().unwrap_or("");
    head.split_once(' ')
        .is_some_and(|(_, rest)| !rest.contains([' ', ',', '\n', '\t']))
}

fn marked_built(failure: Failure, query: &str) -> Failure {
    match failure {
        Failure::Api(mut error) => {
            error.built_query = built_from_struct(query);
            Failure::Api(error)
        }
        other => other,
    }
}

pub(crate) async fn graphql_data(account: &Account, query: &str, variables: Obj) -> Result<Obj> {
    let mut body = Obj::new();
    body.set("query", query);
    if !variables.is_empty() {
        body.set("variables", variables);
    }
    let response = github_request(account, "POST", GRAPHQL_PATH, Some(&Json::Obj(body)))
        .await
        .map_err(|failure| marked_built(failure, query))?;
    let errors = response.get("errors").items();
    if !errors.is_empty() {
        let messages: Vec<String> = errors
            .iter()
            .map(|error| {
                let path: Vec<String> = error.get("path").items().iter().map(Json::show).collect();
                let message = error.get("message").show();
                if path.is_empty() {
                    message
                } else {
                    format!("{message} ({})", path.join("."))
                }
            })
            .collect();
        return value(format!("GraphQL: {}", messages.join(", ")));
    }
    Ok(response.get("data").as_obj().cloned().unwrap_or_default())
}

pub(crate) async fn repository_fields(
    account: &Account,
    target: &RepoRef,
    selection: &str,
) -> Result<Obj> {
    let mut variables = Obj::new();
    variables.set("owner", target.owner.as_str());
    variables.set("name", target.repo.as_str());
    let data = graphql_data(
        account,
        &format!(
            "query RepositoryInfo($owner: String!, $name: String!) {{\n    repository(owner: $owner, name: $name) {{{selection}}}\n  }}"
        ),
        variables,
    )
    .await?;
    match data.get("repository").as_obj() {
        Some(found) => Ok(found.clone()),
        None => missing_repository(target),
    }
}

/// An owner's repositories, most recently pushed first, no owner being
/// the viewer, with the login the owner resolved to.
pub(crate) async fn list_repository_fields(
    account: &Account,
    owner: Option<&str>,
    limit: i64,
    selection: &str,
) -> Result<(Vec<Json>, String)> {
    let head = if owner.is_none() {
        "query RepositoryList($perPage:Int!,$endCursor:String,$privacy:RepositoryPrivacy,$fork:Boolean) {\n    repositoryOwner: viewer {"
    } else {
        "query RepositoryList($perPage:Int!,$endCursor:String,$privacy:RepositoryPrivacy,$fork:Boolean,$owner:String!) {\n    repositoryOwner(login: $owner) {"
    };
    let query = format!(
        "{head}\n      login\n      repositories(first: $perPage, after: $endCursor, privacy: $privacy, isFork: $fork, ownerAffiliations: OWNER, orderBy: {{ field: PUSHED_AT, direction: DESC }}) {{\n        nodes{{{selection}}}\n        totalCount\n        pageInfo{{hasNextPage,endCursor}}\n      }}\n    }}\n  }}"
    );
    let mut rows = Vec::new();
    let mut resolved = String::new();
    let mut cursor: Option<String> = None;
    while (rows.len() as i64) < limit {
        let mut variables = Obj::new();
        variables.set("perPage", limit.min(100));
        if let Some(owner) = owner {
            variables.set("owner", owner);
        }
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, &query, variables).await?;
        let found = data.get("repositoryOwner");
        resolved = found.get("login").text().to_owned();
        let page = found.get("repositories");
        rows.extend(page.get("nodes").items().iter().cloned());
        let info = page.get("pageInfo");
        let following = info.get("endCursor").as_str().map(str::to_owned);
        if !info.get("hasNextPage").truthy() || following.is_none() || following == cursor {
            break;
        }
        cursor = following;
    }
    rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    if owner.is_some() && resolved.is_empty() {
        return value(format!(
            "the owner handle {} was not recognized as either a GitHub user or an organization",
            super::json::quoted(owner.unwrap_or_default())
        ));
    }
    Ok((rows, resolved))
}

/// The README as text, None when the repository has none.
pub(crate) async fn read_readme(account: &Account, target: &RepoRef) -> Result<Option<String>> {
    let path = format!("/repos/{}/{}/readme", target.owner, target.repo);
    let data = match github_request(account, "GET", &path, None).await {
        Ok(data) => data,
        Err(Failure::Api(error)) if error.status == 404 => return Ok(None),
        Err(failure) => return Err(failure),
    };
    Ok(data
        .get("content")
        .as_str()
        .map(|content| String::from_utf8_lossy(&decode_base64(content)).into_owned()))
}

pub(crate) async fn fork_repo(account: &Account, target: &RepoRef, body: Obj) -> Result<Json> {
    github_request(
        account,
        "POST",
        &format!("/repos/{}/{}/forks", target.owner, target.repo),
        Some(&Json::Obj(body)),
    )
    .await
}

pub(crate) async fn edit_repo(account: &Account, target: &RepoRef, body: Obj) -> Result<Json> {
    github_request(
        account,
        "PATCH",
        &format!("/repos/{}/{}", target.owner, target.repo),
        Some(&Json::Obj(body)),
    )
    .await
}

pub(crate) async fn repo_topics(account: &Account, target: &RepoRef) -> Result<Vec<String>> {
    let data = github_request(
        account,
        "GET",
        &format!("/repos/{}/{}/topics", target.owner, target.repo),
        None,
    )
    .await?;
    Ok(data
        .get("names")
        .items()
        .iter()
        .filter_map(|name| name.as_str().map(str::to_owned))
        .collect())
}

pub(crate) async fn set_repo_topics(
    account: &Account,
    target: &RepoRef,
    names: &[String],
) -> Result<Json> {
    let mut body = Obj::new();
    body.set("names", names);
    github_request(
        account,
        "PUT",
        &format!("/repos/{}/{}/topics", target.owner, target.repo),
        Some(&Json::Obj(body)),
    )
    .await
}

pub(crate) async fn delete_repo(account: &Account, target: &RepoRef) -> Result<Json> {
    github_request(
        account,
        "DELETE",
        &format!("/repos/{}/{}", target.owner, target.repo),
        None,
    )
    .await
}

pub(crate) async fn rename_repo(account: &Account, target: &RepoRef, name: &str) -> Result<Json> {
    let mut body = Obj::new();
    body.set("name", name);
    edit_repo(account, target, body).await
}

const REPOSITORY_CREATE: &str = "\n\tmutation RepositoryCreate($input: CreateRepositoryInput!) {\n\t\tcreateRepository(input: $input) {\n\t\t\trepository {\n\t\t\t\tid\n\t\t\t\tname\n\t\t\t\towner { login }\n\t\t\t\turl\n\t\t\t}\n\t\t}\n\t}\n\t";

/// What `gh repo create` asks GitHub for.
pub(crate) struct NewRepo<'a> {
    pub(crate) name: &'a str,
    pub(crate) owner: Option<&'a str>,
    pub(crate) visibility: &'static str,
    pub(crate) description: Option<&'a str>,
    pub(crate) homepage: Option<&'a str>,
    pub(crate) has_issues: bool,
    pub(crate) has_wiki: bool,
    pub(crate) gitignore: Option<&'a str>,
    pub(crate) license: Option<&'a str>,
    pub(crate) add_readme: bool,
}

/// A new repository's URL, made as gh's repoCreate makes it: over REST
/// when GitHub has to write a first commit, otherwise over GraphQL.
pub(crate) async fn create_repo(account: &Account, new: &NewRepo<'_>) -> Result<String> {
    let found = match new.owner {
        Some(owner) => {
            Some(github_request(account, "GET", &format!("/users/{owner}"), None).await?)
        }
        None => None,
    };
    let org = found
        .as_ref()
        .is_some_and(|owner| owner.get("type").as_str() == Some("Organization"));
    if new.visibility == "INTERNAL" && !org {
        return value("internal repositories can only be created within an organization");
    }
    if new.gitignore.is_some() || new.license.is_some() || new.add_readme {
        let mut body = Obj::new();
        body.set("name", new.name);
        if let Some(homepage) = new.homepage {
            body.set("homepage", homepage);
        }
        if let Some(description) = new.description {
            body.set("description", description);
        }
        body.set("private", new.visibility == "PRIVATE");
        if org {
            body.set("visibility", new.visibility.to_lowercase());
        }
        body.set("has_issues", new.has_issues);
        body.set("has_wiki", new.has_wiki);
        if let Some(template) = new.gitignore {
            body.set("gitignore_template", template);
        }
        if let Some(template) = new.license {
            body.set("license_template", template);
        }
        if new.add_readme {
            body.set("auto_init", true);
        }
        let path = match new.owner {
            Some(owner) if org => format!("/orgs/{owner}/repos"),
            _ => "/user/repos".to_owned(),
        };
        let made = github_request(account, "POST", &path, Some(&Json::Obj(body))).await?;
        return Ok(made.get("html_url").text().to_owned());
    }
    let mut input = Obj::new();
    input.set("name", new.name);
    if let Some(description) = new.description {
        input.set("description", description);
    }
    if let Some(homepage) = new.homepage {
        input.set("homepageUrl", homepage);
    }
    input.set("visibility", new.visibility);
    if let Some(owner) = found
        .as_ref()
        .and_then(|owner| owner.get("node_id").as_str())
    {
        input.set("ownerId", owner);
    }
    input.set("hasIssuesEnabled", new.has_issues);
    input.set("hasWikiEnabled", new.has_wiki);
    let mut variables = Obj::new();
    variables.set("input", input);
    let data = graphql_data(account, REPOSITORY_CREATE, variables).await?;
    Ok(data
        .get("createRepository")
        .get("repository")
        .get("url")
        .text()
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_struct_built_query_is_told_by_its_header() {
        assert!(built_from_struct("query UserCurrent{viewer{login}}"));
        assert!(built_from_struct(
            "mutation IssueClose($input:CloseIssueInput!){closeIssue(input: $input){}}"
        ));
        assert!(built_from_struct("query L($a:String!$b:Int){x}"));
        assert!(!built_from_struct("query GetRepoIDs {x}"));
        assert!(!built_from_struct("query R($a:Int!,$b:String){x}"));
        assert!(!built_from_struct("\n\tquery I($owner: String!) {\n\tx}"));
        assert!(!built_from_struct("\n\tfragment repo on Repository {id}"));
    }

    fn named(owner: &str, repo: &str) -> RepoRef {
        RepoRef {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
        }
    }

    #[test]
    fn a_leading_host_is_not_the_owner() {
        assert_eq!(
            parse_repo("github.com/acme/tools").unwrap(),
            named("acme", "tools")
        );
        assert_eq!(parse_repo("acme/tools").unwrap(), named("acme", "tools"));
    }

    #[test]
    fn a_url_loses_its_git_suffix() {
        assert_eq!(
            parse_repo("https://github.com/acme/tools.git").unwrap(),
            named("acme", "tools")
        );
        assert_eq!(
            parse_repo("git@github.com:acme/tools.git").unwrap(),
            named("acme", "tools")
        );
    }

    #[test]
    fn anything_else_is_refused() {
        assert!(parse_repo("tools").is_err());
        assert!(parse_repo("a/b/c/d").is_err());
        assert!(parse_repo("a//c").is_err());
    }

    #[test]
    fn a_repository_names_its_host_only_when_it_has_three_parts() {
        assert_eq!(repo_host("a/b").unwrap(), None);
        assert_eq!(repo_host("GHE.io/a/b").unwrap().as_deref(), Some("ghe.io"));
        assert_eq!(
            repo_host("https://ghe.io/a/b").unwrap().as_deref(),
            Some("ghe.io")
        );
    }

    #[test]
    fn urlsplit_reads_what_python_reads() {
        let split = urlsplit("https://U@Host:8/a/b?x=1#f").unwrap();
        assert_eq!(split.scheme, "https");
        assert_eq!(split.hostname().as_deref(), Some("host"));
        assert_eq!(split.path, "/a/b");
        assert_eq!(split.query, "x=1");
        assert!(urlsplit("https://[::1/x").is_none());
    }
}

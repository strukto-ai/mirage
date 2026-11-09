// Follows gh 2.85.0's pkg/cmd/ruleset (MIT; see licenses/third_party/gh.txt).

use super::accessor::{Flags, Out, repo_for, tsv};
use crate::core::github::client::{Account, Failure, Result, github_request, quote, usage, value};
use crate::core::github::json::{Json, Obj};
use crate::core::github::repo::{RepoRef, graphql_data, view_repo};

const REPO_HEADER: &str = "\nquery RepoRulesetList($limit: Int!, $endCursor: String, $includeParents: Boolean, $owner: String!, $repo: String!) {\n\tlevel: repository(owner: $owner, name: $repo) {\n";
const ORG_HEADER: &str = "\nquery OrgRulesetList($limit: Int!, $endCursor: String, $includeParents: Boolean, $login: String!) {\n\tlevel: organization(login: $login) {\n";
const BODY: &str = "\nrulesets(first: $limit, after: $endCursor, includeParents: $includeParents) {\n\ttotalCount\n\tnodes {\n\t\tdatabaseId\n\t\tname\n\t\ttarget\n\t\tenforcement\n\t\tsource {\n\t\t\t__typename\n\t\t\t... on Repository { owner: nameWithOwner }\n\t\t\t... on Organization { owner: login }\n\t\t}\n\t\trules {\n\t\t\ttotalCount\n\t\t}\n\t}\n\tpageInfo {\n\t\thasNextPage\n\t\tendCursor\n\t}\n}}}";

fn source_name(node: &Json) -> String {
    let level = match node.get("source").get("__typename").as_str() {
        Some("Repository") => "repo",
        Some("Organization") => "org",
        _ => "unknown",
    };
    format!("{} ({level})", node.get("source").get("owner").text())
}

/// A value inside a rule's parameters as Go's `%v` prints it.
fn go_value(value: &Json) -> String {
    match value {
        Json::Str(text) => text.clone(),
        Json::Null => "<nil>".to_owned(),
        Json::Bool(flag) => flag.to_string(),
        Json::Arr(items) => format!(
            "[{}]",
            items.iter().map(go_value).collect::<Vec<_>>().join(" ")
        ),
        Json::Obj(obj) => {
            let mut pairs: Vec<&(String, Json)> = obj.iter().collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            let parts: Vec<String> = pairs
                .iter()
                .map(|(key, item)| format!("{key}:{}", go_value(item)))
                .collect();
            format!("map[{}]", parts.join(" "))
        }
        number => number.show(),
    }
}

fn rules_text(rules: &[Json]) -> String {
    let mut sorted: Vec<&Json> = rules.iter().collect();
    sorted.sort_by(|a, b| a.get("type").text().cmp(b.get("type").text()));
    let mut out = String::new();
    for rule in sorted {
        out.push_str(&format!("- {}", rule.get("type").text()));
        if let Some(parameters) = rule
            .get("parameters")
            .as_obj()
            .filter(|obj| !obj.is_empty())
        {
            out.push_str(": ");
            let mut pairs: Vec<&(String, Json)> = parameters.iter().collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            for (name, item) in pairs {
                out.push_str(&format!("[{name}: {}] ", go_value(item)));
            }
        }
        if !rule.get("ruleset_source").text().is_empty() {
            out.push_str(&format!(
                "\n  (configured in ruleset {} from {} {})\n",
                rule.get("ruleset_id").show(),
                rule.get("ruleset_source_type").text().to_lowercase(),
                rule.get("ruleset_source").text()
            ));
        }
        out.push('\n');
    }
    out
}

fn name_of(repo: &RepoRef) -> String {
    format!("{}/{}", repo.owner, repo.repo)
}

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let org = flags.as_nonempty("org");
    if flags.as_nonempty("repo").is_some() && org.is_some() {
        return usage("only one of --repo and --org may be specified");
    }
    let limit = flags.as_int("limit").unwrap_or(30);
    if limit < 1 {
        return usage(format!("invalid limit: {limit}"));
    }
    let mut base = Obj::new();
    base.set(
        "includeParents",
        flags.raw("parents").is_none() || flags.gh_bool("parents"),
    );
    let query = match org {
        Some(login) => {
            base.set("login", login);
            format!("{ORG_HEADER}{BODY}")
        }
        None => {
            let repo = repo_for(account, flags)?;
            base.set("owner", repo.owner);
            base.set("repo", repo.repo);
            format!("{REPO_HEADER}{BODY}")
        }
    };
    let mut rows: Vec<Json> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut page_limit = limit.min(100);
    loop {
        let mut variables = base.clone();
        variables.set("limit", page_limit);
        if let Some(cursor) = &cursor {
            variables.set("endCursor", cursor);
        }
        let data = graphql_data(account, &query, variables).await.map_err(|failure| {
            if failure.text().contains("requires one of the following scopes: ['admin:org']") {
                Failure::Value("the 'admin:org' scope is required to view organization rulesets, try running 'gh auth refresh -s admin:org'".to_owned())
            } else {
                failure
            }
        })?;
        let page = data.get("level").get("rulesets");
        rows.extend(page.get("nodes").items().iter().cloned());
        if page.get("nodes").items().is_empty()
            || rows.len() as i64 >= limit
            || !page.get("pageInfo").get("hasNextPage").truthy()
        {
            break;
        }
        cursor = page
            .get("pageInfo")
            .get("endCursor")
            .as_str()
            .map(str::to_owned);
        page_limit = page_limit.min(limit - rows.len() as i64);
    }
    Ok(Out::text(
        rows.iter()
            .map(|row| {
                tsv(&[
                    row.get("databaseId").show(),
                    row.get("name").text().to_owned(),
                    source_name(row),
                    row.get("enforcement").text().to_lowercase(),
                    row.get("rules").get("totalCount").show(),
                ])
            })
            .collect::<String>(),
    ))
}

pub(crate) async fn check_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let default = flags.gh_bool("default");
    if !texts.is_empty() && default {
        return usage("specify only one of `--default` or a branch name");
    }
    let repo = repo_for(account, flags)?;
    let branch = if default {
        view_repo(account, &repo)
            .await
            .map_err(|failure| {
                Failure::Value(format!(
                    "could not get repository information: {}",
                    failure.text()
                ))
            })?
            .get("default_branch")
            .text()
            .to_owned()
    } else if let Some(branch) = texts.first() {
        branch.clone()
    } else {
        match account
            .branch
            .as_deref()
            .filter(|branch| !branch.is_empty())
        {
            Some(branch) => branch.to_owned(),
            None => return value("could not determine current branch: no `branch` on the install"),
        }
    };
    let endpoint = format!("repos/{}/rules/branches/{}", name_of(&repo), quote(&branch));
    let found = github_request(account, "GET", &format!("/{endpoint}"), None)
        .await
        .map_err(|failure| Failure::Value(format!("GET {endpoint} failed: {}", failure.text())))?;
    let rules = found.items();
    let mut out = format!(
        "{} rules apply to branch {branch} in repo {}\n",
        rules.len(),
        name_of(&repo)
    );
    if !rules.is_empty() {
        out.push('\n');
        out.push_str(&rules_text(rules));
    }
    Ok(Out::text(out))
}

pub(crate) async fn view_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let org = flags.as_nonempty("org");
    if flags.as_nonempty("repo").is_some() && org.is_some() {
        return usage("only one of --repo and --org may be specified");
    }
    let Some(id) = texts.first() else {
        return usage("a ruleset ID must be provided when not running interactively");
    };
    if id.parse::<i64>().is_err() {
        return usage(format!(
            "invalid value for ruleset ID: {id} is not an integer"
        ));
    }
    let path = match org {
        Some(org) => format!("/orgs/{org}/rulesets/{id}"),
        None => format!(
            "/repos/{}/rulesets/{id}",
            name_of(&repo_for(account, flags)?)
        ),
    };
    let found = github_request(account, "GET", &path, None).await?;
    Ok(Out::text(ruleset_text(&found)))
}

fn ruleset_text(rs: &Json) -> String {
    let mut out = format!(
        "\n{}\nID: {}\nSource: {} ({})\nEnforcement: {}\n",
        rs.get("name").text(),
        rs.get("id").show(),
        rs.get("source").text(),
        rs.get("source_type").text(),
        match rs.get("enforcement").text() {
            "disabled" => "Disabled",
            "evaluate" => "Evaluate Mode (not enforced)",
            "active" => "Active",
            other => other,
        },
    );
    if !rs.get("current_user_can_bypass").text().is_empty() {
        out.push_str(&format!(
            "You can bypass: {}\n",
            rs.get("current_user_can_bypass").text().replace('_', " ")
        ));
    }
    out.push_str("\nBypass List\n");
    let actors = rs.get("bypass_actors").items();
    if actors.is_empty() {
        out.push_str("This ruleset cannot be bypassed\n");
    } else {
        let mut sorted: Vec<&Json> = actors.iter().collect();
        sorted.sort_by_key(|actor| actor.get("actor_id").as_int().unwrap_or(0));
        for actor in sorted {
            out.push_str(&format!(
                "- {} (ID: {}), mode: {}\n",
                actor.get("actor_type").text(),
                actor.get("actor_id").show(),
                actor.get("bypass_mode").text()
            ));
        }
    }
    out.push_str("\nConditions\n");
    let conditions = rs.get("conditions").as_obj();
    match conditions.filter(|obj| !obj.is_empty()) {
        None => out.push_str("No conditions configured\n"),
        Some(obj) => {
            let mut pairs: Vec<&(String, Json)> = obj.iter().collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            for (name, inner) in pairs {
                out.push_str(&format!("- {name}: "));
                if let Some(inner) = inner.as_obj() {
                    let mut items: Vec<&(String, Json)> = inner.iter().collect();
                    items.sort_by(|a, b| a.0.cmp(&b.0));
                    for (key, item) in items {
                        out.push_str(&format!("[{key}: {}] ", go_value(item)));
                    }
                }
                out.push('\n');
            }
        }
    }
    out.push_str("\nRules\n");
    let rules = rs.get("rules").items();
    if rules.is_empty() {
        out.push_str("No rules configured\n");
    } else {
        out.push_str(&rules_text(rules));
    }
    out
}

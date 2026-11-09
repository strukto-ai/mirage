// Follows gh 2.85.0's pkg/cmd/variable (MIT; see licenses/third_party/gh.txt).

use std::collections::BTreeMap;

use super::accessor::{
    Flags, Out, export_out, json_fields, read_cli_file, relative_path, repo_for, time_field, tsv,
};
use super::args::wrong_count;
use crate::core::github::client::{Account, Failure, Result, github_request, quote, usage, value};
use crate::core::github::json::{Json, Obj};
use crate::core::github::paginate::github_pages;
use crate::core::github::repo::{RepoRef, graphql_data, parse_repo};

const VARIABLE_FIELDS: [&str; 7] = [
    "name",
    "value",
    "visibility",
    "updatedAt",
    "createdAt",
    "numSelectedRepos",
    "selectedReposURL",
];

enum Entity<'a> {
    Repository(RepoRef),
    Environment(RepoRef, &'a str),
    Organization(&'a str),
}

fn entity<'a>(account: &Account, flags: &'a Flags) -> Result<Entity<'a>> {
    let org = flags.as_nonempty("org");
    let env = flags.as_nonempty("env");
    if org.is_some() && env.is_some() {
        return usage("specify only one of `--org` or `--env`");
    }
    Ok(match (org, env) {
        (Some(org), _) => Entity::Organization(org),
        (None, Some(env)) => Entity::Environment(repo_for(account, flags)?, env),
        (None, None) => Entity::Repository(repo_for(account, flags)?),
    })
}

fn collection(entity: &Entity<'_>) -> String {
    match entity {
        Entity::Organization(org) => format!("/orgs/{org}/actions/variables"),
        Entity::Environment(repo, env) => {
            format!(
                "/repos/{}/{}/environments/{}/variables",
                repo.owner,
                repo.repo,
                quote(env)
            )
        }
        Entity::Repository(repo) => {
            format!("/repos/{}/{}/actions/variables", repo.owner, repo.repo)
        }
    }
}

/// How many repositories an organization's variable or secret reaches.
pub(crate) async fn selected_count(account: &Account, url: &str) -> Result<i128> {
    let found = github_request(account, "GET", &relative_path(account, url), None).await?;
    Ok(found.get("total_count").as_int().unwrap_or(0))
}

fn row_of(raw: &Json, selected: Option<i128>) -> Obj {
    let text = |key: &str| raw.get(key).as_str().unwrap_or("").to_owned();
    let mut row = Obj::new();
    row.set("name", text("name"));
    row.set("value", text("value"));
    row.set("visibility", text("visibility"));
    row.set("updatedAt", time_field(raw.get("updated_at")));
    row.set("createdAt", time_field(raw.get("created_at")));
    row.set("numSelectedRepos", selected.unwrap_or(0));
    row.set("selectedReposURL", text("selected_repositories_url"));
    row
}

fn pick(row: &Obj, fields: &[String]) -> Json {
    let mut keys = fields.to_vec();
    keys.sort();
    let mut out = Obj::new();
    for key in &keys {
        out.set(key.as_str(), row.get(key).clone());
    }
    Json::Obj(out)
}

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let target = entity(account, flags)?;
    let fields = json_fields(flags, &VARIABLE_FIELDS)?;
    let raw = github_pages(
        account,
        &collection(&target),
        &[],
        i64::MAX,
        Some("variables"),
        |_| true,
    )
    .await
    .map_err(|failure| Failure::Value(format!("failed to get variables: {}", failure.text())))?;
    let wants_count = fields
        .as_ref()
        .is_some_and(|fields| fields.iter().any(|field| field == "numSelectedRepos"));
    let mut rows = Vec::new();
    for item in &raw {
        let url = item
            .get("selected_repositories_url")
            .as_str()
            .filter(|url| !url.is_empty());
        let selected = match (
            matches!(target, Entity::Organization(_)) && wants_count,
            url,
        ) {
            (true, Some(url)) => Some(selected_count(account, url).await?),
            _ => None,
        };
        rows.push(row_of(item, selected));
    }
    if let Some(fields) = fields {
        let selected = Json::Arr(rows.iter().map(|row| pick(row, &fields)).collect());
        return export_out(account, &selected, flags).await;
    }
    Ok(Out::text(
        rows.iter()
            .map(|row| {
                let mut columns = vec![
                    row.get("name").text().to_owned(),
                    row.get("value").text().to_owned(),
                    row.get("updatedAt").text().to_owned(),
                ];
                if !row.get("visibility").text().is_empty() {
                    columns.push(row.get("visibility").text().to_uppercase());
                }
                tsv(&columns)
            })
            .collect::<String>(),
    ))
}

pub(crate) async fn get_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let [name] = texts else {
        return wrong_count(1, texts);
    };
    let target = entity(account, flags)?;
    let fields = json_fields(flags, &VARIABLE_FIELDS)?;
    let path = format!("{}/{}", collection(&target), quote(name));
    let raw = match github_request(account, "GET", &path, None).await {
        Ok(raw) => raw,
        Err(Failure::Api(error)) if error.status == 404 => {
            return value(format!("variable {name} was not found"));
        }
        Err(failure) => {
            return value(format!("failed to get variable {name}: {}", failure.text()));
        }
    };
    if let Some(fields) = fields {
        let url = raw
            .get("selected_repositories_url")
            .as_str()
            .filter(|url| !url.is_empty());
        let selected = match url {
            Some(url) => Some(selected_count(account, url).await?),
            None => None,
        };
        return export_out(account, &pick(&row_of(&raw, selected), &fields), flags).await;
    }
    Ok(Out::text(format!("{}\n", raw.get("value").text())))
}

pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let [name] = texts else {
        return wrong_count(1, texts);
    };
    let target = entity(account, flags)?;
    let path = format!("{}/{}", collection(&target), quote(name));
    github_request(account, "DELETE", &path, None)
        .await
        .map_err(|failure| {
            Failure::Value(format!(
                "failed to delete variable {name}: {}",
                failure.text()
            ))
        })?;
    Ok(Out::default())
}

/// Dotenv text as names and values: `KEY=VALUE` lines, an `export`
/// prefix, `#` comments and quoted values.
pub(crate) fn parse_dotenv(text: &str) -> Result<BTreeMap<String, String>> {
    let mut found = BTreeMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((key, rest)) = line.split_once(['=', ':']) else {
            return value(format!(
                "error parsing env file: unexpected character in line {raw}"
            ));
        };
        let rest = rest.trim();
        let parsed = if let Some(inner) = rest.strip_prefix('"') {
            let end = inner.rfind('"').unwrap_or(inner.len());
            inner[..end].replace("\\n", "\n").replace("\\\"", "\"")
        } else if let Some(inner) = rest.strip_prefix('\'') {
            let end = inner.rfind('\'').unwrap_or(inner.len());
            inner[..end].to_owned()
        } else {
            rest.split(" #").next().unwrap_or("").trim_end().to_owned()
        };
        found.insert(key.trim().to_owned(), parsed);
    }
    Ok(found)
}

/// The database IDs of named repositories, as gh's GetRepoIDs asks.
pub(crate) async fn repo_ids(
    account: &Account,
    owner: Option<&str>,
    names: &[String],
) -> Result<Vec<i128>> {
    let mut repos = Vec::new();
    for name in names.iter().filter(|name| !name.is_empty()) {
        repos.push(match owner.filter(|_| !name.contains('/')) {
            Some(owner) => RepoRef {
                owner: owner.to_owned(),
                repo: name.clone(),
            },
            None => parse_repo(name)
                .map_err(|_| Failure::Value("invalid repository name".to_owned()))?,
        });
    }
    if repos.is_empty() {
        return value("resetting repositories selected to zero is not supported");
    }
    let mut query = String::from("query GetRepoIDs {");
    for (at, repo) in repos.iter().enumerate() {
        query.push_str(&format!(
            "repo_{at:03}: repository(owner: {}, name: {}) {{ databaseId }}\n",
            crate::core::github::json::quoted(&repo.owner),
            crate::core::github::json::quoted(&repo.repo)
        ));
    }
    query.push('}');
    let data = graphql_data(account, &query, Obj::new())
        .await
        .map_err(|failure| {
            Failure::Value(format!(
                "failed to look up IDs for repositories [{}]: {}",
                names.join(" "),
                failure.text()
            ))
        })?;
    Ok((0..repos.len())
        .map(|at| {
            data.get(&format!("repo_{at:03}"))
                .get("databaseId")
                .as_int()
                .unwrap_or(0)
        })
        .collect())
}

/// The text a `--body` or standard input gives, its line endings off.
pub(crate) async fn stdin_or_body(account: &Account, flags: &Flags) -> Result<String> {
    if let Some(body) = flags.as_nonempty("body") {
        return Ok(body.to_owned());
    }
    let bytes = read_cli_file(account, None, Some("-"), "--body").await?;
    Ok(String::from_utf8_lossy(&bytes)
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}

pub(crate) async fn set_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let target = entity(account, flags)?;
    let org = match &target {
        Entity::Organization(org) => Some(*org),
        _ => None,
    };
    let env_file = flags.raw("env_file").is_some();
    if flags.as_nonempty("body").is_some() && env_file {
        return usage("specify only one of `--body` or `--env-file`");
    }
    if texts.is_empty() && !env_file {
        return usage("must pass name argument");
    }
    let visibility_given = account.argv_has("--visibility") || account.argv_has("-v");
    let names = super::accessor::csv_values(&flags.as_list("repos"));
    let mut visibility = flags
        .as_nonempty("visibility")
        .unwrap_or("private")
        .to_owned();
    if visibility_given {
        if org.is_none() {
            return usage("`--visibility` is only supported with `--org`");
        }
        if visibility != "selected" && !names.is_empty() {
            return usage("`--repos` is only supported with `--visibility=selected`");
        }
        if visibility == "selected" && names.is_empty() {
            return usage("`--repos` list required with `--visibility=selected`");
        }
    } else if !names.is_empty() {
        visibility = "selected".to_owned();
    }
    let pairs: BTreeMap<String, String> = if env_file {
        let bytes = read_cli_file(account, Some("env_file"), None, "--env-file")
            .await
            .map_err(|failure| {
                Failure::Value(format!("failed to open env file: {}", failure.text()))
            })?;
        let found = parse_dotenv(&String::from_utf8_lossy(&bytes))?;
        if found.is_empty() {
            return value("no variables found in file");
        }
        found
    } else {
        BTreeMap::from([(texts[0].clone(), stdin_or_body(account, flags).await?)])
    };
    let ids = if names.is_empty() {
        Vec::new()
    } else {
        repo_ids(account, org, &names).await?
    };
    let base = match &target {
        Entity::Environment(repo, env) => {
            let found = repo_ids(account, None, &[format!("{}/{}", repo.owner, repo.repo)]).await?;
            format!(
                "/repositories/{}/environments/{}/variables",
                found[0],
                quote(env)
            )
        }
        other => collection(other),
    };
    let mut errors = Vec::new();
    for (name, text) in &pairs {
        let payload = |with_name: bool| {
            let mut body = Obj::new();
            if with_name {
                body.set("name", name.as_str());
            }
            if !ids.is_empty() {
                body.set(
                    "selected_repository_ids",
                    Json::Arr(ids.iter().map(|id| Json::from(*id)).collect()),
                );
            }
            if !text.is_empty() {
                body.set("value", text.as_str());
            }
            if org.is_some() && !visibility.is_empty() {
                body.set("visibility", visibility.as_str());
            }
            Json::Obj(body)
        };
        let outcome = match github_request(account, "POST", &base, Some(&payload(true))).await {
            Err(Failure::Api(error)) if error.status == 409 => {
                github_request(
                    account,
                    "PATCH",
                    &format!("{base}/{}", quote(name)),
                    Some(&payload(false)),
                )
                .await
            }
            other => other,
        };
        if let Err(failure) = outcome {
            errors.push(format!(
                "failed to set variable {}: {}",
                crate::core::github::json::quoted(name),
                failure.text()
            ));
        }
    }
    if errors.is_empty() {
        Ok(Out::default())
    } else {
        value(errors.join("\n"))
    }
}

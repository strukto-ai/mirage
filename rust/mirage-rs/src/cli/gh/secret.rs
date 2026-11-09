// Follows gh 2.85.0's pkg/cmd/secret (MIT; see licenses/third_party/gh.txt).

use super::accessor::{Flags, Out, export_out, json_fields, repo_for, time_field, tsv};
use super::args::wrong_count;
use super::variable::selected_count;
use crate::core::github::client::{Account, Failure, Result, github_request, quote, usage, value};
use crate::core::github::json::{Json, Obj};
use crate::core::github::paginate::github_pages;
use crate::core::github::repo::RepoRef;

const SECRET_FIELDS: [&str; 5] = [
    "selectedReposURL",
    "name",
    "visibility",
    "updatedAt",
    "numSelectedRepos",
];

pub(super) enum Entity<'a> {
    Repository(RepoRef),
    Environment(RepoRef, &'a str),
    Organization(&'a str),
    User,
}

impl Entity<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Entity::Repository(_) => "repository",
            Entity::Environment(..) => "environment",
            Entity::Organization(_) => "organization",
            Entity::User => "user",
        }
    }
}

pub(super) fn entity<'a>(account: &Account, flags: &'a Flags) -> Result<Entity<'a>> {
    let org = flags.as_nonempty("org");
    let env = flags.as_nonempty("env");
    let user = flags.gh_bool("user");
    if usize::from(org.is_some()) + usize::from(env.is_some()) + usize::from(user) > 1 {
        return usage("specify only one of `--org`, `--env`, or `--user`");
    }
    Ok(match (org, env, user) {
        (Some(org), _, _) => Entity::Organization(org),
        (_, Some(env), _) => Entity::Environment(repo_for(account, flags)?, env),
        (_, _, true) => Entity::User,
        _ => Entity::Repository(repo_for(account, flags)?),
    })
}

/// The application a secret belongs to, refused where it has none.
pub(super) fn application(flags: &Flags, target: &Entity<'_>) -> Result<&'static str> {
    let app = match flags
        .as_nonempty("app")
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "actions" => "actions",
        "codespaces" => "codespaces",
        "dependabot" => "dependabot",
        "" if matches!(target, Entity::User) => "codespaces",
        "" => "actions",
        other => return value(format!("invalid application: {other}")),
    };
    let supported = match target {
        Entity::User => app == "codespaces",
        Entity::Environment(..) => app == "actions",
        _ => true,
    };
    if !supported {
        return value(format!(
            "{} secrets are not supported for {app}",
            target.kind()
        ));
    }
    Ok(app)
}

pub(super) fn collection(target: &Entity<'_>, app: &str) -> String {
    match target {
        Entity::Organization(org) => format!("/orgs/{org}/{app}/secrets"),
        Entity::Environment(repo, env) => {
            format!(
                "/repos/{}/{}/environments/{}/secrets",
                repo.owner,
                repo.repo,
                quote(env)
            )
        }
        Entity::User => "/user/codespaces/secrets".to_owned(),
        Entity::Repository(repo) => format!("/repos/{}/{}/{app}/secrets", repo.owner, repo.repo),
    }
}

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let target = entity(account, flags)?;
    let app = application(flags, &target)?;
    let fields = json_fields(flags, &SECRET_FIELDS)?;
    let raw = github_pages(
        account,
        &collection(&target, app),
        &[],
        i64::MAX,
        Some("secrets"),
        |_| true,
    )
    .await
    .map_err(|failure| Failure::Value(format!("failed to get secrets: {}", failure.text())))?;
    if raw.is_empty() && fields.is_none() {
        return Ok(Out::default());
    }
    let wants_count = fields
        .as_ref()
        .is_some_and(|fields| fields.iter().any(|field| field == "numSelectedRepos"));
    let shared = matches!(target, Entity::Organization(_) | Entity::User);
    let mut rows = Vec::new();
    for item in &raw {
        let text = |key: &str| item.get(key).as_str().unwrap_or("").to_owned();
        let url = text("selected_repositories_url");
        let selected = if shared && wants_count && !url.is_empty() {
            selected_count(account, &url).await?
        } else {
            0
        };
        let mut row = Obj::new();
        row.set("name", text("name"));
        row.set("numSelectedRepos", selected);
        row.set("selectedReposURL", url);
        row.set("updatedAt", time_field(item.get("updated_at")));
        row.set("visibility", text("visibility"));
        rows.push(row);
    }
    if let Some(fields) = fields {
        let mut keys = fields;
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
        return export_out(account, &Json::Arr(selected), flags).await;
    }
    Ok(Out::text(
        rows.iter()
            .map(|row| {
                let mut columns = vec![
                    row.get("name").text().to_owned(),
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

pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let [name] = texts else {
        return wrong_count(1, texts);
    };
    let target = entity(account, flags)?;
    let app = application(flags, &target)?;
    let path = format!("{}/{}", collection(&target, app), quote(name));
    github_request(account, "DELETE", &path, None)
        .await
        .map_err(|failure| {
            Failure::Value(format!(
                "failed to delete secret {name}: {}",
                failure.text()
            ))
        })?;
    Ok(Out::default())
}

// Follows gh 2.85.0's pkg/cmd/repo (MIT; see licenses/third_party/gh.txt).

use super::accessor::{
    Flags, Out, camel, export_out, gh_repo, json_fields, repo_for, time_field, tsv, web_host,
};
use super::args::wrong_count;
use crate::core::github::client::{
    Account, Failure, Result, github_request, quote, quote_ref, usage, value,
};
use crate::core::github::json::{Json, Obj};
use crate::core::github::paginate::github_pages;
use crate::core::github::repo::{
    RepoRef, mutate, parse_repo, repo_host, repository_fields, view_repo,
};

fn full(repo: &RepoRef) -> String {
    format!("{}/{}", repo.owner, repo.repo)
}

async fn set_archived(
    account: &Account,
    flags: &Flags,
    texts: &[String],
    archive: bool,
) -> Result<Out> {
    if !flags.gh_bool("yes") && !flags.gh_bool("confirm") {
        return usage("--yes required when not running interactively");
    }
    let repo = gh_repo(account, texts.first().map(String::as_str))?;
    let found = repository_fields(account, &repo, "name,owner{login},isArchived,id").await?;
    let name = format!(
        "{}/{}",
        found.get("owner").get("login").text(),
        found.get("name").text()
    );
    if found.get("isArchived").truthy() == archive {
        let state = if archive {
            "already archived"
        } else {
            "not archived"
        };
        return Ok(Out::warned(format!("! Repository {name} is {state}\n")));
    }
    let mut input = Obj::new();
    input.set("repositoryId", found.get("id").text());
    if archive {
        mutate(
            account,
            "ArchiveRepository",
            "ArchiveRepositoryInput",
            "archiveRepository",
            "repository{id}",
            input,
        )
        .await?;
    } else {
        mutate(
            account,
            "UnarchiveRepository",
            "UnarchiveRepositoryInput",
            "unarchiveRepository",
            "repository{id}",
            input,
        )
        .await?;
    }
    Ok(Out::default())
}

pub(crate) async fn archive_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    set_archived(account, flags, texts, true).await
}

pub(crate) async fn unarchive_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    set_archived(account, flags, texts, false).await
}

/// The host a named repository lives on: its own, else the install's.
fn host_of(account: &Account, spec: &str) -> Result<String> {
    match repo_host(spec)? {
        Some(host) => Ok(host),
        None => web_host(account),
    }
}

/// `gh repo sync`, of a repository on GitHub: there is no local checkout to
/// sync here.
pub(crate) async fn sync_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let dest = gh_repo(account, texts.first().map(String::as_str))?;
    let force = flags.gh_bool("force");
    let mut source = match flags.as_nonempty("source") {
        Some(spec) => {
            let source = parse_repo(spec)?;
            let named = texts
                .first()
                .map(String::as_str)
                .filter(|named| !named.is_empty())
                .or(account.repo.as_deref())
                .unwrap_or_default();
            if host_of(account, named)? != host_of(account, spec)? {
                return value("can't sync repositories from different hosts");
            }
            Some(source)
        }
        None => None,
    };
    let branch = match flags.as_nonempty("branch") {
        Some(branch) => branch.to_owned(),
        None => view_repo(account, &dest)
            .await?
            .get("default_branch")
            .text()
            .to_owned(),
    };
    let mut body = Obj::new();
    body.set("branch", branch.as_str());
    let path = format!("/repos/{}/merge-upstream", full(&dest));
    match github_request(account, "POST", &path, Some(&Json::Obj(body))).await {
        Ok(_) => return Ok(Out::default()),
        Err(Failure::Api(error)) if matches!(error.status, 409 | 422) => {
            if error.message.contains("refusing to allow")
                && error.message.contains("without `workflow")
            {
                return value(
                    "Upstream commits contain workflow changes, which require the `workflow` scope or permission to merge. To request it, run: gh auth refresh -s workflow",
                );
            }
        }
        Err(failure) => return Err(failure),
    }
    if source.is_none() {
        let found = repository_fields(account, &dest, "parent{name,owner{login}}").await?;
        let parent = found.get("parent");
        if parent.is_null() {
            return value(format!(
                "can't determine source repository for {} because repository is not fork",
                full(&dest)
            ));
        }
        source = Some(RepoRef {
            owner: parent.get("owner").get("login").text().to_owned(),
            repo: parent.get("name").text().to_owned(),
        });
    }
    let source = source.unwrap_or_else(|| dest.clone());
    let reference = quote_ref(&branch);
    let latest = github_request(
        account,
        "GET",
        &format!("/repos/{}/git/refs/heads/{reference}", full(&source)),
        None,
    )
    .await?;
    let mut update = Obj::new();
    update.set("force", force);
    update.set("sha", latest.get("object").get("sha").text());
    match github_request(
        account,
        "PATCH",
        &format!("/repos/{}/git/refs/heads/{reference}", full(&dest)),
        Some(&Json::Obj(update)),
    )
    .await
    {
        Ok(_) => Ok(Out::default()),
        Err(Failure::Api(error)) if error.message == "Update is not a fast forward" => value(
            "can't sync because there are diverging changes; use `--force` to overwrite the destination branch",
        ),
        Err(Failure::Api(error)) if error.message == "Reference does not exist" => value(format!(
            "{branch} branch does not exist on {} repository",
            full(&dest)
        )),
        Err(failure) => Err(failure),
    }
}

const DEPLOY_FIELDS: [&str; 5] = ["id", "key", "title", "createdAt", "readOnly"];
/// gh's deployKey has no field export, so `--json` prints every field of
/// the struct under its wire name, whichever were selected.
const DEPLOY_KEY_EXPORT: [&str; 5] = ["id", "key", "title", "created_at", "read_only"];

pub(crate) async fn deploy_key_list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let fields = json_fields(flags, &DEPLOY_FIELDS)?;
    let repo = repo_for(account, flags)?;
    let keys = github_pages(
        account,
        &format!("/repos/{}/keys", full(&repo)),
        &[],
        i64::MAX,
        None,
        |_| true,
    )
    .await?;
    if keys.is_empty() {
        return Ok(Out::default());
    }
    if fields.is_some() {
        let rows: Vec<Json> = keys
            .iter()
            .map(|key| {
                let mut out = Obj::new();
                for field in DEPLOY_KEY_EXPORT {
                    out.set(field, key.get(field).clone());
                }
                Json::Obj(out)
            })
            .collect();
        return export_out(account, &Json::Arr(rows), flags).await;
    }
    Ok(Out::text(
        keys.iter()
            .map(|key| {
                let mode = if key.get("read_only").truthy() {
                    "read-only"
                } else {
                    "read-write"
                };
                tsv(&[
                    key.get("id").show(),
                    key.get("title").text().to_owned(),
                    mode.to_owned(),
                    key.get("key").text().to_owned(),
                    time_field(key.get("created_at")),
                ])
            })
            .collect::<String>(),
    ))
}

pub(crate) async fn deploy_key_add_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let [file] = texts else {
        return wrong_count(1, texts);
    };
    let repo = repo_for(account, flags)?;
    let content = super::accessor::read_cli_file(account, None, Some(file), "key file").await?;
    let mut body = Obj::new();
    body.set("key", String::from_utf8_lossy(&content).into_owned());
    body.set("read_only", !flags.gh_bool("allow_write"));
    body.set("title", flags.as_str("title").unwrap_or(""));
    github_request(
        account,
        "POST",
        &format!("/repos/{}/keys", full(&repo)),
        Some(&Json::Obj(body)),
    )
    .await?;
    Ok(Out::default())
}

pub(crate) async fn deploy_key_delete_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let [id] = texts else {
        return wrong_count(1, texts);
    };
    let repo = repo_for(account, flags)?;
    github_request(
        account,
        "DELETE",
        &format!("/repos/{}/keys/{id}", full(&repo)),
        None,
    )
    .await?;
    Ok(Out::default())
}

const AUTOLINK_FIELDS: [&str; 4] = ["id", "isAlphanumeric", "keyPrefix", "urlTemplate"];

fn autolink_row(raw: &Json, fields: &[String]) -> Json {
    let row = camel(raw);
    let mut sorted = fields.to_vec();
    sorted.sort();
    let mut out = Obj::new();
    for field in &sorted {
        let value = match field.as_str() {
            "urlTemplate" => raw.get("url_template").clone(),
            _ => row.get(field).clone(),
        };
        out.set(field.as_str(), value);
    }
    Json::Obj(out)
}

fn admin_rights(repo: &RepoRef, prefix: &str, tail: &str) -> String {
    format!(
        "{prefix}HTTP 404: Perhaps you are missing admin rights to the repository? (https://api.github.com/repos/{}/autolinks{tail})",
        full(repo)
    )
}

pub(crate) async fn autolink_list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let fields = json_fields(flags, &AUTOLINK_FIELDS)?;
    let repo = repo_for(account, flags)?;
    let links = match github_request(
        account,
        "GET",
        &format!("/repos/{}/autolinks", full(&repo)),
        None,
    )
    .await
    {
        Ok(links) => links,
        Err(Failure::Api(error)) if error.status == 404 => {
            return value(admin_rights(&repo, "error getting autolinks: ", ""));
        }
        Err(failure) => return Err(failure),
    };
    if links.items().is_empty() && fields.is_none() {
        return Ok(Out::default());
    }
    if let Some(fields) = fields {
        let rows = links
            .items()
            .iter()
            .map(|link| autolink_row(link, &fields))
            .collect();
        return export_out(account, &Json::Arr(rows), flags).await;
    }
    Ok(Out::text(
        links
            .items()
            .iter()
            .map(|link| {
                tsv(&[
                    link.get("id").show(),
                    link.get("key_prefix").text().to_owned(),
                    link.get("url_template").text().to_owned(),
                    link.get("is_alphanumeric").truthy().to_string(),
                ])
            })
            .collect::<String>(),
    ))
}

pub(crate) async fn autolink_create_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let [prefix, template] = texts else {
        return usage(
            "Cannot create autolink: keyPrefix and urlTemplate arguments are both required",
        );
    };
    let repo = repo_for(account, flags)?;
    let mut body = Obj::new();
    body.set("is_alphanumeric", !flags.gh_bool("numeric"));
    body.set("key_prefix", prefix.as_str());
    body.set("url_template", template.as_str());
    let created = github_request(
        account,
        "POST",
        &format!("/repos/{}/autolinks", full(&repo)),
        Some(&Json::Obj(body)),
    )
    .await
    .map_err(|failure| {
        Failure::Value(match failure {
            Failure::Api(error) if error.status == 404 => format!(
                "error creating autolink: HTTP 404: Must have admin rights to Repository. ({})",
                error.url
            ),
            other => format!("error creating autolink: {}", other.text()),
        })
    })?;
    Ok(Out::text(format!(
        "✓ Created repository autolink {} on {}\n",
        created.get("id").show(),
        full(&repo)
    )))
}

pub(crate) async fn autolink_view_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let [id] = texts else {
        return wrong_count(1, texts);
    };
    let fields = json_fields(flags, &AUTOLINK_FIELDS)?;
    let repo = repo_for(account, flags)?;
    let link = match github_request(
        account,
        "GET",
        &format!("/repos/{}/autolinks/{id}", full(&repo)),
        None,
    )
    .await
    {
        Ok(link) => link,
        Err(Failure::Api(error)) if error.status == 404 => {
            return value(admin_rights(
                &repo,
                "error viewing autolink: ",
                &format!("/{id}"),
            ));
        }
        Err(failure) => return value(format!("error viewing autolink: {}", failure.text())),
    };
    if let Some(fields) = fields {
        return export_out(account, &autolink_row(&link, &fields), flags).await;
    }
    Ok(Out::text(format!(
        "Autolink in {}\n\nID: {}\nKey Prefix: {}\nURL Template: {}\nAlphanumeric: {}\n",
        full(&repo),
        link.get("id").show(),
        link.get("key_prefix").text(),
        link.get("url_template").text(),
        link.get("is_alphanumeric").truthy()
    )))
}

pub(crate) async fn autolink_delete_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let [id] = texts else {
        return wrong_count(1, texts);
    };
    if !flags.gh_bool("yes") {
        return usage("--yes required when not running interactively");
    }
    let repo = repo_for(account, flags)?;
    let path = format!("/repos/{}/autolinks/{id}", full(&repo));
    match github_request(account, "GET", &path, None).await {
        Err(Failure::Api(error)) if error.status == 404 => {
            return value(admin_rights(
                &repo,
                "error deleting autolink: ",
                &format!("/{id}"),
            ));
        }
        Err(failure) => return value(format!("error deleting autolink: {}", failure.text())),
        Ok(_) => {}
    }
    match github_request(account, "DELETE", &path, None).await {
        Err(Failure::Api(error)) if error.status == 404 => value(admin_rights(
            &repo,
            "error deleting autolink: ",
            &format!("/{id}"),
        )),
        Err(failure) => Err(failure),
        Ok(_) => Ok(Out::default()),
    }
}

pub(crate) async fn gitignore_list_cmd(account: &Account) -> Result<Out> {
    let found = github_request(account, "GET", "/gitignore/templates", None).await?;
    let mut out = String::new();
    for name in found.items() {
        out.push_str(name.text());
        out.push('\n');
    }
    Ok(Out::text(out))
}

pub(crate) async fn gitignore_view_cmd(account: &Account, texts: &[String]) -> Result<Out> {
    let [name] = texts else {
        return wrong_count(1, texts);
    };
    let path = format!("/gitignore/templates/{}", quote(name));
    match github_request(account, "GET", &path, None).await {
        Err(Failure::Api(error)) if error.status == 404 => value(format!(
            "'{name}' is not a valid gitignore template. Run `gh repo gitignore list` for options"
        )),
        Err(failure) => Err(failure),
        Ok(found) => Ok(Out::text(found.get("source").text().to_owned())),
    }
}

pub(crate) async fn license_list_cmd(account: &Account) -> Result<Out> {
    let found = github_request(account, "GET", "/licenses", None).await?;
    if found.items().is_empty() {
        return value("No repository licenses found");
    }
    Ok(Out::text(
        found
            .items()
            .iter()
            .map(|row| {
                tsv(&[
                    row.get("key").text().to_owned(),
                    row.get("spdx_id").text().to_owned(),
                    row.get("name").text().to_owned(),
                ])
            })
            .collect::<String>(),
    ))
}

pub(crate) async fn license_view_cmd(account: &Account, texts: &[String]) -> Result<Out> {
    let [name] = texts else {
        return wrong_count(1, texts);
    };
    let path = format!("/licenses/{}", quote(name));
    let found = match github_request(account, "GET", &path, None).await {
        Err(Failure::Api(error)) if error.status == 404 => {
            return value(format!(
                "'{name}' is not a valid license name or SPDX ID.\n\nRun `gh repo license list` to see available commonly used licenses. For even more licenses, visit https://choosealicense.com/appendix"
            ));
        }
        Err(failure) => return Err(failure),
        Ok(found) => found,
    };
    Ok(Out::text(found.get("body").text().to_owned()))
}

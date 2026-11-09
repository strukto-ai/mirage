// Follows gh 2.85.0's pkg/cmd/cache (MIT; see licenses/third_party/gh.txt).

use super::accessor::{Flags, Out, camel, repo_for, time_field, tsv, typed_out};
use crate::core::github::client::{
    Account, Failure, Pairs, Result, github_request, github_request_response, usage,
};
use crate::core::github::json::Json;
use crate::core::github::paginate::github_pages;
use crate::core::github::repo::RepoRef;

const CACHE_FIELDS: [&str; 7] = [
    "createdAt",
    "id",
    "key",
    "lastAccessedAt",
    "ref",
    "sizeInBytes",
    "version",
];

fn caches_path(repo: &RepoRef) -> String {
    format!("/repos/{}/{}/actions/caches", repo.owner, repo.repo)
}

async fn caches(
    account: &Account,
    repo: &RepoRef,
    params: &Pairs,
    limit: i64,
) -> Result<Vec<Json>> {
    github_pages(
        account,
        &caches_path(repo),
        params,
        limit,
        Some("actions_caches"),
        |_| true,
    )
    .await
}

fn file_size(size: i128) -> String {
    let decimals = |value: f64| {
        let text = format!("{value:.6}");
        let dot = text.find('.').unwrap_or(text.len());
        text[..(dot + 3).min(text.len())].to_owned()
    };
    if size < 1024 {
        return format!("{size} B");
    }
    let kb = size as f64 / 1024.0;
    if kb < 1024.0 {
        return format!("{} KiB", decimals(kb));
    }
    let mb = kb / 1024.0;
    if mb < 1024.0 {
        return format!("{} MiB", decimals(mb));
    }
    format!("{} GiB", decimals(mb / 1024.0))
}

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let limit = flags.as_int("limit").unwrap_or(30);
    if limit < 1 {
        return usage(format!("invalid limit: {limit}"));
    }
    super::accessor::json_fields(flags, &CACHE_FIELDS)?;
    let repo = repo_for(account, flags)?;
    let mut params = vec![
        (
            "sort".to_owned(),
            flags
                .as_nonempty("sort")
                .unwrap_or("last_accessed_at")
                .to_owned(),
        ),
        (
            "direction".to_owned(),
            flags.as_nonempty("order").unwrap_or("desc").to_owned(),
        ),
    ];
    for (flag, key) in [("key", "key"), ("ref", "ref")] {
        if let Some(text) = flags.as_nonempty(flag) {
            params.push((key.to_owned(), text.to_owned()));
        }
    }
    let rows = caches(account, &repo, &params, limit)
        .await
        .map_err(|failure| Failure::Value(format!("X Failed to get caches: {}", failure.text())))?;
    if rows.is_empty() && flags.raw("json").is_none() {
        return Ok(Out::default());
    }
    let human: String = rows
        .iter()
        .map(|row| {
            tsv(&[
                row.get("id").show(),
                row.get("key").text().to_owned(),
                file_size(row.get("size_in_bytes").as_int().unwrap_or(0)),
                time_field(row.get("created_at")),
                time_field(row.get("last_accessed_at")),
            ])
        })
        .collect();
    let data = Json::Arr(rows.iter().map(camel).collect());
    typed_out(account, &data, flags, human, &CACHE_FIELDS).await
}

pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let all = flags.gh_bool("all");
    let reference = flags.as_nonempty("ref");
    let quiet = flags.gh_bool("succeed_on_no_caches");
    if all && !texts.is_empty() {
        return usage("specify only one of cache id, cache key, or --all");
    }
    if all && reference.is_some() {
        return usage("--ref cannot be used with --all");
    }
    if !all && quiet {
        return usage("--succeed-on-no-caches must be used in conjunction with --all");
    }
    if reference.is_some() && texts.is_empty() {
        return usage("must provide a cache key");
    }
    if !all && texts.is_empty() {
        return usage("must provide either cache id, cache key, or use --all");
    }
    if reference.is_some() && texts[0].parse::<i64>().is_ok() {
        return usage("--ref cannot be used with cache ID");
    }
    let repo = repo_for(account, flags)?;
    let name = format!("{}/{}", repo.owner, repo.repo);
    let mut targets = texts.to_vec();
    if all {
        let rows = caches(account, &repo, &[], i64::MAX).await?;
        if rows.is_empty() {
            if quiet {
                return Ok(Out::default());
            }
            return Err(Failure::Value("X No caches to delete".to_owned()));
        }
        targets = rows.iter().map(|row| row.get("id").show()).collect();
    }
    for target in &targets {
        let outcome = if target.parse::<i64>().is_ok() {
            github_request(
                account,
                "DELETE",
                &format!("{}/{target}", caches_path(&repo)),
                None,
            )
            .await
        } else {
            let mut params = vec![("key".to_owned(), target.clone())];
            if let Some(reference) = reference {
                params.push(("ref".to_owned(), reference.to_owned()));
            }
            github_request_response(account, "DELETE", &caches_path(&repo), None, &params, &[])
                .await
                .map(|_| Json::Null)
        };
        if let Err(failure) = outcome {
            let message = match (&failure, reference) {
                (Failure::Api(error), None) if error.status == 404 => {
                    format!("X Could not find a cache matching {target} in {name}")
                }
                (Failure::Api(error), Some(reference)) if error.status == 404 => {
                    format!(
                        "X Could not find a cache matching {target} (with ref {reference}) in {name}"
                    )
                }
                _ => format!("X Failed to delete cache: {}", failure.text()),
            };
            return Err(Failure::Value(message));
        }
    }
    Ok(Out::default())
}

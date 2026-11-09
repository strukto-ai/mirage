// The calls gh 2.85.0 makes for pkg/cmd/run and pkg/cmd/workflow (MIT; see
// licenses/third_party/gh.txt).

use std::collections::BTreeMap;

use super::client::{
    Account, Failure, Pairs, Result, decode_base64, github_request, github_request_response, quote,
    value,
};
use super::json::{Json, Obj};
use super::paginate::{github_numbered_pages, github_pages};
use super::repo::RepoRef;

const WORKFLOW_LOOKUP: i64 = 100;

fn actions(target: &RepoRef, tail: &str) -> String {
    format!("/repos/{}/{}/actions/{tail}", target.owner, target.repo)
}

pub(crate) async fn resolve_workflow(
    account: &Account,
    target: &RepoRef,
    workflow: &str,
) -> Result<String> {
    if workflow.bytes().all(|b| b.is_ascii_digit()) && !workflow.is_empty()
        || workflow.ends_with(".yml")
        || workflow.ends_with(".yaml")
    {
        return Ok(workflow.to_owned());
    }
    let rows = list_workflows(account, target, WORKFLOW_LOOKUP, |_| true).await?;
    let wanted = workflow.to_lowercase();
    match rows
        .iter()
        .find(|row| row.get("name").show().to_lowercase() == wanted)
    {
        Some(found) => Ok(found.get("id").show()),
        None => value(format!("could not find any workflows named {workflow}")),
    }
}

/// Workflows a selector names, as gh's FindWorkflow finds them: an ID or a
/// file name directly, a name only among the given states.
pub(crate) async fn find_workflows(
    account: &Account,
    target: &RepoRef,
    selector: &str,
    states: &[&str],
) -> Result<Vec<Json>> {
    if selector.parse::<i64>().is_ok() || selector.ends_with(".yml") || selector.ends_with(".yaml")
    {
        let found = github_request(
            account,
            "GET",
            &actions(target, &format!("workflows/{}", quote(selector))),
            None,
        )
        .await
        .map_err(|failure| match failure {
            Failure::Api(mut error) if error.status == 404 => {
                error.joined = format!("workflow {selector} not found on the default branch");
                Failure::Api(error)
            }
            other => other,
        })?;
        return Ok(vec![found]);
    }
    let wanted = selector.to_lowercase();
    let rows = list_workflows(account, target, i64::MAX, |row| {
        row.get("name").show().to_lowercase() == wanted && states.contains(&row.get("state").text())
    })
    .await
    .map_err(|failure| {
        Failure::Value(format!(
            "couldn't fetch workflows for {}/{}: {}",
            target.owner,
            target.repo,
            failure.text()
        ))
    })?;
    Ok(rows)
}

/// The one workflow a selector names, as gh's ResolveWorkflow settles it
/// when it cannot prompt.
pub(crate) async fn the_workflow(
    account: &Account,
    target: &RepoRef,
    selector: &str,
    states: &[&str],
) -> Result<Json> {
    let mut found = find_workflows(account, target, selector, states).await?;
    match found.len() {
        0 => value(format!("could not find any workflows named {selector}")),
        1 => Ok(found.remove(0)),
        _ => {
            let names: String = found
                .iter()
                .map(|row| {
                    let path = row.get("path").text();
                    format!(" {}", path.rsplit('/').next().unwrap_or(path))
                })
                .collect();
            value(format!(
                "could not resolve to a unique workflow; found:{names}"
            ))
        }
    }
}

fn name_run(row: &mut Json, name: &str) {
    if let Json::Obj(fields) = row {
        fields.set("workflowName", name);
    }
}

async fn preload_workflow_names(
    account: &Account,
    target: &RepoRef,
    rows: &mut [Json],
) -> Result<()> {
    let workflows = list_workflows(account, target, i64::MAX, |_| true).await?;
    let mut names: BTreeMap<String, String> = workflows
        .iter()
        .map(|row| (row.get("id").show(), row.get("name").show()))
        .collect();
    for row in rows.iter_mut() {
        let id = row.get("workflow_id").show();
        if !names.contains_key(&id) {
            let name = match github_request(
                account,
                "GET",
                &actions(target, &format!("workflows/{id}")),
                None,
            )
            .await
            {
                Ok(found) => found.get("name").show(),
                Err(Failure::Api(error)) if error.status == 404 => String::new(),
                Err(failure) => return Err(failure),
            };
            names.insert(id.clone(), name);
        }
        name_run(row, names.get(&id).map_or("", String::as_str));
    }
    Ok(())
}

pub(crate) async fn list_runs(
    account: &Account,
    target: &RepoRef,
    params: &Pairs,
    limit: i64,
    workflow: Option<(&str, &[&str])>,
) -> Result<Vec<Json>> {
    let chosen = match workflow {
        None => None,
        Some((selector, states)) => Some(the_workflow(account, target, selector, states).await?),
    };
    let tail = match &chosen {
        None => "runs".to_owned(),
        Some(found) => format!("workflows/{}/runs", found.get("id").show()),
    };
    let mut query = params.to_vec();
    query.push(("exclude_pull_requests".to_owned(), "true".to_owned()));
    let mut rows = github_pages(
        account,
        &actions(target, &tail),
        &query,
        limit,
        Some("workflow_runs"),
        |_| true,
    )
    .await?;
    match &chosen {
        Some(found) => {
            let name = found.get("name").show();
            for row in &mut rows {
                name_run(row, &name);
            }
        }
        None if !rows.is_empty() => preload_workflow_names(account, target, &mut rows).await?,
        None => {}
    }
    Ok(rows)
}

/// A run with its workflow's current name, as gh's GetRun reads one.
pub(crate) async fn get_run(account: &Account, target: &RepoRef, run: &str) -> Result<Json> {
    let query = vec![("exclude_pull_requests".to_owned(), "true".to_owned())];
    let mut row = github_request_response(
        account,
        "GET",
        &actions(target, &format!("runs/{run}")),
        None,
        &query,
        &[],
    )
    .await?
    .data
    .into_json();
    let workflow = github_request(
        account,
        "GET",
        &actions(
            target,
            &format!("workflows/{}", row.get("workflow_id").show()),
        ),
        None,
    )
    .await?;
    name_run(&mut row, &workflow.get("name").show());
    Ok(row)
}

pub(crate) async fn rerun(
    account: &Account,
    target: &RepoRef,
    run: &str,
    suffix: &str,
    body: Option<&Json>,
) -> Result<Json> {
    github_request(
        account,
        "POST",
        &actions(target, &format!("runs/{run}/{suffix}")),
        body,
    )
    .await
}

pub(crate) async fn rerun_job(
    account: &Account,
    target: &RepoRef,
    job: &str,
    body: Option<&Json>,
) -> Result<Json> {
    github_request(
        account,
        "POST",
        &actions(target, &format!("jobs/{job}/rerun")),
        body,
    )
    .await
}

pub(crate) async fn get_job(account: &Account, target: &RepoRef, job: &str) -> Result<Json> {
    github_request(
        account,
        "GET",
        &actions(target, &format!("jobs/{job}")),
        None,
    )
    .await
}

pub(crate) async fn list_workflows(
    account: &Account,
    target: &RepoRef,
    limit: i64,
    include: impl Fn(&Json) -> bool + Send,
) -> Result<Vec<Json>> {
    github_numbered_pages(
        account,
        &actions(target, "workflows"),
        &[],
        limit,
        Some("workflows"),
        include,
    )
    .await
}

pub(crate) async fn dispatch_workflow(
    account: &Account,
    target: &RepoRef,
    workflow: &str,
    body: Obj,
) -> Result<Json> {
    let selector = resolve_workflow(account, target, workflow).await?;
    github_request(
        account,
        "POST",
        &actions(
            target,
            &format!("workflows/{}/dispatches", quote(&selector)),
        ),
        Some(&Json::Obj(body)),
    )
    .await
}

pub(crate) async fn list_jobs(account: &Account, target: &RepoRef, run: i128) -> Result<Vec<Json>> {
    github_pages(
        account,
        &actions(target, &format!("runs/{run}/jobs")),
        &[],
        i64::MAX,
        Some("jobs"),
        |_| true,
    )
    .await
}

async fn bytes_at(account: &Account, path: &str) -> Result<Vec<u8>> {
    Ok(
        github_request_response(account, "GET", path, None, &[], &[])
            .await?
            .data
            .into_bytes(),
    )
}

pub(crate) async fn run_log_archive(
    account: &Account,
    target: &RepoRef,
    run: i128,
) -> Result<Vec<u8>> {
    bytes_at(account, &actions(target, &format!("runs/{run}/logs"))).await
}

pub(crate) async fn job_log(account: &Account, target: &RepoRef, job: i128) -> Result<Vec<u8>> {
    bytes_at(account, &actions(target, &format!("jobs/{job}/logs"))).await
}

/// A workflow file's bytes, at `git_ref` or the default branch.
pub(crate) async fn workflow_content(
    account: &Account,
    target: &RepoRef,
    path: &str,
    git_ref: Option<&str>,
) -> Result<Vec<u8>> {
    let params: Vec<(String, String)> = git_ref
        .map(|name| ("ref".to_owned(), name.to_owned()))
        .into_iter()
        .collect();
    let data = github_request_response(
        account,
        "GET",
        &format!("/repos/{}/{}/contents/{path}", target.owner, target.repo),
        None,
        &params,
        &[],
    )
    .await?
    .data
    .into_json();
    Ok(data
        .get("content")
        .as_str()
        .map_or_else(Vec::new, decode_base64))
}

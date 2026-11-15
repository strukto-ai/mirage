// Follows gh 2.85.0's pkg/cmd/run and pkg/cmd/workflow (MIT; see
// licenses/third_party/gh.txt).

use std::io::Read;

use super::accessor::{
    Flags, Out, camel, go_duration, instant, json_fields, limit_or_refuse, read_cli_file, repo_for,
    time_field, tsv, typed_out,
};
use super::shape::{Shape, exported};
use crate::core::github::actions::{
    dispatch_workflow, get_job, get_run, job_annotations, job_log, list_artifacts, list_jobs,
    list_runs, list_workflows, rerun, rerun_job, run_log_archive, the_workflow, workflow_content,
};
use crate::core::github::client::{
    Account, Failure, Result, github_request, github_request_response, usage, value,
};
use crate::core::github::json::{Json, Obj, quoted};
use crate::core::github::repo::{RepoRef, github_repo, graphql_data};
use crate::request::Request;

const RUN_FIELDS: [&str; 16] = [
    "attempt",
    "conclusion",
    "createdAt",
    "databaseId",
    "displayTitle",
    "event",
    "headBranch",
    "headSha",
    "name",
    "number",
    "startedAt",
    "status",
    "updatedAt",
    "url",
    "workflowDatabaseId",
    "workflowName",
];
/// `gh run view`'s fields: a run's, and its jobs.
const SINGLE_RUN_FIELDS: [&str; 17] = [
    "attempt",
    "conclusion",
    "createdAt",
    "databaseId",
    "displayTitle",
    "event",
    "headBranch",
    "headSha",
    "jobs",
    "name",
    "number",
    "startedAt",
    "status",
    "updatedAt",
    "url",
    "workflowDatabaseId",
    "workflowName",
];
const WORKFLOW_FIELDS: [&str; 4] = ["id", "name", "path", "state"];
const FAILURE_STATES: [&str; 4] = ["action_required", "failure", "startup_failure", "timed_out"];
const MAX_API_LOG_FETCHERS: usize = 25;
const JOB_NAME_MAX_LENGTH: usize = 90;

fn renamed(row: &mut Obj, from: &str, to: &str) {
    if let Some(value) = row.remove(from) {
        row.set(to, value);
    }
}

fn run(raw: &Json) -> Obj {
    let mut row = match camel(raw) {
        Json::Obj(row) => row,
        _ => Obj::new(),
    };
    renamed(&mut row, "id", "databaseId");
    renamed(&mut row, "htmlUrl", "url");
    renamed(&mut row, "runAttempt", "attempt");
    renamed(&mut row, "runNumber", "number");
    renamed(&mut row, "workflowId", "workflowDatabaseId");
    if !row.has("workflowName") {
        row.set(
            "workflowName",
            row.find("name").cloned().unwrap_or_else(|| "".into()),
        );
    }
    if !row.has("startedAt") {
        row.set("startedAt", row.get("runStartedAt").clone());
    }
    row
}

fn workflow(raw: &Json) -> Obj {
    match camel(raw) {
        Json::Obj(row) => row,
        _ => Obj::new(),
    }
}

pub(crate) async fn run_list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    json_fields(flags, &RUN_FIELDS)?;
    let mut params = Vec::new();
    for (flag, key) in [
        ("branch", "branch"),
        ("commit", "head_sha"),
        ("event", "event"),
        ("status", "status"),
        ("user", "actor"),
        ("created", "created"),
    ] {
        if let Some(value) = flags.as_nonempty(flag) {
            params.push((key.to_owned(), value.to_owned()));
        }
    }
    let repo = repo_for(account, flags)?;
    let limit = limit_or_refuse(flags, 20)?;
    let states: &[&str] = if flags.gh_bool("all") {
        &["active", "disabled_manually", "disabled_inactivity"]
    } else {
        &["active"]
    };
    let workflow = flags.as_str("workflow").map(|selector| (selector, states));
    let rows: Vec<Obj> = list_runs(account, &repo, &params, limit, workflow)
        .await
        .map_err(|failure| Failure::Value(format!("failed to get runs: {}", failure.text())))?
        .iter()
        .map(run)
        .collect();
    if rows.is_empty() && flags.raw("json").is_none() {
        return Ok(Out::default());
    }
    let (reply, _) = account.host.ask(Request::Now).await;
    let now = (reply.now.unwrap_or(0.0) * 1e9) as i128;
    let human: String = rows
        .iter()
        .map(|row| {
            let started = if row.get("startedAt").truthy() {
                row.get("startedAt")
            } else {
                row.get("createdAt")
            };
            let end = if row.get("status").as_str() == Some("completed") {
                row.get("updatedAt").as_str().and_then(instant).unwrap_or(0)
            } else {
                now
            };
            let span = end - started.as_str().and_then(instant).unwrap_or(0);
            let rounded = (span.max(0) + 500_000_000) / 1_000_000_000 * 1_000_000_000;
            tsv(&[
                row.get("status").show(),
                row.get("conclusion").as_str().unwrap_or("").to_owned(),
                row.get("displayTitle").show(),
                row.get("workflowName").show(),
                row.get("headBranch").show(),
                row.get("event").show(),
                row.get("databaseId").show(),
                go_duration(rounded),
                time_field(started),
            ])
        })
        .collect();
    let data = Json::Arr(rows.into_iter().map(Json::Obj).collect());
    typed_out(account, &data, flags, human, &RUN_FIELDS).await
}

/// A job under `gh run view --json jobs`, as gh's Run.ExportData builds
/// it: a map, so its keys print sorted, and a time it lacks prints as Go's
/// zero time.
fn exported_job(job: &Json) -> Json {
    let step = Shape::Struct(
        vec![
            ("completedAt", Shape::Time, Some("completed_at")),
            ("conclusion", Shape::Str, None),
            ("name", Shape::Str, None),
            ("number", Shape::Int, None),
            ("startedAt", Shape::Time, Some("started_at")),
            ("status", Shape::Str, None),
        ],
        false,
    );
    let mut out = Obj::new();
    out.set(
        "completedAt",
        exported(job.get("completed_at"), &Shape::Time),
    );
    out.set("conclusion", job.get("conclusion").text());
    out.set("databaseId", job.get("id").as_int().unwrap_or(0));
    out.set("name", job.get("name").text());
    out.set("startedAt", exported(job.get("started_at"), &Shape::Time));
    out.set("status", job.get("status").text());
    out.set(
        "steps",
        Json::Arr(
            job.get("steps")
                .items()
                .iter()
                .map(|one| exported(one, &step))
                .collect(),
        ),
    );
    out.set("url", job.get("html_url").text());
    Json::Obj(out)
}

/// gh's Symbol for a run, a job or a step, uncolored.
fn symbol(item: &Json) -> &'static str {
    if item.get("status").as_str() != Some("completed") {
        return "*";
    }
    match item.get("conclusion").as_str() {
        Some("success") => "✓",
        Some("skipped") | Some("neutral") => "-",
        _ => "X",
    }
}

fn failed(item: &Json) -> bool {
    FAILURE_STATES.contains(&item.get("conclusion").text())
}

const NANOS_PER_MINUTE: i128 = 60_000_000_000;
const NANOS_PER_HOUR: i128 = 60 * NANOS_PER_MINUTE;

/// go-gh's RelativeTimeAgo: how long before `now` `then` was, in the one
/// unit that fits.
fn fuzzy_ago(now: i128, then: i128) -> String {
    let ago = now - then;
    let about = |amount: i128, unit: &str| {
        let plural = if amount == 1 { "" } else { "s" };
        format!("about {amount} {unit}{plural} ago")
    };
    let hours = ago / NANOS_PER_HOUR;
    if ago < NANOS_PER_MINUTE {
        "less than a minute ago".to_owned()
    } else if ago < NANOS_PER_HOUR {
        about(ago / NANOS_PER_MINUTE, "minute")
    } else if hours < 24 {
        about(hours, "hour")
    } else if hours < 30 * 24 {
        about(hours / 24, "day")
    } else if hours < 365 * 24 {
        about(hours / 24 / 30, "month")
    } else {
        about(
            (ago as f64 / NANOS_PER_HOUR as f64 / 24.0 / 365.0) as i128,
            "year",
        )
    }
}

/// gh's RenderRunHeader, uncolored: the run's state, branch, workflow, the
/// pull request it ran for, its ID and attempt, then what triggered it.
fn run_header(row: &Json, ago: &str, pull: &str, attempt: u64) -> String {
    let label = if attempt > 0 {
        format!(" (Attempt #{attempt})")
    } else {
        String::new()
    };
    format!(
        "{} {} {}{pull} · {}{label}\nTriggered via {} {ago}",
        symbol(row),
        row.get("headBranch").text(),
        row.get("workflowName").text(),
        row.get("databaseId").show(),
        row.get("event").text(),
    )
}

/// gh's RenderJobs, uncolored: each job with its time and ID, and its
/// steps when `verbose` or when it failed.
fn render_jobs(jobs: &[Json], verbose: bool) -> String {
    let at = |job: &Json, key: &str| instant(&time_field(job.get(key))).unwrap_or(0);
    let mut lines = Vec::new();
    for job in jobs {
        let elapsed = at(job, "completed_at") - at(job, "started_at");
        let took = if elapsed < 0 {
            String::new()
        } else {
            format!(" in {}", go_duration(elapsed))
        };
        lines.push(format!(
            "{} {}{took} (ID {})",
            symbol(job),
            job.get("name").text(),
            job.get("id").as_int().unwrap_or(0)
        ));
        if verbose || failed(job) {
            for step in job.get("steps").items() {
                lines.push(format!("  {} {}", symbol(step), step.get("name").text()));
            }
        }
    }
    lines.join("\n")
}

/// gh's RenderAnnotations, uncolored: each annotation's level and message
/// over the job, path and line it points at.
fn render_annotations(annotations: &[(String, Json)]) -> String {
    let mut lines = Vec::new();
    for (job, annotation) in annotations {
        let level = match annotation.get("annotation_level").as_str() {
            Some("failure") => "X",
            Some("warning") => "!",
            _ => "-",
        };
        lines.push(format!("{level} {}", annotation.get("message").text()));
        lines.push(format!(
            "{job}: {}#{}\n",
            annotation.get("path").text(),
            annotation.get("start_line").as_int().unwrap_or(0)
        ));
    }
    lines.join("\n")
}

const PULL_FOR_RUN: &str = "
		query PullRequestForRun($owner: String!, $repo: String!, $headRefName: String!) {
			repository(owner: $owner, name: $repo) {
				pullRequests(headRefName: $headRefName, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
					nodes {
						number
						headRepository {
							owner {
								login
							}
							name
						}
					}
				}
			}
		}";

/// gh's PullRequestForRun: the newest pull request from the run's branch
/// of the run's own head repository, as ` OWNER/REPO#N`, or nothing.
async fn pull_for_run(account: &Account, repo: &RepoRef, row: &Json) -> String {
    let mut variables = Obj::new();
    variables.set("owner", repo.owner.as_str());
    variables.set("repo", repo.repo.as_str());
    variables.set("headRefName", row.get("headBranch").text());
    let Ok(data) = graphql_data(account, PULL_FOR_RUN, variables).await else {
        return String::new();
    };
    let head = row.get("headRepository");
    data.get("repository")
        .get("pullRequests")
        .get("nodes")
        .items()
        .iter()
        .rev()
        .find(|pull| {
            let theirs = pull.get("headRepository");
            theirs.get("owner").get("login").text() == head.get("owner").get("login").text()
                && theirs.get("name").text() == head.get("name").text()
        })
        .map(|pull| {
            format!(
                " {}/{}#{}",
                repo.owner,
                repo.repo,
                pull.get("number").as_int().unwrap_or(0)
            )
        })
        .unwrap_or_default()
}

/// Every job's annotations, or None when the token may not read them.
async fn annotations_of(
    account: &Account,
    repo: &RepoRef,
    jobs: &[Json],
) -> Result<Option<Vec<(String, Json)>>> {
    let mut out = Vec::new();
    for job in jobs {
        let id = job.get("id").as_int().unwrap_or(0);
        match job_annotations(account, repo, id).await {
            Ok(found) => out.extend(
                found
                    .items()
                    .iter()
                    .map(|one| (job.get("name").text().to_owned(), one.clone())),
            ),
            Err(Failure::Api(error)) if error.status == 404 => {}
            Err(Failure::Api(error)) if error.status == 403 => return Ok(None),
            Err(failure) => {
                return value(format!("failed to get annotations: {}", failure.text()));
            }
        }
    }
    Ok(Some(out))
}

/// `--attempt` as pflag reads a uint64; 0 is no attempt.
fn attempt_flag(flags: &Flags) -> Result<u64> {
    let Some(text) = flags.as_str("attempt") else {
        return Ok(0);
    };
    match text.parse::<u64>() {
        Ok(attempt) if text.bytes().all(|b| b.is_ascii_digit()) => Ok(attempt),
        _ => usage(format!(
            "invalid argument {} for \"-a, --attempt\" flag: strconv.ParseUint: parsing {}: invalid syntax",
            quoted(text),
            quoted(text)
        )),
    }
}

const ANNOTATIONS_FORBIDDEN: &str = "requesting annotations returned 403 Forbidden as the token does not have sufficient permissions. Note that it is not currently possible to create a fine-grained PAT with the `checks:read` permission.";

pub(crate) async fn run_view_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let attempt = attempt_flag(flags)?;
    let fields = json_fields(flags, &SINGLE_RUN_FIELDS)?;
    let job = flags.as_str("job").filter(|job| !job.is_empty());
    if texts.is_empty() && job.is_none() {
        return usage("run or job ID required when not running interactively");
    }
    let logs = flags.gh_bool("log");
    let failed_only = flags.gh_bool("log_failed");
    if logs && failed_only {
        return usage("specify only one of --log or --log-failed");
    }
    let repo = repo_for(account, flags)?;
    // A job names its own run, and gh then sets aside any run ID given.
    let selected =
        match job {
            Some(job) => Some(get_job(account, &repo, job).await.map_err(|failure| {
                Failure::Value(format!("failed to get job: {}", failure.text()))
            })?),
            None => None,
        };
    let id = match &selected {
        Some(job) => job.get("run_id").show(),
        None => texts[0].clone(),
    };
    let found = get_run(account, &repo, &id, attempt)
        .await
        .map_err(|failure| Failure::Value(format!("failed to get run: {}", failure.text())))?;
    let mut row = run(&found);
    let run_id = row.get("databaseId").as_int().unwrap_or(0);
    if let Some(fields) = &fields {
        if fields.iter().any(|field| field == "jobs") {
            let jobs = list_jobs(account, &repo, run_id, attempt).await?;
            row.set("jobs", Json::Arr(jobs.iter().map(exported_job).collect()));
        }
        return typed_out(
            account,
            &Json::Obj(row),
            flags,
            String::new(),
            &SINGLE_RUN_FIELDS,
        )
        .await;
    }
    let jobs = match &selected {
        Some(job) => vec![job.clone()],
        None => list_jobs(account, &repo, run_id, attempt)
            .await
            .map_err(|failure| Failure::Value(format!("failed to get jobs: {}", failure.text())))?,
    };
    if logs || failed_only {
        return Ok(Out {
            stdout: run_log(
                account,
                &repo,
                &row,
                &jobs,
                selected.is_some(),
                failed_only,
                attempt,
            )
            .await?,
            ..Out::default()
        });
    }
    let row = Json::Obj(row);
    let pull = pull_for_run(account, &repo, &row).await;
    let artifacts = match selected {
        Some(_) => Vec::new(),
        None => list_artifacts(account, &repo, run_id)
            .await
            .map_err(|failure| {
                Failure::Value(format!("failed to get artifacts: {}", failure.text()))
            })?,
    };
    let annotations = annotations_of(account, &repo, &jobs).await?;
    let (reply, _) = account.host.ask(Request::Now).await;
    let now = (reply.now.unwrap_or(0.0) * 1e9) as i128;
    let started = if row.get("startedAt").text().is_empty() {
        row.get("createdAt")
    } else {
        row.get("startedAt")
    };
    let ago = fuzzy_ago(now, instant(&time_field(started)).unwrap_or(0));
    let url = row.get("url").text();
    let exit_status = flags.gh_bool("exit_status");
    let mut text = format!("\n{}\n\n", run_header(&row, &ago, &pull, attempt));
    let conclusion = row.get("conclusion").text();
    if (jobs.is_empty() && conclusion == "failure") || conclusion == "startup_failure" {
        text.push_str(&format!(
            "X This run likely failed because of a workflow file issue.\n\nFor more information, see: {url}\n"
        ));
        return Ok(Out {
            exit: i32::from(exit_status),
            ..Out::text(text)
        });
    }
    if selected.is_none() {
        text.push_str("JOBS\n");
    }
    text.push_str(&render_jobs(
        &jobs,
        selected.is_some() || flags.gh_bool("verbose"),
    ));
    text.push('\n');
    match &annotations {
        None => text.push_str(&format!("\nANNOTATIONS\n{ANNOTATIONS_FORBIDDEN}\n")),
        Some(found) if !found.is_empty() => {
            text.push_str(&format!("\nANNOTATIONS\n{}\n", render_annotations(found)));
        }
        Some(_) => {}
    }
    let failing = match &selected {
        Some(job) => {
            let id = job.get("id").show();
            if failed(job) {
                text.push_str(&format!(
                    "\nTo see the logs for the failed steps, try: gh run view --log-failed --job={id}\n"
                ));
            } else {
                text.push_str(&format!(
                    "\nTo see the full job log, try: gh run view --log --job={id}\n"
                ));
            }
            failed(job)
        }
        None => {
            if !artifacts.is_empty() {
                text.push_str("\nARTIFACTS\n");
                for artifact in &artifacts {
                    let expired = if artifact.get("expired").as_bool() == Some(true) {
                        " (expired)"
                    } else {
                        ""
                    };
                    text.push_str(&format!("{}{expired}\n", artifact.get("name").text()));
                }
            }
            text.push('\n');
            if failed(&row) {
                text.push_str(&format!(
                    "To see what failed, try: gh run view {run_id} --log-failed\n"
                ));
            } else if jobs.len() == 1 {
                text.push_str(&format!(
                    "For more information about the job, try: gh run view --job={}\n",
                    jobs[0].get("id").show()
                ));
            } else {
                text.push_str(
                    "For more information about a job, try: gh run view --job=<job-id>\n",
                );
            }
            failed(&row)
        }
    };
    text.push_str(&format!("View this run on GitHub: {url}\n"));
    Ok(Out {
        exit: i32::from(exit_status && failing),
        ..Out::text(text)
    })
}

/// A job's name as the archive spells it: the `/` and `:` the server
/// drops, cut to 90 UTF-16 code units the way C# cuts a string, a half
/// surrogate pair read as U+FFFD, and trimmed.
fn log_name(name: &str) -> String {
    let units: Vec<u16> = name
        .chars()
        .filter(|c| !matches!(c, '/' | ':'))
        .collect::<String>()
        .encode_utf16()
        .take(JOB_NAME_MAX_LENGTH)
        .collect();
    String::from_utf16_lossy(&units).trim().to_owned()
}

/// A log's lines as bufio.Scanner splits them.
fn log_lines(data: &[u8]) -> Vec<&[u8]> {
    let mut lines: Vec<&[u8]> = data.split(|b| *b == b'\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .collect()
}

const LOG_WINDOW: usize = 1 << 20;

struct ZipEntry {
    name: String,
    method: u16,
    crc: u32,
    compressed: usize,
    offset: usize,
}

struct Zip<'a> {
    data: &'a [u8],
    entries: Vec<ZipEntry>,
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

impl Zip<'_> {
    /// The archive's central directory, or None for what is no zip.
    fn open(data: &[u8]) -> Option<Zip<'_>> {
        if data.len() < 22 {
            return None;
        }
        let lowest = data.len().saturating_sub(22 + 0xffff);
        let end = (lowest..=data.len() - 22)
            .rev()
            .find(|at| u32_at(data, *at) == Some(0x0605_4b50))?;
        let count = usize::from(u16_at(data, end + 10)?);
        let mut at = u32_at(data, end + 16)? as usize;
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            if u32_at(data, at)? != 0x0201_4b50 {
                return None;
            }
            let name_len = usize::from(u16_at(data, at + 28)?);
            let extra_len = usize::from(u16_at(data, at + 30)?);
            let comment_len = usize::from(u16_at(data, at + 32)?);
            entries.push(ZipEntry {
                name: String::from_utf8_lossy(data.get(at + 46..at + 46 + name_len)?).into_owned(),
                method: u16_at(data, at + 10)?,
                crc: u32_at(data, at + 16)?,
                compressed: u32_at(data, at + 20)? as usize,
                offset: u32_at(data, at + 42)? as usize,
            });
            at += 46 + name_len + extra_len + comment_len;
        }
        Some(Zip { data, entries })
    }

    async fn read(&self, account: &Account, name: &str) -> Result<Vec<u8>> {
        let broken = || Failure::Value("zip: not a valid zip file".to_owned());
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .ok_or_else(broken)?;
        let name_len = usize::from(u16_at(self.data, entry.offset + 26).ok_or_else(broken)?);
        let extra_len = usize::from(u16_at(self.data, entry.offset + 28).ok_or_else(broken)?);
        let start = entry.offset + 30 + name_len + extra_len;
        let body = self
            .data
            .get(start..start + entry.compressed)
            .ok_or_else(broken)?;
        let out = match entry.method {
            0 => body.to_vec(),
            8 => inflated(account, body).await?,
            _ => return Err(broken()),
        };
        checked(out, entry.crc)
    }
}

/// A deflated entry a window at a time, each window held to the workspace's
/// memory and giving the host its turn.
async fn inflated(account: &Account, body: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = flate2::read::DeflateDecoder::new(body);
    let mut window = vec![0; LOG_WINDOW];
    let mut out = Vec::new();
    loop {
        let read = decoder
            .read(&mut window)
            .map_err(|_| Failure::Value("zip: checksum error".to_owned()))?;
        if read == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&window[..read]);
        account
            .host
            .ask(Request::Memory {
                size: out.len() as u64,
            })
            .await;
    }
}

/// An entry's bytes, refused unless they are what the directory promised.
fn checked(data: Vec<u8>, crc: u32) -> Result<Vec<u8>> {
    let mut sum = flate2::Crc::new();
    sum.update(&data);
    if sum.sum() == crc {
        Ok(data)
    } else {
        value("zip: checksum error")
    }
}

enum Source {
    Archive(String),
    Job(i128),
}

struct Segment {
    job: String,
    step: String,
    source: Source,
}

fn step_entry<'a>(names: &'a [&'a str], name: &str, number: &str) -> Option<&'a str> {
    let prefix = format!("{name}/{number}_");
    names
        .iter()
        .find(|entry| {
            entry.starts_with(&prefix) && entry.ends_with(".txt") && !entry.contains('\n')
        })
        .copied()
}

fn job_entry<'a>(names: &'a [&'a str], name: &str, negative: bool) -> Option<&'a str> {
    let suffix = format!("_{name}.txt");
    names
        .iter()
        .find(|entry| {
            let Some(head) = entry.strip_suffix(&suffix) else {
                return false;
            };
            let digits = if negative {
                match head.strip_prefix('-') {
                    Some(digits) => digits,
                    None => return false,
                }
            } else {
                head
            };
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        })
        .copied()
}

/// The segments gh prints for a run's log: per job, its steps' own files
/// when the archive has any, otherwise the job's whole log from the
/// archive, otherwise the job's log fetched on its own, at most 25 of
/// those. A skipped job prints nothing, and `--log-failed` keeps only
/// failed jobs and, within them, failed steps.
fn log_segments(jobs: &[Json], names: &[&str], failed_only: bool) -> Result<Vec<Segment>> {
    let mut segments = Vec::new();
    let mut fetchers = 0;
    for job in jobs {
        let conclusion = job.get("conclusion").show();
        if conclusion == "skipped" {
            continue;
        }
        if failed_only && !FAILURE_STATES.contains(&conclusion.as_str()) {
            continue;
        }
        let title = job.get("name").show();
        let name = log_name(&title);
        let mut steps: Vec<(&Json, Option<&str>)> = job
            .get("steps")
            .items()
            .iter()
            .filter(|step| step.as_obj().is_some())
            .map(|step| (step, step_entry(names, &name, &step.get("number").show())))
            .collect();
        if steps.iter().any(|(_, file)| file.is_some()) {
            steps.sort_by_key(|(step, _)| step.get("number").as_int().unwrap_or(0));
            for (step, file) in steps {
                if failed_only && !FAILURE_STATES.contains(&step.get("conclusion").show().as_str())
                {
                    continue;
                }
                if let Some(file) = file {
                    segments.push(Segment {
                        job: title.clone(),
                        step: step.get("name").show(),
                        source: Source::Archive(file.to_owned()),
                    });
                }
            }
            continue;
        }
        let whole = job_entry(names, &name, false).or_else(|| job_entry(names, &name, true));
        if let Some(file) = whole {
            segments.push(Segment {
                job: title,
                step: "UNKNOWN STEP".to_owned(),
                source: Source::Archive(file.to_owned()),
            });
            continue;
        }
        segments.push(Segment {
            job: title,
            step: "UNKNOWN STEP".to_owned(),
            source: Source::Job(job.get("id").as_int().unwrap_or(0)),
        });
        fetchers += 1;
        if fetchers > MAX_API_LOG_FETCHERS {
            return value(
                "too many API requests needed to fetch logs; try narrowing down to a specific job with the `--job` option",
            );
        }
    }
    Ok(segments)
}

async fn api_job_log(account: &Account, repo: &RepoRef, job: i128) -> Result<Vec<u8>> {
    match job_log(account, repo, job).await {
        Err(Failure::Api(error)) if error.status == 404 => value(format!("log not found: {job}")),
        other => other,
    }
}

/// `gh run view --log` and `--log-failed`: printed a line at a time
/// behind the job and step it came from, the run's jobs or the one
/// `--job` selected.
async fn run_log(
    account: &Account,
    repo: &RepoRef,
    row: &Obj,
    jobs: &[Json],
    selected: bool,
    failed_only: bool,
    attempt: u64,
) -> Result<Vec<u8>> {
    let id = row.get("databaseId").as_int().unwrap_or(0);
    if let (true, Some(job)) = (selected, jobs.first()) {
        if job.get("status").as_str() != Some("completed") {
            return value(format!(
                "job {} is still in progress; logs will be available when it is complete",
                job.get("id").show()
            ));
        }
    }
    if row.get("status").as_str() != Some("completed") {
        return value(format!(
            "run {id} is still in progress; logs will be available when it is complete"
        ));
    }
    let data = match run_log_archive(account, repo, id, attempt).await {
        Ok(data) => data,
        Err(Failure::Api(error)) => {
            let reason = if error.status == 404 {
                "log not found".to_owned()
            } else {
                error.message
            };
            return value(format!("failed to get run log: {reason}"));
        }
        Err(failure) => return Err(failure),
    };
    let Some(archive) = Zip::open(&data) else {
        return value("failed to get run log: zip: not a valid zip file");
    };
    let names: Vec<&str> = archive
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    let segments = log_segments(jobs, &names, failed_only)?;
    let mut printed = Vec::new();
    for segment in segments {
        let log = match &segment.source {
            Source::Archive(entry) => archive.read(account, entry).await,
            Source::Job(job) => api_job_log(account, repo, *job).await,
        };
        let log = match log {
            Ok(log) => log,
            Err(failure) if printed.is_empty() => return Err(failure),
            Err(failure) => {
                return Err(Failure::Printed {
                    output: printed,
                    message: failure.text(),
                });
            }
        };
        let prefix = format!("{}\t{}\t", segment.job, segment.step);
        for line in log_lines(&log) {
            printed.extend_from_slice(prefix.as_bytes());
            printed.extend_from_slice(line);
            printed.push(b'\n');
        }
        account
            .host
            .ask(Request::Memory {
                size: printed.len() as u64,
            })
            .await;
    }
    Ok(printed)
}

pub(crate) async fn run_rerun_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let job = flags.as_str("job").filter(|job| !job.is_empty());
    let run_id = texts.first();
    if run_id.is_none() && job.is_none() {
        return usage("`<run-id>` or `--job` required when not running interactively");
    }
    let repo = repo_for(account, flags)?;
    let mut debug = Obj::new();
    debug.set("enable_debug_logging", true);
    let debug = Json::Obj(debug);
    let body = flags.gh_bool("debug").then_some(&debug);
    if let Some(job) = job {
        let found = get_job(account, &repo, job)
            .await
            .map_err(|failure| Failure::Value(format!("failed to get job: {}", failure.text())))?;
        let id = found.get("id").show();
        return match rerun_job(account, &repo, &id, body).await {
            Err(Failure::Api(error)) if error.status == 403 => {
                value(format!("job {id} cannot be rerun"))
            }
            Err(failure) => value(format!("failed to rerun: {}", failure.text())),
            Ok(_) => Ok(Out::default()),
        };
    }
    let found = get_run(account, &repo, &run_id.cloned().unwrap_or_default(), 0)
        .await
        .map_err(|failure| Failure::Value(format!("failed to get run: {}", failure.text())))?;
    let id = found.get("id").show();
    let suffix = if flags.gh_bool("failed") {
        "rerun-failed-jobs"
    } else {
        "rerun"
    };
    match rerun(account, &repo, &id, suffix, body).await {
        Err(Failure::Api(error)) if error.status == 403 => {
            value(format!("run {id} cannot be rerun; {}", error.joined))
        }
        Err(failure) => value(format!("failed to rerun: {}", failure.text())),
        Ok(_) => Ok(Out::default()),
    }
}

pub(crate) async fn workflow_list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    json_fields(flags, &WORKFLOW_FIELDS)?;
    let all = flags.gh_bool("all");
    let repo = repo_for(account, flags)?;
    let limit = limit_or_refuse(flags, 50)?;
    let rows: Vec<Obj> = list_workflows(account, &repo, limit, move |row| {
        all || row.get("state").as_str() == Some("active")
    })
    .await
    .map_err(|failure| Failure::Value(format!("could not get workflows: {}", failure.text())))?
    .iter()
    .map(workflow)
    .collect();
    let human: String = rows
        .iter()
        .map(|row| {
            format!(
                "{}\t{}\t{}\n",
                row.get("name").show(),
                row.get("state").show(),
                row.get("id").show()
            )
        })
        .collect();
    let data = Json::Arr(rows.into_iter().map(Json::Obj).collect());
    typed_out(account, &data, flags, human, &WORKFLOW_FIELDS).await
}

pub(crate) async fn workflow_view_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let name = texts.first().map_or("", String::as_str);
    if name.is_empty() {
        return usage("workflow argument required when not running interactively");
    }
    let yaml = flags.gh_bool("yaml");
    let git_ref = flags.as_str("ref").unwrap_or("");
    if !yaml && !git_ref.is_empty() {
        return usage("`--yaml` required when specifying `--ref`");
    }
    let repo = repo_for(account, flags)?;
    let row = workflow(&the_workflow(account, &repo, name, &["active"]).await?);
    if !yaml {
        return Ok(Out::text(
            workflow_info(account, &repo, &row)
                .await
                .map_err(|failure| {
                    Failure::Value(format!("failed to get runs: {}", failure.text()))
                })?,
        ));
    }
    Ok(Out {
        stdout: workflow_yaml(account, &repo, &row.get("path").show(), git_ref).await?,
        ..Out::default()
    })
}

async fn workflow_runs_page(
    account: &Account,
    path: &str,
    params: &[(String, String)],
) -> Result<Json> {
    let response = github_request_response(account, "GET", path, None, params, &[]).await?;
    Ok(response.data.into_json())
}

/// A workflow and its recent runs, as `gh workflow view` prints them when
/// nothing is a terminal.
async fn workflow_info(account: &Account, repo: &RepoRef, row: &Obj) -> Result<String> {
    let id = row.get("id").show();
    let path = row.get("path").show();
    let base = path.rsplit('/').next().unwrap_or(&path).to_owned();
    let name = row.get("name").show();
    let response = workflow_runs_page(
        account,
        &format!(
            "/repos/{}/{}/actions/workflows/{id}/runs",
            repo.owner, repo.repo
        ),
        &[
            ("per_page".to_owned(), "5".to_owned()),
            ("exclude_pull_requests".to_owned(), "true".to_owned()),
        ],
    )
    .await?;
    let total = response.get("total_count").as_int().unwrap_or(0);
    let (reply, _) = account.host.ask(Request::Now).await;
    let now = (reply.now.unwrap_or(0.0) * 1e9) as i128;
    let mut text = format!("{name} - {base}\nID: {id}\n\nTotal runs {total}\n");
    if total != 0 {
        text.push_str("Recent runs\n");
    }
    for raw in response.get("workflow_runs").items() {
        let found = run(raw);
        let started = if found.get("startedAt").truthy() {
            found.get("startedAt")
        } else {
            found.get("createdAt")
        };
        let end = if found.get("status").as_str() == Some("completed") {
            found
                .get("updatedAt")
                .as_str()
                .and_then(instant)
                .unwrap_or(0)
        } else {
            now
        };
        let span = end - started.as_str().and_then(instant).unwrap_or(0);
        let rounded = (span.max(0) + 500_000_000) / 1_000_000_000 * 1_000_000_000;
        text.push_str(&tsv(&[
            found.get("status").show(),
            found.get("conclusion").as_str().unwrap_or("").to_owned(),
            found.get("displayTitle").show(),
            name.clone(),
            found.get("headBranch").show(),
            found.get("event").show(),
            go_duration(rounded),
            found.get("databaseId").show(),
        ]));
    }
    text.push('\n');
    if total != 0 {
        text.push_str(&format!(
            "To see more runs for this workflow, try: gh run list --workflow {base}\n"
        ));
    }
    text.push_str(&format!(
        "To see the YAML for this workflow, try: gh workflow view {base} --yaml\n"
    ));
    Ok(text)
}

async fn workflow_yaml(
    account: &Account,
    repo: &RepoRef,
    path: &str,
    git_ref: &str,
) -> Result<Vec<u8>> {
    let base = path.rsplit('/').next().unwrap_or(path);
    let wanted = (!git_ref.is_empty()).then_some(git_ref);
    let mut content = match workflow_content(account, repo, path, wanted).await {
        Ok(content) => content,
        Err(Failure::Api(error)) => {
            if error.status != 404 {
                return value(format!(
                    "could not get workflow file content: {}",
                    error.message
                ));
            }
            if git_ref.is_empty() {
                return value(format!(
                    "could not find workflow file {base}, try specifying a branch or tag using `--ref`"
                ));
            }
            return value(format!(
                "could not find workflow file {base} on {git_ref}, try specifying a different ref"
            ));
        }
        Err(failure) => return Err(failure),
    };
    if content.last() != Some(&b'\n') {
        content.push(b'\n');
    }
    Ok(content)
}

fn key_value(pair: &str) -> Result<(&str, &str)> {
    match pair.split_once('=') {
        Some(found) => Ok(found),
        None => value(format!(
            "field {} requires a value separated by an '=' sign",
            quoted(pair)
        )),
    }
}

async fn workflow_inputs(account: &Account, flags: &Flags) -> Result<Obj> {
    if flags.gh_bool("json") {
        let bytes = read_cli_file(account, None, Some("-"), "--json").await?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let parsed = Json::parse(text.as_bytes())
            .map_err(|err| Failure::Value(format!("could not parse provided JSON: {err}")))?;
        let kind = match parsed {
            Json::Obj(inputs) => return Ok(inputs),
            Json::Null => return Ok(Obj::new()),
            Json::Bool(_) => "bool",
            Json::Int(_) | Json::Float(_) => "number",
            Json::Str(_) => "string",
            Json::Arr(_) => "array",
        };
        return value(format!(
            "could not parse provided JSON: json: cannot unmarshal {kind} into Go value of type map[string]interface {{}}"
        ));
    }
    let mut inputs = Obj::new();
    for pair in flags.as_list("raw_field") {
        let (key, item) = key_value(&pair)?;
        inputs.set(key, item);
    }
    for pair in flags.as_list("field") {
        let (key, item) = key_value(&pair)?;
        if let Some(path) = item.strip_prefix('@') {
            let bytes = read_cli_file(account, None, Some(path), "--field").await?;
            inputs.set(key, String::from_utf8_lossy(&bytes).into_owned());
        } else {
            inputs.set(key, item);
        }
    }
    Ok(inputs)
}

pub(crate) async fn workflow_run_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    let name = texts.first().map_or("", String::as_str);
    if name.is_empty() {
        if !flags.as_list("field").is_empty() || !flags.as_list("raw_field").is_empty() {
            return usage("workflow argument required when passing -f or -F");
        }
        return usage("workflow ID, name, or filename required when not running interactively");
    }
    let repo = repo_for(account, flags)?;
    let branch = match flags.as_nonempty("ref") {
        Some(branch) => branch.to_owned(),
        None => github_repo(account, &repo)
            .await
            .map_err(|failure| {
                Failure::Value(format!(
                    "unable to determine default branch for {}/{}: {}",
                    repo.owner,
                    repo.repo,
                    failure.text()
                ))
            })?
            .get("defaultBranchRef")
            .get("name")
            .text()
            .to_owned(),
    };
    if branch.is_empty() {
        return value("a workflow ref is required");
    }
    let mut body = Obj::new();
    body.set("ref", branch);
    body.set("inputs", workflow_inputs(account, flags).await?);
    dispatch_workflow(account, &repo, name, body)
        .await
        .map_err(|failure| {
            Failure::Value(format!(
                "could not create workflow dispatch event: {}",
                failure.text()
            ))
        })?;
    Ok(Out::default())
}

async fn run_action(
    account: &Account,
    flags: &Flags,
    texts: &[String],
    method: &str,
    tail: &str,
    missing: &str,
    conflict: &str,
) -> Result<(RepoRef, String)> {
    let Some(id) = texts.first() else {
        return usage("run ID required when not running interactively");
    };
    let repo = repo_for(account, flags)?;
    let path = format!("/repos/{}/{}/actions/runs/{id}", repo.owner, repo.repo);
    match get_run(account, &repo, id, 0).await {
        Err(Failure::Api(error)) if error.status == 404 => {
            return value(format!("{missing} {id}"));
        }
        Err(failure) => return Err(failure),
        Ok(_) => {}
    }
    match github_request(account, method, &format!("{path}{tail}"), None).await {
        Err(Failure::Api(error)) if error.status == 409 => value(conflict),
        Err(failure) => Err(failure),
        Ok(_) => Ok((repo, id.clone())),
    }
}

pub(crate) async fn run_cancel_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    if let Some(id) = texts.first().filter(|id| id.parse::<i64>().is_err()) {
        return value(format!("invalid run-id {}", quoted(id)));
    }
    let force = flags.gh_bool("force");
    let tail = if force { "/force-cancel" } else { "/cancel" };
    let (_, id) = run_action(
        account,
        flags,
        texts,
        "POST",
        tail,
        "Could not find any workflow run with ID",
        "Cannot cancel a workflow run that is completed",
    )
    .await?;
    let kind = if force { "force cancel" } else { "cancel" };
    Ok(Out::text(format!(
        "✓ Request to {kind} workflow {id} submitted.\n"
    )))
}

pub(crate) async fn run_delete_cmd(
    account: &Account,
    flags: &Flags,
    texts: &[String],
) -> Result<Out> {
    run_action(
        account,
        flags,
        texts,
        "DELETE",
        "",
        "could not find any workflow run with ID",
        "cannot delete a workflow run that is completed",
    )
    .await?;
    Ok(Out::text("✓ Request to delete workflow run submitted.\n"))
}

pub(crate) async fn workflow_toggle(
    account: &Account,
    flags: &Flags,
    texts: &[String],
    enable: bool,
) -> Result<Out> {
    let Some(selector) = texts.first() else {
        return usage("workflow ID or name required when not running interactively");
    };
    let repo = repo_for(account, flags)?;
    let states: &[&str] = if enable {
        &["disabled_manually", "disabled_inactivity"]
    } else {
        &["active"]
    };
    let id = the_workflow(account, &repo, selector, states)
        .await?
        .get("id")
        .show();
    let action = if enable { "enable" } else { "disable" };
    github_request(
        account,
        "PUT",
        &format!(
            "/repos/{}/{}/actions/workflows/{id}/{action}",
            repo.owner, repo.repo
        ),
        None,
    )
    .await
    .map_err(|failure| {
        Failure::Value(format!("failed to {action} workflow: {}", failure.text()))
    })?;
    Ok(Out::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_name_loses_what_the_server_drops_and_its_tail() {
        assert_eq!(log_name(" a/b:c "), "abc");
        assert_eq!(log_name(&"x".repeat(100)).len(), 90);
    }

    #[test]
    fn a_long_name_cut_inside_a_surrogate_pair_keeps_a_replacement() {
        let name = format!("{}😀", "x".repeat(89));
        assert_eq!(log_name(&name), format!("{}\u{fffd}", "x".repeat(89)));
    }

    #[test]
    fn log_lines_drop_carriage_returns_and_a_final_empty_line() {
        assert_eq!(log_lines(b"a\r\nb\n"), [b"a".as_slice(), b"b".as_slice()]);
        assert_eq!(
            log_lines(b"a\n\nb"),
            [b"a".as_slice(), b"".as_slice(), b"b".as_slice()]
        );
    }

    #[test]
    fn a_failed_step_finds_its_file_and_others_stay_out() {
        let jobs = Json::parse(
            br#"[{"name":"build","conclusion":"failure","id":1,"steps":[
                {"number":1,"name":"ok","conclusion":"success"},
                {"number":2,"name":"bad","conclusion":"failure"}]}]"#,
        )
        .unwrap();
        let names = ["build/1_ok.txt", "build/2_bad.txt"];
        let segments = log_segments(jobs.items(), &names, true).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].step, "bad");
    }

    #[test]
    fn a_log_entry_must_match_its_checksum() {
        let mut sum = flate2::Crc::new();
        sum.update(b"log");
        assert_eq!(checked(b"log".to_vec(), sum.sum()).unwrap(), b"log");
        assert!(checked(b"lag".to_vec(), sum.sum()).is_err());
    }

    #[test]
    fn bytes_that_are_no_zip_are_refused() {
        assert!(Zip::open(b"not a zip").is_none());
    }

    const UPLOAD: &[u8] = br#"{"id":399,"run_id":200,"name":"upload","status":"completed",
        "conclusion":"failure","started_at":"2025-12-31T00:00:41Z",
        "completed_at":"2025-12-31T00:01:30Z",
        "html_url":"https://github.com/o/r/actions/runs/200/job/399","steps":[
        {"number":1,"name":"Set up job","status":"completed","conclusion":"success",
         "started_at":"2025-12-31T00:00:41Z","completed_at":"2025-12-31T00:00:42Z"},
        {"number":2,"name":"Upload","status":"completed","conclusion":"failure",
         "started_at":"2025-12-31T00:00:42Z","completed_at":"2025-12-31T00:01:29Z"},
        {"number":3,"name":"Notify","status":"completed","conclusion":"skipped",
         "started_at":null,"completed_at":null}]}"#;

    #[test]
    fn a_job_exports_sorted_with_go_zero_times_for_what_it_lacks() {
        let job = Json::parse(UPLOAD).unwrap();
        assert_eq!(
            exported_job(&job).dump(),
            concat!(
                r#"{"completedAt":"2025-12-31T00:01:30Z","conclusion":"failure","#,
                r#""databaseId":399,"name":"upload","startedAt":"2025-12-31T00:00:41Z","#,
                r#""status":"completed","steps":["#,
                r#"{"completedAt":"2025-12-31T00:00:42Z","conclusion":"success","name":"Set up job","number":1,"startedAt":"2025-12-31T00:00:41Z","status":"completed"},"#,
                r#"{"completedAt":"2025-12-31T00:01:29Z","conclusion":"failure","name":"Upload","number":2,"startedAt":"2025-12-31T00:00:42Z","status":"completed"},"#,
                r#"{"completedAt":"0001-01-01T00:00:00Z","conclusion":"skipped","name":"Notify","number":3,"startedAt":"0001-01-01T00:00:00Z","status":"completed"}],"#,
                r#""url":"https://github.com/o/r/actions/runs/200/job/399"}"#
            )
        );
    }

    #[test]
    fn a_queued_job_exports_null_conclusion_as_empty_and_no_steps_as_empty() {
        let job = Json::parse(br#"{"id":7,"status":"queued","conclusion":null}"#).unwrap();
        let out = exported_job(&job);
        assert_eq!(out.get("conclusion").as_str(), Some(""));
        assert_eq!(
            out.get("completedAt").as_str(),
            Some("0001-01-01T00:00:00Z")
        );
        assert_eq!(out.get("steps").dump(), "[]");
    }

    #[test]
    fn a_failed_job_lists_its_steps_and_a_passing_one_only_when_verbose() {
        let failed = Json::parse(UPLOAD).unwrap();
        let passed = Json::parse(
            br#"{"id":398,"name":"build","status":"completed","conclusion":"success",
                "started_at":"2025-12-31T00:00:02Z","completed_at":"2025-12-31T00:00:40Z",
                "steps":[{"name":"Set up job","status":"completed","conclusion":"success"}]}"#,
        )
        .unwrap();
        let jobs = [passed, failed];
        assert_eq!(
            render_jobs(&jobs, false),
            "✓ build in 38s (ID 398)\nX upload in 49s (ID 399)\n  ✓ Set up job\n  X Upload\n  - Notify"
        );
        assert!(render_jobs(&jobs, true).starts_with("✓ build in 38s (ID 398)\n  ✓ Set up job\n"));
    }

    #[test]
    fn a_running_job_has_no_elapsed_time() {
        let job = Json::parse(
            br#"{"id":8,"name":"lint","status":"in_progress","conclusion":null,
                "started_at":"2026-01-01T00:00:00Z","completed_at":null,"steps":[]}"#,
        )
        .unwrap();
        assert_eq!(render_jobs(&[job], true), "* lint (ID 8)");
    }

    #[test]
    fn the_header_names_branch_workflow_pull_request_and_attempt() {
        let row = Json::parse(
            br#"{"status":"completed","conclusion":"failure","headBranch":"fix",
                "workflowName":"CI","databaseId":200,"event":"pull_request"}"#,
        )
        .unwrap();
        assert_eq!(
            run_header(&row, "about 2 hours ago", " o/r#7", 2),
            "X fix CI o/r#7 · 200 (Attempt #2)\nTriggered via pull_request about 2 hours ago"
        );
        assert_eq!(
            run_header(&row, "less than a minute ago", "", 0),
            "X fix CI · 200\nTriggered via pull_request less than a minute ago"
        );
    }

    #[test]
    fn annotations_print_level_message_and_where_with_a_blank_line_between() {
        let failure = Json::parse(
            br#"{"annotation_level":"failure","message":"exit 1","path":".github","start_line":28}"#,
        )
        .unwrap();
        let warning =
            Json::parse(br#"{"annotation_level":"warning","message":"slow","path":"a.py"}"#)
                .unwrap();
        assert_eq!(
            render_annotations(&[("format".to_owned(), failure), ("lint".to_owned(), warning)]),
            "X exit 1\nformat: .github#28\n\n! slow\nlint: a.py#0\n"
        );
    }

    #[test]
    fn fuzzy_ago_names_the_largest_unit_and_its_plural() {
        let minute = NANOS_PER_MINUTE;
        let hour = NANOS_PER_HOUR;
        assert_eq!(fuzzy_ago(59 * 1_000_000_000, 0), "less than a minute ago");
        assert_eq!(fuzzy_ago(minute, 0), "about 1 minute ago");
        assert_eq!(fuzzy_ago(2 * hour + minute, 0), "about 2 hours ago");
        assert_eq!(fuzzy_ago(47 * hour, 0), "about 1 day ago");
        assert_eq!(fuzzy_ago(60 * 24 * hour, 0), "about 2 months ago");
        assert_eq!(fuzzy_ago(800 * 24 * hour, 0), "about 2 years ago");
    }

    #[test]
    fn one_job_falls_back_to_its_own_log_when_the_archive_lacks_it() {
        let job = Json::parse(UPLOAD).unwrap();
        let segments = log_segments(std::slice::from_ref(&job), &[], false).unwrap();
        assert_eq!(segments.len(), 1);
        assert!(matches!(segments[0].source, Source::Job(399)));
    }
}

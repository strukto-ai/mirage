# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import io
import json
import re
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from mirage.commands.cli.builtin.gh.accessor import (
    camel,
    gh_bool,
    list_limit,
    read_cli_file,
    repo_for,
    text_out,
    typed_out,
)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import PartialOutputError, UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.actions import (
    dispatch_workflow,
    get_run,
    get_workflow,
    job_log,
    list_jobs,
    list_runs,
    list_workflows,
    rerun,
    rerun_job,
    run_log_archive,
    workflow_content,
)
from mirage.core.github.client import GitHubApiError, GitHubConnectionError
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import RepoRef, view_repo
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

RUN_FIELDS = (
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
)
WORKFLOW_FIELDS = ("id", "name", "path", "state")
# The conclusions gh's `--log-failed` keeps (run/shared IsFailureState).
FAILURE_STATES = frozenset(
    ("action_required", "failure", "startup_failure", "timed_out")
)
# How many jobs gh will fetch one by one when the archive lacks their logs.
MAX_API_LOG_FETCHERS = 25
# gh's cap on a job name in an archive path, in UTF-16 code units, since
# the server that writes the archive truncates in C#.
JOB_NAME_MAX_LENGTH = 90


def _run(value: JsonValue) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    if "id" in result:
        result["databaseId"] = result.pop("id")
    if "htmlUrl" in result:
        result["url"] = result.pop("htmlUrl")
    if "runAttempt" in result:
        result["attempt"] = result.pop("runAttempt")
    if "runNumber" in result:
        result["number"] = result.pop("runNumber")
    if "workflowId" in result:
        result["workflowDatabaseId"] = result.pop("workflowId")
    result.setdefault("workflowName", result.get("name", ""))
    result.setdefault("startedAt", result.get("runStartedAt"))
    return result


def _workflow(value: JsonValue) -> dict[str, Any]:
    row = camel(value)
    return row if isinstance(row, dict) else {}


async def run_list_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    params: dict[str, str] = {}
    for flag, key in (
        ("branch", "branch"),
        ("commit", "head_sha"),
        ("event", "event"),
        ("status", "status"),
        ("user", "actor"),
        ("created", "created"),
    ):
        value = fl.as_str(flag)
        if value:
            params[key] = value
    rows = [
        _run(value)
        for value in await list_runs(
            inv.config,
            repo_for(inv, fl),
            params,
            list_limit(fl, 20),
            fl.as_str("workflow"),
        )
    ]
    human = "".join(
        f"{row.get('status', '')}\t"
        f"{row.get('conclusion', '')}\t"
        f"{row.get('displayTitle', '')}\t"
        f"{row.get('workflowName', '')}\t"
        f"{row.get('headBranch', '')}\t"
        f"{row.get('event', '')}\t{row.get('databaseId', '')}\n"
        for row in rows
    )
    return await typed_out(rows, fl, human, RUN_FIELDS)


async def run_view_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    raw = inv.texts[0] if inv.texts else ""
    if not raw.isdigit():
        raise ValueError("a run ID is required in noninteractive mode")
    logs = gh_bool(fl, "log")
    failed_only = gh_bool(fl, "log_failed")
    if logs and failed_only:
        raise UsageError("specify only one of --log or --log-failed", 1)
    ref = repo_for(inv, fl)
    row = _run(await get_run(inv.config, ref, int(raw)))
    # `--json` is answered first, as gh's exporter is.
    if (logs or failed_only) and fl.as_str("json") is None:
        return await _run_log(inv.config, ref, row, failed_only), IOResult()
    human = (
        f"title:\t{row.get('displayTitle', '')}\n"
        f"workflow:\t{row.get('workflowName', '')}\n"
        f"status:\t{row.get('status', '')}\n"
        f"conclusion:\t{row.get('conclusion', '')}\n"
        f"branch:\t{row.get('headBranch', '')}\n"
        f"event:\t{row.get('event', '')}\n"
    )
    out, io = await typed_out(row, fl, human, RUN_FIELDS)
    if gh_bool(fl, "exit_status") and row.get("conclusion") not in (
        None,
        "",
        "success",
    ):
        io.exit_code = 1
    return out, io


def _log_name(name: str) -> str:
    """A job's name as the archive spells it (gh's
    getJobNameForLogFilename).

    The ``/`` and ``:`` the server drops, cut to 90 UTF-16 code units the
    way C# cuts a string, a half surrogate pair read as U+FFFD, and
    trimmed.

    Args:
        name (str): the job's name.
    """
    units = name.replace("/", "").replace(":", "").encode("utf-16-le")
    cut = units[: JOB_NAME_MAX_LENGTH * 2].decode("utf-16-le", "replace")
    return cut.strip()


def _log_lines(data: bytes) -> list[bytes]:
    """A log's lines as bufio.Scanner splits them.

    At each newline, a carriage return before it dropped, and no empty
    line after a final newline.

    Args:
        data (bytes): the log.
    """
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    return [line[:-1] if line.endswith(b"\r") else line for line in lines]


@dataclass(frozen=True)
class _LogSegment:
    job: str
    step: str
    read: Callable[[], Awaitable[bytes]]


def _entry_for(names: list[str], pattern: str) -> str | None:
    compiled = re.compile(pattern)
    return next((name for name in names if compiled.search(name)), None)


async def _api_job_log(config: GhConfig, ref: RepoRef, job_id: int) -> bytes:
    try:
        return await job_log(config, ref, job_id)
    except GitHubApiError as exc:
        if exc.status == 404:
            raise ValueError(f"log not found: {job_id}") from exc
        raise


def _log_segments(
    config: GhConfig,
    ref: RepoRef,
    jobs: list[dict[str, Any]],
    archive: zipfile.ZipFile,
    failed_only: bool,
) -> list[_LogSegment]:
    """The segments gh prints for a run's log (run/view
    populateLogSegments).

    Per job, its steps' own files when the archive has any, otherwise the
    job's whole log from the archive, otherwise the job's log fetched on
    its own, at most 25 of those. A skipped job prints nothing, and
    ``--log-failed`` keeps only failed jobs and, within them, failed steps.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.
        jobs (list[dict[str, Any]]): the run's jobs.
        archive (zipfile.ZipFile): the run's log archive.
        failed_only (bool): whether this is ``--log-failed``.
    """
    names = archive.namelist()
    segments: list[_LogSegment] = []
    fetchers = 0

    def read_entry(entry: str) -> Callable[[], Awaitable[bytes]]:

        async def read() -> bytes:
            return archive.read(entry)

        return read

    for job in jobs:
        conclusion = str(job.get("conclusion") or "")
        if conclusion == "skipped":
            continue
        if failed_only and conclusion not in FAILURE_STATES:
            continue
        title = str(job.get("name") or "")
        name = re.escape(_log_name(title))
        steps = [
            step for step in job.get("steps") or [] if isinstance(step, dict)
        ]
        files = {
            id(step): _entry_for(
                names, rf"^{name}/{step.get('number', '')}_.*\.txt$"
            )
            for step in steps
        }
        if any(file is not None for file in files.values()):
            for step in sorted(steps, key=lambda s: int(s.get("number") or 0)):
                if (
                    failed_only
                    and step.get("conclusion") not in FAILURE_STATES
                ):
                    continue
                file = files[id(step)]
                if file is not None:
                    segments.append(
                        _LogSegment(
                            title,
                            str(step.get("name") or ""),
                            read_entry(file),
                        )
                    )
            continue
        file = _entry_for(names, rf"^\d+_{name}\.txt$") or _entry_for(
            names, rf"^-\d+_{name}\.txt$"
        )
        if file is not None:
            segments.append(
                _LogSegment(title, "UNKNOWN STEP", read_entry(file))
            )
            continue
        job_id = int(job.get("id") or 0)

        async def fetch(job_id: int = job_id) -> bytes:
            return await _api_job_log(config, ref, job_id)

        segments.append(_LogSegment(title, "UNKNOWN STEP", fetch))
        fetchers += 1
        if fetchers > MAX_API_LOG_FETCHERS:
            raise ValueError(
                "too many API requests needed to fetch logs; try narrowing "
                "down to a specific job with the `--job` option"
            )
    return segments


async def _run_log(
    config: GhConfig, ref: RepoRef, row: dict[str, Any], failed_only: bool
) -> bytes:
    """``gh run view --log`` and ``--log-failed``.

    The run's jobs, then, once the run is complete, its log archive,
    printed a line at a time behind the job and step it came from. A run
    still going is refused before any log is asked for, in gh's words.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.
        row (dict[str, Any]): the run, as ``gh run view`` shapes it.
        failed_only (bool): whether this is ``--log-failed``.
    """
    run_id = int(row.get("databaseId") or 0)
    jobs = await list_jobs(config, ref, run_id)
    if row.get("status") != "completed":
        raise ValueError(
            f"run {run_id} is still in progress; logs will be "
            "available when it is complete"
        )
    try:
        data = await run_log_archive(config, ref, run_id)
    except GitHubApiError as exc:
        reason = "log not found" if exc.status == 404 else str(exc)
        raise ValueError(f"failed to get run log: {reason}") from exc
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError(
            "failed to get run log: zip: not a valid zip file"
        ) from exc
    printed: list[bytes] = []
    for segment in _log_segments(config, ref, jobs, archive, failed_only):
        try:
            log = await segment.read()
        except (
            ValueError,
            GitHubApiError,
            GitHubConnectionError,
            zipfile.BadZipFile,
        ) as exc:
            if not printed:
                raise
            raise PartialOutputError(str(exc), b"".join(printed)) from exc
        prefix = f"{segment.job}\t{segment.step}\t".encode()
        for line in _log_lines(log):
            printed.extend((prefix, line, b"\n"))
    return b"".join(printed)


async def run_rerun_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    raw = inv.texts[0] if inv.texts else ""
    if not raw.isdigit():
        raise ValueError("a run ID is required in noninteractive mode")
    ref = repo_for(inv, fl)
    job = fl.as_str("job")
    if job:
        if not job.isdigit():
            raise ValueError("--job expects a numeric job ID")
        await rerun_job(inv.config, ref, int(job), gh_bool(fl, "debug"))
    else:
        suffix = "rerun-failed-jobs" if gh_bool(fl, "failed") else "rerun"
        body: JsonValue = (
            {"enable_debug_logging": True} if gh_bool(fl, "debug") else None
        )
        await rerun(inv.config, ref, int(raw), suffix, body)
    return text_out("")


async def workflow_list_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    include = (
        None
        if gh_bool(fl, "all")
        else lambda row: row.get("state") == "active"
    )
    rows = [
        _workflow(value)
        for value in await list_workflows(
            inv.config, repo_for(inv, fl), list_limit(fl, 50), include=include
        )
    ]
    human = "".join(
        f"{row.get('name', '')}\t{row.get('state', '')}\t{row.get('id', '')}\n"
        for row in rows
    )
    return await typed_out(rows, fl, human, WORKFLOW_FIELDS)


async def workflow_view_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    workflow = inv.texts[0] if inv.texts else ""
    if not workflow:
        raise ValueError("a workflow ID, name, or filename is required")
    yaml = gh_bool(fl, "yaml")
    git_ref = fl.as_str("ref") or ""
    if not yaml and git_ref:
        raise UsageError("`--yaml` required when specifying `--ref`", 1)
    ref = repo_for(inv, fl)
    row = _workflow(await get_workflow(inv.config, ref, workflow))
    if not yaml:
        human = (
            f"{row.get('name', '')} - {row.get('state', '')}\n"
            f"ID: {row.get('id', '')}\nFile: {row.get('path', '')}\n"
        )
        return text_out(human)
    return await _workflow_yaml(
        inv.config, ref, str(row.get("path", "")), git_ref
    ), IOResult()


async def _workflow_yaml(
    config: GhConfig, ref: RepoRef, path: str, git_ref: str
) -> bytes:
    """``gh workflow view --yaml``: the workflow's file.

    Read from the repository at ``--ref`` or the default branch and
    printed as it is, with a newline added when it ends without one. A
    file the ref lacks is refused in gh's words.

    Args:
        config (GhConfig): the install's configuration.
        ref (RepoRef): the repository.
        path (str): the workflow's file.
        git_ref (str): the ``--ref`` given, or empty.
    """
    base = path.rsplit("/", 1)[-1]
    try:
        content = await workflow_content(config, ref, path, git_ref or None)
    except GitHubApiError as exc:
        if exc.status != 404:
            raise ValueError(
                f"could not get workflow file content: {exc}"
            ) from exc
        if git_ref:
            raise ValueError(
                f"could not find workflow file {base} on {git_ref}, "
                "try specifying a different ref"
            ) from exc
        raise ValueError(
            f"could not find workflow file {base}, try "
            "specifying a branch or tag using `--ref`"
        ) from exc
    return content if content.endswith(b"\n") else content + b"\n"


async def _workflow_inputs(
    inv: CLIInvocation[GhConfig], fl: FlagView
) -> dict[str, JsonValue]:
    if gh_bool(fl, "json"):
        if inv.stdin is None:
            raise ValueError("--json needs standard input")
        try:
            value = json.loads((await materialize(inv.stdin)).decode())
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"invalid JSON from standard input: {exc.msg}"
            ) from None
        if not isinstance(value, dict):
            raise ValueError("workflow inputs must be a JSON object")
        return value
    inputs: dict[str, JsonValue] = {}
    for pair in fl.as_list("raw_field"):
        key, sep, value = pair.partition("=")
        if not sep:
            raise ValueError(f'expected "key=value", got "{pair}"')
        inputs[key] = value
    for pair in fl.as_list("field"):
        key, sep, value = pair.partition("=")
        if not sep:
            raise ValueError(f'expected "key=value", got "{pair}"')
        inputs[key] = (
            (await read_cli_file(inv, value[1:], "--field")).decode()
            if value.startswith("@")
            else value
        )
    return inputs


async def workflow_run_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    workflow = inv.texts[0] if inv.texts else ""
    if not workflow:
        raise ValueError("a workflow ID, name, or filename is required")
    ref = repo_for(inv, fl)
    branch = fl.as_str("ref") or inv.config.branch
    if not branch:
        repo = await view_repo(inv.config, ref)
        candidate = (
            repo.get("default_branch") if isinstance(repo, dict) else None
        )
        branch = candidate if isinstance(candidate, str) else None
    if not isinstance(branch, str) or not branch:
        raise ValueError("a workflow ref is required")
    body: dict[str, JsonValue] = {
        "ref": branch,
        "inputs": await _workflow_inputs(inv, fl),
    }
    await dispatch_workflow(inv.config, ref, workflow, body)
    return text_out("")

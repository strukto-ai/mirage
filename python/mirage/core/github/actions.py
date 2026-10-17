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

import base64
import sys
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

from mirage.accessor.github import GitHubAccount
from mirage.core.github.client import github_request
from mirage.core.github.paginate import github_pages
from mirage.core.github.repo import RepoRef
from mirage.types import JsonValue

WORKFLOW_FILES = (".yml", ".yaml")
WORKFLOW_LOOKUP = 100
# gh reads every page of a run's jobs, however many there are.
ALL_JOBS = sys.maxsize


def _actions(ref: RepoRef, tail: str) -> str:
    return f"/repos/{ref.owner}/{ref.repo}/actions/{tail}"


async def resolve_workflow(
    account: GitHubAccount, ref: RepoRef, workflow: str
) -> str:
    if workflow.isdigit() or workflow.endswith(WORKFLOW_FILES):
        return workflow
    rows = await list_workflows(account, ref, WORKFLOW_LOOKUP)
    wanted = workflow.casefold()
    match = next(
        (row for row in rows if str(row.get("name", "")).casefold() == wanted),
        None,
    )
    if match is None:
        raise ValueError(f"could not find any workflows named {workflow}")
    return str(match.get("id", ""))


async def list_runs(
    account: GitHubAccount,
    ref: RepoRef,
    params: dict[str, str],
    limit: int,
    workflow: str | None = None,
) -> list[dict[str, Any]]:
    if workflow is None:
        tail = "runs"
    else:
        selector = await resolve_workflow(account, ref, workflow)
        tail = f"workflows/{quote(selector, safe='')}/runs"
    return await github_pages(
        account,
        _actions(ref, tail),
        params=params,
        limit=limit,
        key="workflow_runs",
    )


async def get_run(
    account: GitHubAccount, ref: RepoRef, run_id: int
) -> JsonValue:
    return await github_request(
        account, "GET", _actions(ref, f"runs/{run_id}")
    )


async def rerun(
    account: GitHubAccount,
    ref: RepoRef,
    run_id: int,
    suffix: str,
    body: JsonValue = None,
) -> JsonValue:
    if body is None:
        return await github_request(
            account, "POST", _actions(ref, f"runs/{run_id}/{suffix}")
        )
    return await github_request(
        account, "POST", _actions(ref, f"runs/{run_id}/{suffix}"), body
    )


async def rerun_job(
    account: GitHubAccount, ref: RepoRef, job_id: int, debug: bool
) -> JsonValue:
    return await github_request(
        account,
        "POST",
        _actions(ref, f"jobs/{job_id}/rerun"),
        {"enable_debug_logging": debug},
    )


async def list_workflows(
    account: GitHubAccount,
    ref: RepoRef,
    limit: int,
    *,
    include: Callable[[dict[str, Any]], bool] | None = None,
) -> list[dict[str, Any]]:
    return await github_pages(
        account,
        _actions(ref, "workflows"),
        limit=limit,
        key="workflows",
        include=include,
    )


async def get_workflow(
    account: GitHubAccount, ref: RepoRef, workflow: str
) -> JsonValue:
    selector = await resolve_workflow(account, ref, workflow)
    return await github_request(
        account, "GET", _actions(ref, f"workflows/{quote(selector, safe='')}")
    )


async def dispatch_workflow(
    account: GitHubAccount,
    ref: RepoRef,
    workflow: str,
    body: dict[str, JsonValue],
) -> JsonValue:
    selector = await resolve_workflow(account, ref, workflow)
    return await github_request(
        account,
        "POST",
        _actions(ref, f"workflows/{quote(selector, safe='')}/dispatches"),
        body,
    )


async def list_jobs(
    account: GitHubAccount, ref: RepoRef, run_id: int
) -> list[dict[str, Any]]:
    """A run's jobs, every page of them, as ``gh run view`` reads them.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        run_id (int): the run.
    """
    return await github_pages(
        account,
        _actions(ref, f"runs/{run_id}/jobs"),
        limit=ALL_JOBS,
        key="jobs",
    )


def _bytes_of(data: "JsonValue | bytes") -> bytes:
    if isinstance(data, bytes):
        return data
    return data.encode() if isinstance(data, str) else b""


async def run_log_archive(
    account: GitHubAccount, ref: RepoRef, run_id: int
) -> bytes:
    """A completed run's log archive, the zip GitHub ships its logs as.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        run_id (int): the run.
    """
    return _bytes_of(
        await github_request(
            account, "GET", _actions(ref, f"runs/{run_id}/logs")
        )
    )


async def job_log(account: GitHubAccount, ref: RepoRef, job_id: int) -> bytes:
    """One job's whole log, where gh turns when the archive holds none.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        job_id (int): the job.
    """
    return _bytes_of(
        await github_request(
            account, "GET", _actions(ref, f"jobs/{job_id}/logs")
        )
    )


async def workflow_content(
    account: GitHubAccount, ref: RepoRef, path: str, git_ref: str | None = None
) -> bytes:
    """A workflow file's bytes as the repository holds it.

    The one read ``gh workflow view --yaml`` makes, at ``git_ref`` or the
    default branch.

    Args:
        account (GitHubAccount): the token, API base and pool to ride.
        ref (RepoRef): the repository.
        path (str): the workflow's file.
        git_ref (str | None): the branch or tag, or None for the default.
    """
    params = {"ref": git_ref} if git_ref else None
    data = await github_request(
        account,
        "GET",
        f"/repos/{ref.owner}/{ref.repo}/contents/{path}",
        params=params,
    )
    content = data.get("content") if isinstance(data, dict) else None
    return (
        base64.b64decode("".join(content.split()))
        if isinstance(content, str)
        else b""
    )

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
import zipfile
from urllib.parse import urlencode

import pytest

from mirage.commands.cli.builtin.gh.actions import (
    run_view_cmd,
    workflow_view_cmd,
)
from mirage.commands.config import Context
from mirage.commands.errors import PartialOutputError, UsageError
from mirage.core.github.actions import list_jobs, run_log_archive
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GhConfig
from mirage.core.github.paginate import github_pages
from mirage.io.types import materialize
from mirage.types import PathSpec

CONFIG = GhConfig(token="t", repo="o/r")
RUN = "/repos/o/r/actions/runs/7"
# Each `METHOD path` answers its own reply, or fails with it when it is an
# error; every call is recorded with its query.
ROUTES: dict[str, object] = {}
CALLS: list[str] = []


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    ROUTES.clear()
    CALLS.clear()
    ROUTES[f"GET {RUN}"] = {
        "id": 7,
        "status": "completed",
        "conclusion": "failure",
        "name": "CI",
    }

    async def fake_request(
        token,
        method,
        path,
        body=None,
        params=None,
        *,
        base_url=None,
        headers=None,
    ):
        query = f"?{urlencode(params)}" if params else ""
        CALLS.append(f"{method} {path}{query}")
        reply = ROUTES.get(f"{method} {path}")
        if isinstance(reply, Exception):
            raise reply
        if reply is None:
            raise GitHubApiError("Not Found", 404)
        return reply

    monkeypatch.setitem(
        run_log_archive.__globals__, "github_request", fake_request
    )
    monkeypatch.setitem(
        github_pages.__globals__, "github_request", fake_request
    )
    assert list_jobs.__globals__ is run_log_archive.__globals__


def _args(
    texts, flags=None
) -> tuple[GhConfig, list[PathSpec], list[str], Context]:
    return CONFIG, [], list(texts), Context(flags=flags or {})


def _zip(entries: list[tuple[str, str]]) -> bytes:
    """A zip holding ``entries`` uncompressed, the shape of GitHub's log
    archive.

    Args:
        entries (list[tuple[str, str]]): each entry's name and text.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for name, text in entries:
            archive.writestr(name, text)
    return buffer.getvalue()


def _step(number: int, name: str, conclusion: str = "success") -> dict:
    return {
        "number": number,
        "name": name,
        "status": "completed",
        "conclusion": conclusion,
    }


@pytest.mark.asyncio
async def test_run_log_prints_each_line_behind_its_job_and_step():
    ROUTES[f"GET {RUN}/jobs"] = {
        "jobs": [
            {
                "id": 1,
                "name": "build / test: unit",
                "conclusion": "failure",
                "steps": [
                    _step(2, "Run tests", "failure"),
                    _step(1, "Set up job"),
                ],
            }
        ]
    }
    ROUTES[f"GET {RUN}/logs"] = _zip(
        [
            ("0_build  test unit.txt", "whole job\n"),
            ("build  test unit/1_Set up job.txt", "ready\r\n"),
            ("build  test unit/2_Run tests.txt", "one\n\ntwo"),
        ]
    )
    out, _io = await run_view_cmd(*_args(["7"], {"log": True}))
    assert await materialize(out) == (
        b"build / test: unit\tSet up job\tready\n"
        b"build / test: unit\tRun tests\tone\n"
        b"build / test: unit\tRun tests\t\n"
        b"build / test: unit\tRun tests\ttwo\n"
    )
    assert CALLS == [
        f"GET {RUN}",
        f"GET {RUN}/jobs?per_page=100&page=1",
        f"GET {RUN}/logs",
    ]


@pytest.mark.asyncio
async def test_run_log_failed_keeps_failed_jobs_and_their_failed_steps():
    ROUTES[f"GET {RUN}/jobs"] = {
        "jobs": [
            {
                "id": 1,
                "name": "lint",
                "conclusion": "success",
                "steps": [_step(1, "Lint")],
            },
            {
                "id": 2,
                "name": "test",
                "conclusion": "failure",
                "steps": [
                    _step(1, "Set up job"),
                    _step(2, "Run tests", "failure"),
                ],
            },
        ]
    }
    ROUTES[f"GET {RUN}/logs"] = _zip(
        [
            ("lint/1_Lint.txt", "clean\n"),
            ("test/1_Set up job.txt", "ready\n"),
            ("test/2_Run tests.txt", "boom\n"),
        ]
    )
    out, _io = await run_view_cmd(*_args(["7"], {"log_failed": True}))
    assert await materialize(out) == b"test\tRun tests\tboom\n"


@pytest.mark.asyncio
async def test_run_log_reads_a_jobs_whole_log_when_no_step_has_one():
    ROUTES[f"GET {RUN}/jobs"] = {
        "jobs": [
            {
                "id": 1,
                "name": "test",
                "conclusion": "success",
                "steps": [_step(1, "Run")],
            },
            {"id": 2, "name": "skipped", "conclusion": "skipped", "steps": []},
        ]
    }
    ROUTES[f"GET {RUN}/logs"] = _zip([("-2147483648_test.txt", "legacy\n")])
    out, _io = await run_view_cmd(*_args(["7"], {"log": True}))
    assert await materialize(out) == b"test\tUNKNOWN STEP\tlegacy\n"


@pytest.mark.asyncio
async def test_run_log_fetches_a_missing_job_and_names_one_with_no_log():
    ROUTES[f"GET {RUN}/jobs"] = {
        "jobs": [
            {"id": 1, "name": "a", "conclusion": "success", "steps": []},
            {"id": 2, "name": "b", "conclusion": "success", "steps": []},
        ]
    }
    ROUTES[f"GET {RUN}/logs"] = _zip([])
    ROUTES["GET /repos/o/r/actions/jobs/1/logs"] = "from the api\n"
    with pytest.raises(PartialOutputError) as caught:
        await run_view_cmd(*_args(["7"], {"log": True}))
    assert str(caught.value) == "log not found: 2"
    assert caught.value.stdout == b"a\tUNKNOWN STEP\tfrom the api\n"


@pytest.mark.asyncio
async def test_run_log_refuses_a_run_still_going_before_asking_for_a_log():
    ROUTES[f"GET {RUN}"] = {"id": 7, "status": "queued", "conclusion": None}
    ROUTES[f"GET {RUN}/jobs"] = {"jobs": []}
    with pytest.raises(
        ValueError,
        match="run 7 is still in progress; logs will be "
        "available when it is complete",
    ):
        await run_view_cmd(*_args(["7"], {"log": True}))
    assert f"GET {RUN}/logs" not in CALLS


@pytest.mark.asyncio
async def test_run_log_names_an_archive_missing_or_not_a_zip():
    ROUTES[f"GET {RUN}/jobs"] = {"jobs": []}
    with pytest.raises(
        ValueError, match="failed to get run log: log not found"
    ):
        await run_view_cmd(*_args(["7"], {"log": True}))
    ROUTES[f"GET {RUN}/logs"] = b"not a zip"
    with pytest.raises(
        ValueError, match="failed to get run log: zip: not a valid zip"
    ):
        await run_view_cmd(*_args(["7"], {"log": True}))


@pytest.mark.asyncio
async def test_run_log_takes_one_flag_and_answers_json_first():
    with pytest.raises(UsageError):
        await run_view_cmd(*_args(["7"], {"log": True, "log_failed": True}))
    assert CALLS == []
    out, _io = await run_view_cmd(
        *_args(["7"], {"log": True, "json": "status"})
    )
    assert await materialize(out) == b'{"status":"completed"}\n'


_WORKFLOW = {
    "id": 3,
    "name": "CI",
    "path": ".github/workflows/ci.yml",
    "state": "active",
}


@pytest.mark.asyncio
async def test_workflow_yaml_prints_the_file_at_the_ref(monkeypatch):
    monkeypatch.setitem(
        workflow_view_cmd.__globals__, "get_workflow", _fake_workflow
    )
    ROUTES["GET /repos/o/r/contents/.github/workflows/ci.yml"] = {
        "content": "bmFtZTogQ0kKb246IHB1c2g=\n"
    }
    out, _io = await workflow_view_cmd(
        *_args(["ci.yml"], {"yaml": True, "ref": "dev"})
    )
    assert await materialize(out) == b"name: CI\non: push\n"
    assert CALLS == [
        "GET /repos/o/r/contents/.github/workflows/ci.yml?ref=dev"
    ]


@pytest.mark.asyncio
async def test_workflow_ref_without_yaml_is_refused_before_asking():
    with pytest.raises(
        UsageError, match="`--yaml` required when specifying `--ref`"
    ):
        await workflow_view_cmd(*_args(["ci.yml"], {"ref": "dev"}))
    assert CALLS == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,message",
    [
        (
            {},
            "could not find workflow file ci.yml, try specifying a branch or "
            "tag using `--ref`",
        ),
        (
            {"ref": "dev"},
            "could not find workflow file ci.yml on dev, try specifying a "
            "different ref",
        ),
    ],
)
async def test_workflow_yaml_names_a_file_the_ref_lacks(
    monkeypatch, flags, message
):
    monkeypatch.setitem(
        workflow_view_cmd.__globals__, "get_workflow", _fake_workflow
    )
    with pytest.raises(ValueError) as caught:
        await workflow_view_cmd(*_args(["ci.yml"], {"yaml": True, **flags}))
    assert str(caught.value) == message


async def _fake_workflow(config, ref, workflow):
    return _WORKFLOW

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

import pytest

from mirage.core.github.actions import (
    dispatch_workflow,
    get_workflow,
    list_runs,
    list_workflows,
    rerun,
    resolve_workflow,
)
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import RepoRef


@pytest.mark.asyncio
async def test_list_runs_can_scope_to_a_workflow(monkeypatch):
    calls = []

    async def pages(config, path, *, params, limit, key):
        calls.append((path, params, limit, key))
        return [{"id": 1}]

    monkeypatch.setitem(list_runs.__globals__, "github_pages", pages)

    assert await list_runs(
        GhConfig(token="t"),
        RepoRef("o", "r"),
        {"status": "success"},
        5,
        "ci#nightly.yml",
    ) == [{"id": 1}]
    assert calls == [
        (
            "/repos/o/r/actions/workflows/ci%23nightly.yml/runs",
            {"status": "success"},
            5,
            "workflow_runs",
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("selector", ["101", "ci.yml", "ci.yaml"])
async def test_resolve_workflow_passes_ids_and_filenames_through(
    monkeypatch, selector
):
    async def workflows(config, ref, limit):
        raise AssertionError("an id or filename needs no lookup")

    monkeypatch.setitem(
        resolve_workflow.__globals__, "list_workflows", workflows
    )

    assert (
        await resolve_workflow(
            GhConfig(token="t"), RepoRef("o", "r"), selector
        )
        == selector
    )


@pytest.mark.asyncio
async def test_resolve_workflow_matches_a_display_name_case_insensitively(
    monkeypatch,
):
    calls = []

    async def workflows(config, ref, limit):
        calls.append(limit)
        return [{"id": 102, "name": "Archive"}, {"id": 101, "name": "CI"}]

    monkeypatch.setitem(
        resolve_workflow.__globals__, "list_workflows", workflows
    )

    assert (
        await resolve_workflow(GhConfig(token="t"), RepoRef("o", "r"), "ci")
        == "101"
    )
    assert calls == [100]


@pytest.mark.asyncio
async def test_resolve_workflow_rejects_an_unknown_display_name(monkeypatch):
    async def workflows(config, ref, limit):
        return [{"id": 101, "name": "CI"}]

    monkeypatch.setitem(
        resolve_workflow.__globals__, "list_workflows", workflows
    )

    with pytest.raises(
        ValueError, match="could not find any workflows named Nightly"
    ):
        await resolve_workflow(
            GhConfig(token="t"), RepoRef("o", "r"), "Nightly"
        )


@pytest.mark.asyncio
async def test_workflow_verbs_resolve_a_display_name_once(monkeypatch):
    calls = []

    async def workflows(config, ref, limit):
        return [{"id": 101, "name": "CI"}]

    async def request(token, method, path, body=None, *, base_url=None):
        calls.append((method, path))
        return {}

    async def pages(config, path, *, params, limit, key):
        calls.append(("GET", path))
        return []

    monkeypatch.setitem(
        resolve_workflow.__globals__, "list_workflows", workflows
    )
    monkeypatch.setitem(get_workflow.__globals__, "github_request", request)
    monkeypatch.setitem(list_runs.__globals__, "github_pages", pages)
    config = GhConfig(token="t")
    ref = RepoRef("o", "r")

    await get_workflow(config, ref, "CI")
    await dispatch_workflow(config, ref, "CI", {"ref": "main"})
    await list_runs(config, ref, {}, 5, "CI")

    assert calls == [
        ("GET", "/repos/o/r/actions/workflows/101"),
        ("POST", "/repos/o/r/actions/workflows/101/dispatches"),
        ("GET", "/repos/o/r/actions/workflows/101/runs"),
    ]


@pytest.mark.asyncio
async def test_rerun_omits_the_optional_debug_body(monkeypatch):
    calls = []

    async def request(token, method, path, *args, base_url=None):
        calls.append((method, path, args))
        return None

    monkeypatch.setitem(rerun.__globals__, "github_request", request)

    assert (
        await rerun(GhConfig(token="t"), RepoRef("o", "r"), 7, "rerun") is None
    )
    assert calls == [("POST", "/repos/o/r/actions/runs/7/rerun", ())]


@pytest.mark.asyncio
async def test_workflow_verbs_encode_the_identifier(monkeypatch):
    calls = []

    async def request(token, method, path, body=None, *, base_url=None):
        calls.append((method, path, body))
        return {}

    monkeypatch.setitem(get_workflow.__globals__, "github_request", request)
    config = GhConfig(token="t")
    ref = RepoRef("o", "r")

    await get_workflow(config, ref, "ci#nightly.yml")
    await dispatch_workflow(config, ref, "ci#nightly.yml", {"ref": "main"})

    assert calls == [
        ("GET", "/repos/o/r/actions/workflows/ci%23nightly.yml", None),
        (
            "POST",
            "/repos/o/r/actions/workflows/ci%23nightly.yml/dispatches",
            {"ref": "main"},
        ),
    ]


@pytest.mark.asyncio
async def test_list_workflows_filters_before_applying_the_limit(monkeypatch):
    seen = []

    async def pages(config, path, *, limit, key, include):
        seen.append((path, limit, key))
        rows = [
            {"id": 2, "state": "disabled_manually"},
            {"id": 1, "state": "active"},
        ]
        return [row for row in rows if include(row)][:limit]

    monkeypatch.setitem(list_workflows.__globals__, "github_pages", pages)

    rows = await list_workflows(
        GhConfig(token="t"),
        RepoRef("o", "r"),
        1,
        include=lambda row: row["state"] == "active",
    )

    assert rows == [{"id": 1, "state": "active"}]
    assert seen == [("/repos/o/r/actions/workflows", 1, "workflows")]

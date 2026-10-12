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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import unsearched_text
from mirage.core.linear.search import SEARCH_LIMIT, files_containing
from mirage.types import JsonValue, PathSpec

TEAM = {"id": "T1", "key": "ENG", "name": "Engineering"}
ISSUES_DIR = "teams/ENG__Engineering__T1/issues"
DOCS_DIR = "teams/ENG__Engineering__T1/documents"


def _issue(
    issue_id: str, title: str, state: str, description: str = ""
) -> dict:
    return {
        "id": issue_id,
        "identifier": f"ENG-{issue_id[-1]}",
        "title": title,
        "description": description,
        "team": TEAM,
        "state": {"id": "S", "name": state},
    }


ISSUES = [
    _issue("I1", "Fix the login page", "Todo"),
    _issue("I2", "Write release notes", "Blocked"),
    _issue("I3", "Docs", "Todo", "Visit wombat.example.com first"),
]
DOCUMENTS = [
    {"id": "D1", "title": "Search plan", "content": "Wombat rollout steps"},
    {"id": "D2", "title": "Runbook", "content": "Restart the workers"},
]
ALL_ISSUES = ["ENG-1__I1", "ENG-2__I2", "ENG-3__I3"]


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/linear/" + vfs_path if vfs_path else "/linear"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


async def _ask(
    text: str,
    named: list[str] | dict[str, list[str]],
    under: list[PathSpec] | None = None,
    reply: "JsonValue | Exception" = None,
    ask_linear: bool = True,
):
    accessor = LinearAccessor(LinearConfig(api_key="k", content_search=True))

    def nodes(config, query, variables, **kwargs):
        ids = (
            named.get(variables["term"], [])
            if isinstance(named, dict)
            else named
        )
        return {"searchIssues": {"nodes": [{"id": i} for i in ids]}}

    found = (
        AsyncMock(side_effect=nodes)
        if reply is None
        else AsyncMock(side_effect=[reply])
    )
    readdir = "mirage.core.linear.readdir"
    with (
        patch(f"{readdir}.list_teams", AsyncMock(return_value=[TEAM])),
        patch(f"{readdir}.list_team_issues", AsyncMock(return_value=ISSUES)),
        patch(f"{readdir}.list_team_members", AsyncMock(return_value=[])),
        patch(f"{readdir}.list_team_projects", AsyncMock(return_value=[])),
        patch(f"{readdir}.list_team_cycles", AsyncMock(return_value=[])),
        patch(
            f"{readdir}.list_team_documents",
            AsyncMock(return_value=DOCUMENTS),
        ),
        patch("mirage.core.linear.client.graphql_request", found),
    ):
        out = await files_containing(
            accessor,
            text,
            under or [_scope()],
            RAMIndexCacheStore(),
            ask_linear=ask_linear,
        )
    return out, [call.args[2]["term"] for call in found.await_args_list]


def _issues(out) -> list[str]:
    return sorted(
        p.vfs_path.rsplit("/", 2)[-2]
        for p in out
        if p.vfs_path.endswith("/issue.json")
    )


def _documents(out) -> list[str]:
    return sorted(
        p.vfs_path.rsplit("/", 1)[-1]
        for p in out
        if p.vfs_path.startswith(DOCS_DIR)
    )


def test_unsearched_text_leaves_out_title_and_description():
    kept = unsearched_text(ISSUES[0])
    assert "todo" in kept and "engineering" in kept
    assert "login" not in kept


# Linear names the issue whose title holds the word; the other is named by
# its state, which Linear's search does not read.
@pytest.mark.asyncio
async def test_hits_are_what_linear_names_and_what_the_listing_kept():
    out, asked = await _ask("Blocked", ["I1"])
    assert out is not None
    assert _issues(out) == ["ENG-1__I1", "ENG-2__I2"]
    assert asked == ["blocked", "locked"]


# Linear's search may miss a word inside a link, so the listing keeps it, and
# each word of a phrase is found in either place.
@pytest.mark.asyncio
async def test_a_word_in_a_link_is_kept_by_the_listing():
    out, asked = await _ask("visit wombat", {"visit": ["I3"]})
    assert out is not None
    assert _issues(out) == ["ENG-3__I3"]
    assert asked == ["visit", "wombat"]


# A document's listing entry keeps its text, so a document is read only when
# that text holds the word in any case, whether Linear is asked or not.
@pytest.mark.asyncio
@pytest.mark.parametrize("ask_linear", [True, False])
async def test_a_document_is_read_when_its_text_holds_it(ask_linear):
    out, _ = await _ask("WOMBAT", ["I3"], ask_linear=ask_linear)
    assert out is not None
    assert len(_documents(out)) == 1
    out, _ = await _ask("nowhere", [], [_scope(DOCS_DIR)])
    assert out == []


# Without an answer from Linear every issue is read; a scope inside an issue
# and a text that is not ASCII read every file.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, named, ask_linear",
    [
        ("title", ["I1"], True),
        ("true", ["I1"], True),
        ("q4", ["I1"], True),
        ("login", [], True),
        ("login", [f"X{i}" for i in range(SEARCH_LIMIT)], True),
        ("login", ["I1"], False),
    ],
)
async def test_an_unsure_answer_reads_every_issue(text, named, ask_linear):
    out, _ = await _ask(
        text, named, [_scope(ISSUES_DIR)], ask_linear=ask_linear
    )
    assert out is not None
    assert _issues(out) == ALL_ISSUES


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, under",
    [
        ("login", f"{ISSUES_DIR}/ENG-1__I1"),
        ("caf\u00e9", ""),
    ],
)
async def test_every_file_is_read_when_the_walk_cannot_answer(text, under):
    out, _ = await _ask(text, ["I1"], [_scope(under)])
    assert out is None


# A reply that is not a list of issues, or not JSON, is a failed search:
# I2's state holds "Blocked", but Linear may have named I1 too.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    [
        {"searchIssues": {"nodes": {}}},
        {"searchIssues": None},
        {"searchIssues": {"nodes": [{"title": "Fix the login page"}]}},
        json.JSONDecodeError("Expecting value", "<html>", 0),
    ],
)
async def test_a_garbled_reply_reads_every_issue(reply):
    out, _ = await _ask("Blocked", [], [_scope(ISSUES_DIR)], reply=reply)
    assert out is not None
    assert _issues(out) == ALL_ISSUES

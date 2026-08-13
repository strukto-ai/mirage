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

from mirage.commands.cli.builtin.gh import GH
from mirage.commands.cli.builtin.gh.api import api
from mirage.commands.cli.builtin.gh.repo import fork, rename, view
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.cli.types import CLIInvocation
from mirage.core.github.config import GhConfig
from mirage.io.types import materialize
from mirage.types import ResourceName

CONFIG = GhConfig(token="t")
CALLS: list[dict] = []
REPLY: dict = {}


def _record(**call) -> dict:
    CALLS.append(call)
    return REPLY


def _reset(reply=None) -> None:
    CALLS.clear()
    globals()["REPLY"] = {} if reply is None else reply


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    _reset()

    async def fake_view(config, ref):
        return _record(method="GET", path=f"/repos/{ref.owner}/{ref.repo}")

    async def fake_fork(config, ref, name=None):
        return _record(method="POST",
                       path=f"/repos/{ref.owner}/{ref.repo}/forks",
                       body={} if name is None else {"name": name})

    async def fake_rename(config, ref, name):
        return _record(method="PATCH",
                       path=f"/repos/{ref.owner}/{ref.repo}",
                       body={"name": name})

    async def fake_request(token,
                           method,
                           path,
                           body=None,
                           params=None,
                           *,
                           base_url=None):
        call = {"method": method, "path": path}
        if body is not None:
            call["body"] = body
        if params is not None:
            call["params"] = params
        return _record(**call)

    monkeypatch.setitem(view.__globals__, "view_repo", fake_view)
    monkeypatch.setitem(fork.__globals__, "fork_repo", fake_fork)
    monkeypatch.setitem(rename.__globals__, "rename_repo", fake_rename)
    monkeypatch.setitem(api.__globals__, "github_request", fake_request)


def _inv(texts=(), flags=None, config=CONFIG) -> CLIInvocation:
    return CLIInvocation(config, texts=tuple(texts), flags=flags or {})


def test_registers_itself_under_the_grammar_gh_uses():
    assert cli_spec_for("gh") is GH
    assert [c.name for c in GH.subcommands] == ["repo", "api"]
    assert [c.name for c in GH.subcommands[0].subcommands
            ] == ["view", "fork", "rename"]


# A gh write lands on the repository a `github` mount reads, by name rather
# than by any vfs path, so the mount cannot invalidate itself. Without this
# the executor's post-write cache drop is a no-op and a committed file still
# reads back as its pre-write bytes.
def test_names_the_mounted_resource_its_writes_invalidate():
    assert GH.serves == (ResourceName.GITHUB, )


@pytest.mark.asyncio
async def test_views_the_repository_the_operand_names():
    await view(_inv(["o/r"]))
    assert CALLS == [{"method": "GET", "path": "/repos/o/r"}]


@pytest.mark.asyncio
async def test_falls_back_to_the_install_repo():
    await view(_inv(config=GhConfig(token="t", repo="cfg/repo")))
    assert CALLS[0]["path"] == "/repos/cfg/repo"


@pytest.mark.asyncio
async def test_refuses_a_line_with_no_repository_anywhere():
    with pytest.raises(ValueError, match="no repository given"):
        await view(_inv())


@pytest.mark.asyncio
async def test_refuses_a_repository_that_is_not_owner_repo():
    with pytest.raises(ValueError, match="OWNER/REPO"):
        await view(_inv(["justaname"]))


# gh's format is [HOST/]OWNER/REPO, so the owner and repo are the *last* two
# segments. Reading the first two made `github.com/acme/tools` a request for
# `github.com/acme` -- a different repository, reported as success.
@pytest.mark.asyncio
async def test_drops_the_optional_host_rather_than_shifting_the_repo():
    await view(_inv(["github.com/acme/tools"]))
    assert CALLS[0]["path"] == "/repos/acme/tools"


@pytest.mark.asyncio
async def test_refuses_more_segments_than_a_host_and_a_repository():
    with pytest.raises(ValueError, match="OWNER/REPO"):
        await view(_inv(["a/b/c/d"]))


@pytest.mark.asyncio
async def test_names_the_fork_at_creation_time():
    _reset({"full_name": "me/renamed"})
    out, _io = await fork(_inv(["o/r"], {"fork_name": "renamed"}))
    assert CALLS == [{
        "method": "POST",
        "path": "/repos/o/r/forks",
        "body": {
            "name": "renamed"
        }
    }]
    assert b"me/renamed" in await materialize(out)


@pytest.mark.asyncio
async def test_forks_under_the_source_name_when_unnamed():
    _reset({"full_name": "me/r"})
    await fork(_inv(["o/r"]))
    assert CALLS[0]["body"] == {}


# gh takes the new name as the operand and the repository to rename as -R,
# which is the reverse of what the shape of the line suggests.
@pytest.mark.asyncio
async def test_renames_the_dash_r_repository_to_the_operand():
    _reset({"full_name": "me/after"})
    await rename(_inv(["after"], {"repo": "me/before"}))
    assert CALLS == [{
        "method": "PATCH",
        "path": "/repos/me/before",
        "body": {
            "name": "after"
        }
    }]


@pytest.mark.asyncio
async def test_api_is_a_get_with_no_fields_and_sends_them_as_query():
    await api(
        _inv(["repos/o/r/contents/x"], {
            "raw_field": ["ref=master"],
            "method": "GET"
        }))
    assert CALLS[0] == {
        "method": "GET",
        "path": "/repos/o/r/contents/x",
        "params": {
            "ref": "master"
        },
    }


@pytest.mark.asyncio
async def test_api_is_a_post_once_a_field_is_given():
    await api(_inv(["repos/o/r/issues"], {"raw_field": ["title=hi"]}))
    assert CALLS[0]["method"] == "POST"


@pytest.mark.asyncio
async def test_api_sends_dash_f_verbatim_and_reads_dash_f_as_json_types():
    await api(
        _inv(
            ["x"], {
                "method": "PUT",
                "raw_field": ["a=1"],
                "field": ["b=2", "c=true", "d=null", "e=text"],
            }))
    assert CALLS[0]["body"] == {
        "a": "1",
        "b": 2,
        "c": True,
        "d": None,
        "e": "text"
    }


@pytest.mark.asyncio
async def test_api_keeps_everything_after_the_first_equals():
    await api(_inv(["x"], {"raw_field": ["content=YQ==\n"]}))
    assert CALLS[0]["body"] == {"content": "YQ==\n"}


@pytest.mark.asyncio
async def test_api_takes_an_endpoint_with_or_without_a_leading_slash():
    await api(_inv(["/user"]))
    assert CALLS[0]["path"] == "/user"


@pytest.mark.asyncio
async def test_api_refuses_a_field_that_is_not_key_value():
    with pytest.raises(ValueError, match="key=value"):
        await api(_inv(["x"], {"raw_field": ["nope"]}))


# Real gh sends no body for a call carrying no fields, so a bare DELETE is a
# bare DELETE rather than an empty JSON object with a content type.
@pytest.mark.asyncio
async def test_api_sends_no_body_at_all_when_no_field_was_given():
    await api(_inv(["repos/o/r"], {"method": "DELETE"}))
    assert CALLS[0] == {"method": "DELETE", "path": "/repos/o/r"}


# -F types a value for a JSON body; on a GET the same value has to reach the
# query string, where everything is a string.
@pytest.mark.asyncio
async def test_api_stringifies_a_typed_field_bound_for_the_query():
    await api(
        _inv(["search/code"], {
            "method": "GET",
            "field": ["per_page=5", "draft=true"]
        }))
    assert CALLS[0]["params"] == {"per_page": "5", "draft": "true"}
    assert "body" not in CALLS[0]

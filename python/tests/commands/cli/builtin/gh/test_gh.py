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
from unittest.mock import AsyncMock

import pytest

from mirage.commands.cli.builtin.gh import GH
from mirage.commands.cli.builtin.gh.accessor import (
    body_value,
    read_cli_file,
    repo_number,
)
from mirage.commands.cli.builtin.gh.api import api
from mirage.commands.cli.builtin.gh.issue import comments_for, comments_text
from mirage.commands.cli.builtin.gh.repo import (
    delete_cmd,
    edit_cmd,
    fork,
    list_cmd,
    rename,
    summary,
    view,
)
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.errors import PartialOutputError, UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.api.client import ApiResponse
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import RepoRef, edit_repo, repository_fields
from mirage.io.types import materialize
from mirage.types import PathSpec

CONFIG = GhConfig(token="t")
CALLS: list[dict] = []
REPLY: dict = {}
RESPONSES: list[ApiResponse] = []
README: list[str | None] = [None]
_MISSING = object()


def _record(**call) -> dict:
    CALLS.append(call)
    return REPLY


def _reset(reply=None) -> None:
    CALLS.clear()
    RESPONSES.clear()
    README[0] = None
    globals()["REPLY"] = {} if reply is None else reply


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    _reset()

    async def fake_view(config, ref):
        return _record(method="GET", path=f"/repos/{ref.owner}/{ref.repo}")

    async def fake_readme(config, ref):
        return README[0]

    async def fake_fork(config, ref, body=None):
        return _record(
            method="POST",
            path=f"/repos/{ref.owner}/{ref.repo}/forks",
            body=body or {},
        )

    async def fake_rename(config, ref, name):
        return _record(
            method="PATCH",
            path=f"/repos/{ref.owner}/{ref.repo}",
            body={"name": name},
        )

    async def fake_request(
        token,
        method,
        path,
        body=_MISSING,
        params=None,
        *,
        base_url=None,
        headers=None,
    ):
        call = {"method": method, "path": path}
        if body is not _MISSING:
            call["body"] = body
        if params is not None:
            call["params"] = params
        if headers is not None:
            call["headers"] = headers
        return _record(**call)

    async def fake_response(
        token,
        method,
        path,
        body=_MISSING,
        params=None,
        *,
        base_url=None,
        headers=None,
    ):
        if body is _MISSING:
            await fake_request(
                token,
                method,
                path,
                params=params,
                base_url=base_url,
                headers=headers,
            )
        else:
            await fake_request(
                token,
                method,
                path,
                body,
                params,
                base_url=base_url,
                headers=headers,
            )
        if RESPONSES:
            answer = RESPONSES.pop(0)
            if isinstance(answer, GitHubApiError):
                raise answer
            return answer
        return ApiResponse(REPLY, 200, {})

    monkeypatch.setitem(view.__globals__, "view_repo", fake_view)
    monkeypatch.setitem(view.__globals__, "read_readme", fake_readme)
    monkeypatch.setitem(fork.__globals__, "fork_repo", fake_fork)
    monkeypatch.setitem(rename.__globals__, "rename_repo", fake_rename)
    monkeypatch.setitem(api.__globals__, "github_request", fake_request)
    monkeypatch.setitem(
        api.__globals__, "github_request_response", fake_response
    )


def _inv(
    texts=(), flags=None, config=CONFIG, stdin=None, doors=None, argv=()
) -> CLIInvocation:
    return CLIInvocation(
        config,
        argv=tuple(argv),
        texts=tuple(texts),
        flags=flags or {},
        stdin=stdin,
        doors=doors,
    )


def test_registers_itself_under_the_grammar_gh_uses():
    assert cli_spec_for("gh") is GH
    assert [c.name for c in GH.subcommands] == [
        "auth",
        "help",
        "version",
        "api",
        "issue",
        "pr",
        "repo",
        "release",
        "run",
        "workflow",
        "search",
    ]
    repo = next(c for c in GH.subcommands if c.name == "repo")
    assert [c.name for c in repo.subcommands] == [
        "list",
        "clone",
        "view",
        "create",
        "fork",
        "rename",
        "edit",
        "delete",
    ]
    groups = {
        c.name: [leaf.name for leaf in c.subcommands]
        for c in GH.subcommands
        if c.subcommands
    }
    assert groups["issue"] == [
        "list",
        "view",
        "create",
        "edit",
        "close",
        "reopen",
        "comment",
    ]
    assert groups["pr"] == [
        "list",
        "view",
        "create",
        "edit",
        "merge",
        "close",
        "comment",
        "diff",
        "checks",
    ]
    assert groups["release"] == ["list", "view", "create"]
    assert groups["run"] == ["list", "view", "rerun"]
    assert groups["workflow"] == ["list", "view", "run"]


def _path(value: str) -> PathSpec:
    return PathSpec.from_str_path(value)


def _doors(files: dict[str, bytes]) -> CLIDoors:
    async def dispatch(op, path, *args, **kwargs):
        assert op == "read"
        return files[path.virtual], None

    return CLIDoors(dispatch=dispatch)


@pytest.mark.asyncio
async def test_short_body_file_dash_reads_standard_input():
    flags = {
        "body_file": PathSpec(
            virtual="/-", directory="/", vfs_path="-", raw_path="-"
        )
    }
    for argv in (("issue", "create", "-F", "-"), ("issue", "create", "-F-")):
        value = await body_value(
            _inv(flags=flags, stdin=b"short body", argv=argv), FlagView(flags)
        )
        assert value == "short body"


def test_full_subject_url_overrides_the_configured_repository():
    flags = {"repo": "wrong/repo"}
    ref, number = repo_number(
        _inv(flags=flags),
        FlagView(flags),
        "https://github.com/acme/tools/issues/42",
        "issue",
        "issues",
    )
    assert (ref.owner, ref.repo, number) == ("acme", "tools", 42)


def test_subject_url_kind_must_match_the_verb():
    with pytest.raises(ValueError, match="pull request number"):
        repo_number(
            _inv(),
            FlagView({}),
            "https://github.com/acme/tools/issues/42",
            "pull request",
            "pull",
        )


@pytest.mark.asyncio
async def test_views_the_repository_the_operand_names():
    await view(_inv(["o/r"]))
    assert CALLS == [{"method": "GET", "path": "/repos/o/r"}]


def _graphql(monkeypatch) -> None:
    """Answer the core GraphQL client from REPLY, recording each call."""

    async def fake_request(token, method, path, body=_MISSING, **_kwargs):
        return _record(method=method, path=path, body=body)

    monkeypatch.setitem(
        repository_fields.__globals__, "github_request", fake_request
    )


@pytest.mark.asyncio
async def test_json_repo_view_asks_graphql_for_the_fields_named(monkeypatch):
    async def unexpected_readme(config, ref):
        raise AssertionError("JSON output must not fetch README content")

    monkeypatch.setitem(view.__globals__, "read_readme", unexpected_readme)
    _graphql(monkeypatch)
    _reset({"data": {"repository": {"parent": None, "name": "r"}}})
    out, _io = await view(_inv(["o/r"], {"json": "parent,name"}))
    assert CALLS == [
        {
            "method": "POST",
            "path": "graphql",
            "body": {
                "query": "query RepositoryInfo($owner: String!, $name: String!) {\n"
                "    repository(owner: $owner, name: $name) "
                "{parent{id,name,owner{id,login}},name}\n  }",
                "variables": {"owner": "o", "name": "r"},
            },
        }
    ]
    assert await materialize(out) == b'{"name":"r","parent":null}\n'


@pytest.mark.asyncio
async def test_json_output_is_ghs_compact_go_encoding(monkeypatch):
    _graphql(monkeypatch)
    text = "a<b>&c\N{LINE SEPARATOR}d\N{PARAGRAPH SEPARATOR}\b\u00e9"
    _reset({"data": {"repository": {"description": text}}})
    out, _io = await view(_inv(["o/r"], {"json": "description"}))
    assert (
        await materialize(out)
        == ('{"description":"a<b>&c\\u2028d\\u2029\\b\u00e9"}\n').encode()
    )


# gh decodes the answer into Go structs and prints those: a null string
# is "", a struct keeps every field (a user's databaseId is 0), a
# repository with no topics prints null, and projectsV2 prints its
# untagged `Nodes`.
@pytest.mark.asyncio
async def test_json_repo_view_prints_the_shape_gh_decodes(monkeypatch):
    _graphql(monkeypatch)
    _reset(
        {
            "data": {
                "repository": {
                    "description": None,
                    "assignableUsers": {
                        "nodes": [{"id": "U1", "login": "ada", "name": None}]
                    },
                    "repositoryTopics": {"nodes": []},
                    "projectsV2": {"nodes": []},
                    "latestRelease": None,
                    "watchers": {"totalCount": 3},
                    "owner": {"id": "O1", "login": "o"},
                    "parent": {
                        "id": "R0",
                        "name": "up",
                        "owner": {"id": "O0", "login": "u"},
                    },
                }
            }
        }
    )
    fields = (
        "watchers,parent,owner,latestRelease,projectsV2,"
        "repositoryTopics,assignableUsers,description"
    )
    out, _io = await view(_inv(["o/r"], {"json": fields}))
    printed = json.loads(await materialize(out))
    assert printed == {
        "assignableUsers": [
            {"id": "U1", "login": "ada", "name": "", "databaseId": 0}
        ],
        "description": "",
        "latestRelease": None,
        "owner": {"id": "O1", "login": "o"},
        "parent": {
            "id": "R0",
            "name": "up",
            "owner": {"id": "O0", "login": "u"},
        },
        "projectsV2": {"Nodes": []},
        "repositoryTopics": None,
        "watchers": {"totalCount": 3},
    }
    assert list(printed) == sorted(printed)


@pytest.mark.asyncio
async def test_json_repo_view_refuses_an_unknown_field_before_asking(
    monkeypatch,
):
    _graphql(monkeypatch)
    with pytest.raises(UsageError) as caught:
        await view(_inv(["o/r"], {"json": "isFork,bogus"}))
    assert caught.value.exit_code == 1
    assert str(caught.value).startswith(
        'Unknown JSON field: "bogus"\nAvailable fields:\n  archivedAt\n'
        "  assignableUsers\n"
    )
    assert CALLS == []


@pytest.mark.asyncio
async def test_json_repo_view_words_a_graphql_error_as_gh_does(monkeypatch):
    _graphql(monkeypatch)
    _reset(
        {
            "data": {"repository": None},
            "errors": [
                {
                    "message": "Could not resolve to a Repository with the name 'o/r'.",
                    "path": ["repository"],
                }
            ],
        }
    )
    with pytest.raises(
        ValueError,
        match=r"^GraphQL: Could not resolve to a Repository "
        r"with the name 'o/r'\. \(repository\)$",
    ):
        await view(_inv(["o/r"], {"json": "name"}))


@pytest.mark.asyncio
async def test_json_repo_list_asks_graphql_for_the_owner(monkeypatch):
    _graphql(monkeypatch)
    _reset(
        {
            "data": {
                "repositoryOwner": {
                    "repositories": {
                        "nodes": [{"name": "a", "isFork": True}],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            }
        }
    )
    out, _io = await list_cmd(
        _inv(["acme"], {"json": "name,isFork", "limit": 5})
    )
    assert len(CALLS) == 1
    body = CALLS[0]["body"]
    assert "repositoryOwner(login: $owner)" in body["query"]
    assert "nodes{name,isFork}" in body["query"]
    assert body["variables"] == {"perPage": 5, "owner": "acme"}
    assert json.loads(await materialize(out)) == [
        {"isFork": True, "name": "a"}
    ]


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
    assert CALLS == [
        {
            "method": "POST",
            "path": "/repos/o/r/forks",
            "body": {"name": "renamed"},
        }
    ]
    assert b"me/renamed" in await materialize(out)


@pytest.mark.asyncio
async def test_forks_under_the_source_name_when_unnamed():
    _reset({"full_name": "me/r"})
    await fork(_inv(["o/r"]))
    assert CALLS[0]["body"] == {}


@pytest.mark.asyncio
async def test_refuses_a_remote_for_the_current_repository():
    with pytest.raises(ValueError, match="--remote is not supported"):
        await fork(
            _inv([], {"remote": "true"}, GhConfig(token="t", repo="o/r"))
        )


@pytest.fixture()
def _core_repo(monkeypatch):
    """Route the core repository calls through the recorder."""

    async def fake_request(
        token,
        method,
        path,
        body=_MISSING,
        params=None,
        *,
        base_url=None,
        headers=None,
    ):
        call = {"method": method, "path": path}
        if body is not _MISSING:
            call["body"] = body
        return _record(**call)

    monkeypatch.setitem(edit_repo.__globals__, "github_request", fake_request)


@pytest.mark.asyncio
async def test_repo_edit_sends_one_patch_and_prints_nothing(_core_repo):
    _reset(
        {
            "names": ["old", "keep"],
            "data": {"repository": {"viewerCanAdminister": True}},
        }
    )
    out, _io = await edit_cmd(
        _inv(
            ["o/r"],
            {
                "description": "d",
                "enable_wiki": "false",
                "template": True,
                "enable_secret_scanning": "false",
                "add_topic": ["new,keep"],
                "remove_topic": ["old"],
            },
        )
    )
    assert out == b""
    assert [(c["method"], c["path"], c.get("body")) for c in CALLS[1:]] == [
        (
            "PATCH",
            "/repos/o/r",
            {
                "description": "d",
                "has_wiki": False,
                "is_template": True,
                "security_and_analysis": {
                    "secret_scanning": {"status": "disabled"}
                },
            },
        ),
        ("GET", "/repos/o/r/topics", None),
        ("PUT", "/repos/o/r/topics", {"names": ["keep", "new"]}),
    ]
    assert CALLS[0]["method"] == "POST"


@pytest.mark.asyncio
async def test_repo_edit_refuses_a_security_edit_it_cannot_administer(
    _core_repo,
):
    _reset({"data": {"repository": {"viewerCanAdminister": False}}})
    with pytest.raises(ValueError, match="sufficient permissions"):
        await edit_cmd(_inv(["o/r"], {"enable_secret_scanning": True}))
    assert [c["method"] for c in CALLS] == ["POST"]


@pytest.mark.asyncio
async def test_repo_edit_leaves_the_topics_alone_when_none_change(_core_repo):
    _reset({"names": ["keep"]})
    await edit_cmd(
        _inv(["o/r"], {"add_topic": ["keep"], "remove_topic": ["gone"]})
    )
    assert [f"{c['method']} {c['path']}" for c in CALLS] == [
        "GET /repos/o/r/topics"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,message",
    [
        ({}, "specify properties to edit"),
        (
            {"visibility": "private"},
            "requires --accept-visibility-change-consequences",
        ),
    ],
)
async def test_repo_edit_refuses_as_gh_does_without_a_terminal(
    _core_repo, flags, message
):
    with pytest.raises(UsageError, match=message):
        await edit_cmd(_inv(["o/r"], flags))
    assert CALLS == []


@pytest.mark.asyncio
async def test_repo_delete_reads_a_bare_name_as_the_viewers(_core_repo):
    _reset({"login": "me"})
    out, _io = await delete_cmd(_inv(["tools"], {"yes": True}))
    assert out == b""
    assert [f"{c['method']} {c['path']}" for c in CALLS] == [
        "GET /user",
        "DELETE /repos/me/tools",
    ]


@pytest.mark.asyncio
async def test_repo_delete_warns_that_confirm_is_deprecated(_core_repo):
    _out, io = await delete_cmd(_inv(["o/r"], {"confirm": True}))
    assert await materialize(io.stderr) == (
        b"Flag --confirm has been deprecated, use `--yes` instead\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texts,flags,message",
    [
        (
            (),
            {"yes": True},
            "cannot non-interactively delete current repository",
        ),
        (("o/r",), {}, "--yes required when not running interactively"),
    ],
)
async def test_repo_delete_refuses_without_a_terminal(
    _core_repo, texts, flags, message
):
    with pytest.raises(UsageError, match=message):
        await delete_cmd(_inv(texts, flags))
    assert CALLS == []


# gh takes the new name as the operand and the repository to rename as -R,
# which is the reverse of what the shape of the line suggests.
@pytest.mark.asyncio
async def test_renames_the_dash_r_repository_to_the_operand():
    _reset({"full_name": "me/after"})
    await rename(_inv(["after"], {"repo": "me/before"}))
    assert CALLS == [
        {
            "method": "PATCH",
            "path": "/repos/me/before",
            "body": {"name": "after"},
        }
    ]


@pytest.mark.asyncio
async def test_api_is_a_get_with_no_fields_and_sends_them_as_query():
    await api(
        _inv(
            ["repos/o/r/contents/x"],
            {"raw_field": ["ref=master"], "method": "GET"},
        )
    )
    assert CALLS[0] == {
        "method": "GET",
        "path": "/repos/o/r/contents/x",
        "params": {"ref": "master"},
    }


@pytest.mark.asyncio
async def test_api_is_a_post_once_a_field_is_given():
    await api(_inv(["repos/o/r/issues"], {"raw_field": ["title=hi"]}))
    assert CALLS[0]["method"] == "POST"


@pytest.mark.asyncio
async def test_api_sends_dash_f_verbatim_and_reads_dash_f_as_json_types():
    await api(
        _inv(
            ["x"],
            {
                "method": "PUT",
                "raw_field": ["a=1"],
                "field": ["b=2", "c=true", "d=null", "e=text"],
            },
        )
    )
    assert CALLS[0]["body"] == {
        "a": "1",
        "b": 2,
        "c": True,
        "d": None,
        "e": "text",
    }


@pytest.mark.asyncio
async def test_api_keeps_everything_after_the_first_equals():
    await api(_inv(["x"], {"raw_field": ["content=YQ==\n"]}))
    assert CALLS[0]["body"] == {"content": "YQ==\n"}


@pytest.mark.asyncio
async def test_api_takes_an_endpoint_with_or_without_a_leading_slash():
    await api(_inv(["/user"]))
    assert CALLS[0]["path"] == "/user"


# gh sends `graphql` alone to the GraphQL endpoint (`p == "graphql"`) and
# any other spelling, `/graphql` included, under the REST base.
@pytest.mark.asyncio
async def test_api_names_graphql_by_the_bare_graphql_endpoint_alone():
    await api(_inv(["graphql"], {"raw_field": ["query={ viewer { login } }"]}))
    await api(_inv(["/graphql"]))
    assert [call["path"] for call in CALLS] == ["graphql", "/graphql"]


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
        _inv(
            ["search/code"],
            {"method": "GET", "field": ["per_page=5", "draft=true"]},
        )
    )
    assert CALLS[0]["params"] == {"per_page": "5", "draft": "true"}
    assert "body" not in CALLS[0]


@pytest.mark.asyncio
async def test_api_builds_nested_objects_and_arrays():
    await api(
        _inv(
            ["x"],
            {
                "field": [
                    "config[enabled]=true",
                    "labels[]=bug",
                    "labels[]=agent",
                    "empty[]",
                ]
            },
        )
    )
    assert CALLS[0]["body"] == {
        "config": {"enabled": True},
        "labels": ["bug", "agent"],
        "empty": [],
    }


@pytest.mark.asyncio
async def test_api_reads_typed_at_values_from_workspace_and_stdin():
    await api(
        _inv(
            ["x"],
            {"field": ["body=@/scratch/body.md", "note=@-"]},
            stdin=b"from stdin",
            doors=_doors({"/scratch/body.md": b"from file"}),
        )
    )
    assert CALLS[0]["body"] == {"body": "from file", "note": "from stdin"}


@pytest.mark.asyncio
async def test_api_input_is_the_body_and_fields_move_to_the_query():
    await api(
        _inv(
            ["x"],
            {
                "method": "PATCH",
                "input": _path("/scratch/body.json"),
                "raw_field": ["mode=strict"],
            },
            doors=_doors({"/scratch/body.json": b'{"enabled":true}'}),
        )
    )
    assert CALLS[0] == {
        "method": "PATCH",
        "path": "/x",
        "body": {"enabled": True},
        "params": {"mode": "strict"},
    }


@pytest.mark.asyncio
async def test_api_input_preserves_an_explicit_json_null_body():
    await api(
        _inv(
            ["x"],
            {"input": _path("/scratch/body.json")},
            doors=_doors({"/scratch/body.json": b"null"}),
        )
    )
    assert CALLS[0] == {"method": "POST", "path": "/x", "body": None}


@pytest.mark.asyncio
async def test_api_passes_custom_headers_without_replacing_defaults():
    await api(_inv(["x"], {"header": ["Accept: text/plain", "X-Probe: yes"]}))
    assert CALLS[0]["headers"] == {"Accept": "text/plain", "X-Probe": "yes"}


@pytest.mark.asyncio
async def test_api_follows_link_headers_and_slurps_pages():
    RESPONSES.extend(
        [
            ApiResponse(
                [{"id": 1}],
                200,
                {"link": '<http://fake/items?page=2>; rel="next"'},
            ),
            ApiResponse([{"id": 2}], 200, {}),
        ]
    )
    out, _io = await api(_inv(["items"], {"paginate": True, "slurp": True}))
    assert [call["path"] for call in CALLS] == ["/items", "/items?page=2"]
    assert await materialize(out) == b'[[{"id":1}],[{"id":2}]]'


# gh copies each body out verbatim, the vendor's compact text with no
# newline added, and a paginated run streams array pages as one array (its
# paginatedArrayReader); an empty page leaves a space behind.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bodies,paginate,stdout",
    [
        ([[{"id": 1}]], False, '[{"id":1}]'),
        ([[1, 2], [3]], True, "[1,2,3]"),
        ([[1], [], [2]], True, "[1 ,2]"),
        ([{"a": 1}, {"a": 2}], True, '{"a":1}{"a":2}'),
    ],
)
async def test_api_prints_bodies_as_gh_does(bodies, paginate, stdout):
    RESPONSES.extend(
        ApiResponse(
            body,
            200,
            {"link": f'<http://fake/items?page={index + 2}>; rel="next"'}
            if index < len(bodies) - 1
            else {},
        )
        for index, body in enumerate(bodies)
    )
    out, _io = await api(
        _inv(["items"], {"paginate": True} if paginate else {})
    )
    assert await materialize(out) == stdout.encode()


@pytest.mark.asyncio
async def test_api_strips_the_enterprise_prefix_from_link_pages():
    RESPONSES.extend(
        [
            ApiResponse(
                [{"id": 1}],
                200,
                {
                    "link": '<https://git.example/api/v3/items?page=2>; rel="next"'
                },
            ),
            ApiResponse([{"id": 2}], 200, {}),
        ]
    )
    await api(
        _inv(
            ["items"],
            {"paginate": True},
            config=GhConfig(token="t", base_url="https://git.example/api/v3"),
        )
    )
    assert [call["path"] for call in CALLS] == ["/items", "/items?page=2"]


@pytest.mark.asyncio
async def test_api_silent_suppresses_output():
    out, _io = await api(_inv(["x"], {"method": "POST", "silent": True}))
    assert await materialize(out) == b""


@pytest.mark.asyncio
async def test_api_copies_a_body_that_is_not_text_out_as_its_bytes():
    RESPONSES.append(ApiResponse(b"PK\xff\x00", 200, {}))
    out, _io = await api(_inv(["repos/o/r/actions/runs/1/logs"]))
    assert await materialize(out) == b"PK\xff\x00"


# gh 2.85's `-i` (api.go processResponse): the protocol and status, every
# header but Status in name order ending `\r\n`, a blank `\r\n` line, then
# the body, for every response, the failing one included.
_HEADERS = {
    "x-github-request-id": "AB:CD",
    "content-type": "application/json; charset=utf-8",
    "status": "200 OK",
}
_HEAD = (
    b"HTTP/1.1 200 OK\nContent-Type: application/json; charset=utf-8\r\n"
    b"X-Github-Request-Id: AB:CD\r\n\r\n"
)


@pytest.mark.asyncio
async def test_api_include_prints_the_status_line_and_headers_first():
    RESPONSES.append(ApiResponse({"a": 1}, 200, _HEADERS))
    out, _io = await api(_inv(["x"], {"include": True}))
    assert await materialize(out) == _HEAD + b'{"a":1}'


@pytest.mark.asyncio
async def test_api_include_drops_the_headers_of_the_encoded_body():
    RESPONSES.append(
        ApiResponse(
            None,
            204,
            {
                "content-encoding": "gzip",
                "content-length": "20",
                "etag": 'W/"1"',
            },
        )
    )
    out, _io = await api(_inv(["x"], {"include": True, "method": "DELETE"}))
    assert await materialize(out) == (
        b'HTTP/1.1 204 No Content\nEtag: W/"1"\r\n\r\n'
    )


@pytest.mark.asyncio
async def test_api_include_heads_every_page_and_prints_pages_as_they_came():
    link = {"link": '<http://fake/x?page=2>; rel="next"'}
    RESPONSES.extend([ApiResponse([1], 200, link), ApiResponse([2], 200, {})])
    out, _io = await api(_inv(["x"], {"include": True, "paginate": True}))
    assert await materialize(out) == (
        b'HTTP/1.1 200 OK\nLink: <http://fake/x?page=2>; rel="next"\r\n'
        b"\r\n[1]\nHTTP/1.1 200 OK\n\r\n[2]"
    )


@pytest.mark.asyncio
async def test_api_include_opens_each_slurp_page_before_its_head():
    link = {"link": '<http://fake/x?page=2>; rel="next"'}
    RESPONSES.extend([ApiResponse([1], 200, link), ApiResponse([2], 200, {})])
    out, _io = await api(
        _inv(["x"], {"include": True, "paginate": True, "slurp": True})
    )
    assert await materialize(out) == (
        b'[HTTP/1.1 200 OK\nLink: <http://fake/x?page=2>; rel="next"\r\n'
        b"\r\n[1]\n,HTTP/1.1 200 OK\n\r\n[2]]"
    )


@pytest.mark.asyncio
async def test_api_include_keeps_heads_under_silent_and_before_jq():
    RESPONSES.append(ApiResponse({"a": 1}, 200, _HEADERS))
    out, _io = await api(_inv(["x"], {"include": True, "silent": True}))
    assert await materialize(out) == _HEAD
    RESPONSES.append(ApiResponse({"a": 1}, 200, _HEADERS))
    out, _io = await api(_inv(["x"], {"include": True, "jq": ".a"}))
    assert await materialize(out) == _HEAD + b"1\n"


@pytest.mark.asyncio
async def test_api_include_heads_a_failing_response_too():
    RESPONSES.append(
        GitHubApiError(
            "Not Found",
            404,
            body='{"message":"Not Found"}',
            headers={"content-type": "application/json"},
        )
    )
    out, io = await api(_inv(["x"], {"include": True}))
    assert await materialize(out) == (
        b"HTTP/1.1 404 Not Found\nContent-Type: application/json\r\n\r\n"
        b'{"message":"Not Found"}'
    )
    assert await materialize(io.stderr) == b"gh: Not Found (HTTP 404)\n"


@pytest.mark.asyncio
async def test_api_emits_a_non_json_response_verbatim():
    RESPONSES.append(ApiResponse("diff --git a/x b/x\n", 200, {}))
    out, _io = await api(
        _inv(
            ["repos/o/r/pulls/1"],
            {"header": ["Accept: application/vnd.github.v3.diff"]},
        )
    )
    assert await materialize(out) == b"diff --git a/x b/x\n"


# `--jq` renders the way gh 2.85 does, probed live: a string raw, null as
# an empty line, everything else as compact JSON with its keys sorted, one
# output per line.
@pytest.mark.asyncio
async def test_api_jq_prints_a_string_raw():
    _reset({"full_name": "o/r"})
    out, _io = await api(_inv(["repos/o/r"], {"jq": ".full_name"}))
    assert await materialize(out) == b"o/r\n"


@pytest.mark.asyncio
async def test_api_jq_prints_non_strings_as_compact_json():
    _reset({"name": "r", "count": 2, "ok": True})
    out, _io = await api(
        _inv(["repos/o/r"], {"jq": "{name: .name, count: .count}, .ok"})
    )
    assert await materialize(out) == b'{"count":2,"name":"r"}\ntrue\n'


# go-gh prints a number on its own line in fixed notation, whole with no
# decimals and otherwise with two, rounded half to even as strconv rounds;
# anything else goes through Go's json.Marshal: keys sorted, <, > and &
# escaped for HTML and U+2028 and U+2029 for JavaScript, DEL raw, and
# numbers spelled as ES6 spells them. Pinned against gh 2.85's go-gh with
# `gh api rate_limit --jq`.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, line",
    [
        ("1.5", "1.50"),
        ("0.125", "0.12"),
        ("0.375", "0.38"),
        ("-0.125", "-0.12"),
        ("2.675", "2.67"),
        ("1e-7", "0.00"),
        ("3.0", "3"),
        ("1e21", "1000000000000000000000"),
        (".n / 3", "1666.67"),
        ("[.n / 3]", "[1666.6666666666667]"),
        ("[1.5, 1e21, 1e-7, 0.000001, 100]", "[1.5,1e+21,1e-7,0.000001,100]"),
        ('{"b": 1, "a": {"d": 2, "c": 3}}', '{"a":{"c":3,"d":2},"b":1}'),
        ('{"x": "<&>"}', '{"x":"\\u003c\\u0026\\u003e"}'),
        (
            '["\\u2028", "\\u2029", "\\u007f", "é", "\\u0001", "\\b"]',
            '["\\u2028","\\u2029","\x7f","é","\\u0001","\\b"]',
        ),
        ('[true, null, "x"]', '[true,null,"x"]'),
    ],
)
async def test_api_jq_prints_each_output_as_go_gh_does(program, line):
    _reset({"n": 5000})
    out, _io = await api(_inv(["repos/o/r"], {"jq": program}))
    assert await materialize(out) == f"{line}\n".encode()


# gh prints a computed negative zero as -0, but jq.py hands it to Python as
# the int 0, so both hosts print 0.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, line",
    [
        (".n * 0 * -1", "0"),
        ("[.n * 0 * -1]", "[0]"),
    ],
)
async def test_api_jq_prints_negative_zero_as_zero(program, line):
    _reset({"n": 5000})
    out, _io = await api(_inv(["repos/o/r"], {"jq": program}))
    assert await materialize(out) == f"{line}\n".encode()


@pytest.mark.asyncio
async def test_api_jq_prints_null_as_an_empty_line():
    _reset({"name": "r"})
    out, _io = await api(_inv(["repos/o/r"], {"jq": ".nope"}))
    assert await materialize(out) == b"\n"


@pytest.mark.asyncio
async def test_api_jq_emits_one_line_per_output():
    _reset({"a": "x", "b": "y"})
    out, _io = await api(_inv(["repos/o/r"], {"jq": ".a, .b"}))
    assert await materialize(out) == b"x\ny\n"


# go-gh's gojq ends the output at `halt` and fails at halt_error, pinned
# against gh: `halt error: <message>`, exit 1 whatever the code.
@pytest.mark.asyncio
async def test_api_jq_ends_the_output_at_halt():
    _reset({"a": "x"})
    out, _io = await api(_inv(["repos/o/r"], {"jq": ".a, halt, .a"}))
    assert await materialize(out) == b"x\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, message",
    [
        ('"x" | halt_error(3)', "halt error: x"),
        ('{"a":1} | halt_error', 'halt error: {"a":1}'),
        ("[.a] | map({v: .} | halt_error(0))", 'halt error: {"v":"x"}'),
    ],
)
async def test_api_jq_fails_at_halt_error(program, message):
    _reset({"a": "x"})
    with pytest.raises(PartialOutputError) as caught:
        await api(_inv(["repos/o/r"], {"jq": program}))
    assert (str(caught.value), caught.value.stdout) == (message, b"")


# gojq reports what the program raised with `error` as `error: <value>`,
# anything but a string in gojq's own compact JSON (keys sorted), and a
# builtin's error in words mirage's jq does not share, so jq 1.8.2's stand,
# except for the builtins gojq writes in jq. Pinned against gh 2.85's
# gojq with `gh api rate_limit --jq`.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, message",
    [
        ('error("boom")', "error: boom"),
        ('"x" | error', "error: x"),
        ("error(null)", "error: null"),
        ("error(error)", 'error: {"a":"x"}'),
        ('error({"b": 1, "a": [2, "x"]})', 'error: {"a":[2,"x"],"b":1}'),
        (
            'error(["\\u007f", "é", "<&>", "\\u0001"])',
            'error: ["\\u007f","é","<&>","\\u0001"]',
        ),
        ("error(1.0)", "error: 1"),
        ("error(1e21)", "error: 1e+21"),
        ("error(0.0000001)", "error: 1e-7"),
        ('[error("in")]', "error: in"),
        ('first(error("in"))', "error: in"),
        (
            "try (.a | .b) catch error",
            'error: Cannot index string with string ("b")',
        ),
        (".a | .b", 'Cannot index string with string ("b")'),
        ("label $f | .a | .b", 'Cannot index string with string ("b")'),
        ("def error: 7; error | .b", 'Cannot index number with string ("b")'),
        ("limit(-1; .a)", "error: limit doesn't support negative count"),
        ("skip(-1; .a)", "error: skip doesn't support negative count"),
        ("nth(-1; .a)", "error: nth doesn't support negative index"),
        ('{"b": 1, "a": 2} | halt_error(1)', 'halt error: {"a":2,"b":1}'),
    ],
)
async def test_api_jq_fails_the_way_gojq_reports_it(program, message):
    _reset({"a": "x"})
    with pytest.raises(PartialOutputError) as caught:
        await api(_inv(["repos/o/r"], {"jq": program}))
    assert (str(caught.value), caught.value.stdout) == (message, b"")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, message",
    [
        ('.a, ("y" | halt_error(1))', "halt error: y"),
        ('.a, error("boom")', "error: boom"),
        ('(try error(.a) catch .), error("y")', "error: y"),
    ],
)
async def test_api_jq_keeps_what_it_printed_before_failing(program, message):
    _reset({"a": "x"})
    with pytest.raises(PartialOutputError) as caught:
        await api(_inv(["repos/o/r"], {"jq": program}))
    assert (str(caught.value), caught.value.stdout) == (message, b"x\n")


# gh prints two tab-separated header lines and then the README verbatim;
# with no README there is no `--` separator at all. Probed against 2.85.
def test_summary_is_gh_s_two_headers_then_the_readme():
    out = summary({"full_name": "o/r", "description": "d"}, "# Title\n")
    assert out == "name:\to/r\ndescription:\td\n--\n# Title\n"


def test_summary_omits_the_separator_without_a_readme():
    out = summary({"full_name": "o/r", "description": None}, None)
    assert out == "name:\to/r\ndescription:\t\n"


@pytest.mark.asyncio
async def test_view_renders_text_not_the_rest_object():
    _reset({"full_name": "integ/x", "description": "hi"})
    README[0] = "body\n"
    out, _io = await view(_inv(["integ/x"]))
    assert (
        await materialize(out)
        == b"name:\tinteg/x\ndescription:\thi\n--\nbody\n"
    )


@pytest.mark.asyncio
async def test_api_renders_non_ascii_as_raw_utf8():
    # `json_out` (accessor.py) used to default to ensure_ascii, so
    # `Café` reached stdout as `"Café"` where `JSON.stringify`
    # emits the raw UTF-8 bytes.
    RESPONSES.append(ApiResponse({"name": "Café", "city": "東京"}, 200, {}))
    out, _io = await api(_inv(["x"]))
    printed = (await materialize(out)).decode()
    assert '"Café"' in printed
    assert '"東京"' in printed
    assert "\\u" not in printed


@pytest.mark.asyncio
async def test_api_renders_non_ascii_across_pages_as_raw_utf8():
    # The multi-page render has its own json.dumps, so it needed the
    # same fix as the single-page one.
    RESPONSES.extend(
        [
            ApiResponse(
                [{"name": "Café"}],
                200,
                {"link": '<http://fake/items?page=2>; rel="next"'},
            ),
            ApiResponse([{"name": "東京"}], 200, {}),
        ]
    )
    out, _io = await api(_inv(["items"], {"paginate": True}))
    printed = (await materialize(out)).decode()
    assert '"Café"' in printed
    assert '"東京"' in printed
    assert "\\u" not in printed


@pytest.mark.asyncio
async def test_comment_metadata_matches_gh(monkeypatch):
    row = {
        "author": None,
        "authorAssociation": "CONTRIBUTOR",
        "includesCreatedEdit": True,
        "isMinimized": True,
        "minimizedReason": "OUTDATED",
        "body": "comment",
        "viewerDidAuthor": False,
        "reactionGroups": [
            {"content": "THUMBS_UP", "users": {"totalCount": 2}},
            {"content": "LAUGH", "users": {"totalCount": 0}},
        ],
    }

    async def comments(*args):
        return [row.copy()]

    monkeypatch.setitem(comments_for.__globals__, "issue_comments", comments)
    rows = await comments_for(
        _inv([], {"comments": True}),
        FlagView({"comments": True}),
        RepoRef("o", "r"),
        1,
    )
    assert rows == [
        {
            **row,
            "author": {"login": ""},
            "reactionGroups": row["reactionGroups"][:1],
        }
    ]
    assert comments_text(rows) == (
        "author:\t\nassociation:\tcontributor\n"
        "edited:\ttrue\nstatus:\toutdated\n"
        "--\ncomment\n--\n"
    )


@pytest.mark.asyncio
async def test_file_reader_keeps_resolved_path_and_materializes_stream():
    path = PathSpec(
        virtual="/scratch/body.md",
        directory="/scratch/",
        vfs_path="body.md",
        raw_path="./body.md",
    )
    content = [b"first ", b"second"]

    async def chunks():
        for chunk in content:
            yield chunk

    async def dispatch(op, spec, *args, **kwargs):
        assert op == "read"
        assert spec is path
        return chunks(), None

    value = await read_cli_file(
        _inv(doors=CLIDoors(dispatch=dispatch)), path, "--body-file"
    )
    assert value == b"first second"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,body,stdout,stderr",
    [
        (
            {},
            ' {"message":"Not Found"}\n',
            ' {"message":"Not Found"}\n',
            "gh: Not Found (HTTP 404)\n",
        ),
        (
            {"silent": True},
            '{"message":"Not Found"}',
            "",
            "gh: Not Found (HTTP 404)\n",
        ),
        (
            {"jq": ".message"},
            '{"message":"Not Found"}',
            '{"message":"Not Found"}',
            "gh: Not Found (HTTP 404)\n",
        ),
        ({}, "not found\n", "not found\n", "gh: HTTP 404\n"),
        ({}, "", "", "gh: HTTP 404\n"),
    ],
)
async def test_api_http_failure_keeps_the_response(
    monkeypatch, flags, body, stdout, stderr
):
    request = AsyncMock(
        side_effect=GitHubApiError("Not Found", 404, body=body)
    )
    monkeypatch.setitem(api.__globals__, "github_request_response", request)
    out, io = await api(_inv(("repos/o/missing",), flags))
    assert await materialize(out) == stdout.encode()
    assert await io.stderr_str() == stderr
    assert io.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,stderr",
    [
        (
            '{"message":"Validation Failed","errors":"bad thing"}',
            "gh: bad thing (Validation Failed)\n",
        ),
        ('{"errors":"bad thing"}', "gh: bad thing\n"),
        (
            '{"message":"Validation Failed","errors":[{"message":"one"}]}',
            "gh: Validation Failed (HTTP 422)\n",
        ),
        ('{"errors":[{"message":"one"},"two"]}', "gh: one\ntwo\n"),
        ('{"errors":[{"code":"x"}]}', "gh: HTTP 422\n"),
        ('{"errors":[]}', "gh: HTTP 422\n"),
        ('{"message":""}', "gh: HTTP 422\n"),
        ('["not", "an", "object"]', "gh: HTTP 422\n"),
    ],
)
async def test_api_failure_names_what_gh_reads_off_the_body(
    monkeypatch, body, stderr
):
    request = AsyncMock(
        side_effect=GitHubApiError("Validation Failed", 422, body=body)
    )
    monkeypatch.setitem(api.__globals__, "github_request_response", request)
    out, io = await api(_inv(("repos/o/r",)))
    assert await materialize(out) == body.encode()
    assert await io.stderr_str() == stderr
    assert io.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,body,stdout,stderr",
    [
        (
            {"jq": ".value"},
            '{"message":"Validation Failed"}',
            'first\n{"message":"Validation Failed"}',
            "gh: Validation Failed (HTTP 422)\n",
        ),
        (
            {"slurp": True},
            '{"message":"Validation Failed"}',
            '[{"value":"first"},{"message":"Validation Failed"}]',
            "gh: Validation Failed (HTTP 422)\n",
        ),
        (
            {"slurp": True},
            "upstream unavailable\n",
            '[{"value":"first"},upstream unavailable\n]',
            "gh: HTTP 422\n",
        ),
        ({"slurp": True}, "", '[{"value":"first"},]', "gh: HTTP 422\n"),
        (
            {},
            '{"message":"Validation Failed"}',
            '{"value":"first"}{"message":"Validation Failed"}',
            "gh: Validation Failed (HTTP 422)\n",
        ),
        (
            {"silent": True},
            '{"message":"Validation Failed"}',
            "",
            "gh: Validation Failed (HTTP 422)\n",
        ),
    ],
)
async def test_api_later_page_failure_keeps_rendered_pages(
    monkeypatch, flags, body, stdout, stderr
):
    request = AsyncMock(
        side_effect=[
            ApiResponse(
                {"value": "first"}, 200, {"link": '</page2>; rel="next"'}
            ),
            GitHubApiError("Validation Failed", 422, body=body),
        ]
    )
    monkeypatch.setitem(api.__globals__, "github_request_response", request)
    out, io = await api(_inv(("page1",), {"paginate": True, **flags}))
    assert await materialize(out) == stdout.encode()
    assert io.exit_code == 1
    assert await io.stderr_str() == stderr
    assert request.await_count == 2


# gh runs `--jq` over each page as it lands, so a failure on a later page
# keeps the lines the earlier pages printed.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program, message",
    [
        (
            'if .value == "second" then "y" | halt_error(1) else .value end',
            "halt error: y",
        ),
        (
            'if .value == "second" then error("boom") else .value end',
            "error: boom",
        ),
    ],
)
async def test_api_jq_failure_on_a_later_page_keeps_the_earlier_pages(
    monkeypatch, program, message
):
    request = AsyncMock(
        side_effect=[
            ApiResponse(
                {"value": "first"}, 200, {"link": '</page2>; rel="next"'}
            ),
            ApiResponse({"value": "second"}, 200, {}),
        ]
    )
    monkeypatch.setitem(api.__globals__, "github_request_response", request)
    with pytest.raises(PartialOutputError) as caught:
        await api(_inv(("page1",), {"paginate": True, "jq": program}))
    assert (str(caught.value), caught.value.stdout) == (message, b"first\n")


# A failing response after an array page is still a page to gh, so that
# array's closing bracket stays withheld and the failing body runs on.
@pytest.mark.asyncio
async def test_api_leaves_an_array_page_open_before_a_failing_page(
    monkeypatch,
):
    request = AsyncMock(
        side_effect=[
            ApiResponse([1], 200, {"link": '</page2>; rel="next"'}),
            GitHubApiError(
                "Validation Failed",
                422,
                body='{"message":"Validation Failed"}',
            ),
        ]
    )
    monkeypatch.setitem(api.__globals__, "github_request_response", request)
    out, io = await api(_inv(("page1",), {"paginate": True}))
    assert await materialize(out) == b'[1{"message":"Validation Failed"}'
    assert io.exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,stdout",
    [
        ({}, '{"errors":[{"message":"one"},{"message":"two"}],"data":null}'),
        (
            {"jq": ".data"},
            '{"errors":[{"message":"one"},{"message":"two"}],"data":null}',
        ),
        ({"silent": True}, ""),
    ],
)
async def test_api_graphql_errors_fail_as_gh_fails(monkeypatch, flags, stdout):
    data = {"errors": [{"message": "one"}, {"message": "two"}], "data": None}
    request = AsyncMock(return_value=ApiResponse(data, 200, {}))
    monkeypatch.setitem(api.__globals__, "github_request_response", request)
    out, io = await api(
        _inv(
            ("graphql",),
            {"raw_field": ["query={ viewer { login } }"], **flags},
        )
    )
    assert await materialize(out) == stdout.encode()
    assert await io.stderr_str() == "gh: one\ntwo\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_api_graphql_errors_only_count_on_the_graphql_endpoint(
    monkeypatch,
):
    data = {"errors": [{"message": "one"}]}
    request = AsyncMock(return_value=ApiResponse(data, 200, {}))
    monkeypatch.setitem(api.__globals__, "github_request_response", request)
    out, io = await api(_inv(("repos/o/r",)))
    assert json.loads(await materialize(out)) == data
    assert io.exit_code == 0

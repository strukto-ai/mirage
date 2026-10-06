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
from dulwich.refs import Ref

from mirage.commands.cli.builtin.git.refs import (
    blocking_ref,
    load_refs,
    mapped,
    parse_refspec,
    read_head,
    safe_ref_name,
    valid_ref_name,
    whole_ref_name,
    without_packed,
)
from mirage.commands.cli.builtin.git.types import Refspec
from mirage.io import IOResult

from .conftest import GITDIR, make_branch, mounted, pack_refs

DETACHED_SHA = "cdd6234342b147880f5d86c55dad6c1fbe222bfe"


def _dispatch_returning(data: bytes):
    """A dispatch that answers every read with the given bytes.

    Args:
        data (bytes): the content HEAD holds.
    """

    async def dispatch(op: str, path, **kwargs):
        assert op == "read"
        assert path.virtual == "/repo/.git/HEAD"
        return data, IOResult()

    return dispatch


@pytest.mark.asyncio
async def test_symbolic_ref_reports_the_short_branch():
    head = await read_head(
        _dispatch_returning(b"ref: refs/heads/main\n"), GITDIR
    )
    assert head.branch == "main"
    assert head.ref == "refs/heads/main"
    assert head.commit is None


@pytest.mark.asyncio
async def test_branch_name_keeps_its_slashes():
    head = await read_head(
        _dispatch_returning(b"ref: refs/heads/feat/git-cli\n"), GITDIR
    )
    assert head.branch == "feat/git-cli"


@pytest.mark.asyncio
async def test_detached_head_reports_the_commit():
    head = await read_head(_dispatch_returning(DETACHED_SHA.encode()), GITDIR)
    assert head.branch is None
    assert head.ref is None
    assert head.commit == DETACHED_SHA


@pytest.mark.asyncio
async def test_ref_outside_refs_heads_keeps_its_full_name():
    head = await read_head(
        _dispatch_returning(b"ref: refs/remotes/origin/main\n"), GITDIR
    )
    assert head.branch == "refs/remotes/origin/main"
    assert head.ref == "refs/remotes/origin/main"


@pytest.mark.asyncio
async def test_load_refs_reads_loose_branches(workspace):
    refs = await load_refs(workspace.dispatch, GITDIR)
    keys = refs.allkeys()
    assert b"refs/heads/main" in keys
    assert b"HEAD" in keys


@pytest.mark.asyncio
async def test_load_refs_reads_packed_refs(repo_path, workspace):
    # A freshly cloned repository keeps its remote-tracking refs only in
    # packed-refs, so a loose-only reader would miss them entirely.
    pack_refs(repo_path)
    with mounted(repo_path) as ws:
        refs = await load_refs(ws.dispatch, GITDIR)
    assert b"refs/heads/main" in refs.allkeys()


@pytest.mark.asyncio
async def test_load_refs_walks_nested_ref_names(repo_path, workspace):
    make_branch(repo_path, "feat/git-cli")
    with mounted(repo_path) as ws:
        refs = await load_refs(ws.dispatch, GITDIR)
    assert b"refs/heads/feat/git-cli" in refs.allkeys()


@pytest.mark.asyncio
async def test_head_symref_resolves_through_the_container(workspace):
    refs = await load_refs(workspace.dispatch, GITDIR)
    assert refs[b"HEAD"] == refs[b"refs/heads/main"]


@pytest.mark.parametrize(
    "name",
    ["v1.0", "feat/git-cli", "a10", "B", "@", "x-y_z", "release-2026.01"],
)
def test_names_git_accepts_are_valid(name: str):
    assert valid_ref_name(name)


@pytest.mark.parametrize(
    "name",
    [
        "",
        "bad name",
        "bad..name",
        "x.lock",
        ".x",
        "x/",
        "/x",
        "a//b",
        "x.",
        "a@{b",
        "a~b",
        "a^b",
        "a:b",
        "a?b",
        "a*b",
        "a[b",
        "a\\b",
        "a\tb",
    ],
)
def test_names_git_refuses_are_invalid(name: str):
    assert not valid_ref_name(name)


PACKED = (
    "# pack-refs with: peeled fully-peeled sorted \n"
    "1111111111111111111111111111111111111111 refs/heads/main\n"
    "2222222222222222222222222222222222222222 refs/tags/ann\n"
    "^3333333333333333333333333333333333333333\n"
    "4444444444444444444444444444444444444444 refs/tags/lw\n"
)


def test_dropping_a_packed_tag_drops_its_peeled_line():
    rewritten = without_packed(PACKED.encode(), "refs/tags/ann")
    assert rewritten is not None
    assert b"refs/tags/ann" not in rewritten
    assert b"^3333" not in rewritten
    assert b"refs/tags/lw" in rewritten
    assert b"refs/heads/main" in rewritten


def test_dropping_the_last_ref_keeps_the_header():
    rewritten = without_packed(PACKED.encode(), "refs/tags/lw")
    assert rewritten is not None
    assert rewritten.startswith(b"# pack-refs with:")
    assert b"^3333" in rewritten


def test_a_ref_the_file_does_not_hold_rewrites_nothing():
    assert without_packed(PACKED.encode(), "refs/heads/other") is None


def test_a_ref_above_the_new_one_blocks_it():
    known = {Ref(b"refs/tags/foo"), Ref(b"refs/heads/main")}
    assert blocking_ref(known, "refs/tags/foo/bar") == "refs/tags/foo"
    # Every level above is searched, not just the parent.
    assert blocking_ref(known, "refs/tags/foo/bar/baz") == "refs/tags/foo"


def test_a_ref_below_the_new_one_blocks_it_too():
    known = {Ref(b"refs/tags/foo/c"), Ref(b"refs/tags/foo/a")}
    # git names one ref, and the walk that finds it is ordered, so the
    # answer does not depend on how the set happens to iterate.
    assert blocking_ref(known, "refs/tags/foo") == "refs/tags/foo/a"


def test_a_ref_with_no_collision_is_free():
    known = {Ref(b"refs/tags/foo"), Ref(b"refs/heads/main")}
    assert blocking_ref(known, "refs/tags/other") is None
    # A prefix that is not a whole path segment is not a collision.
    assert blocking_ref(known, "refs/tags/foobar") is None
    # And the ref itself existing is a different refusal, not this one.
    assert blocking_ref(known, "refs/tags/foo") is None


@pytest.mark.parametrize(
    "text,expected",
    [
        ("main", Refspec("main", None, False)),
        (
            "+refs/heads/*:refs/remotes/origin/*",
            Refspec("refs/heads/*", "refs/remotes/origin/*", True),
        ),
        ("topic:copy", Refspec("topic", "copy", False)),
        ("main:", Refspec("main", None, False)),
    ],
)
def test_a_refspec_splits_into_source_destination_and_force(text, expected):
    assert parse_refspec(text) == expected


@pytest.mark.parametrize(
    "spec,name,expected",
    [
        (
            "+refs/heads/*:refs/remotes/origin/*",
            "refs/heads/feat/x",
            "refs/remotes/origin/feat/x",
        ),
        ("+refs/heads/*:refs/remotes/origin/*", "refs/tags/v1", None),
        (
            "refs/heads/main:refs/heads/copy",
            "refs/heads/main",
            "refs/heads/copy",
        ),
        ("refs/heads/main", "refs/heads/main", ""),
    ],
)
def test_a_refspec_maps_a_remote_ref(spec, name, expected):
    assert mapped(parse_refspec(spec), name) == expected


@pytest.mark.parametrize(
    ("name", "safe"),
    [
        ("HEAD", True),
        ("ORIG_HEAD", True),
        ("refs/heads/main", True),
        ("refs/heads/a..b", True),
        ("lower", False),
        ("A1", False),
        ("refs/", False),
        ("refs/heads//x", False),
        ("refs/heads/./x", False),
        ("refs/heads/../x", False),
    ],
)
def test_safe_ref_name_follows_refname_is_safe(name: str, safe: bool):
    assert safe_ref_name(name) is safe


def test_a_bare_at_is_no_whole_ref_name():
    assert not whole_ref_name("@")
    assert whole_ref_name("HEAD")

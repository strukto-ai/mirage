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

from unittest.mock import patch

import pytest

from mirage.commands.cli.builtin.hf.upload import (
    collect,
    in_repo_base,
    keep,
    upload_cmd,
)
from mirage.commands.errors import UsageError
from mirage.utils.path import typed_spec
from tests.commands.cli.builtin.hf.conftest import ANON, inv


@pytest.mark.asyncio
async def test_collect_reads_one_file_under_its_basename(doors):
    record, _, _, _ = doors
    assert await collect(record, typed_spec("/work/a.txt", "/")) == (
        [("a.txt", b"alpha")],
        False,
    )


@pytest.mark.asyncio
async def test_collect_walks_a_directory_relative_to_it(doors):
    record, _, _, _ = doors
    assert await collect(record, typed_spec("/work", "/")) == (
        [("a.txt", b"alpha"), ("sub/b.txt", b"beta")],
        True,
    )


@pytest.mark.asyncio
async def test_collect_refuses_a_missing_path(doors):
    record, _, _, _ = doors
    with pytest.raises(UsageError, match="No such file"):
        await collect(record, typed_spec("/work/nope", "/"))


def test_keep_applies_include_then_exclude():
    rows = [("a.txt", b""), ("sub/b.txt", b"")]
    assert keep(rows, ["sub/*"], []) == [("sub/b.txt", b"")]
    assert keep(rows, [], ["sub/*"]) == [("a.txt", b"")]


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.upload.create_repo")
@patch("mirage.commands.cli.builtin.hf.upload.commit")
async def test_upload_commits_every_walked_file_at_once(
    mock_commit, mock_create, doors
):
    record, _, _, _ = doors
    await upload_cmd(inv(texts=("acme/widget", "/work"), doors=record))
    additions = mock_commit.await_args.kwargs["additions"]
    assert sorted(a.path for a in additions) == ["a.txt", "sub/b.txt"]
    assert mock_commit.await_count == 1


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.upload.create_repo")
@patch("mirage.commands.cli.builtin.hf.upload.commit")
async def test_upload_of_a_file_lands_at_path_in_repo(
    mock_commit, mock_create, doors
):
    """Upstream reads `path_in_repo` as the destination FILE for a file
    source: `_resolve_upload_paths` only falls back to the basename when
    the operand is absent. Probed against hf 0.35.3, which stores
    `hf upload r ./a.txt docs` as a file named `docs`."""
    record, _, _, _ = doors
    await upload_cmd(
        inv(texts=("acme/widget", "/work/a.txt", "docs"), doors=record)
    )
    assert mock_commit.await_args.kwargs["additions"][0].path == "docs"


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.upload.create_repo")
@patch("mirage.commands.cli.builtin.hf.upload.commit")
async def test_upload_of_a_directory_spreads_under_path_in_repo(
    mock_commit, mock_create, doors
):
    """A directory source is the other half of the same rule: there
    `path_in_repo` names the destination FOLDER."""
    record, _, _, _ = doors
    await upload_cmd(inv(texts=("acme/widget", "/work", "docs"), doors=record))
    paths = [a.path for a in mock_commit.await_args.kwargs["additions"]]
    assert paths == ["docs/a.txt", "docs/sub/b.txt"]


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.upload.create_repo")
@patch("mirage.commands.cli.builtin.hf.upload.commit")
async def test_upload_of_a_file_without_path_in_repo_uses_its_basename(
    mock_commit, mock_create, doors
):
    record, _, _, _ = doors
    await upload_cmd(inv(texts=("acme/widget", "/work/a.txt"), doors=record))
    assert mock_commit.await_args.kwargs["additions"][0].path == "a.txt"


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.upload.create_repo")
@patch("mirage.commands.cli.builtin.hf.upload.commit")
async def test_upload_passes_the_delete_globs_through(
    mock_commit, mock_create, doors
):
    record, _, _, _ = doors
    await upload_cmd(
        inv(
            texts=("acme/widget", "/work/a.txt"),
            flags={"delete": ["old.txt"], "create_pr": True},
            doors=record,
        )
    )
    assert mock_commit.await_args.kwargs["deletions"] == ["old.txt"]
    assert mock_commit.await_args.kwargs["create_pr"] is True


@pytest.mark.asyncio
async def test_upload_refuses_without_a_token(doors):
    record, _, _, _ = doors
    with pytest.raises(UsageError, match="token"):
        await upload_cmd(
            inv(texts=("acme/widget", "/work"), config=ANON, doors=record)
        )


@pytest.mark.asyncio
async def test_upload_needs_a_workspace():
    with pytest.raises(UsageError, match="workspace"):
        await upload_cmd(inv(texts=("acme/widget", "/work")))


@pytest.mark.parametrize(
    "value,expected",
    [
        ("", ""),
        (".", ""),
        ("./", ""),
        ("/", ""),
        ("docs", "docs"),
        ("/docs/", "docs"),
        ("./docs", "docs"),
        ("docs/../notes", "notes"),
        ("a/b/c", "a/b/c"),
    ],
)
def test_in_repo_base_normalizes(value, expected):
    """A Hub path is repo-relative with no leading slash and no `.`
    component. Taking `hf upload repo /local .` literally stored every
    file under `./`, which the resolve endpoint could not then find."""
    assert in_repo_base(value) == expected


@pytest.mark.parametrize("value", ["..", "../out", "docs/../../out"])
def test_in_repo_base_refuses_climbing_out(value):
    with pytest.raises(UsageError, match="stay inside the repository"):
        in_repo_base(value)

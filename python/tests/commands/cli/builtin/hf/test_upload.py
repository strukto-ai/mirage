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
    upload_cmd,
)
from mirage.commands.errors import UsageError
from mirage.core.hf_hub.commit import Addition
from mirage.types import PathSpec
from tests.commands.cli.builtin.hf.conftest import ANON, inv


@pytest.mark.asyncio
async def test_collect_reads_one_file_under_its_basename(view):
    record, _, _, _ = view
    assert await collect(record, PathSpec.from_str_path("/work/a.txt")) == (
        [Addition("a.txt", b"alpha")],
        False,
    )


@pytest.mark.asyncio
async def test_collect_walks_a_directory_relative_to_it(view):
    record, _, _, _ = view
    assert await collect(record, PathSpec.from_str_path("/work")) == (
        [Addition("a.txt", b"alpha"), Addition("sub/b.txt", b"beta")],
        True,
    )


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.upload.create_repo")
@patch("mirage.commands.cli.builtin.hf.upload.commit")
async def test_upload_commits_every_walked_file_at_once(
    mock_commit, mock_create, view
):
    record, _, _, _ = view
    await upload_cmd(
        inv(
            texts=("acme/widget",),
            paths=("/work",),
            flags={"create_pr": True},
            view=record,
        )
    )
    additions = mock_commit.await_args.kwargs["additions"]
    assert sorted(a.path for a in additions) == ["a.txt", "sub/b.txt"]
    assert mock_commit.await_count == 1
    assert mock_commit.await_args.kwargs["create_pr"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "local,in_repo,expected",
    [
        ("/work/a.txt", "docs", ["docs"]),
        ("/work", "docs", ["docs/a.txt", "docs/sub/b.txt"]),
        ("/work/a.txt", "", ["a.txt"]),
    ],
)
@patch("mirage.commands.cli.builtin.hf.upload.create_repo")
@patch("mirage.commands.cli.builtin.hf.upload.commit")
async def test_upload_destination(
    mock_commit, mock_create, view, local, in_repo, expected
):
    """A file lands at path_in_repo; a folder spreads underneath it."""
    record, _, _, _ = view
    texts = ("acme/widget", in_repo) if in_repo else ("acme/widget",)
    await upload_cmd(inv(texts=texts, paths=(local,), view=record))
    assert [
        a.path for a in mock_commit.await_args.kwargs["additions"]
    ] == expected


@pytest.mark.asyncio
async def test_upload_refuses_without_a_token(view):
    record, _, _, _ = view
    with pytest.raises(UsageError, match="token"):
        await upload_cmd(
            inv(
                texts=("acme/widget",),
                paths=("/work",),
                config=ANON,
                view=record,
            )
        )


@pytest.mark.asyncio
async def test_upload_needs_a_workspace():
    with pytest.raises(UsageError, match="workspace"):
        await upload_cmd(inv(texts=("acme/widget",), paths=("/work",)))


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

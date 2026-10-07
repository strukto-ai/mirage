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

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.cli.builtin.hf.download import (
    download_cmd,
    ensure_dir,
    refuse_variadic,
    selected,
)
from mirage.commands.errors import UsageError
from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.repo import Absence
from mirage.core.hf_hub.tree import parse_entry
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec
from tests.commands.cli.builtin.hf.conftest import inv
from tests.core.hf_hub.conftest import dir_row, file_row

TREE = {
    "a.txt": parse_entry(file_row("a.txt")),
    "sub/b.json": parse_entry(file_row("sub/b.json")),
    "sub": parse_entry(dir_row("sub")),
}


async def _text(result) -> str:
    source, _ = result
    return (await materialize(source)).decode()


def test_selected_never_lists_a_directory():
    assert selected(TREE, [], [], []) == ["a.txt", "sub/b.json"]


def test_named_files_win_over_the_include_filter():
    """Upstream downloads exactly the files named and does not then
    filter them; --include only narrows a whole-repo download."""
    assert selected(TREE, ["a.txt"], ["sub/*"], []) == ["a.txt"]


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
@pytest.mark.parametrize(
    "refusal",
    [
        HfHubError("nope", 401),
        HfHubError("nope", 403),
        HfHubError("nope", 404, "RepoNotFound"),
        HfHubError("nope", 404, "RevisionNotFound"),
    ],
)
async def test_download_still_names_the_absence_when_the_tree_refuses(
    mock_tree, doors, refusal
):
    # The tree walk raises for a repo it cannot see; download reads that as
    # nothing listed, so the message upstream prints is unchanged.
    record, _, _, _ = doors
    mock_tree.side_effect = refusal
    with patch(
        "mirage.commands.cli.builtin.hf.download.classify_absence",
        AsyncMock(return_value=Absence.REPO),
    ):
        with pytest.raises(HfHubError, match="Repository Not Found"):
            await download_cmd(
                inv(
                    texts=("acme/widget",),
                    flags={"local_dir": PathSpec.from_str_path("/work/out")},
                    doors=record,
                )
            )


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_download_lets_a_server_failure_through(mock_tree, doors):
    record, _, _, _ = doors
    mock_tree.side_effect = HfHubError("boom", 500)
    classify = AsyncMock(return_value=Absence.REPO)
    with patch(
        "mirage.commands.cli.builtin.hf.download.classify_absence", classify
    ):
        with pytest.raises(HfHubError, match="boom"):
            await download_cmd(
                inv(
                    texts=("acme/widget",),
                    flags={"local_dir": PathSpec.from_str_path("/work/out")},
                    doors=record,
                )
            )
    classify.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.hub_bytes")
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_download_writes_through_the_workspace_door(
    mock_tree, mock_bytes, doors
):
    record, calls, tree, _ = doors
    mock_tree.return_value = TREE
    mock_bytes.return_value = b"payload"
    await download_cmd(
        inv(
            texts=("acme/widget", "a.txt"),
            flags={"local_dir": PathSpec.from_str_path("/work/out")},
            doors=record,
        )
    )
    assert tree["/work/out/a.txt"] == b"payload"
    assert ("write", "/work/out/a.txt", {"data": b"payload"}) in calls


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.hub_bytes")
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_download_creates_every_nested_level(
    mock_tree, mock_bytes, doors
):
    """The dispatcher's mkdir is single-level, so a nested repo path
    needs one call per missing segment; a level that is already there is
    left alone, which is why /work is absent from the list."""
    record, calls, tree, _ = doors
    mock_tree.return_value = TREE
    mock_bytes.return_value = b"x"
    await download_cmd(
        inv(
            texts=("acme/widget", "sub/b.json"),
            flags={"local_dir": PathSpec.from_str_path("/work/out")},
            doors=record,
        )
    )
    made = [path for op, path, _ in calls if op == "mkdir"]
    assert made == ["/work/out", "/work/out/sub"]
    assert "/work/out/sub/b.json" in tree


@pytest.mark.asyncio
async def test_download_requires_a_local_dir(doors):
    """Upstream defaults to ~/.cache/huggingface, which a workspace has
    no equivalent of, so this must not silently resolve somewhere the
    agent cannot see."""
    record, _, _, _ = doors
    with pytest.raises(UsageError, match="--local-dir"):
        await download_cmd(inv(texts=("acme/widget",), doors=record))


@pytest.mark.asyncio
async def test_download_requires_a_repo_id(doors):
    record, _, _, _ = doors
    with pytest.raises(UsageError, match="repo_id"):
        await download_cmd(
            inv(
                flags={"local_dir": PathSpec.from_str_path("/work")},
                doors=record,
            )
        )


@pytest.mark.asyncio
async def test_download_needs_a_workspace():
    with pytest.raises(UsageError, match="workspace"):
        await download_cmd(
            inv(
                texts=("acme/widget",),
                flags={"local_dir": PathSpec.from_str_path("/work")},
            )
        )


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_download_refuses_when_nothing_matched(mock_tree, doors):
    """A glob that matched nothing in a repository that is plainly
    there: the Hub is asked why anyway, says nothing is missing, and the
    refusal names the line rather than inventing an absence."""
    record, _, _, _ = doors
    mock_tree.return_value = TREE
    with patch(
        "mirage.commands.cli.builtin.hf.download.classify_absence",
        AsyncMock(return_value=Absence.PRESENT),
    ):
        with pytest.raises(HfHubError, match="matched the line"):
            await download_cmd(
                inv(
                    texts=("acme/widget",),
                    flags={
                        "local_dir": PathSpec.from_str_path("/work/out"),
                        "include": ["zzz*"],
                    },
                    doors=record,
                )
            )


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_download_tells_the_three_absences_apart(mock_tree, doors):
    """download folds a refused tree walk (401/403/404) into an empty
    listing itself. Three different failures would then all read as "no
    files matched", so the CLI asks the Hub which one it was."""
    record, _, _, _ = doors
    mock_tree.return_value = {}
    cases = [
        (Absence.REPO, (), "Repository Not Found"),
        (Absence.REVISION, (), "Invalid rev id"),
        (Absence.PRESENT, ("nope.txt",), "Entry Not Found"),
    ]
    for absence, names, expected in cases:
        with patch(
            "mirage.commands.cli.builtin.hf.download.classify_absence",
            AsyncMock(return_value=absence),
        ):
            with pytest.raises(HfHubError, match=expected):
                await download_cmd(
                    inv(
                        texts=("acme/widget", *names),
                        flags={
                            "local_dir": PathSpec.from_str_path("/work/out")
                        },
                        doors=record,
                    )
                )


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.hub_bytes")
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_quiet_prints_only_the_directory(mock_tree, mock_bytes, doors):
    record, _, _, _ = doors
    mock_tree.return_value = TREE
    mock_bytes.return_value = b"x"
    text = await _text(
        await download_cmd(
            inv(
                texts=("acme/widget", "a.txt"),
                flags={
                    "local_dir": PathSpec.from_str_path("/work/out"),
                    "quiet": True,
                },
                doors=record,
            )
        )
    )
    assert text == "/work/out\n"


def test_refuse_variadic_accepts_real_filenames():
    """Upstream's --include is nargs='*'; mirage's grammar has no
    variadic option value, so the second pattern would land as a
    filename operand and be looked for literally. Only a glob-shaped
    operand is that mistake; a real filename is not."""
    refuse_variadic(["a.txt"], "--include", ["*.json"])


def test_refuse_variadic_names_the_spelling_that_works():
    with pytest.raises(UsageError) as caught:
        refuse_variadic(["*.txt"], "--include", ["*.json"])
    assert "write --include '*.json' --include '*.txt'" in str(caught.value)


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.hub_bytes")
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_download_refuses_the_upstream_variadic_line(
    mock_tree, mock_bytes, doors
):
    record, _, _, _ = doors
    mock_tree.return_value = TREE
    mock_bytes.return_value = b"x"
    with pytest.raises(UsageError, match="--include"):
        await download_cmd(
            inv(
                texts=("acme/widget", "*.json"),
                flags={
                    "include": ["*.txt"],
                    "local_dir": PathSpec.from_str_path("/work/out"),
                },
                doors=record,
            )
        )


@pytest.mark.asyncio
@patch("mirage.commands.cli.builtin.hf.download.hub_bytes")
@patch("mirage.commands.cli.builtin.hf.download.fetch_tree")
async def test_download_fetches_with_a_bounded_pool(
    mock_tree, mock_bytes, doors
):
    """The bound is the point, not the parallelism: the Hub rate-limits
    its resolvers, so a repository of many small files must not fan out
    without one."""
    record, _, tree, _ = doors
    mock_tree.return_value = TREE
    mock_bytes.return_value = b"x"
    await download_cmd(
        inv(
            texts=("acme/widget",),
            flags={
                "local_dir": PathSpec.from_str_path("/work/out"),
                "max_workers": 2,
            },
            doors=record,
        )
    )
    assert "/work/out/a.txt" in tree
    assert "/work/out/sub/b.json" in tree


@pytest.mark.asyncio
async def test_ensure_dir_tolerates_a_parent_another_worker_just_made():
    """A parallel download fans out over files that share parents, so two
    workers can read the same parent as missing and then both create it.
    The loser's EEXIST must not fail the whole gather."""
    dirs: set[str] = set()

    async def dispatch(op, spec, **kwargs):
        path = spec.virtual
        if op == "stat":
            # Yield here, so the second walk probes before the first has
            # created anything. Without it the two run to completion in
            # turn and the race the fix exists for never happens.
            await asyncio.sleep(0)
            if path in dirs:
                return FileStat(name=path, type=FileType.DIRECTORY), None
            raise FileNotFoundError(path)
        if op == "mkdir":
            if path in dirs:
                raise FileExistsError(path)
            dirs.add(path)
            return None, None
        raise AssertionError(f"unexpected op {op}")

    await asyncio.gather(
        ensure_dir(dispatch, PathSpec.from_str_path("/work/out")),
        ensure_dir(dispatch, PathSpec.from_str_path("/work/out")),
    )
    assert dirs == {"/work", "/work/out"}

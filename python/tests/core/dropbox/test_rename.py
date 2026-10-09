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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import push_cache_manager
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.rename import rename
from mirage.types import PathSpec
from mirage.vfs.dropbox.config import DropboxConfig
from tests.core.dropbox.conftest import FakeDropboxRpc


class _Moves:
    """Which invalidation each end of a rename took, in call order."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.calls.append(("unlink", path.virtual))

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.calls.append(("subtree", path.virtual))

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        return None


def make_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_rename_replaces_existing_destination_file():
    conflict = DropboxApiError("conflict", 409, "to/conflict/file/...")
    with patch(
        "mirage.core.dropbox.rename.move_path",
        new_callable=AsyncMock,
        side_effect=[conflict, {}],
    ) as moved:
        with patch(
            "mirage.core.dropbox.copy.get_metadata",
            new_callable=AsyncMock,
            return_value={".tag": "file", "name": "b.txt"},
        ):
            with patch(
                "mirage.core.dropbox.copy.delete_path",
                new_callable=AsyncMock,
            ) as deleted:
                await rename(
                    make_accessor(),
                    PathSpec.from_str_path("/a.txt"),
                    PathSpec.from_str_path("/b.txt"),
                )
    assert deleted.await_args.args[1] == "/b.txt"
    assert moved.await_count == 2


@pytest.mark.asyncio
async def test_rename_conflict_replaces_empty_dir_destination():
    conflict = DropboxApiError("conflict", 409, "to/conflict/folder/...")
    with patch(
        "mirage.core.dropbox.rename.move_path",
        new_callable=AsyncMock,
        side_effect=[conflict, {}],
    ) as moved:
        with patch(
            "mirage.core.dropbox.copy.get_metadata",
            new_callable=AsyncMock,
            return_value={".tag": "folder", "name": "dst"},
        ):
            with patch(
                "mirage.core.dropbox.copy.list_folder",
                new_callable=AsyncMock,
                return_value=[],
            ):
                with patch(
                    "mirage.core.dropbox.copy.delete_path",
                    new_callable=AsyncMock,
                ) as deleted:
                    await rename(
                        make_accessor(),
                        PathSpec.from_str_path("/src"),
                        PathSpec.from_str_path("/dst"),
                    )
    assert deleted.await_args.args[1] == "/dst"
    assert moved.await_count == 2


@pytest.mark.asyncio
async def test_rename_conflict_keeps_error_for_nonempty_dir():
    conflict = DropboxApiError("conflict", 409, "to/conflict/folder/...")
    with patch(
        "mirage.core.dropbox.rename.move_path",
        new_callable=AsyncMock,
        side_effect=[conflict, {}],
    ) as moved:
        with patch(
            "mirage.core.dropbox.copy.get_metadata",
            new_callable=AsyncMock,
            return_value={".tag": "folder", "name": "dst"},
        ):
            with patch(
                "mirage.core.dropbox.copy.list_folder",
                new_callable=AsyncMock,
                return_value=[{".tag": "file", "name": "keep.txt"}],
            ):
                with patch(
                    "mirage.core.dropbox.copy.delete_path",
                    new_callable=AsyncMock,
                ) as deleted:
                    with pytest.raises(DropboxApiError):
                        await rename(
                            make_accessor(),
                            PathSpec.from_str_path("/src"),
                            PathSpec.from_str_path("/dst"),
                        )
    assert deleted.await_count == 0
    assert moved.await_count == 1


@pytest.mark.asyncio
async def test_rename_missing_source_raises_enoent():
    with patch(
        "mirage.core.dropbox.rename.move_path",
        new_callable=AsyncMock,
        side_effect=DropboxApiError("nf", 409, "from_lookup/not_found/..."),
    ):
        with pytest.raises(FileNotFoundError):
            await rename(
                make_accessor(),
                PathSpec.from_str_path("/ghost"),
                PathSpec.from_str_path("/b.txt"),
            )


@pytest.mark.asyncio
async def test_rename_conflict_probe_is_bounded_to_one_entry(dropbox_accessor):
    # The conflict probe is bounded, not a full listing: `list_folder`
    # follows every continuation cursor, so asking it with a small page
    # size made one request per child to answer a yes/no.
    conflict = DropboxApiError("conflict", 409, "to/conflict/folder/...")
    rpc = FakeDropboxRpc(
        entries=[{".tag": "file", "name": "keep.txt"}] * 3,
        metadata={".tag": "folder", "name": "dst"},
        move_errors=[conflict],
    )
    with patch("mirage.core.dropbox.api.dropbox_rpc", new=rpc):
        with pytest.raises(DropboxApiError):
            await rename(
                dropbox_accessor,
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )
    assert rpc.list_limits == [1]
    assert rpc.list_requests == 1
    assert rpc.deleted == []


_CONFLICT_FOLDER = DropboxApiError("conflict", 409, "to/conflict/folder/...")
_CONFLICT_OTHER = DropboxApiError("conflict", 409, "to/conflict/other/...")
_CONFLICT_FILE = DropboxApiError("conflict", 409, "to/conflict/file/...")


async def _moved(*replies, existing: str | None) -> list[tuple[str, str]]:
    moves = _Moves()
    prev = push_cache_manager(moves)
    try:
        with patch(
            "mirage.core.dropbox.rename.move_path",
            new_callable=AsyncMock,
            side_effect=list(replies),
        ):
            with patch(
                "mirage.core.dropbox.copy.get_metadata",
                new_callable=AsyncMock,
                return_value={"name": "b"}
                if existing is None
                else {".tag": existing, "name": "b"},
            ):
                with patch(
                    "mirage.core.dropbox.copy.list_folder",
                    new_callable=AsyncMock,
                    return_value=[],
                ):
                    with patch(
                        "mirage.core.dropbox.copy.delete_path",
                        new_callable=AsyncMock,
                    ):
                        await rename(
                            make_accessor(),
                            PathSpec.from_str_path("/a"),
                            PathSpec.from_str_path("/b"),
                        )
    finally:
        push_cache_manager(prev)
    return moves.calls


_FILE = {".tag": "file", "name": "b"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("replies", "existing", "drops"),
    [
        ([_FILE], "folder", ("unlink", "unlink")),
        ([{".tag": "folder", "name": "b"}], "folder", ("subtree", "subtree")),
        ([{}], "folder", ("subtree", "subtree")),
        ([_CONFLICT_FOLDER, _FILE], "folder", ("unlink", "subtree")),
        ([_CONFLICT_OTHER, _FILE], None, ("unlink", "subtree")),
        ([_CONFLICT_FILE, _FILE], "file", ("unlink", "unlink")),
    ],
    ids=[
        "file",
        "folder",
        "no-tag",
        "file-over-empty-folder",
        "file-over-no-kind",
        "file-over-file",
    ],
)
async def test_only_a_moved_file_narrows_and_only_onto_a_file(
    replies, existing, drops
):
    # move_v2 answers with the moved entry's metadata; only a file tag
    # spares the subtree. A destination the move replaced keeps its
    # subtree unless that was positively a file: its name may still have
    # cached children removed outside mirage.
    assert await _moved(*replies, existing=existing) == [
        (drops[0], "/a"),
        (drops[1], "/b"),
    ]

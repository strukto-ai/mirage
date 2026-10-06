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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import ListingCheckStore, RAMIndexCacheStore
from mirage.core.box.client import BoxApiError, BoxTokenManager
from mirage.core.box.read import read
from mirage.core.box.readdir import readdir
from mirage.core.box.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.vfs.box.config import BoxConfig


@pytest.mark.asyncio
async def test_stat_root_fetches_folder_info(accessor, index):
    with patch(
        "mirage.core.box.stat.get_folder_info",
        new_callable=AsyncMock,
        return_value={"id": "0", "modified_at": "2026-04-01T00:00:00+00:00"},
    ) as mock_info:
        info = await stat(
            accessor, PathSpec(vfs_path="", virtual="/", directory="/"), index
        )
    assert info.type == FileType.DIRECTORY
    assert info.name == "/"
    assert info.modified == "2026-04-01T00:00:00+00:00"
    mock_info.assert_awaited_once_with(accessor.token_manager, "0")


@pytest.mark.asyncio
async def test_stat_file_carries_box_metadata(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                IndexEntry(
                    id="200",
                    name="a.txt",
                    resource_type="box/file",
                    remote_time="2026-04-01T00:00:00+00:00",
                    vfs_name="a.txt",
                    size=5,
                ),
            )
        ],
    )
    info = await stat(
        accessor,
        PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
        index,
    )
    assert info.content == ContentType.TEXT
    assert info.size == 5
    assert info.modified == "2026-04-01T00:00:00+00:00"
    assert info.fingerprint is None
    assert info.extra["box_id"] == "200"
    assert info.extra["resource_type"] == "box/file"


@pytest.mark.asyncio
async def test_stat_folder_is_directory(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "docs",
                IndexEntry(
                    id="100",
                    name="docs",
                    resource_type="box/folder",
                    remote_time="2026-04-01T00:00:00+00:00",
                    vfs_name="docs",
                ),
            )
        ],
    )
    info = await stat(
        accessor,
        PathSpec(vfs_path="docs", virtual="/docs", directory="/"),
        index,
    )
    assert info.type == FileType.DIRECTORY
    assert info.extra["box_id"] == "100"


@pytest.mark.asyncio
async def test_stat_populates_via_parent_readdir(accessor, index):
    items = [
        {
            "id": "200",
            "name": "a.txt",
            "type": "file",
            "size": 5,
            "modified_at": "2026-04-01T00:00:00+00:00",
        }
    ]
    with patch(
        "mirage.core.box.readdir.list_folder_items",
        new_callable=AsyncMock,
        return_value=items,
    ):
        info = await stat(
            accessor,
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
            index,
        )
    assert info.size == 5


@pytest.mark.asyncio
async def test_stat_missing_raises(accessor, index):
    with (
        patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "mirage.core.box.resolve.list_folder_items",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(vfs_path="ghost", virtual="/ghost", directory="/"),
                index,
            )


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(accessor, index):
    # The fskit invariant behind sizes_always_known: the size stat serves
    # from the listing must equal the byte length a read delivers, 0-byte
    # files included; weblinks never appear at all.
    contents = {
        "200": b"hello",
        "201": b"",
        "400": b"abc",
    }
    tree = {
        "0": [
            {
                "id": "100",
                "name": "docs",
                "type": "folder",
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
            {
                "id": "200",
                "name": "a.txt",
                "type": "file",
                "size": 5,
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
            {
                "id": "201",
                "name": "empty.txt",
                "type": "file",
                "size": 0,
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
            {
                "id": "300",
                "name": "homepage",
                "type": "web_link",
                "modified_at": "2026-04-01T00:00:00+00:00",
            },
        ],
        "100": [
            {
                "id": "400",
                "name": "b.bin",
                "type": "file",
                "size": 3,
                "modified_at": "2026-04-01T00:00:00+00:00",
            }
        ],
    }

    async def _list(_tm, folder_id):
        return tree[folder_id]

    async def _download(_tm, file_id, _range=None):
        return contents[file_id]

    files: list[str] = []
    with (
        patch("mirage.core.box.readdir.list_folder_items", side_effect=_list),
        patch("mirage.core.box.read.download_file", side_effect=_download),
    ):
        stack = ["/"]
        while stack:
            current = stack.pop()
            listing = await readdir(
                accessor, PathSpec.from_str_path(current), index
            )
            for child in listing:
                trimmed = child.rstrip("/")
                info = await stat(
                    accessor, PathSpec.from_str_path(trimmed), index
                )
                if info.type == FileType.DIRECTORY:
                    stack.append(trimmed)
                    continue
                assert info.size is not None, trimmed
                body = await read(
                    accessor, PathSpec.from_str_path(trimmed), index
                )
                assert info.size == len(body), trimmed
                files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]


@pytest.mark.asyncio
async def test_stat_direct_resolve_hides_weblinks(accessor, index):
    # Weblinks are filtered from listings; the resolve_item fallback must
    # not resurface one as a sizeless, unreadable entry.
    weblink = {
        "id": "300",
        "name": "homepage",
        "type": "web_link",
        "modified_at": "2026-04-01T00:00:00+00:00",
    }
    with (
        patch(
            "mirage.core.box.readdir.list_folder_items",
            new_callable=AsyncMock,
            return_value=[weblink],
        ),
        patch(
            "mirage.core.box.resolve.list_folder_items",
            new_callable=AsyncMock,
            return_value=[weblink],
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(
                    vfs_path="homepage", virtual="/homepage", directory="/"
                ),
                index,
            )


@pytest.mark.asyncio
async def test_stat_root_reads_a_404_as_absence(accessor, index):
    with patch(
        "mirage.core.box.stat.get_folder_info",
        new_callable=AsyncMock,
        side_effect=BoxApiError("Box GET /folders/0 -> 404 not_found", 404),
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(vfs_path="", virtual="/", directory="/"),
                index,
            )


@pytest.mark.asyncio
async def test_stat_root_keeps_a_server_error_a_failure(accessor, index):
    with patch(
        "mirage.core.box.stat.get_folder_info",
        new_callable=AsyncMock,
        side_effect=BoxApiError("Box GET /folders/0 -> 500 internal", 500),
    ):
        with pytest.raises(BoxApiError) as caught:
            await stat(
                accessor,
                PathSpec(vfs_path="", virtual="/", directory="/"),
                index,
            )
    assert caught.value.status == 500


SHA_FAST = "fast"
SHA_WALK = "walk"
ALL_FILES = {"type": "folder", "id": "0", "name": "All Files"}
TRASH = {"type": "folder", "id": "1", "name": "Trash"}


def _folder(fid: str, name: str) -> dict:
    return {"type": "folder", "id": fid, "name": name}


def _row(fid: str, name: str, sha1: str | None) -> dict:
    row = {
        "type": "file",
        "id": fid,
        "name": name,
        "size": 5,
        "modified_at": "2026-04-01T00:00:00+00:00",
    }
    if sha1 is not None:
        row["sha1"] = sha1
    return row


def _item(chain: list[dict], status: str = "active", **over) -> dict:
    item = {
        **_row("F1", "c.txt", SHA_FAST),
        "item_status": status,
        "path_collection": {"total_count": len(chain), "entries": chain},
    }
    item.update(over)
    return item


class _Box:
    """Folder listings by id, the one file-info answer, and a ledger."""

    def __init__(self, folders: dict, info) -> None:
        self.folders = folders
        self.info = info
        self.log: list[str] = []

    async def list_items(self, _tm, folder_id):
        self.log.append(f"items:{folder_id}")
        if folder_id not in self.folders:
            raise BoxApiError("gone", 404)
        return self.folders[folder_id]

    async def file_info(self, _tm, file_id):
        self.log.append(f"info:{file_id}")
        if isinstance(self.info, Exception):
            raise self.info
        return self.info


def _walk_tree(root: str = "0", leaf: dict | None = None) -> dict:
    kids = [] if leaf is None else [leaf]
    return {
        root: [_folder("A", "a")],
        "A": [_folder("B", "b")],
        "B": kids,
    }


async def _scratch_stat(
    accessor, box, virtual="/a/b/c.txt", row_id="F1", kind="box/file"
):
    src = RAMIndexCacheStore()
    parent, name = virtual.rsplit("/", 1)
    row = IndexEntry(id=row_id, name=name, resource_type=kind)
    await src.set_dir(parent, [(name, row)])
    scratch = ListingCheckStore(hints=src)
    vfs_path = "a/b/c.txt"
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=box.list_items),
        patch("mirage.core.box.resolve.list_folder_items", new=box.list_items),
        patch("mirage.core.box.stat.get_file_info", new=box.file_info),
    ):
        return await stat(
            accessor,
            PathSpec(
                vfs_path=vfs_path,
                virtual=virtual,
                directory=virtual.rsplit("/", 1)[0],
            ),
            scratch,
        )


WALK_FOUND = ["items:0", "items:A", "items:B"]
WALK_GONE = WALK_FOUND + WALK_FOUND


def _rooted(root: str) -> BoxAccessor:
    config = BoxConfig(access_token="test-token", root_folder_id=root)
    return BoxAccessor(config, BoxTokenManager(config))


@pytest.mark.asyncio
async def test_a_sha1_less_row_stats_with_no_token(accessor, index):
    # modified_at is no content token: two same-size edits in one second
    # share it, so a file Box gives no sha1 stats with none.
    with patch(
        "mirage.core.box.readdir.list_folder_items",
        new_callable=AsyncMock,
        return_value=[_row("200", "a.txt", None)],
    ):
        info = await stat(
            accessor,
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
            index,
        )
    assert info.fingerprint is None
    assert info.modified == "2026-04-01T00:00:00+00:00"


@pytest.mark.asyncio
async def test_a_direct_resolve_of_a_sha1_less_item_has_no_token(accessor):
    listing = AsyncMock(return_value=[_row("200", "a.txt", None)])
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=listing),
        patch("mirage.core.box.resolve.list_folder_items", new=listing),
    ):
        info = await stat(
            accessor,
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
        )
    assert info.fingerprint is None
    assert info.modified == "2026-04-01T00:00:00+00:00"


@pytest.mark.asyncio
async def test_a_listed_sha1_is_the_stat_token(accessor, index):
    await index.set_dir(
        "/",
        [
            (
                "a.txt",
                IndexEntry(
                    id="200",
                    name="a.txt",
                    resource_type="box/file",
                    remote_time="2026-04-01T00:00:00+00:00",
                    extra={"sha1": SHA_FAST},
                ),
            )
        ],
    )
    info = await stat(
        accessor,
        PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
        index,
    )
    assert info.fingerprint == SHA_FAST


@pytest.mark.asyncio
async def test_a_valid_hint_is_one_request_and_the_walks_answer(accessor):
    chain = [ALL_FILES, _folder("A", "a"), _folder("B", "b")]
    box = _Box(_walk_tree(leaf=_row("F1", "c.txt", SHA_FAST)), _item(chain))
    fast = await _scratch_stat(accessor, box)
    assert box.log == ["info:F1"]
    walk_box = _Box(_walk_tree(leaf=_row("F1", "c.txt", SHA_FAST)), None)
    walked = await _scratch_stat(accessor, walk_box, row_id="")
    # The command reuses the probe's stat, so the fast path must build the
    # stat the walk would have: compared with the real walk, not by hand.
    assert walk_box.log == WALK_FOUND
    assert fast == walked
    assert fast.fingerprint == SHA_FAST


@pytest.mark.asyncio
async def test_only_a_scratch_store_takes_the_one_request_path(accessor):
    box = _Box(_walk_tree(leaf=_row("F1", "c.txt", SHA_FAST)), None)
    store = RAMIndexCacheStore()
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=box.list_items),
        patch("mirage.core.box.stat.get_file_info", new=box.file_info),
    ):
        await stat(
            accessor,
            PathSpec(
                vfs_path="a/b/c.txt", virtual="/a/b/c.txt", directory="/a/b"
            ),
            store,
        )
    assert box.log == WALK_FOUND


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row_id, kind",
    [("", "box/file"), ("F1", "box/folder")],
    ids=["empty-id", "folder"],
)
async def test_an_unusable_hint_walks_without_asking_for_it(
    accessor, row_id, kind
):
    box = _Box(_walk_tree(leaf=_row("F2", "c.txt", SHA_WALK)), None)
    info = await _scratch_stat(accessor, box, row_id=row_id, kind=kind)
    assert box.log == WALK_FOUND
    assert info.fingerprint == SHA_WALK


@pytest.mark.asyncio
async def test_no_hint_walks_as_today(accessor):
    box = _Box(_walk_tree(leaf=_row("F2", "c.txt", SHA_WALK)), None)
    scratch = ListingCheckStore()
    with (
        patch("mirage.core.box.readdir.list_folder_items", new=box.list_items),
        patch("mirage.core.box.stat.get_file_info", new=box.file_info),
    ):
        info = await stat(
            accessor,
            PathSpec(
                vfs_path="a/b/c.txt", virtual="/a/b/c.txt", directory="/a/b"
            ),
            scratch,
        )
    assert box.log == WALK_FOUND
    assert info.fingerprint == SHA_WALK


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "info, leaf, ledger",
    [
        # Only the active-status check fails: trashed, its chain unchanged.
        (
            _item(
                [ALL_FILES, _folder("A", "a"), _folder("B", "b")], "trashed"
            ),
            _row("F2", "c.txt", SHA_WALK),
            WALK_FOUND,
        ),
        # Only the path-name check fails: moved under a/x.
        (
            _item([ALL_FILES, _folder("A", "a"), _folder("X", "x")]),
            None,
            WALK_GONE,
        ),
        # Only the path-name check fails: the parent renamed to b2.
        (
            _item([ALL_FILES, _folder("A", "a"), _folder("B", "b2")]),
            None,
            WALK_GONE,
        ),
        # Only the path-name check fails: a case-only rename, which a listing
        # tells apart.
        (
            _item(
                [ALL_FILES, _folder("A", "a"), _folder("B", "b")], name="C.txt"
            ),
            None,
            WALK_GONE,
        ),
        # Only the is-a-file check fails.
        (
            _item(
                [ALL_FILES, _folder("A", "a"), _folder("B", "b")],
                type="web_link",
            ),
            _row("F2", "c.txt", SHA_WALK),
            WALK_FOUND,
        ),
        (
            BoxApiError("purged", 404),
            _row("F2", "c.txt", SHA_WALK),
            WALK_FOUND,
        ),
        (
            BoxApiError("no access", 403),
            _row("F2", "c.txt", SHA_WALK),
            WALK_FOUND,
        ),
    ],
    ids=[
        "trashed",
        "moved",
        "parent-renamed",
        "case-only",
        "not-a-file",
        "404",
        "403",
    ],
)
async def test_a_hint_that_no_longer_names_the_path_falls_back_to_the_walk(
    accessor, info, leaf, ledger
):
    box = _Box(_walk_tree(leaf=leaf), info)
    if leaf is None:
        with pytest.raises(FileNotFoundError):
            await _scratch_stat(accessor, box)
    else:
        assert (await _scratch_stat(accessor, box)).fingerprint == SHA_WALK
    assert box.log == ["info:F1"] + ledger


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chain",
    [
        # The mount root R itself in Trash: the All-Files-root and no-Trash
        # checks both fail.
        [TRASH, _folder("R", "r"), _folder("A", "a"), _folder("B", "b")],
        # Only the no-Trash check fails, should Box render Trash under 0.
        [
            ALL_FILES,
            TRASH,
            _folder("R", "r"),
            _folder("A", "a"),
            _folder("B", "b"),
        ],
    ],
    ids=["root-in-trash", "trash-under-all-files"],
)
async def test_a_file_under_a_trashed_mount_root_is_gone(chain):
    box = _Box({}, _item(chain))
    with pytest.raises(FileNotFoundError):
        await _scratch_stat(_rooted("R"), box, virtual="/m/a/b/c.txt")
    # The trashed root's listing 404s for the populate walk and again for
    # resolve_item.
    assert box.log == ["info:F1", "items:R", "items:R"]


@pytest.mark.asyncio
async def test_a_chain_not_rooted_at_all_files_falls_back():
    # R reached from a folder that is not 0. Only the All-Files-root check
    # rejects it, and the walk then answers.
    chain = [
        _folder("X", "x"),
        _folder("R", "r"),
        _folder("A", "a"),
        _folder("B", "b"),
    ]
    box = _Box(_walk_tree("R", _row("F2", "c.txt", SHA_WALK)), _item(chain))
    info = await _scratch_stat(_rooted("R"), box, virtual="/m/a/b/c.txt")
    assert info.fingerprint == SHA_WALK
    assert box.log == ["info:F1", "items:R", "items:A", "items:B"]


@pytest.mark.asyncio
async def test_a_mount_rooted_below_all_files_takes_the_one_request_path():
    chain = [
        ALL_FILES,
        _folder("X", "x"),
        _folder("R", "r"),
        _folder("A", "a"),
        _folder("B", "b"),
    ]
    box = _Box({}, _item(chain))
    info = await _scratch_stat(_rooted("R"), box, virtual="/m/a/b/c.txt")
    assert box.log == ["info:F1"]
    assert info.fingerprint == SHA_FAST


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 429, 500])
async def test_a_failed_point_lookup_propagates(accessor, status):
    box = _Box(
        _walk_tree(leaf=_row("F1", "c.txt", SHA_FAST)),
        BoxApiError("x", status),
    )
    with pytest.raises(BoxApiError) as exc:
        await _scratch_stat(accessor, box)
    assert exc.value.status == status
    assert box.log == ["info:F1"]


@pytest.mark.asyncio
async def test_an_answer_without_item_status_is_not_taken_as_active(accessor):
    # Box sends item_status when asked; an answer without it proves nothing
    # about the file being active, so the walk decides.
    chain = [ALL_FILES, _folder("A", "a"), _folder("B", "b")]
    info = _item(chain)
    del info["item_status"]
    box = _Box(_walk_tree(leaf=_row("F2", "c.txt", SHA_WALK)), info)
    assert (await _scratch_stat(accessor, box)).fingerprint == SHA_WALK
    assert box.log == ["info:F1"] + WALK_FOUND


@pytest.mark.asyncio
async def test_a_rooted_mount_stats_its_root_folder_not_all_files():
    with patch(
        "mirage.core.box.stat.get_folder_info",
        new_callable=AsyncMock,
        return_value={"id": "R", "modified_at": "2026-05-01T00:00:00+00:00"},
    ) as mock_info:
        info = await stat(
            _rooted("R"), PathSpec(vfs_path="", virtual="/", directory="/")
        )
    assert info.extra["box_id"] == "R"
    assert mock_info.await_args.args[1] == "R"

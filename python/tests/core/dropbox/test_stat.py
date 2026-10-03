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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.read import read
from mirage.core.dropbox.readdir import readdir
from mirage.core.dropbox.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.core.dropbox.conftest import FakeDropboxRpc

# The default seam for this file is the JSON-RPC transport
# (`mirage.core.dropbox.api.dropbox_rpc`): `list_folder`, `get_metadata`
# and the token refresh all funnel through it, so one FakeDropboxRpc patch
# makes stat hermetic with no live api.dropboxapi.com call and no token to
# seed. The two error-propagation tests that assert "the collaborator
# raised X" patch the collaborator directly instead, since the transport
# fake only ever raises a 409.
RPC = "mirage.core.dropbox.api.dropbox_rpc"

FILE_ENTRY = {
    ".tag": "file",
    "id": "id:a",
    "name": "a.txt",
    "path_display": "/a.txt",
    "size": 5,
    "server_modified": "2026-04-01T00:00:00Z",
    "content_hash": "hash-a",
}

FOLDER_ENTRY = {
    ".tag": "folder",
    "id": "id:docs",
    "name": "docs",
    "path_display": "/docs",
}


# Stateless transport fakes for the error-path tests. They capture nothing
# from a test body, so they live at module scope (a nested function is for
# closures only).
async def _meta_500(_tm, _endpoint, _body):
    raise DropboxApiError("boom", 500)


async def _list_500(_tm, endpoint, _body):
    if endpoint == "/files/list_folder":
        raise DropboxApiError("boom", 500)
    raise AssertionError(f"unexpected endpoint {endpoint}")


async def _all_absent(_tm, _endpoint, _body):
    raise DropboxApiError("nf", 409, "path/not_found/...")


async def _restricted(_tm, _endpoint, _body):
    raise DropboxApiError("restricted", 409, "path/restricted_content/..")


async def _server_error_naming_a_miss(_tm, _endpoint, _body):
    raise DropboxApiError("relay", 502, "path/not_found/..")


async def _not_folder(_tm, _endpoint, _body):
    raise DropboxApiError("nf", 409, "path/not_folder/..")


async def _under_file(_tm, endpoint, body):
    if endpoint == "/files/list_folder":
        raise DropboxApiError("nf", 409, "path/not_folder/...")
    if endpoint == "/files/get_metadata":
        if body["path"] == "/a.txt":
            return {".tag": "file", "name": "a.txt"}
        raise DropboxApiError("nf", 409, "path/not_found/...")
    raise AssertionError(f"unexpected endpoint {endpoint}")


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def scratch():
    # The throwaway store a fresh probe or the drift check stats through.
    return RAMIndexCacheStore(scratch=True)


@pytest.mark.asyncio
async def test_stat_mount_root_is_directory(dropbox_accessor, index):
    rpc = FakeDropboxRpc()
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(vfs_path="", virtual="/", directory="/"),
            index,
        )
    assert out.type == FileType.DIRECTORY
    assert out.name == "/"
    assert rpc.list_requests == 0


@pytest.mark.asyncio
async def test_stat_null_index_file_from_api(dropbox_accessor):
    # No index: stat resolves directly through get_metadata
    # (unlink/rmdir classification and walk fallbacks take this path).
    rpc = FakeDropboxRpc(metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        out = await stat(dropbox_accessor, PathSpec.from_str_path("/a.txt"))
    assert out.type == FileType.FILE
    assert out.name == "a.txt"
    assert out.size == 5
    assert out.content == ContentType.TEXT
    assert out.modified == "2026-04-01T00:00:00Z"
    assert out.fingerprint == "hash-a"
    assert out.extra["dropbox_id"] == "id:a"
    assert out.extra["resource_type"] == "dropbox/file"


@pytest.mark.asyncio
async def test_stat_null_index_folder_from_api(dropbox_accessor):
    rpc = FakeDropboxRpc(metadata=FOLDER_ENTRY)
    with patch(RPC, new=rpc):
        out = await stat(dropbox_accessor, PathSpec.from_str_path("/docs"))
    assert out.type == FileType.DIRECTORY
    assert out.name == "docs"
    assert out.size is None
    assert out.extra["dropbox_id"] == "id:docs"


@pytest.mark.asyncio
async def test_stat_null_index_missing_is_enoent(dropbox_accessor):
    rpc = FakeDropboxRpc(metadata=None)
    with patch(RPC, new=rpc):
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(dropbox_accessor, PathSpec.from_str_path("/ghost.txt"))
    assert str(excinfo.value) == "/ghost.txt"


@pytest.mark.asyncio
async def test_stat_null_index_non_409_propagates(dropbox_accessor):
    # A rate-limit or server error is not absence: it must surface, not
    # collapse into ENOENT.
    with patch(RPC, new=_meta_500):
        with pytest.raises(DropboxApiError) as excinfo:
            await stat(dropbox_accessor, PathSpec.from_str_path("/a.txt"))
    assert excinfo.value.status == 500


_FALLBACK_CASES = [
    (
        {
            ".tag": "file",
            "id": "id:x",
            "name": "f.txt",
            "client_modified": "2026-01-02T00:00:00Z",
            "size": 3,
        },
        "id:x",
        3,
        "2026-01-02T00:00:00Z",
        None,
    ),
    (
        {
            ".tag": "file",
            "id": "id:x",
            "name": "f.txt",
            "size": 3,
        },
        "id:x",
        3,
        "",
        None,
    ),
    (
        {
            ".tag": "file",
            "name": "f.txt",
            "path_display": "/d/f.txt",
            "size": 3,
        },
        "/d/f.txt",
        3,
        "",
        None,
    ),
    (
        {
            ".tag": "file",
            "name": "f.txt",
            "size": 3,
        },
        "f.txt",
        3,
        "",
        None,
    ),
    (
        {
            ".tag": "file",
            "id": "id:x",
            "name": "f.txt",
        },
        "id:x",
        None,
        "",
        None,
    ),
    (
        {
            ".tag": "file",
            "id": "id:x",
            "name": "f.txt",
            "size": "big",
        },
        "id:x",
        None,
        "",
        None,
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "entry, dropbox_id, size, modified, fingerprint", _FALLBACK_CASES
)
async def test_stat_entry_field_fallbacks(
    dropbox_accessor, entry, dropbox_id, size, modified, fingerprint
):
    # _stat_from_entry's fallbacks: server_modified→client_modified→"",
    # id→path_display→name, no content_hash is no token (never the
    # modified stamp, a different kind than a read records), and a
    # non-int/absent size renders as None
    # (the unknown-size machinery, never a fabricated number).
    rpc = FakeDropboxRpc(metadata=entry)
    with patch(RPC, new=rpc):
        out = await stat(dropbox_accessor, PathSpec.from_str_path("/f.txt"))
    assert out.extra["dropbox_id"] == dropbox_id
    assert out.size == size
    assert out.modified == modified
    assert out.fingerprint == fingerprint


@pytest.mark.asyncio
async def test_stat_scratch_miss_asks_one_point_lookup(
    dropbox_accessor, scratch
):
    # A fresh probe stats through a scratch store: one get_metadata, never a
    # listing of the parent, whose size is the folder's.
    rpc = FakeDropboxRpc(entries=[FILE_ENTRY], metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
            scratch,
        )
    assert out.type == FileType.FILE
    assert out.name == "a.txt"
    assert out.size == 5
    assert out.content == ContentType.TEXT
    assert out.modified == "2026-04-01T00:00:00Z"
    assert out.fingerprint == "hash-a"
    assert out.extra["dropbox_id"] == "id:a"
    assert out.extra["resource_type"] == "dropbox/file"
    assert rpc.list_requests == 0
    assert rpc.metadata_paths == ["/a.txt"]


@pytest.mark.asyncio
async def test_stat_point_answer_in_another_case_is_enoent(
    dropbox_accessor, scratch
):
    # get_metadata matches case-insensitively, where a listing's names are
    # exact: a point answer naming the file in another case is not this
    # path, as the listing would have said.
    rpc = FakeDropboxRpc(metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(vfs_path="A.TXT", virtual="/A.TXT", directory="/"),
                scratch,
            )
    assert str(excinfo.value) == "/A.TXT"
    assert rpc.list_requests == 0


@pytest.mark.asyncio
async def test_stat_serves_index_hit_without_second_call(
    dropbox_accessor, index
):
    # The reason the index exists: once a parent listing populates it, a
    # stat of any sibling serves from cache. `metadata=None` makes a stray
    # get_metadata blow up as a 409, so a single list request proves both
    # the file and the folder came from the index.
    rpc = FakeDropboxRpc(entries=[FOLDER_ENTRY, FILE_ENTRY], metadata=None)
    with patch(RPC, new=rpc):
        await readdir(dropbox_accessor, PathSpec.from_str_path("/"), index)
        file_out = await stat(
            dropbox_accessor,
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
            index,
        )
        dir_out = await stat(
            dropbox_accessor,
            PathSpec(vfs_path="docs", virtual="/docs", directory="/"),
            index,
        )
    assert file_out.type == FileType.FILE
    assert dir_out.type == FileType.DIRECTORY
    assert dir_out.extra["dropbox_id"] == "id:docs"
    assert rpc.list_requests == 1
    assert rpc.metadata_paths == []


@pytest.mark.asyncio
async def test_stat_miss_in_a_cached_listing_is_enoent(
    dropbox_accessor, index
):
    # A cached parent listing without the child answers ENOENT from the
    # index, with no point lookup.
    other = {
        ".tag": "file",
        "id": "id:o",
        "name": "other.txt",
        "path_display": "/other.txt",
        "size": 1,
    }
    rpc = FakeDropboxRpc(entries=[other])
    with patch(RPC, new=rpc):
        await readdir(dropbox_accessor, PathSpec.from_str_path("/"), index)
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="note.txt", virtual="/note.txt", directory="/"
                ),
                index,
            )
    assert str(excinfo.value) == "/note.txt"
    assert rpc.list_requests == 1
    assert rpc.metadata_paths == []


@pytest.mark.asyncio
async def test_stat_scratch_miss_under_mount_prefix(dropbox_accessor, scratch):
    # Every other test runs on an unprefixed mount; this pins the prefix
    # arithmetic (virtual_key and the Dropbox path asked for).
    rpc = FakeDropboxRpc(metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(
                virtual="/dropbox/a.txt",
                directory="/dropbox",
                vfs_path=mount_key("/dropbox/a.txt", "/dropbox"),
            ),
            scratch,
        )
    assert out.type == FileType.FILE
    assert out.name == "a.txt"
    assert out.size == 5
    assert rpc.metadata_paths == ["/a.txt"]


@pytest.mark.asyncio
async def test_stat_scratch_miss_under_a_missing_parent_names_the_child(
    dropbox_accessor, scratch
):
    # The one lookup answers 409 because the parent is missing too; the
    # ENOENT names the path asked for, not the parent.
    with patch(RPC, new=_all_absent):
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="ghost/missing.txt",
                    virtual="/ghost/missing.txt",
                    directory="/ghost",
                ),
                scratch,
            )
    assert str(excinfo.value) == "/ghost/missing.txt"


@pytest.mark.asyncio
async def test_stat_scratch_409_that_is_not_a_miss_propagates(
    dropbox_accessor, scratch
):
    # A restricted file exists: its 409 is no miss, so the fresh probe must
    # not hear ENOENT and call it gone, dropping its overlay.
    with patch(RPC, new=_restricted):
        with pytest.raises(DropboxApiError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
                scratch,
            )
    assert excinfo.value.summary.startswith("path/restricted_content")


@pytest.mark.asyncio
async def test_stat_scratch_miss_needs_a_409(dropbox_accessor, scratch):
    # Only a 409 carries Dropbox's verdict; a relay's 5xx whose body happens
    # to read path/not_found is no evidence the file is gone.
    with patch(RPC, new=_server_error_naming_a_miss):
        with pytest.raises(DropboxApiError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
                scratch,
            )
    assert excinfo.value.status == 502


@pytest.mark.asyncio
async def test_stat_scratch_not_folder_is_a_miss(dropbox_accessor, scratch):
    with patch(RPC, new=_not_folder):
        with pytest.raises(FileNotFoundError):
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt"
                ),
                scratch,
            )


@pytest.mark.asyncio
async def test_stat_scratch_lookup_server_error_propagates(
    dropbox_accessor, scratch
):
    # A 5xx/429 from the point lookup is not absence: stat must let it
    # surface rather than collapse it into a (destructively actionable)
    # false ENOENT.
    with patch(RPC, new=_meta_500):
        with pytest.raises(DropboxApiError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="ghost/missing.txt",
                    virtual="/ghost/missing.txt",
                    directory="/ghost",
                ),
                scratch,
            )
    assert excinfo.value.status == 500


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(dropbox_accessor, index):
    # The fskit invariant behind sizes_always_known: the size stat serves
    # from the listing must equal the byte length a read delivers, 0-byte
    # files included. Listings go through the transport seam; the content
    # channel (dropbox_download) does not pass through dropbox_rpc, so it
    # keeps its own download seam.
    contents = {
        "/a.txt": b"hello",
        "/empty.txt": b"",
        "/docs/b.bin": b"abc",
    }
    tree = {
        "": [
            {
                ".tag": "folder",
                "id": "id:docs",
                "name": "docs",
                "path_display": "/docs",
            },
            {
                ".tag": "file",
                "id": "id:a",
                "name": "a.txt",
                "path_display": "/a.txt",
                "size": 5,
                "server_modified": "2026-04-01T00:00:00Z",
            },
            {
                ".tag": "file",
                "id": "id:empty",
                "name": "empty.txt",
                "path_display": "/empty.txt",
                "size": 0,
                "server_modified": "2026-04-01T00:00:00Z",
            },
        ],
        "/docs": [
            {
                ".tag": "file",
                "id": "id:b",
                "name": "b.bin",
                "path_display": "/docs/b.bin",
                "size": 3,
                "server_modified": "2026-04-01T00:00:00Z",
            }
        ],
    }

    async def _rpc(_tm, endpoint, body):
        if endpoint == "/files/list_folder":
            return {
                "entries": tree[body["path"]],
                "cursor": "c",
                "has_more": False,
            }
        raise AssertionError(f"unexpected endpoint {endpoint}")

    async def _download(_tm, path, _range=None):
        return contents[path], None

    files: list[str] = []
    with (
        patch(RPC, new=_rpc),
        patch(
            "mirage.core.dropbox.read.dropbox_download", side_effect=_download
        ),
    ):
        stack = ["/"]
        while stack:
            current = stack.pop()
            listing = await readdir(
                dropbox_accessor, PathSpec.from_str_path(current), index
            )
            for child in listing:
                trimmed = child.rstrip("/")
                info = await stat(
                    dropbox_accessor, PathSpec.from_str_path(trimmed), index
                )
                if info.type == FileType.DIRECTORY:
                    stack.append(trimmed)
                    continue
                assert info.size is not None, trimmed
                body = await read(
                    dropbox_accessor, PathSpec.from_str_path(trimmed), index
                )
                assert info.size == len(body), trimmed
                files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]


@pytest.mark.asyncio
async def test_stat_on_a_mount_index_lists_the_parent(dropbox_accessor, index):
    # A mount's own index is not scratch: a cold miss lists the parent and
    # keeps it, as before, so the next stat of it or a sibling is free.
    rpc = FakeDropboxRpc(entries=[FILE_ENTRY], metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        spec = PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/")
        await stat(dropbox_accessor, spec, index)
        await stat(dropbox_accessor, spec, index)
    assert rpc.list_requests == 1
    assert rpc.metadata_paths == []


@pytest.mark.asyncio
async def test_stat_failed_populate_is_enoent(dropbox_accessor, index):
    # A genuinely missing parent (409 on the listing and on every ancestor
    # probe) surfaces as ENOENT through readdir; stat swallows that and
    # answers its own ENOENT naming the child, not the parent.
    with patch(RPC, new=_all_absent):
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="ghost/missing.txt",
                    virtual="/ghost/missing.txt",
                    directory="/ghost",
                ),
                index,
            )
    assert str(excinfo.value) == "/ghost/missing.txt"


@pytest.mark.asyncio
async def test_stat_populate_server_error_propagates(dropbox_accessor, index):
    # A 5xx/429 while listing the parent is not absence: readdir re-raises
    # it, and stat must let it surface rather than collapse it into a
    # (destructively actionable) false ENOENT.
    with patch(RPC, new=_list_500):
        with pytest.raises(DropboxApiError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="ghost/missing.txt",
                    virtual="/ghost/missing.txt",
                    directory="/ghost",
                ),
                index,
            )
    assert excinfo.value.status == 500


@pytest.mark.asyncio
async def test_stat_enotdir_from_populate_propagates(dropbox_accessor, index):
    # A path under a file is ENOTDIR, not ENOENT: readdir's ancestor walk
    # classifies it, and stat must let NotADirectoryError escape.
    with patch(RPC, new=_under_file):
        with pytest.raises(NotADirectoryError):
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt"
                ),
                index,
            )


@pytest.mark.asyncio
async def test_stat_scratch_miss_is_one_lookup_even_under_a_file(
    dropbox_accessor, scratch
):
    # The probe's callers treat ENOENT and ENOTDIR alike, so a scratch miss
    # asks nothing past the path itself, even when a parent is a file.
    rpc = FakeDropboxRpc(metadata_by_path={"/a.txt": FILE_ENTRY})
    with patch(RPC, new=rpc):
        with pytest.raises(FileNotFoundError):
            await stat(
                dropbox_accessor,
                PathSpec(
                    vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt"
                ),
                scratch,
            )
    assert rpc.metadata_paths == ["/a.txt/x"]

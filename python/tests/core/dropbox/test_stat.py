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


async def _all_absent(_tm, _endpoint, _body):
    raise DropboxApiError("nf", 409, "path/not_found/...")


async def _list_500(_tm, endpoint, _body):
    if endpoint == "/files/list_folder":
        raise DropboxApiError("boom", 500)
    raise AssertionError(f"unexpected endpoint {endpoint}")


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


@pytest.mark.asyncio
async def test_stat_mount_root_is_directory(dropbox_accessor, index):
    rpc = FakeDropboxRpc()
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(resource_path="", virtual="/", directory="/"), index)
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
    assert out.fingerprint == "2026-04-01T00:00:00Z"
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
    ({
        ".tag": "file",
        "id": "id:x",
        "name": "f.txt",
        "client_modified": "2026-01-02T00:00:00Z",
        "size": 3,
    }, "id:x", 3, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"),
    ({
        ".tag": "file",
        "id": "id:x",
        "name": "f.txt",
        "size": 3,
    }, "id:x", 3, "", None),
    ({
        ".tag": "file",
        "name": "f.txt",
        "path_display": "/d/f.txt",
        "size": 3,
    }, "/d/f.txt", 3, "", None),
    ({
        ".tag": "file",
        "name": "f.txt",
        "size": 3,
    }, "f.txt", 3, "", None),
    ({
        ".tag": "file",
        "id": "id:x",
        "name": "f.txt",
    }, "id:x", None, "", None),
    ({
        ".tag": "file",
        "id": "id:x",
        "name": "f.txt",
        "size": "big",
    }, "id:x", None, "", None),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("entry, dropbox_id, size, modified, fingerprint",
                         _FALLBACK_CASES)
async def test_stat_entry_field_fallbacks(dropbox_accessor, entry, dropbox_id,
                                          size, modified, fingerprint):
    # _stat_from_entry's fallbacks: server_modified→client_modified→"",
    # id→path_display→name, and a non-int/absent size renders as None
    # (the unknown-size machinery, never a fabricated number).
    rpc = FakeDropboxRpc(metadata=entry)
    with patch(RPC, new=rpc):
        out = await stat(dropbox_accessor, PathSpec.from_str_path("/f.txt"))
    assert out.extra["dropbox_id"] == dropbox_id
    assert out.size == size
    assert out.modified == modified
    assert out.fingerprint == fingerprint


@pytest.mark.asyncio
async def test_stat_populates_from_parent_listing(dropbox_accessor, index):
    rpc = FakeDropboxRpc(entries=[FILE_ENTRY])
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(resource_path="a.txt", virtual="/a.txt", directory="/"),
            index)
    assert out.type == FileType.FILE
    assert out.name == "a.txt"
    assert out.size == 5
    assert out.content == ContentType.TEXT
    assert out.modified == "2026-04-01T00:00:00Z"
    assert out.fingerprint == "2026-04-01T00:00:00Z"
    assert out.extra["dropbox_id"] == "id:a"
    assert out.extra["resource_type"] == "dropbox/file"
    assert rpc.list_requests == 1


@pytest.mark.asyncio
async def test_stat_serves_index_hit_without_second_call(
        dropbox_accessor, index):
    # The reason the index exists: once a parent listing populates it, a
    # stat of any sibling serves from cache. `metadata=None` makes a stray
    # get_metadata blow up as a 409, so a single list request proves both
    # the file and the folder came from the index.
    rpc = FakeDropboxRpc(entries=[FOLDER_ENTRY, FILE_ENTRY], metadata=None)
    with patch(RPC, new=rpc):
        file_out = await stat(
            dropbox_accessor,
            PathSpec(resource_path="a.txt", virtual="/a.txt", directory="/"),
            index)
        dir_out = await stat(
            dropbox_accessor,
            PathSpec(resource_path="docs", virtual="/docs", directory="/"),
            index)
    assert file_out.type == FileType.FILE
    assert dir_out.type == FileType.DIRECTORY
    assert dir_out.extra["dropbox_id"] == "id:docs"
    assert rpc.list_requests == 1


@pytest.mark.asyncio
async def test_stat_miss_after_populate_is_enoent(dropbox_accessor, index):
    # The parent lists cleanly but does not contain the child: stat's own
    # re-check-then-ENOENT, distinct from readdir's 409 mapping.
    other = {
        ".tag": "file",
        "id": "id:o",
        "name": "other.txt",
        "path_display": "/other.txt",
        "size": 1,
    }
    rpc = FakeDropboxRpc(entries=[other])
    with patch(RPC, new=rpc):
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(resource_path="note.txt",
                         virtual="/note.txt",
                         directory="/"), index)
    assert str(excinfo.value) == "/note.txt"
    assert rpc.list_requests == 1


@pytest.mark.asyncio
async def test_stat_under_mount_prefix(dropbox_accessor, index):
    # Every other test runs on an unprefixed mount; this pins the prefix
    # arithmetic (virtual_key and the parent's resource_path).
    rpc = FakeDropboxRpc(entries=[FILE_ENTRY])
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(virtual="/dropbox/a.txt",
                     directory="/dropbox",
                     resource_path=mount_key("/dropbox/a.txt", "/dropbox")),
            index)
    assert out.type == FileType.FILE
    assert out.name == "a.txt"
    assert out.size == 5


@pytest.mark.asyncio
async def test_stat_failed_populate_is_enoent(dropbox_accessor, index):
    # A genuinely missing parent (409 on the listing and on every ancestor
    # probe) surfaces as ENOENT through readdir; stat swallows that and
    # answers its own ENOENT naming the child, not the parent.
    with patch(RPC, new=_all_absent):
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(
                dropbox_accessor,
                PathSpec(resource_path="ghost/missing.txt",
                         virtual="/ghost/missing.txt",
                         directory="/ghost"), index)
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
                PathSpec(resource_path="ghost/missing.txt",
                         virtual="/ghost/missing.txt",
                         directory="/ghost"), index)
    assert excinfo.value.status == 500


@pytest.mark.asyncio
async def test_stat_enotdir_from_populate_propagates(dropbox_accessor, index):
    # A path under a file is ENOTDIR, not ENOENT: readdir's ancestor walk
    # classifies it, and stat must let NotADirectoryError escape.
    with patch(RPC, new=_under_file):
        with pytest.raises(NotADirectoryError):
            await stat(
                dropbox_accessor,
                PathSpec(resource_path="a.txt/x",
                         virtual="/a.txt/x",
                         directory="/a.txt"), index)


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(dropbox_accessor, index):
    # The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat serves
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
        "/docs": [{
            ".tag": "file",
            "id": "id:b",
            "name": "b.bin",
            "path_display": "/docs/b.bin",
            "size": 3,
            "server_modified": "2026-04-01T00:00:00Z",
        }],
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
        return contents[path]

    files: list[str] = []
    with patch(RPC, new=_rpc), \
         patch("mirage.core.dropbox.read.dropbox_download",
               side_effect=_download):
        stack = ["/"]
        while stack:
            current = stack.pop()
            listing = await readdir(dropbox_accessor,
                                    PathSpec.from_str_path(current), index)
            for child in listing:
                trimmed = child.rstrip("/")
                info = await stat(dropbox_accessor,
                                  PathSpec.from_str_path(trimmed), index)
                if info.type == FileType.DIRECTORY:
                    stack.append(trimmed)
                    continue
                assert info.size is not None, trimmed
                body = await read(dropbox_accessor,
                                  PathSpec.from_str_path(trimmed), index)
                assert info.size == len(body), trimmed
                files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]

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

from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.read import read
from mirage.core.dropbox.readdir import readdir
from mirage.core.dropbox.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.core.dropbox.conftest import FakeDropboxRpc
from tests.fixtures.handed import call

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


@pytest.mark.asyncio
async def test_stat_mount_root_is_directory(dropbox_accessor):
    rpc = FakeDropboxRpc()
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(vfs_path="", virtual="/", directory="/"),
        )
    assert out.type == FileType.DIRECTORY
    assert out.name == "/"
    assert rpc.list_requests == 0


@pytest.mark.asyncio
async def test_stat_file_from_api(dropbox_accessor):
    # Dropbox addresses by path: stat is one get_metadata.
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
async def test_stat_folder_from_api(dropbox_accessor):
    rpc = FakeDropboxRpc(metadata=FOLDER_ENTRY)
    with patch(RPC, new=rpc):
        out = await stat(dropbox_accessor, PathSpec.from_str_path("/docs"))
    assert out.type == FileType.DIRECTORY
    assert out.name == "docs"
    assert out.size is None
    assert out.extra["dropbox_id"] == "id:docs"


@pytest.mark.asyncio
async def test_stat_missing_is_enoent(dropbox_accessor):
    rpc = FakeDropboxRpc(metadata=None)
    with patch(RPC, new=rpc):
        with pytest.raises(FileNotFoundError) as excinfo:
            await stat(dropbox_accessor, PathSpec.from_str_path("/ghost.txt"))
    assert excinfo.value.filename == "/ghost.txt"


@pytest.mark.asyncio
async def test_stat_non_409_propagates(dropbox_accessor):
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
    # stat_from_entry's fallbacks: server_modified→client_modified→"",
    # id→path_display→name, no content_hash is no token, and a
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
async def test_stat_under_mount_prefix(dropbox_accessor):
    # Every other test runs on an unprefixed mount; this pins the prefix
    # arithmetic of the path get_metadata is asked for.
    rpc = FakeDropboxRpc(metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(
                virtual="/dropbox/a.txt",
                directory="/dropbox",
                vfs_path=mount_key("/dropbox/a.txt", "/dropbox"),
            ),
        )
    assert out.type == FileType.FILE
    assert out.name == "a.txt"
    assert out.size == 5
    assert rpc.metadata_paths == ["/a.txt"]


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(dropbox_accessor):
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

    entries = {e["path_display"]: e for kids in tree.values() for e in kids}

    async def _rpc(_tm, endpoint, body):
        if endpoint == "/files/list_folder":
            return {
                "entries": tree[body["path"]],
                "cursor": "c",
                "has_more": False,
            }
        if endpoint == "/files/get_metadata":
            return entries[body["path"]]
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
                dropbox_accessor, PathSpec.from_str_path(current)
            )
            for child in listing:
                trimmed = current.rstrip("/") + "/" + child.name
                spec = PathSpec.from_str_path(trimmed)
                info = await stat(dropbox_accessor, spec)
                if info.type == FileType.DIRECTORY:
                    stack.append(trimmed)
                    continue
                assert info.size is not None, trimmed
                body = await call(read, readdir, dropbox_accessor, spec)
                assert info.size == len(body), trimmed
                files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]


@pytest.mark.asyncio
async def test_stat_asks_one_lookup(dropbox_accessor):
    # One get_metadata, never a listing of the parent: the mount keeps
    # listings and answers a listed path itself.
    rpc = FakeDropboxRpc(entries=[FILE_ENTRY], metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        out = await stat(
            dropbox_accessor,
            PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
        )
    assert out.fingerprint == "hash-a"
    assert rpc.list_requests == 0
    assert rpc.metadata_paths == ["/a.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status, summary, raised",
    [
        (409, "path/not_found/..", FileNotFoundError),
        (409, "path/not_folder/..", FileNotFoundError),
        (409, "path/restricted_content/..", DropboxApiError),
        (502, "path/not_found/..", DropboxApiError),
    ],
    ids=["not-found", "not-folder", "restricted", "5xx"],
)
async def test_stat_from_api_reads_only_a_miss_as_enoent(
    dropbox_accessor, status, summary, raised
):
    # A restricted file exists, so a fresh probe must not hear ENOENT and
    # drop its overlay; a 5xx body naming not_found is a relay's.
    async def refuse(_tm, _endpoint, _body):
        raise DropboxApiError("refused", status, summary)

    with patch(RPC, new=refuse):
        with pytest.raises(raised):
            await stat(
                dropbox_accessor,
                PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
            )


@pytest.mark.asyncio
async def test_stat_from_api_answer_in_another_case_is_enoent(
    dropbox_accessor,
):
    # get_metadata matches case-insensitively where a listing is exact.
    rpc = FakeDropboxRpc(metadata=FILE_ENTRY)
    with patch(RPC, new=rpc):
        with pytest.raises(FileNotFoundError):
            await stat(dropbox_accessor, PathSpec.from_str_path("/A.TXT"))

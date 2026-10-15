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

import base64
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.github.config import GitHubConfig
from mirage.core.github.read import read, read_bytes, read_stream
from mirage.core.github.readdir import readdir
from mirage.core.github.stat import stat
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.github_api import FakeGitHub, blob_sha, serve
from tests.fixtures.handed import entry_at


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@pytest.mark.asyncio
@patch("mirage.core.github.read.github_get", new_callable=AsyncMock)
async def test_read_bytes_utf8(mock_get, config):
    content = b"hello world"
    mock_get.return_value = {"content": base64.b64encode(content).decode()}
    result = await read_bytes(config, "acme", "proj", "sha123")
    assert result == content
    assert result.decode("utf-8") == "hello world"


@pytest.mark.asyncio
@patch("mirage.core.github.read.github_get", new_callable=AsyncMock)
async def test_read_bytes_binary(mock_get, config):
    content = bytes(range(256))
    mock_get.return_value = {"content": base64.b64encode(content).decode()}
    result = await read_bytes(config, "acme", "proj", "sha456")
    assert result == content


# A read is handed its row; with none, or a folder's, it asks nothing.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rel, entry, error",
    [
        ("src/gone.py", None, FileNotFoundError),
        (
            "src",
            FileStat(name="src", type=FileType.DIRECTORY),
            IsADirectoryError,
        ),
        ("", None, IsADirectoryError),
    ],
)
async def test_a_read_without_a_file_row_asks_nothing(rel, entry, error):
    with serve(FakeGitHub(files={"src/a.txt": b"x"})) as gh:
        with pytest.raises(error):
            await read(_served(gh), _at(rel, "/gh"), entry)
        assert gh.log == []


def _served(gh: FakeGitHub) -> GitHubAccessor:
    return GitHubAccessor(
        GitHubConfig(token="t", base_url=gh.url), "o", "r", "main"
    )


def _at(rel: str, prefix: str) -> PathSpec:
    virtual = (prefix.rstrip("/") + "/" + rel) if prefix != "/" else "/" + rel
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=rel,
    )


# A mount at the root, one at /gh, and one named like a directory inside the
# repository, so a record labelled with anything but the virtual path lands
# on a key the cache never asks for.
@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/", "/gh", "/src"])
async def test_a_read_records_the_blob_sha_under_the_virtual_path(prefix):
    data = b"payload"
    with serve(FakeGitHub(files={"src/a.txt": data})) as gh:
        path = _at("src/a.txt", prefix)
        scope = RecordingScope()
        accessor = _served(gh)
        row = await entry_at(readdir, accessor, path)
        try:
            assert await read(accessor, path, row) == data
        finally:
            scope.close()
        (rec,) = scope.records
        assert (rec.op, rec.path, rec.source, rec.bytes, rec.fingerprint) == (
            "read",
            path.virtual,
            "github",
            len(data),
            blob_sha(data),
        )
        # The stamped token is the sha the blob was fetched by.
        assert ("blob", rec.fingerprint) in gh.log


@pytest.mark.asyncio
async def test_the_synthesized_stream_records_once():
    data = b"streamed"
    with serve(FakeGitHub(files={"a.txt": data})) as gh:
        accessor = _served(gh)
        path = _at("a.txt", "/gh")
        row = await entry_at(readdir, accessor, path)
        scope = RecordingScope()
        try:
            chunks = [c async for c in read_stream(accessor, path, row)]
        finally:
            scope.close()
        assert b"".join(chunks) == data
        assert [(r.op, r.fingerprint) for r in scope.records] == [
            ("read", blob_sha(data))
        ]


@pytest.mark.asyncio
async def test_a_read_stamps_the_sha_it_fetched_not_a_newer_one():
    old, reseated, live = b"old", b"reseated", b"live"
    with serve(FakeGitHub(files={"a.txt": old})) as gh:
        accessor = _served(gh)
        path = _at("a.txt", "/gh")
        row = await entry_at(readdir, accessor, path)
        gh.files["a.txt"] = reseated
        # A later listing reseats the accessor's tree only.
        await readdir(accessor, _at("", "/gh"))
        assert accessor.tree["a.txt"].sha == blob_sha(reseated)
        gh.files["a.txt"] = live
        scope = RecordingScope()
        try:
            data = await read(accessor, path, row)
        finally:
            scope.close()
        # Three shas are in play: the handed row's, the accessor tree's and
        # the live one. Only the first names the bytes this read returned.
        assert data == old
        assert [r.fingerprint for r in scope.records] == [blob_sha(old)]
        # The check that follows sees the live sha, which is not the one the
        # read stamped, so the copy it left is stale rather than fresh.
        probe = await stat(accessor, path, None, ListingCheckStore())
        assert probe.fingerprint == blob_sha(live)
        assert probe.fingerprint != scope.records[0].fingerprint

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

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.read import read, resolve_entry, row_token
from mirage.observe.context import RecordingScope
from tests.core.hf_hub.conftest import file_row, ps, seed


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes_tagged")
async def test_read_bytes_fetches_the_resolve_url(mock_bytes, loaded):
    mock_bytes.return_value = (b"hello", "")
    assert await read(loaded, ps("a.txt")) == b"hello"
    url = mock_bytes.await_args.args[1]
    assert url == "https://huggingface.co/acme/widget/resolve/main/a.txt"
    assert mock_bytes.await_args.args[2] is None


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes_tagged")
async def test_read_bytes_passes_a_byte_window(mock_bytes, loaded):
    mock_bytes.return_value = (b"he", "")
    await read(loaded, ps("a.txt"), offset=0, size=2)
    window = mock_bytes.await_args.args[2]
    assert (window.offset, window.size) == (0, 2)


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes_tagged")
async def test_read_bytes_prefixes_the_repo_path(mock_bytes, prefixed):
    """A prefix normalized with a trailing slash must not double up."""
    from tests.core.hf_hub.conftest import file_row, seed

    seed(prefixed, file_row("a.txt"))
    mock_bytes.return_value = (b"", "")
    await read(prefixed, ps("a.txt"))
    assert mock_bytes.await_args.args[1].endswith(
        "/resolve/main/sub/dir/a.txt"
    )


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes_tagged")
async def test_read_of_a_missing_path_never_reaches_the_network(
    mock_bytes, loaded
):
    with pytest.raises(FileNotFoundError):
        await read(loaded, ps("nope"))
    mock_bytes.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_of_a_directory_is_eisdir(loaded):
    with pytest.raises(IsADirectoryError):
        await read(loaded, ps("d"))


@pytest.mark.asyncio
async def test_read_of_the_mount_root_is_eisdir(loaded):
    with pytest.raises(IsADirectoryError):
        await read(loaded, ps(""))


@pytest.mark.asyncio
async def test_resolve_entry_returns_the_row(loaded):
    from mirage.cache.index import NULL_INDEX

    entry = await resolve_entry(loaded, ps("a.txt"), NULL_INDEX)
    assert entry.size == 7


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes_tagged")
async def test_read_records_the_virtual_path(mock_bytes, accessor):
    # A repo folder named like its mount keeps /m/k.txt off the virtual path.
    seed(accessor, file_row("m/k.txt", 5))
    mock_bytes.return_value = (b"hello", "")
    scope = RecordingScope()
    try:
        data = await read(accessor, ps("m/k.txt", "/m"))
    finally:
        scope.close()
    assert data == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


# One row whose four ids all differ, and none is a hash of the content, so
# every accepted ETag is distinguishable from every other and from a guess.
ROW = IndexEntry(
    id="O",
    name="f.bin",
    resource_type="file",
    extra={"oid": "O", "lfs_oid": "L", "xet_hash": "X", "last_commit": "C"},
)
# The common case: a plain git file carries its oid and nothing else.
PLAIN = IndexEntry(
    id="P", name="a.txt", resource_type="file", extra={"oid": "P"}
)
# A row that carries the LFS and Xet keys empty: a missing ETag must not match
# one of them.
BLANK = IndexEntry(
    id="P",
    name="a.txt",
    resource_type="file",
    extra={"oid": "P", "lfs_oid": "", "xet_hash": ""},
)


@pytest.mark.parametrize(
    "entry,etag,expected",
    [
        (ROW, '"O"', "O"),
        (ROW, "L", "O"),
        (ROW, 'W/"X"', "O"),
        (ROW, '"Z"', None),
        (ROW, "", None),
        (ROW, '"C"', None),
        (PLAIN, '"P"', "P"),
        (PLAIN, "", None),
        (PLAIN, '"Z"', None),
        (BLANK, "", None),
    ],
)
def test_row_token_stamps_the_oid_only_when_the_etag_names_the_row(
    entry, etag, expected
):
    assert row_token(entry, etag) == expected


def test_row_token_never_stamps_an_empty_id():
    # The ETag matches, so this takes the match branch; an empty id must
    # still come back as no token rather than "".
    entry = IndexEntry(
        id="", name="f", resource_type="file", extra={"lfs_oid": "L"}
    )
    assert row_token(entry, '"L"') is None


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes_tagged")
async def test_read_stamps_the_oid_when_the_etag_names_the_row(
    mock_bytes, accessor
):
    seed(accessor, file_row("a.txt", 5))
    mock_bytes.return_value = (b"hello", '"oid-a.txt"')
    scope = RecordingScope()
    try:
        await read(accessor, ps("a.txt"))
    finally:
        scope.close()
    assert [r.fingerprint for r in scope.records] == ["oid-a.txt"]


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes_tagged")
async def test_read_stamps_nothing_when_the_bytes_are_another_version(
    mock_bytes, accessor
):
    # The listing says oid-a.txt, the download is a newer version: labelling
    # those bytes with the listing's oid is how a later revert would pass
    # them off as fresh.
    seed(accessor, file_row("a.txt", 5))
    mock_bytes.return_value = (b"newer", '"another-version"')
    scope = RecordingScope()
    try:
        await read(accessor, ps("a.txt"))
    finally:
        scope.close()
    assert [r.fingerprint for r in scope.records] == [None]


@pytest.mark.asyncio
async def test_a_read_of_a_repo_the_hub_refuses_is_permission_denied(accessor):
    refused = AsyncMock(side_effect=HfHubError("nope", 403))
    with patch("mirage.core.hf_hub.tree.hub_get_response", refused):
        with pytest.raises(PermissionError):
            await read(accessor, ps("a.txt"), RAMIndexCacheStore())


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403])
async def test_a_download_the_hub_refuses_is_permission_denied(loaded, status):
    # A gated repo lists its tree but refuses the file itself.
    refused = AsyncMock(side_effect=HfHubError("gated", status))
    with patch("mirage.core.hf_hub.read.hub_bytes_tagged", refused):
        with pytest.raises(PermissionError):
            await read(loaded, ps("a.txt"))


@pytest.mark.asyncio
async def test_a_download_of_a_vanished_file_stays_a_hub_error(loaded):
    # One file 404ing is not a refusal to show the repo.
    missing = AsyncMock(side_effect=HfHubError("gone", 404, "EntryNotFound"))
    with patch("mirage.core.hf_hub.read.hub_bytes_tagged", missing):
        with pytest.raises(HfHubError, match="gone"):
            await read(loaded, ps("a.txt"))

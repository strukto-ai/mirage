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

import uuid
from collections.abc import AsyncIterator, Iterator
from types import MappingProxyType
from unittest.mock import AsyncMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto.server import ThreadedMotoServer

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.read import read as ram_read
from mirage.core.ram.readdir import readdir as ram_readdir
from mirage.core.ram.stat import stat as ram_stat
from mirage.core.ram.write import write as ram_write
from mirage.core.s3.constants import CONDITION_SUPPORT
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from mirage.vfs.s3.config import S3Config
from mirage.vfs.s3.s3 import S3VFS
from mirage.vfs.testing import (
    MutationFixture,
    ReadFixture,
    check_mutation_contract,
    check_read_contract,
)

FILE = PathSpec(virtual="/data/a.txt", directory="/data", vfs_path="a.txt")
DIRECTORY = PathSpec(virtual="/data", directory="/", vfs_path="")
MISSING = PathSpec(
    virtual="/data/missing", directory="/data", vfs_path="missing"
)
CONTENT = "é: hello\n".encode()
FIXTURE = ReadFixture(FILE, DIRECTORY, MISSING, CONTENT)
DOC = PathSpec(
    virtual="/data/a.gdoc.json", directory="/data", vfs_path="a.gdoc.json"
)
DOC_MISSING = PathSpec(
    virtual="/data/missing.gdoc.json",
    directory="/data",
    vfs_path="missing.gdoc.json",
)


class Minimal(BaseVFS):
    """The three required reads over a RAM store, whole reads sliced."""

    name = "custom"

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await ram_readdir(self.accessor, path)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await ram_read(self.accessor, path)
        return slice_window(data, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await ram_stat(self.accessor, path)


class EndForSize(Minimal):
    reads_ranges = True

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await ram_read(self.accessor, path)
        return data[offset:size]


class LenientStat(Minimal):
    async def stat(self, path: PathSpec) -> FileStat:
        if path.vfs_path == MISSING.vfs_path:
            return FileStat(name="missing", type=FileType.FILE, size=0)
        return await super().stat(path)


class RowsHanded(Minimal):
    """Reads through its folder's row and answers existence from the row
    at the path, as Trello and Box do."""

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        parent: FileStat | None = None,
    ) -> bytes:
        if parent is None:
            raise FileNotFoundError(path.virtual)
        return await super().read(path, offset, size)

    async def exists(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> bool:
        return entry is not None


class RenderedOnly(BaseVFS):
    """Serves its one filetype through a renderer and defines no read."""

    name = "custom"
    renderers = MappingProxyType({".gdoc.json": "read_doc"})

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await ram_readdir(self.accessor, path)

    async def read_doc(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await ram_read(self.accessor, path)
        return slice_window(data, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await ram_stat(self.accessor, path)


class WholeRender(RenderedOnly):
    async def read_doc(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        return await ram_read(self.accessor, path)


class Rendering(Minimal):
    """Stores and streams bytes, and renders its doc filetype reversed."""

    renderers = MappingProxyType(
        {".json": "read_json", ".gdoc.json": "read_doc"}
    )

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> AsyncIterator[bytes]:
        yield slice_window(await ram_read(self.accessor, path), offset, size)

    async def read_json(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        raise AssertionError("a .gdoc.json file renders as a doc")

    async def read_doc(
        self,
        path: PathSpec,
        *,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await ram_read(self.accessor, path)
        return slice_window(data[::-1], offset, size)


async def _seeded(cls: type[BaseVFS], content: bytes) -> BaseVFS:
    store = RAMStore()
    accessor = RAMAccessor(store)
    await ram_write(accessor, FILE, content)
    return cls(accessor=accessor)


@pytest.mark.asyncio
@pytest.mark.parametrize("content", [b"", b"a", b"ab", CONTENT])
async def test_a_minimal_vfs_meets_the_contract(content):
    vfs = await _seeded(Minimal, content)
    await check_read_contract(
        vfs, FIXTURE.__class__(FILE, DIRECTORY, MISSING, content)
    )


@pytest.mark.asyncio
async def test_a_builtin_meets_the_contract():
    ram = RAMVFS()
    await ram_write(ram.accessor, FILE, CONTENT)
    await check_read_contract(ram, FIXTURE)


@pytest.mark.asyncio
async def test_a_vfs_handed_its_rows_meets_the_contract():
    nested = PathSpec(
        virtual="/data/sub/a.txt", directory="/data/sub", vfs_path="sub/a.txt"
    )
    folder = PathSpec(virtual="/data/sub", directory="/data", vfs_path="sub")
    missing = PathSpec(
        virtual="/data/sub/missing",
        directory="/data/sub",
        vfs_path="sub/missing",
    )
    store = RAMStore()
    store.dirs.add("/sub")
    accessor = RAMAccessor(store)
    await ram_write(accessor, nested, CONTENT)
    await check_read_contract(
        RowsHanded(accessor=accessor),
        ReadFixture(nested, folder, missing, CONTENT),
    )


@pytest.mark.asyncio
async def test_a_rendered_filetype_meets_the_contract_through_its_renderer():
    accessor = RAMAccessor(RAMStore())
    await ram_write(accessor, DOC, CONTENT)
    await check_read_contract(
        RenderedOnly(accessor=accessor),
        ReadFixture(DOC, DIRECTORY, DOC_MISSING, CONTENT),
    )


@pytest.mark.asyncio
async def test_a_render_is_checked_apart_from_the_stored_stream():
    accessor = RAMAccessor(RAMStore())
    await ram_write(accessor, DOC, CONTENT)
    await check_read_contract(
        Rendering(accessor=accessor),
        ReadFixture(DOC, DIRECTORY, DOC_MISSING, CONTENT[::-1]),
    )


@pytest.mark.asyncio
async def test_the_contract_catches_ranges_using_end_instead_of_size():
    vfs = await _seeded(EndForSize, CONTENT)
    with pytest.raises(AssertionError, match="offset and byte count"):
        await check_read_contract(vfs, FIXTURE)


@pytest.mark.asyncio
async def test_the_contract_catches_a_renderer_that_ignores_the_window():
    accessor = RAMAccessor(RAMStore())
    await ram_write(accessor, DOC, CONTENT)
    with pytest.raises(AssertionError, match="offset and byte count"):
        await check_read_contract(
            WholeRender(accessor=accessor),
            ReadFixture(DOC, DIRECTORY, DOC_MISSING, CONTENT),
        )


@pytest.mark.asyncio
async def test_the_contract_catches_a_stat_that_answers_for_a_missing_path():
    vfs = await _seeded(LenientStat, CONTENT)
    with pytest.raises(AssertionError, match="must raise FileNotFoundError"):
        await check_read_contract(vfs, FIXTURE)


@pytest.mark.asyncio
async def test_the_contract_propagates_a_permission_failure():
    vfs = await _seeded(Minimal, CONTENT)
    vfs.read = AsyncMock(side_effect=PermissionError("denied"))  # type: ignore[method-assign]
    with pytest.raises(PermissionError, match="denied"):
        await check_read_contract(vfs, FIXTURE)


@pytest.mark.asyncio
async def test_stream_contract_rejects_oversized_chunks_and_closes_source():
    vfs = await _seeded(Minimal, CONTENT)
    closed = []

    async def source(path):
        try:
            yield CONTENT
        finally:
            closed.append(True)

    vfs.read = source  # type: ignore[method-assign]
    with pytest.raises(AssertionError, match="max_chunk_size"):
        await check_read_contract(
            vfs,
            ReadFixture(FILE, DIRECTORY, MISSING, CONTENT, max_chunk_size=1),
        )
    assert closed == [True]


SCRATCH = MutationFixture(DIRECTORY, CONTENT)


class CopyKeepsDestination(RAMVFS):
    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        if await self.exists(dst):
            return
        await super().copy(src, dst)


class RenameKeepsSource(RAMVFS):
    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await super().copy(src, dst)


class RenameMissingQuietly(RAMVFS):
    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        if await self.exists(src):
            await super().rename(src, dst)


class NeedsRows(RAMVFS):
    """Finds a file only through the row the mount hands it, as Box does."""

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        if entry is None:
            raise FileNotFoundError(path.virtual)
        return await super().stat(path)

    async def unlink(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        if entry is None:
            raise FileNotFoundError(path.virtual)
        await super().unlink(path)

    async def rename(
        self, src: PathSpec, dst: PathSpec, entry: FileStat | None = None
    ) -> None:
        if entry is None:
            raise FileNotFoundError(src.virtual)
        await super().rename(src, dst)

    async def copy(
        self, src: PathSpec, dst: PathSpec, entry: FileStat | None = None
    ) -> None:
        if entry is None:
            raise FileNotFoundError(src.virtual)
        await super().copy(src, dst)


class CountsListings(RAMVFS):
    """Takes no rows and counts the listings it serves."""

    listings = 0

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        self.listings += 1
        return await super().readdir(path)


class KeepsRenameDst(RAMVFS):
    """Refuses to unlink the rename destination."""

    async def unlink(self, path: PathSpec) -> None:
        if path.virtual.endswith("/rename-dst"):
            raise PermissionError(path.virtual)
        await super().unlink(path)


class NoUnlink(RAMVFS):
    unlink = BaseVFS.unlink


class ClaimsPutConditions(RAMVFS):
    """Declares conditional puts and writes through them unconditioned."""

    @property
    def condition_support(self):
        return {"put": frozenset({"absent", "match"})}


class ClaimsCopyConditions(RAMVFS):
    """Declares conditional copies it cannot enforce, as moto does."""

    @property
    def condition_support(self):
        return {"copy": frozenset({"absent", "match"})}


class AwsS3(S3VFS):
    """S3 on moto declaring what AWS declares, not what a custom endpoint
    does; moto ignores a copy's destination conditions."""

    @property
    def condition_support(self):
        return CONDITION_SUPPORT


UNENFORCED_COPY = frozenset({("copy", "absent"), ("copy", "match")})


async def _names(vfs: RAMVFS) -> list[str]:
    return [row.name for row in await vfs.readdir(DIRECTORY)]


@pytest.mark.asyncio
async def test_ram_meets_the_mutation_contract_and_cleans_up():
    vfs = RAMVFS()
    await check_mutation_contract(vfs, SCRATCH)
    assert await _names(vfs) == []


@pytest.mark.asyncio
async def test_a_failed_check_still_cleans_up():
    vfs = RenameKeepsSource()
    with pytest.raises(AssertionError):
        await check_mutation_contract(vfs, SCRATCH)
    assert await _names(vfs) == []


@pytest.mark.asyncio
async def test_each_op_is_handed_its_rows():
    vfs = NeedsRows()
    await check_mutation_contract(vfs, SCRATCH)
    assert await _names(vfs) == []


@pytest.mark.asyncio
async def test_no_listing_for_ops_that_take_no_rows():
    vfs = CountsListings()
    await check_mutation_contract(vfs, SCRATCH)
    assert vfs.listings == 0


@pytest.mark.asyncio
async def test_cleanup_tries_every_file_then_raises():
    vfs = KeepsRenameDst()
    with pytest.raises(PermissionError, match="rename-dst"):
        await check_mutation_contract(vfs, SCRATCH)
    assert await _names(vfs) == ["rename-dst"]


@pytest.mark.asyncio
async def test_the_check_needs_unlink_to_clean_up():
    with pytest.raises(AssertionError, match="cleans up through unlink"):
        await check_mutation_contract(NoUnlink(), SCRATCH)


@pytest.mark.asyncio
async def test_an_overwrite_is_caught_whatever_the_content():
    fixture = MutationFixture(DIRECTORY, b"replaced\n")
    with pytest.raises(AssertionError, match="over an existing file"):
        await check_mutation_contract(CopyKeepsDestination(), fixture)


@pytest.mark.asyncio
async def test_an_unenforced_condition_is_skipped_with_a_warning():
    with pytest.warns(UserWarning, match=r"copy \(absent\) skipped"):
        await check_mutation_contract(
            ClaimsCopyConditions(), SCRATCH, unenforced=UNENFORCED_COPY
        )


@pytest.mark.asyncio
async def test_an_unenforced_condition_must_be_declared():
    with pytest.raises(AssertionError, match="does not declare"):
        await check_mutation_contract(
            RAMVFS(), SCRATCH, unenforced=UNENFORCED_COPY
        )


@pytest.fixture()
def moto_bucket() -> Iterator[tuple[str, str]]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    bucket = f"bkt-{uuid.uuid4().hex[:8]}"
    boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name="us-east-1",
    ).create_bucket(Bucket=bucket)
    yield endpoint, bucket
    server.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("cls", "unenforced"), [(S3VFS, frozenset()), (AwsS3, UNENFORCED_COPY)]
)
async def test_s3_fails_the_mutation_contract_only_at_no_such_key(
    cls, unenforced, moto_bucket
):
    """Every case passes up to a copy of a missing source: s3 raises
    NoSuchKey there, not FileNotFoundError. Fixing that fails this test."""
    endpoint, bucket = moto_bucket
    vfs = cls(
        S3Config(
            bucket=bucket,
            region="us-east-1",
            endpoint_url=endpoint,
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
        )
    )
    try:
        with pytest.raises(ClientError) as raised:
            await check_mutation_contract(vfs, SCRATCH, unenforced=unenforced)
    finally:
        await vfs.close()
    assert raised.value.response["Error"]["Code"] == "NoSuchKey"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("cls", "message"),
    [
        (CopyKeepsDestination, "over an existing file"),
        (RenameKeepsSource, "rename must remove the source"),
        (RenameMissingQuietly, "must raise FileNotFoundError"),
        (ClaimsPutConditions, "lost put \\(absent\\) must raise"),
        (ClaimsCopyConditions, "lost copy \\(absent\\) must raise"),
    ],
)
async def test_the_mutation_contract_catches(cls, message):
    with pytest.raises(AssertionError, match=message):
        await check_mutation_contract(cls(), SCRATCH)

from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage import (
    BaseVFS,
    DriverOps,
    ReadFixture,
    check_driver_contract,
    check_read_contract,
)
from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.ram.io import IO
from mirage.ops.registry import op
from mirage.types import FileStat, FileType, PathSpec
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.ram.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from mirage.vfs.types import ReadOps

FILE = PathSpec(virtual="/data/a.txt", directory="/data", vfs_path="a.txt")
DIRECTORY = PathSpec(virtual="/data", directory="/", vfs_path="")
MISSING = PathSpec(
    virtual="/data/missing", directory="/data", vfs_path="missing"
)
CONTENT = "é: hello\n".encode()
FIXTURE = ReadFixture(FILE, DIRECTORY, MISSING, CONTENT)


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [False, True])
async def test_builtin_and_minimal_adapter_share_the_contract(native):
    accessor = RAMAccessor(RAMStore())
    await IO.write(accessor, FILE, CONTENT)
    adapter = (
        IO
        if native
        else VFSAdapter(
            read=ReadOps(
                readdir=IO.readdir, read_bytes=IO.read_bytes, stat=IO.stat
            )
        )
    )
    await check_read_contract(adapter, accessor, FIXTURE)


@pytest.mark.asyncio
@pytest.mark.parametrize("content", [b"", b"a", b"ab", CONTENT])
async def test_contract_only_probes_valid_native_ranges(content):
    accessor = RAMAccessor(RAMStore())
    await IO.write(accessor, FILE, content)
    calls = []

    async def strict_range(a, p, i, offset, size):
        if size == 0 or offset >= len(content):
            raise ValueError("unsatisfiable native range")
        calls.append((offset, size))
        return content[offset : None if size is None else offset + size]

    await check_read_contract(
        replace(IO, read_range=strict_range),
        accessor,
        replace(FIXTURE, content=content),
    )
    assert len(calls) == (2 if content else 0)
    if content:
        assert calls[0][1] is not None
        assert calls[1][1] is None


@pytest.mark.asyncio
async def test_contract_catches_ranges_using_end_instead_of_size():
    accessor = RAMAccessor(RAMStore())
    await IO.write(accessor, FILE, CONTENT)

    async def broken_range(a, p, i, offset, size):
        return CONTENT[offset:size]

    with pytest.raises(AssertionError, match="offset and byte count"):
        await check_read_contract(
            replace(IO, read_range=broken_range), accessor, FIXTURE
        )


@pytest.mark.asyncio
async def test_contract_propagates_permission_failure():
    accessor = RAMAccessor(RAMStore())
    read = AsyncMock(side_effect=PermissionError("denied"))
    with pytest.raises(PermissionError, match="denied"):
        await check_read_contract(
            replace(IO, read_bytes=read), accessor, FIXTURE
        )


def _custom(store: RAMStore, ops: list | None = None) -> BaseVFS:
    return BaseVFS(
        name="custom",
        accessor=RAMAccessor(store),
        io=VFSAdapter(
            read=ReadOps(
                readdir=IO.readdir, read_bytes=IO.read_bytes, stat=IO.stat
            )
        ),
        ops=ops,
    )


@pytest.mark.asyncio
async def test_a_builtin_driver_meets_the_driver_contract():
    ram = RAMVFS()
    await DriverOps(ram).write(FILE, CONTENT)
    await check_driver_contract(ram, FIXTURE)


@pytest.mark.asyncio
@pytest.mark.parametrize("content", [b"", b"a", CONTENT])
async def test_a_table_built_driver_meets_the_driver_contract(content):
    store = RAMStore()
    await IO.write(RAMAccessor(store), FILE, content)
    await check_driver_contract(
        _custom(store), replace(FIXTURE, content=content)
    )


@pytest.mark.asyncio
async def test_driver_contract_catches_a_read_that_ignores_the_window():
    @op("read", vfs="custom")
    async def whole_read(accessor, path, **kwargs):
        return CONTENT

    store = RAMStore()
    await IO.write(RAMAccessor(store), FILE, CONTENT)
    with pytest.raises(AssertionError, match="offset and byte count"):
        await check_driver_contract(_custom(store, [whole_read]), FIXTURE)


@pytest.mark.asyncio
async def test_driver_contract_catches_a_stat_that_answers_for_a_missing_path():
    @op("stat", vfs="custom")
    async def lenient_stat(accessor, path, *, index=None, **kwargs):
        if path.vfs_path == MISSING.vfs_path:
            return FileStat(name="missing", type=FileType.FILE, size=0)
        return await IO.stat(accessor, path, index)

    store = RAMStore()
    await IO.write(RAMAccessor(store), FILE, CONTENT)
    with pytest.raises(AssertionError, match="must raise FileNotFoundError"):
        await check_driver_contract(_custom(store, [lenient_stat]), FIXTURE)


@pytest.mark.asyncio
async def test_driver_ops_calls_a_driver_without_a_workspace():
    table = DriverOps(RAMVFS())
    await table.write(FILE, b"payload")
    assert await table.read(FILE) == b"payload"
    assert await table.read(FILE, offset=1, size=3) == b"ayl"
    assert table.has("glob")
    with pytest.raises(KeyError, match="no op registered"):
        table.op("search")

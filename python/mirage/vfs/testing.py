from dataclasses import dataclass

from mirage.cache.index import IndexCacheStore, RAMIndexCacheStore
from mirage.types import FileType, PathSpec
from mirage.vfs.base import BaseVFS


@dataclass(frozen=True, slots=True)
class ReadFixture:
    """A small known file, its parent directory, and an absent sibling."""

    file: PathSpec
    directory: PathSpec
    missing: PathSpec
    content: bytes


async def check_read_contract(
    vfs: BaseVFS, fixture: ReadFixture, index: IndexCacheStore | None = None
) -> None:
    """Verify a VFS's reads against a caller-owned fixture, mutating nothing.

    A stream and an existence check are probed only where the VFS defines
    them, and a byte window only where it reads ranges natively: the
    caller reads whole and slices otherwise.

    Args:
        vfs (BaseVFS): the VFS being validated.
        fixture (ReadFixture): file, parent, absent sibling, and bytes.
        index (IndexCacheStore | None): the store to hand every function;
            a RAM store at the VFS's ``index_ttl`` by default.
    """
    store = (
        index if index is not None else RAMIndexCacheStore(ttl=vfs.index_ttl)
    )
    data = await vfs.read(fixture.file, store)
    assert data == fixture.content, "read differs from fixture content"
    info = await vfs.stat(fixture.file, store)
    assert info.type == FileType.FILE, "fixture must stat as a file"
    assert info.size is None or info.size == len(data), (
        "stat size must be rendered byte length or None"
    )
    parent = await vfs.stat(fixture.directory, store)
    assert parent.type == FileType.DIRECTORY, "parent must stat as a directory"
    children = await vfs.readdir(fixture.directory, store)
    assert fixture.file.virtual in children, (
        "readdir must include the child virtual path"
    )
    if vfs.supports("read_stream"):
        streamed = b"".join(
            [part async for part in vfs.read_stream(fixture.file, store)]
        )
        assert streamed == data, "read_stream differs from read"
    if vfs.reads_ranges and data:
        offset = min(1, len(data) - 1)
        for size in (min(3, len(data) - offset), None):
            end = None if size is None else offset + size
            actual = await vfs.read(fixture.file, store, offset, size)
            assert actual == data[offset:end], (
                "read must use offset and byte count"
            )
    if vfs.supports("exists"):
        assert await vfs.exists(fixture.file), (
            "exists rejected the fixture file"
        )
        assert not await vfs.exists(fixture.missing), (
            "exists accepted a missing file"
        )
    for call in (vfs.stat, vfs.read):
        try:
            await call(fixture.missing, store)
        except FileNotFoundError:
            continue
        raise AssertionError("missing paths must raise FileNotFoundError")

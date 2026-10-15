import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from mirage.cache.index import IndexCacheStore, RAMIndexCacheStore
from mirage.io.stream import close_quietly
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.filetype import get_extension
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.base import BaseVFS


@dataclass(frozen=True, slots=True)
class ReadFixture:
    """A known file, its parent and absent sibling, and an optional chunk bound."""

    file: PathSpec
    directory: PathSpec
    missing: PathSpec
    content: bytes
    max_chunk_size: int | None = None


def _renderer(
    vfs: BaseVFS, path: PathSpec
) -> Callable[..., Awaitable[bytes]] | None:
    """The renderer a read of ``path`` runs, found by the extension the
    mount resolves it by, or None where the VFS renders none.

    Args:
        vfs (BaseVFS): the VFS being validated.
        path (PathSpec): the path read.
    """
    name = vfs.renderers.get(get_extension(path.virtual) or "")
    if name is None:
        return None
    render: Callable[..., Awaitable[bytes]] | None = getattr(vfs, name, None)
    assert callable(render), f"renderer {name} is not a method"
    return render


def _taken(
    fn: Callable[..., Any],
    store: IndexCacheStore,
    entry: FileStat | None,
) -> dict[str, Any]:
    """What a VFS function is handed beside its path, as the mount hands
    it: the store where it takes an index, and what is at its path where
    it declares ``entry``.

    Args:
        fn (Callable[..., Any]): the VFS function.
        store (IndexCacheStore): the store for a function that keeps one.
        entry (FileStat | None): what is at the path.
    """
    params = inspect.signature(fn).parameters
    taken: dict[str, Any] = {}
    if "index" in params:
        taken["index"] = store
    if "entry" in params and entry is not None:
        taken["entry"] = entry
    return taken


async def _entry(vfs: BaseVFS, path: PathSpec) -> FileStat | None:
    """What is at ``path``, found by listing each directory from the
    mount root down, each handed what its own parent's listing named, as
    the mount finds it. None for a VFS that keeps its own index, and for
    a path nothing is at.

    Args:
        vfs (BaseVFS): the VFS being validated.
        path (PathSpec): the path, keyed below the mount.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    names = [name for name in path.vfs_path.strip("/").split("/") if name]
    found: FileStat | None = None
    for depth, name in enumerate(names):
        key = "/".join(names[:depth])
        virtual = f"{prefix}/{key}" if key else prefix or "/"
        folder = PathSpec(virtual=virtual, directory=virtual, vfs_path=key)
        listed = await vfs.readdir(
            folder, **_taken(vfs.readdir, RAMIndexCacheStore(), found)
        )
        rows = listed.entries if isinstance(listed, DirListing) else listed
        found = next(
            (
                row
                for row in rows
                if isinstance(row, FileStat) and row.name == name
            ),
            None,
        )
        if found is None:
            return None
    return found


async def _check_windows(
    read: Callable[..., Awaitable[bytes]],
    path: PathSpec,
    store: IndexCacheStore,
    entry: FileStat | None,
    data: bytes,
) -> None:
    """Check that ``read`` answers a byte window of ``data``.

    Args:
        read (Callable[..., Awaitable[bytes]]): the read handed a window.
        path (PathSpec): the file.
        store (IndexCacheStore): the store handed to the read.
        entry (FileStat | None): what is at the file.
        data (bytes): the whole file as ``read`` answers it.
    """
    if not data:
        return
    offset = min(1, len(data) - 1)
    for size in (min(3, len(data) - offset), None):
        end = None if size is None else offset + size
        actual = await read(
            path, offset=offset, size=size, **_taken(read, store, entry)
        )
        assert actual == data[offset:end], (
            "read must use offset and byte count"
        )


async def check_read_contract(
    vfs: BaseVFS, fixture: ReadFixture, index: IndexCacheStore | None = None
) -> None:
    """Verify a VFS's reads against a caller-owned fixture, mutating nothing.

    A read runs the renderer of the file's filetype where the VFS renders
    one, else ``read``; a stream is compared with what ``read`` stores. A
    stream and an existence check are probed only where the VFS defines
    them. A renderer is always handed a byte window, ``read`` only where
    it takes one natively: the caller reads whole and slices otherwise.

    Args:
        vfs (BaseVFS): the VFS being validated.
        fixture (ReadFixture): file, parent, absent sibling, and bytes.
        index (IndexCacheStore | None): the store to hand every function;
            a RAM store at the VFS's ``index_ttl`` by default.
    """
    store = (
        index if index is not None else RAMIndexCacheStore(ttl=vfs.index_ttl)
    )
    entry = await _entry(vfs, fixture.file)
    folder = await _entry(vfs, fixture.directory)
    render = _renderer(vfs, fixture.file)
    read = render or vfs.read
    data = await read(fixture.file, **_taken(read, store, entry))
    assert data == fixture.content, "read differs from fixture content"
    info = await vfs.stat(fixture.file, **_taken(vfs.stat, store, entry))
    assert info.type == FileType.FILE, "fixture must stat as a file"
    assert info.size is None or info.size == len(data), (
        "stat size must be rendered byte length or None"
    )
    parent = await vfs.stat(
        fixture.directory, **_taken(vfs.stat, store, folder)
    )
    assert parent.type == FileType.DIRECTORY, "parent must stat as a directory"
    listed = await vfs.readdir(
        fixture.directory, **_taken(vfs.readdir, store, folder)
    )
    rows = listed.entries if isinstance(listed, DirListing) else listed
    child = fixture.file.virtual.rstrip("/").rsplit("/", 1)[-1]
    assert child in [row.name for row in rows], (
        "readdir must include the child"
    )
    stored = (
        await vfs.read(fixture.file, **_taken(vfs.read, store, entry))
        if render is not None and vfs.supports("read")
        else data
    )
    if vfs.supports("read_stream"):
        parts: list[bytes] = []
        source = vfs.read_stream(
            fixture.file, **_taken(vfs.read_stream, store, entry)
        )
        try:
            async for part in source:
                assert (
                    fixture.max_chunk_size is None
                    or len(part) <= fixture.max_chunk_size
                ), "read_stream exceeded max_chunk_size"
                parts.append(part)
        finally:
            await close_quietly(source)
        streamed = b"".join(parts)
        assert streamed == stored, "read_stream differs from read"
    if render is not None:
        await _check_windows(render, fixture.file, store, entry, data)
    if vfs.reads_ranges and vfs.supports("read"):
        await _check_windows(vfs.read, fixture.file, store, entry, stored)
    if vfs.supports("exists"):
        assert await vfs.exists(fixture.file), (
            "exists rejected the fixture file"
        )
        assert not await vfs.exists(fixture.missing), (
            "exists accepted a missing file"
        )
    for call in (vfs.stat, _renderer(vfs, fixture.missing) or vfs.read):
        try:
            await call(fixture.missing, **_taken(call, store, None))
        except FileNotFoundError:
            continue
        raise AssertionError("missing paths must raise FileNotFoundError")

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from mirage.cache.index import IndexCacheStore, RAMIndexCacheStore
from mirage.cache.types import (
    ABSENT_WRITE,
    ConditionMode,
    MatchWrite,
    Measured,
    OwnRead,
    ReplaceRequest,
    WriteCondition,
    WriteContext,
)
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.errors.types import OperationNotSupportedError, StaleWriteError
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
    parent: FileStat | None = None,
) -> dict[str, Any]:
    """What a VFS function is handed beside its path, as the mount hands
    it: the store where it takes an index, what is at its path where it
    declares ``entry``, and its folder's row where it declares
    ``parent``.

    Args:
        fn (Callable[..., Any]): the VFS function.
        store (IndexCacheStore): the store for a function that keeps one.
        entry (FileStat | None): what is at the path.
        parent (FileStat | None): what is at the path's folder.
    """
    params = inspect.signature(fn).parameters
    taken: dict[str, Any] = {}
    if "index" in params:
        taken["index"] = store
    if "entry" in params and entry is not None:
        taken["entry"] = entry
    if "parent" in params and parent is not None:
        taken["parent"] = parent
    return taken


async def _rows_at(
    vfs: BaseVFS, path: PathSpec
) -> tuple[FileStat | None, FileStat | None]:
    """What is at ``path`` and at its folder, found by listing each
    directory from the mount root down, each handed what its own
    parent's listing named, as the mount finds it. None for the root,
    which no listing names, and for a path nothing is at.

    Args:
        vfs (BaseVFS): the VFS being validated.
        path (PathSpec): the path, keyed below the mount.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    names = [name for name in path.vfs_path.strip("/").split("/") if name]
    found: FileStat | None = None
    above: FileStat | None = None
    for depth, name in enumerate(names):
        key = "/".join(names[:depth])
        virtual = f"{prefix}/{key}" if key else prefix or "/"
        folder = PathSpec(virtual=virtual, directory=virtual, vfs_path=key)
        listed = await vfs.readdir(
            folder,
            **_taken(vfs.readdir, RAMIndexCacheStore(), found, above),
        )
        rows = listed.entries if isinstance(listed, DirListing) else listed
        above, found = (
            found,
            next(
                (
                    row
                    for row in rows
                    if isinstance(row, FileStat) and row.name == name
                ),
                None,
            ),
        )
        if found is None:
            return None, above
    return found, above


async def _bytes_of(answer: Any, max_chunk_size: int | None = None) -> bytes:
    """What a ``read`` answered, a stream collected and each of its chunks
    held to ``max_chunk_size``.

    Args:
        answer (Any): what calling ``read`` returned.
        max_chunk_size (int | None): the largest chunk a stream may hand
            out; None for any.
    """
    found = await answer if inspect.isawaitable(answer) else answer
    if isinstance(found, bytes):
        return found
    parts: list[bytes] = []
    try:
        async for part in found:
            assert max_chunk_size is None or len(part) <= max_chunk_size, (
                "read streamed a chunk over max_chunk_size"
            )
            parts.append(part)
    finally:
        await close_quietly(found)
    return b"".join(parts)


async def _check_windows(
    read: Callable[..., Any],
    path: PathSpec,
    store: IndexCacheStore,
    entry: FileStat | None,
    parent: FileStat | None,
    data: bytes,
) -> None:
    """Check that ``read`` answers a byte window of ``data``.

    Args:
        read (Callable[..., Any]): the read handed a window.
        path (PathSpec): the file.
        store (IndexCacheStore): the store handed to the read.
        entry (FileStat | None): what is at the file.
        parent (FileStat | None): what is at the file's folder.
        data (bytes): the whole file as ``read`` answers it.
    """
    if not data:
        return
    offset = min(1, len(data) - 1)
    for size in (min(3, len(data) - offset), None):
        end = None if size is None else offset + size
        actual = await _bytes_of(
            read(
                path,
                offset=offset,
                size=size,
                **_taken(read, store, entry, parent),
            )
        )
        assert actual == data[offset:end], (
            "read must use offset and byte count"
        )


async def check_read_contract(
    vfs: BaseVFS, fixture: ReadFixture, index: IndexCacheStore | None = None
) -> None:
    """Verify a VFS's reads against a caller-owned fixture, mutating nothing.

    A read runs the renderer of the file's filetype where the VFS renders
    one, else ``read``; a read that answers a stream is collected, each
    chunk held to the fixture's bound, and a missing file may fail when
    it is called or at its first pull. An existence check is probed only
    where the VFS defines one. A renderer is always handed a byte window,
    ``read`` only where it takes one natively: the caller reads whole and
    slices otherwise.

    Args:
        vfs (BaseVFS): the VFS being validated.
        fixture (ReadFixture): file, parent, absent sibling, and bytes.
        index (IndexCacheStore | None): the store to hand every function;
            a RAM store at the VFS's ``index_ttl`` by default.
    """
    store = (
        index if index is not None else RAMIndexCacheStore(ttl=vfs.index_ttl)
    )
    entry, folder = await _rows_at(vfs, fixture.file)
    _, above = await _rows_at(vfs, fixture.directory)
    render = _renderer(vfs, fixture.file)
    read = render or vfs.read
    data = await _bytes_of(
        read(fixture.file, **_taken(read, store, entry, folder)),
        fixture.max_chunk_size,
    )
    assert data == fixture.content, "read differs from fixture content"
    info = await vfs.stat(
        fixture.file, **_taken(vfs.stat, store, entry, folder)
    )
    assert info.type == FileType.FILE, "fixture must stat as a file"
    assert info.size is None or info.size == len(data), (
        "stat size must be rendered byte length or None"
    )
    parent = await vfs.stat(
        fixture.directory, **_taken(vfs.stat, store, folder, above)
    )
    assert parent.type == FileType.DIRECTORY, "parent must stat as a directory"
    listed = await vfs.readdir(
        fixture.directory, **_taken(vfs.readdir, store, folder, above)
    )
    rows = listed.entries if isinstance(listed, DirListing) else listed
    child = fixture.file.virtual.rstrip("/").rsplit("/", 1)[-1]
    assert child in [row.name for row in rows], (
        "readdir must include the child"
    )
    stored = (
        await _bytes_of(
            vfs.read(fixture.file, **_taken(vfs.read, store, entry, folder)),
            fixture.max_chunk_size,
        )
        if render is not None and vfs.supports("read")
        else data
    )
    if render is not None:
        await _check_windows(render, fixture.file, store, entry, folder, data)
    if vfs.reads_ranges and vfs.supports("read"):
        await _check_windows(
            vfs.read, fixture.file, store, entry, folder, stored
        )
    if vfs.supports("exists"):
        exists: Callable[..., Awaitable[bool]] = vfs.exists
        assert await exists(
            fixture.file, **_taken(exists, store, entry, folder)
        ), "exists rejected the fixture file"
        assert not await exists(
            fixture.missing, **_taken(exists, store, None, folder)
        ), "exists accepted a missing file"
    try:
        await vfs.stat(
            fixture.missing, **_taken(vfs.stat, store, None, folder)
        )
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("missing paths must raise FileNotFoundError")
    miss = _renderer(vfs, fixture.missing) or vfs.read
    try:
        await _bytes_of(
            miss(fixture.missing, **_taken(miss, store, None, folder))
        )
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("missing paths must raise FileNotFoundError")


@dataclass(frozen=True, slots=True)
class MutationFixture:
    """An empty, caller-owned scratch directory the check writes its files
    in, and the bytes it seeds them with."""

    directory: PathSpec
    content: bytes = b"mutation contract\n"


_OTHER = b"replaced\n"
_LOST = "0" * 32


def _child(directory: PathSpec, name: str) -> PathSpec:
    """The file ``name`` in ``directory``, keyed below the same mount.

    Args:
        directory (PathSpec): the scratch directory.
        name (str): the file's name.
    """
    key = f"{directory.vfs_path.strip('/')}/{name}".lstrip("/")
    return PathSpec(
        virtual=directory.child(name),
        directory=directory.virtual,
        vfs_path=key,
    )


async def _rejects(
    call: Awaitable[Any], error: type[BaseException], message: str
) -> None:
    """Check that ``call`` raises ``error``, letting any other propagate.

    Args:
        call (Awaitable[Any]): the call expected to fail.
        error (type[BaseException]): the error it must raise.
        message (str): the failure when it succeeds.
    """
    try:
        await call
    except error:
        return
    raise AssertionError(message)


class _Pinned:
    """A write context holding one version per path, as a conditional
    mount's cache would after the session read it.

    Args:
        vfs (BaseVFS): the VFS being validated.
    """

    def __init__(self, vfs: BaseVFS) -> None:
        self.vfs = vfs
        self.versions: dict[str, Measured] = {}

    async def read_version(self, path: PathSpec) -> Measured | None:
        return self.versions.get(path.virtual)

    async def read_versions(
        self, paths: list[PathSpec]
    ) -> list[Measured | None]:
        return [self.versions.get(path.virtual) for path in paths]

    async def drop(self, path: PathSpec) -> None:
        self.versions.pop(path.virtual, None)

    async def keep(self, path: PathSpec, version: Measured) -> None:
        self.versions[path.virtual] = version

    def context(self) -> WriteContext:
        support = self.vfs.condition_support
        return WriteContext(
            vfs=self.vfs.name,
            conditions=frozenset(
                kind for kind, modes in support.items() if "match" in modes
            ),
            creates=frozenset(
                kind for kind, modes in support.items() if "absent" in modes
            ),
            read_version=self.read_version,
            read_versions=self.read_versions,
            drop=self.drop,
            keep=self.keep,
        )

    async def run(self, call: Awaitable[Any]) -> None:
        """Await ``call`` under this write context, as a conditional
        mount binds it.

        Args:
            call (Awaitable[Any]): the op to run.
        """
        token = bind_caller(
            current_caller().changed({"write_context": self.context()})
        )
        try:
            await call
        finally:
            reset_caller(token)


class _Checker:
    """One mutation-contract run: the VFS, its store, and the scratch
    directory's files.

    Args:
        vfs (BaseVFS): the VFS being validated.
        fixture (MutationFixture): the scratch directory and seed bytes.
        store (IndexCacheStore): the store handed to every function.
    """

    def __init__(
        self, vfs: BaseVFS, fixture: MutationFixture, store: IndexCacheStore
    ) -> None:
        self.vfs = vfs
        self.fixture = fixture
        self.store = store

    def path(self, name: str) -> PathSpec:
        return _child(self.fixture.directory, name)

    async def put(self, path: PathSpec, data: bytes) -> None:
        await self.vfs.write(
            path, data, **_taken(self.vfs.write, self.store, None)
        )

    async def bytes_at(self, path: PathSpec) -> bytes:
        return await _bytes_of(
            self.vfs.read(path, **_taken(self.vfs.read, self.store, None))
        )

    async def gone(self, path: PathSpec) -> bool:
        try:
            await self.vfs.stat(
                path, **_taken(self.vfs.stat, self.store, None)
            )
        except FileNotFoundError:
            return True
        return False

    async def version(self, path: PathSpec) -> str:
        info = await self.vfs.stat(
            path, **_taken(self.vfs.stat, self.store, None)
        )
        assert info.fingerprint, (
            "a VFS that declares a match condition must stat a fingerprint"
        )
        return info.fingerprint

    async def call(self, op: str, *paths: PathSpec) -> None:
        fn: Callable[..., Awaitable[Any]] = getattr(self.vfs, op)
        await fn(*paths, **_taken(fn, self.store, None))

    async def check_moved(self, op: str) -> None:
        """Check ``rename`` or ``copy`` of one file: onto a fresh name, onto
        an existing file, and from a missing source.

        Args:
            op (str): ``rename`` or ``copy``.
        """
        content = self.fixture.content
        src, dst = self.path(f"{op}-src"), self.path(f"{op}-dst")
        for existing in (False, True):
            await self.put(src, content)
            if existing:
                await self.put(dst, _OTHER)
            await self.call(op, src, dst)
            assert await self.bytes_at(dst) == content, (
                f"{op} must land the source's bytes"
                + (" over an existing file" if existing else "")
            )
            if op == "rename":
                assert await self.gone(src), "rename must remove the source"
            else:
                assert await self.bytes_at(src) == content, (
                    "copy must keep the source"
                )
        await _rejects(
            self.call(op, self.path(f"{op}-missing"), dst),
            FileNotFoundError,
            f"{op} of a missing source must raise FileNotFoundError",
        )
        assert await self.bytes_at(dst) == content, (
            f"a refused {op} must leave the destination"
        )

    async def check_put(self, mode: ConditionMode, declared: bool) -> None:
        """Check a conditional replace: honoured and refused when declared,
        refused unsupported, writing nothing, when not.

        Args:
            mode (ConditionMode): ``absent`` or ``match``.
            declared (bool): whether ``condition_support`` declares it.
        """
        content = self.fixture.content
        path = self.path(f"put-{mode}")
        if mode == "match" or not declared:
            await self.put(path, _OTHER)
        held: WriteCondition = (
            ABSENT_WRITE
            if mode == "absent"
            else MatchWrite(await self.version(path) if declared else _LOST)
        )
        lost: WriteCondition = (
            ABSENT_WRITE if mode == "absent" else MatchWrite(_LOST)
        )
        if not declared:
            await _rejects(
                self.vfs._replace(ReplaceRequest(path, content, held)),
                OperationNotSupportedError,
                f"an undeclared put ({mode}) must raise "
                "OperationNotSupportedError",
            )
            assert await self.bytes_at(path) == _OTHER, (
                f"an undeclared put ({mode}) must write nothing"
            )
            return
        await self.vfs._replace(ReplaceRequest(path, content, held))
        assert await self.bytes_at(path) == content, (
            f"a held put ({mode}) must land"
        )
        await _rejects(
            self.vfs._replace(ReplaceRequest(path, _OTHER, lost)),
            StaleWriteError,
            f"a lost put ({mode}) must raise StaleWriteError",
        )
        assert await self.bytes_at(path) == content, (
            f"a lost put ({mode}) must write nothing"
        )

    async def check_copy(self, mode: ConditionMode) -> None:
        """Check a declared conditional copy, honoured and refused.

        Args:
            mode (ConditionMode): ``absent`` or ``match``.
        """
        content = self.fixture.content
        src, dst = self.path(f"copy-{mode}-src"), self.path(f"copy-{mode}")
        await self.put(src, content)
        if mode == "match":
            await self.put(dst, _OTHER)
        pinned = _Pinned(self.vfs)
        pinned.versions[dst.virtual] = (
            OwnRead.ABSENT if mode == "absent" else await self.version(dst)
        )
        await pinned.run(self.call("copy", src, dst))
        assert await self.bytes_at(dst) == content, (
            f"a held copy ({mode}) must land"
        )
        await self.put(src, _OTHER)
        pinned.versions[dst.virtual] = (
            OwnRead.ABSENT if mode == "absent" else _LOST
        )
        await _rejects(
            pinned.run(self.call("copy", src, dst)),
            StaleWriteError,
            f"a lost copy ({mode}) must raise StaleWriteError",
        )
        assert await self.bytes_at(dst) == content, (
            f"a lost copy ({mode}) must write nothing"
        )

    async def check_delete(self) -> None:
        """Check a declared conditional delete (match), honoured and
        refused."""
        path = self.path("delete-match")
        await self.put(path, self.fixture.content)
        pinned = _Pinned(self.vfs)
        pinned.versions[path.virtual] = _LOST
        await _rejects(
            pinned.run(self.call("unlink", path)),
            StaleWriteError,
            "a lost delete (match) must raise StaleWriteError",
        )
        assert await self.bytes_at(path) == self.fixture.content, (
            "a lost delete (match) must keep the file"
        )
        pinned.versions[path.virtual] = await self.version(path)
        await pinned.run(self.call("unlink", path))
        assert await self.gone(path), "a held delete (match) must remove"


async def check_mutation_contract(
    vfs: BaseVFS,
    fixture: MutationFixture,
    index: IndexCacheStore | None = None,
) -> None:
    """Verify a VFS's single-file mutations in an empty, caller-owned
    scratch directory, leaving the files it wrote there.

    ``rename`` and ``copy`` are checked where the VFS defines them: onto a
    fresh name and over an existing file the destination holds the
    source's bytes, ``rename`` removes the source and ``copy`` keeps it,
    and a missing source raises FileNotFoundError and leaves the
    destination. Write preconditions are checked exactly as
    ``condition_support`` declares them, under the write context a
    ``write: conditional`` mount binds: a declared condition lands when it
    holds and raises StaleWriteError, writing nothing, when it does not.
    An undeclared put condition must raise OperationNotSupportedError and
    write nothing; an undeclared copy or delete condition is refused by
    the mount before the VFS sees it, so it is not probed.

    Args:
        vfs (BaseVFS): the VFS being validated.
        fixture (MutationFixture): the scratch directory and seed bytes.
        index (IndexCacheStore | None): the store to hand every function;
            a RAM store at the VFS's ``index_ttl`` by default.
    """
    assert vfs.supports("write"), "the mutation contract seeds through write"
    checker = _Checker(
        vfs,
        fixture,
        index if index is not None else RAMIndexCacheStore(ttl=vfs.index_ttl),
    )
    for op in ("rename", "copy"):
        if vfs.supports(op):
            await checker.check_moved(op)
    support = vfs.condition_support
    for mode in ("absent", "match"):
        await checker.check_put(mode, mode in support.get("put", frozenset()))
    if vfs.supports("copy"):
        for mode in support.get("copy", frozenset()):
            await checker.check_copy(mode)
    if vfs.supports("unlink") and "match" in support.get(
        "delete", frozenset()
    ):
        await checker.check_delete()

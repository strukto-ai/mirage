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


from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.context.types import IOContext
from mirage.errors.fs import eexist, einval, eisdir, enotsup
from mirage.ops.generic.types import OpCoreFn, OpsTable
from mirage.ops.registry import RegisteredOp
from mirage.types import FileType, PathSpec
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.ranges import (
    is_unsatisfiable_range,
    slice_window,
    splice_window,
)


def _make_read(fn: OpCoreFn) -> OpCoreFn:
    async def read(
        accessor: Accessor,
        path: PathSpec,
        *,
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> bytes:
        return await fn(accessor, path, index)

    return read


def _make_ranged_read(table: OpsTable) -> OpCoreFn:
    """Build the ``read`` op, honoring a byte range when one is asked for.

    A backend that can fetch a range natively does so, which is the whole
    point on an object store: one ranged GET instead of the whole file.
    Every other backend falls back to reading and slicing, which is the
    same answer at the same cost as before, and is the only meaningful
    behavior for a backend that renders its content rather than storing
    it, since there is no remote range to ask for.

    A zero-length read is answered here rather than sent anywhere: no
    store can express an empty range, and the answer is known.

    A window starting at or past EOF is the one case where the two paths
    do not agree on their own: slicing yields empty, the POSIX answer,
    while an HTTP store refuses with 416. Normalizing here rather than in
    each reader keeps the op's contract one thing, and keeps a backend
    from becoming the odd one out the day it grows a native range.

    Args:
        table (OpsTable): the backend's op table.
    """

    async def read(
        accessor: Accessor,
        path: PathSpec,
        *,
        index: IndexCacheStore | None = None,
        offset: int = 0,
        size: int | None = None,
        **kwargs,
    ) -> bytes:
        if size == 0:
            return b""
        whole = not offset and size is None
        native = table.read_range
        if native is not None and not whole:
            try:
                return await native(accessor, path, index, offset, size)
            except Exception as exc:
                if not is_unsatisfiable_range(exc):
                    raise
                return b""
        data = await table.read_bytes(accessor, path, index)
        if whole:
            return data
        return slice_window(data, offset, size)

    return read


def _make_glob(table: OpsTable) -> OpCoreFn:
    # Glob expansion is a walk over readdir, so it is derived here rather
    # than written per driver: one walker, capped by the table's own
    # limit, with the table's stat so a trailing slash keeps directories
    # only. The mount hands it one pattern spec at a time and passes the
    # rest through, which is what every driver's resolver did with the
    # list.
    async def glob(
        accessor: Accessor,
        path: PathSpec,
        *,
        index: IndexCacheStore = NULL_INDEX,
        io_context: IOContext | None = None,
        **kwargs,
    ) -> list[PathSpec]:
        resolve = make_resolve_glob(
            table.readdir,
            table.max_glob_matches,
            stat=table.stat,
            context=io_context,
        )
        return await resolve(accessor, [path], index)

    return glob


def _make_data_write(fn: OpCoreFn) -> OpCoreFn:
    async def write(
        accessor: Accessor, path: PathSpec, data: bytes, **kwargs
    ) -> None:
        await fn(accessor, path, data)

    return write


def _make_emulated_append(
    stat: OpCoreFn, read_bytes: OpCoreFn, write_bytes: OpCoreFn
) -> OpCoreFn:
    async def append(
        accessor: Accessor,
        path: PathSpec,
        data: bytes,
        *,
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> None:
        # A zero-byte append is an open for appending with nothing
        # written after it (`exec >> f`, `: >> f`): it creates a missing
        # file and leaves an existing one alone. Reading and rewriting
        # the whole object to add nothing would move it twice and could
        # put back bytes a concurrent writer had just replaced.
        if not data:
            try:
                found = await stat(accessor, path, index)
            except FileNotFoundError:
                await write_bytes(accessor, path, data)
                return
            if found.type == FileType.DIRECTORY:
                raise eisdir(path.virtual)
            return
        # The read takes the caller's index, like every other read here:
        # an id-addressed backend (Box, Drive) turns a path into an id
        # through it, and without one every read is a miss, so each append
        # would overwrite what the last one wrote.
        try:
            existing = await read_bytes(accessor, path, index)
        except FileNotFoundError:
            await write_bytes(accessor, path, data)
            return
        await write_bytes(accessor, path, existing + data)

    return append


def _expect_offset(offset: int, path: PathSpec) -> int:
    if offset < 0:
        raise einval(path)
    return offset


def _make_pwrite(fn: OpCoreFn) -> OpCoreFn:
    async def pwrite(
        accessor: Accessor, path: PathSpec, data: bytes, offset: int, **kwargs
    ) -> None:
        await fn(accessor, path, data, _expect_offset(offset, path))

    return pwrite


def _make_emulated_pwrite(
    read_bytes: OpCoreFn, write_bytes: OpCoreFn, stat: OpCoreFn
) -> OpCoreFn:
    async def pwrite(
        accessor: Accessor,
        path: PathSpec,
        data: bytes,
        offset: int,
        *,
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> None:
        # The read is this op's own, below the door that judged it a
        # write: a session that may write a file and not read it still
        # writes at an offset, as pwrite(2) on a write-only descriptor
        # does. It takes the caller's index for the reason append does.
        offset = _expect_offset(offset, path)
        if not data:
            # A zero-length pwrite(2) on an existing file changes nothing
            # and must not read the file back: a concurrent writer's update
            # between this stat and a would-be write would be clobbered by
            # the stale contents. A zero-length pwrite on a missing file
            # creates an empty file (pwrite(2) with O_CREAT semantics).
            try:
                found = await stat(accessor, path, index)
            except FileNotFoundError:
                await write_bytes(accessor, path, data)
                return
            if found.type == FileType.DIRECTORY:
                raise eisdir(path.virtual)
            return
        try:
            existing = await read_bytes(accessor, path, index)
        except FileNotFoundError:
            # A key store answers a read of a directory's name as a
            # missing key; writing there would put an object beside the
            # directory.
            try:
                found = await stat(accessor, path, index)
            except FileNotFoundError:
                found = None
            if found is not None and found.type == FileType.DIRECTORY:
                raise eisdir(path.virtual)
            existing = b""
        await write_bytes(
            accessor, path, splice_window(existing, offset, data)
        )

    return pwrite


def _make_path_write(fn: OpCoreFn) -> OpCoreFn:
    async def mutate(accessor: Accessor, path: PathSpec, **kwargs) -> None:
        await fn(accessor, path)

    return mutate


async def refuse_taken(
    stat: OpCoreFn, accessor: Accessor, path: PathSpec, parents: bool
) -> None:
    """Refuse a mkdir of a name that is taken, as mkdir(2) does.

    mkdir(2) refuses a name that exists, file or directory, and ``mkdir
    -p`` passes only a directory. Not every backend's create says so (a
    Graph 409 on a folder, Nextcloud's MKCOL 405, SFTP under ``-p``), so
    both doors look the name up before the create. A directory under
    ``-p`` still reaches the create, which keeps it durable (an object
    store writes the marker of a directory only a key implied), and a
    name that cannot be looked up is left to it too, to answer ENOENT or
    ENOTDIR. Mirrors TS ``refuseTaken``.

    Args:
        stat (OpCoreFn): the backend's stat.
        accessor (Accessor): the call's accessor.
        path (PathSpec): the directory to make.
        parents (bool): ``-p``.

    Raises:
        FileExistsError: the name is taken and ``-p`` does not pass it.
    """
    try:
        row = await stat(accessor, path)
    except (FileNotFoundError, NotADirectoryError):
        return
    if parents and row.type == FileType.DIRECTORY:
        return
    raise eexist(path)


def _make_mkdir_parents(
    fn: OpCoreFn, stat: OpCoreFn, force_parents: bool = True
) -> OpCoreFn:
    async def mkdir(accessor: Accessor, path: PathSpec, **kwargs) -> None:
        parents = kwargs.get("parents") is True
        await refuse_taken(stat, accessor, path, parents)
        await fn(accessor, path, parents=force_parents or parents)

    return mkdir


def _make_rename(fn: OpCoreFn) -> OpCoreFn:
    async def rename(
        accessor: Accessor, src: PathSpec, dst: PathSpec, **kwargs
    ) -> None:
        await fn(accessor, src, dst)

    return rename


def _make_truncate(fn: OpCoreFn) -> OpCoreFn:
    async def truncate(
        accessor: Accessor,
        path: PathSpec,
        length: int,
        no_create: bool = False,
        **kwargs,
    ) -> None:
        await fn(accessor, path, length, no_create)

    return truncate


def _make_emulated_truncate(
    read_bytes: OpCoreFn, write_bytes: OpCoreFn
) -> OpCoreFn:
    async def truncate(
        accessor: Accessor,
        path: PathSpec,
        length: int,
        no_create: bool = False,
        **kwargs,
    ) -> None:
        if no_create:
            raise enotsup("emulated", "truncate --no-create", path)
        try:
            data = await read_bytes(accessor, path, index=NULL_INDEX)
        except FileNotFoundError:
            data = b""
        await write_bytes(accessor, path, data[:length].ljust(length, b"\0"))

    return truncate


def _make_set_attrs(fn: OpCoreFn) -> OpCoreFn:
    async def set_attrs(
        accessor: Accessor,
        path: PathSpec,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> dict[str, int | str]:
        return await fn(
            accessor,
            path,
            mode=mode,
            uid=uid,
            gid=gid,
            atime=atime,
            mtime=mtime,
        )

    return set_attrs


def _emit(
    ops: list[RegisteredOp],
    vfs_names: list[str],
    name: str,
    fn: OpCoreFn,
    write: bool,
    filetype: str | None,
    overrides: set[str],
    ranges: bool = False,
) -> None:
    if name in overrides:
        return
    for res in vfs_names:
        ops.append(
            RegisteredOp(
                name=name,
                vfs=res,
                filetype=filetype,
                fn=fn,
                write=write,
                ranges=ranges,
            )
        )


def make_generic_ops(
    vfs: str | list[str],
    table: OpsTable,
    *,
    emulate_truncate: bool = False,
    mkdir_parents: bool = False,
    overrides: set[str] | None = None,
) -> list[RegisteredOp]:
    """Generate a backend's VFS/FUSE op set from its ``CommandIO`` table.

    The per-backend ``ops/<b>/`` wrapper modules were hand-written
    forwards of exactly five shapes; this factory emits the same
    wrappers from the table that already feeds
    ``make_generic_commands``, so a backend declares its core surface
    once. Ops whose table field is None are omitted, mirroring how the
    command factory skips write commands on read-only backends. A writable
    table without a native append or pwrite builds them from read and
    write, which is async but not atomic against concurrent writers, like
    emulated truncate.

    ``index`` is forwarded into read/readdir/stat for every backend, so
    there is deliberately no ``forward_index`` knob here, in either
    language. Every write path evicts the parent listing through
    :meth:`Dispatcher.invalidate_after_write`, and both VFS/FUSE
    surfaces (:class:`Ops` in both languages) delegate to
    that same dispatcher, so the door that populates a listing is the
    door that evicts it.

    Every op emitted here is filetype-agnostic. To serve one extension
    differently, register a filetype-scoped op on the mount; the mount
    resolves ``(name, filetype)`` before ``(name, VFS)``.

    Args:
        vfs (str | list[str]): VFS name(s) the ops register
            under; a list fans out one ``RegisteredOp`` per name (the
            HF family registers one surface for four VFS).
        table (OpsTable): the backend's IO table (its ``CommandIO``).
        emulate_truncate (bool): synthesize ``truncate`` from
            ``read_bytes`` + ``write`` for a backend with no native
            partial write (dropbox is the only one; the rest grew a
            real ``truncate`` in their table, which wins outright).
        mkdir_parents (bool): forward ``parents=True`` to the core
            mkdir (databricks_volume).
        overrides (set[str] | None): op names to skip because the
            backend registers its own irregular wrapper.
    """
    vfs_names = vfs if isinstance(vfs, list) else [vfs]
    skip = overrides or set()
    ops: list[RegisteredOp] = []

    _emit(
        ops,
        vfs_names,
        "read",
        _make_ranged_read(table),
        False,
        None,
        skip,
        ranges=table.read_range is not None,
    )
    _emit(
        ops, vfs_names, "readdir", _make_read(table.readdir), False, None, skip
    )
    _emit(ops, vfs_names, "stat", _make_read(table.stat), False, None, skip)
    _emit(ops, vfs_names, "glob", _make_glob(table), False, None, skip)

    if table.write is not None:
        _emit(
            ops,
            vfs_names,
            "write",
            _make_data_write(table.write),
            True,
            None,
            skip,
        )
    if table.append is not None:
        _emit(
            ops,
            vfs_names,
            "append",
            _make_data_write(table.append),
            True,
            None,
            skip,
        )
    elif table.write is not None:
        _emit(
            ops,
            vfs_names,
            "append",
            _make_emulated_append(table.stat, table.read_bytes, table.write),
            True,
            None,
            skip,
        )
    if table.pwrite is not None:
        _emit(
            ops,
            vfs_names,
            "pwrite",
            _make_pwrite(table.pwrite),
            True,
            None,
            skip,
        )
    elif table.write is not None:
        _emit(
            ops,
            vfs_names,
            "pwrite",
            _make_emulated_pwrite(table.read_bytes, table.write, table.stat),
            True,
            None,
            skip,
        )
    if table.create is not None:
        _emit(
            ops,
            vfs_names,
            "create",
            _make_path_write(table.create),
            True,
            None,
            skip,
        )
    if table.mkdir is not None:
        mkdir_fn = _make_mkdir_parents(table.mkdir, table.stat, mkdir_parents)
        _emit(ops, vfs_names, "mkdir", mkdir_fn, True, None, skip)
    if table.unlink is not None:
        _emit(
            ops,
            vfs_names,
            "unlink",
            _make_path_write(table.unlink),
            True,
            None,
            skip,
        )
    if table.rmdir is not None:
        _emit(
            ops,
            vfs_names,
            "rmdir",
            _make_path_write(table.rmdir),
            True,
            None,
            skip,
        )
    if table.rename is not None:
        _emit(
            ops,
            vfs_names,
            "rename",
            _make_rename(table.rename),
            True,
            None,
            skip,
        )

    if table.truncate is not None:
        _emit(
            ops,
            vfs_names,
            "truncate",
            _make_truncate(table.truncate),
            True,
            None,
            skip,
        )
    elif emulate_truncate:
        if table.write is None:
            raise ValueError(
                "emulate_truncate requires a write op on the table"
            )
        _emit(
            ops,
            vfs_names,
            "truncate",
            _make_emulated_truncate(table.read_bytes, table.write),
            True,
            None,
            skip,
        )

    if table.set_attrs is not None:
        _emit(
            ops,
            vfs_names,
            "setattr",
            _make_set_attrs(table.set_attrs),
            True,
            None,
            skip,
        )

    return ops

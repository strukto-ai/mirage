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
from mirage.ops.generic.table import OpFn, OpsTable
from mirage.ops.registry import RegisteredOp
from mirage.types import PathSpec
from mirage.utils.ranges import is_unsatisfiable_range, slice_window


def _make_read(fn: OpFn) -> OpFn:

    async def read(accessor: Accessor,
                   path: PathSpec,
                   *,
                   index: IndexCacheStore | None = None,
                   **kwargs) -> bytes:
        return await fn(accessor, path, index)

    return read


def _make_ranged_read(table: OpsTable) -> OpFn:
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

    async def read(accessor: Accessor,
                   path: PathSpec,
                   *,
                   index: IndexCacheStore | None = None,
                   offset: int = 0,
                   size: int | None = None,
                   **kwargs) -> bytes:
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


def _make_data_write(fn: OpFn) -> OpFn:

    async def write(accessor: Accessor, path: PathSpec, data: bytes,
                    **kwargs) -> None:
        await fn(accessor, path, data)

    return write


def _make_emulated_append(read_bytes: OpFn, write_bytes: OpFn) -> OpFn:

    async def append(accessor: Accessor,
                     path: PathSpec,
                     data: bytes,
                     *,
                     index: IndexCacheStore | None = None,
                     **kwargs) -> None:
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


def _make_path_write(fn: OpFn) -> OpFn:

    async def mutate(accessor: Accessor, path: PathSpec, **kwargs) -> None:
        await fn(accessor, path)

    return mutate


def _make_mkdir_parents(fn: OpFn, force_parents: bool = True) -> OpFn:

    async def mkdir(accessor: Accessor, path: PathSpec, **kwargs) -> None:
        await fn(accessor,
                 path,
                 parents=force_parents or kwargs.get("parents") is True)

    return mkdir


def _make_rename(fn: OpFn) -> OpFn:

    async def rename(accessor: Accessor, src: PathSpec, dst: PathSpec,
                     **kwargs) -> None:
        await fn(accessor, src, dst)

    return rename


def _make_truncate(fn: OpFn) -> OpFn:

    async def truncate(accessor: Accessor, path: PathSpec, length: int,
                       **kwargs) -> None:
        await fn(accessor, path, length)

    return truncate


def _make_emulated_truncate(read_bytes: OpFn, write_bytes: OpFn) -> OpFn:

    async def truncate(accessor: Accessor, path: PathSpec, length: int,
                       **kwargs) -> None:
        try:
            data = await read_bytes(accessor, path, index=NULL_INDEX)
        except FileNotFoundError:
            data = b""
        await write_bytes(accessor, path, data[:length].ljust(length, b"\0"))

    return truncate


def _make_set_attrs(fn: OpFn) -> OpFn:

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
        return await fn(accessor,
                        path,
                        mode=mode,
                        uid=uid,
                        gid=gid,
                        atime=atime,
                        mtime=mtime)

    return set_attrs


def _emit(ops: list[RegisteredOp], vfs_names: list[str], name: str, fn: OpFn,
          write: bool, filetype: str | None, overrides: set[str]) -> None:
    if name in overrides:
        return
    for res in vfs_names:
        ops.append(
            RegisteredOp(name=name,
                         vfs=res,
                         filetype=filetype,
                         fn=fn,
                         write=write))


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
    table without native append uses read-modify-write, which is async but
    not atomic against concurrent writers, like emulated truncate.

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
            mkdir (disk).
        overrides (set[str] | None): op names to skip because the
            backend registers its own irregular wrapper.
    """
    vfs_names = vfs if isinstance(vfs, list) else [vfs]
    skip = overrides or set()
    ops: list[RegisteredOp] = []

    _emit(ops, vfs_names, "read", _make_ranged_read(table), False, None, skip)
    _emit(ops, vfs_names, "readdir", _make_read(table.readdir), False, None,
          skip)
    _emit(ops, vfs_names, "stat", _make_read(table.stat), False, None, skip)

    if table.write is not None:
        _emit(ops, vfs_names, "write", _make_data_write(table.write), True,
              None, skip)
    if table.append is not None:
        _emit(ops, vfs_names, "append", _make_data_write(table.append), True,
              None, skip)
    elif table.write is not None:
        _emit(ops, vfs_names, "append",
              _make_emulated_append(table.read_bytes, table.write), True, None,
              skip)
    if table.create is not None:
        _emit(ops, vfs_names, "create", _make_path_write(table.create), True,
              None, skip)
    if table.mkdir is not None:
        mkdir_fn = _make_mkdir_parents(table.mkdir, mkdir_parents)
        _emit(ops, vfs_names, "mkdir", mkdir_fn, True, None, skip)
    if table.unlink is not None:
        _emit(ops, vfs_names, "unlink", _make_path_write(table.unlink), True,
              None, skip)
    if table.rmdir is not None:
        _emit(ops, vfs_names, "rmdir", _make_path_write(table.rmdir), True,
              None, skip)
    if table.rename is not None:
        _emit(ops, vfs_names, "rename", _make_rename(table.rename), True, None,
              skip)

    if table.truncate is not None:
        _emit(ops, vfs_names, "truncate", _make_truncate(table.truncate), True,
              None, skip)
    elif emulate_truncate:
        if table.write is None:
            raise ValueError(
                "emulate_truncate requires a write op on the table")
        _emit(ops, vfs_names, "truncate",
              _make_emulated_truncate(table.read_bytes, table.write), True,
              None, skip)

    if table.set_attrs is not None:
        _emit(ops, vfs_names, "setattr", _make_set_attrs(table.set_attrs),
              True, None, skip)

    return ops

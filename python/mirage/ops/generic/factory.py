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
from mirage.commands.optional import try_load_command
from mirage.ops.generic.table import OpFn, OpsTable
from mirage.ops.registry import RegisteredOp
from mirage.types import PathSpec

FILETYPE_CATS: dict[str, OpFn | None] = {
    ".parquet": try_load_command("mirage.core.filetype.parquet", "cat",
                                 "parquet"),
    ".feather": try_load_command("mirage.core.filetype.feather", "cat",
                                 "parquet"),
    ".orc": try_load_command("mirage.core.filetype.orc", "cat", "parquet"),
    ".hdf5": try_load_command("mirage.core.filetype.hdf5", "cat", "hdf5"),
}


def _make_read(fn: OpFn) -> OpFn:

    async def read(accessor: Accessor,
                   path: PathSpec,
                   *,
                   index: IndexCacheStore | None = None,
                   **kwargs) -> bytes:
        return await fn(accessor, path, index)

    return read


def _make_filetype_read(fn: OpFn, cat: OpFn) -> OpFn:

    async def read(accessor: Accessor,
                   path: PathSpec,
                   *,
                   index: IndexCacheStore | None = None,
                   **kwargs) -> bytes:
        raw = await fn(accessor, path, index)
        return cat(raw)

    return read


def _make_data_write(fn: OpFn) -> OpFn:

    async def write(accessor: Accessor, path: PathSpec, data: bytes,
                    **kwargs) -> None:
        await fn(accessor, path, data)

    return write


def _make_path_write(fn: OpFn) -> OpFn:

    async def mutate(accessor: Accessor, path: PathSpec, **kwargs) -> None:
        await fn(accessor, path)

    return mutate


def _make_mkdir_parents(fn: OpFn) -> OpFn:

    async def mkdir(accessor: Accessor, path: PathSpec, **kwargs) -> None:
        await fn(accessor, path, parents=True)

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


def _emit(ops: list[RegisteredOp], resources: list[str], name: str, fn: OpFn,
          write: bool, filetype: str | None, overrides: set[str]) -> None:
    if name in overrides:
        return
    for res in resources:
        ops.append(
            RegisteredOp(name=name,
                         resource=res,
                         filetype=filetype,
                         fn=fn,
                         write=write))


def make_generic_ops(
    resource: str | list[str],
    table: OpsTable,
    *,
    filetype_read: bool = False,
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
    command factory skips write commands on read-only backends.

    Args:
        resource (str | list[str]): resource name(s) the ops register
            under; a list fans out one ``RegisteredOp`` per name (the
            HF family registers one surface for four resources).
        table (OpsTable): the backend's IO table (its ``CommandIO``).
        filetype_read (bool): emit ``read`` ops for ``.parquet`` /
            ``.feather`` / ``.orc`` / ``.hdf5`` rendered through the
            shared filetype cats; formats whose optional dependency is
            missing are skipped like ``try_load_command`` does.
        emulate_truncate (bool): synthesize ``truncate`` from
            ``read_bytes`` + ``write`` for backends with no native
            partial write (s3/ssh/ram/redis today).
        mkdir_parents (bool): forward ``parents=True`` to the core
            mkdir (disk).
        overrides (set[str] | None): op names to skip because the
            backend registers its own irregular wrapper.
    """
    resources = resource if isinstance(resource, list) else [resource]
    skip = overrides or set()
    ops: list[RegisteredOp] = []

    _emit(ops, resources, "read", _make_read(table.read_bytes), False, None,
          skip)
    _emit(ops, resources, "readdir", _make_read(table.readdir), False, None,
          skip)
    _emit(ops, resources, "stat", _make_read(table.stat), False, None, skip)

    if filetype_read:
        for ext, cat in FILETYPE_CATS.items():
            if cat is None:
                continue
            _emit(ops, resources, "read",
                  _make_filetype_read(table.read_bytes, cat), False, ext, skip)

    if table.write is not None:
        _emit(ops, resources, "write", _make_data_write(table.write), True,
              None, skip)
    if table.append is not None:
        _emit(ops, resources, "append", _make_data_write(table.append), True,
              None, skip)
    if table.create is not None:
        _emit(ops, resources, "create", _make_path_write(table.create), True,
              None, skip)
    if table.mkdir is not None:
        mkdir_fn = (_make_mkdir_parents(table.mkdir)
                    if mkdir_parents else _make_path_write(table.mkdir))
        _emit(ops, resources, "mkdir", mkdir_fn, True, None, skip)
    if table.unlink is not None:
        _emit(ops, resources, "unlink", _make_path_write(table.unlink), True,
              None, skip)
    if table.rmdir is not None:
        _emit(ops, resources, "rmdir", _make_path_write(table.rmdir), True,
              None, skip)
    if table.rename is not None:
        _emit(ops, resources, "rename", _make_rename(table.rename), True, None,
              skip)

    if table.truncate is not None:
        _emit(ops, resources, "truncate", _make_truncate(table.truncate), True,
              None, skip)
    elif emulate_truncate:
        if table.write is None:
            raise ValueError(
                "emulate_truncate requires a write op on the table")
        _emit(ops, resources, "truncate",
              _make_emulated_truncate(table.read_bytes, table.write), True,
              None, skip)

    if table.set_attrs is not None:
        _emit(ops, resources, "setattr", _make_set_attrs(table.set_attrs),
              True, None, skip)

    return ops

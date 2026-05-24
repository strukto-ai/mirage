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

import functools
import importlib
import logging
from collections.abc import Callable
from types import ModuleType

from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult

_logger = logging.getLogger(__name__)

_EXT_GROUPS = (
    ((".parquet", ), "parquet"),
    ((".orc", ), "orc"),
    ((".feather", ".arrow", ".ipc"), "feather"),
    ((".hdf5", ".h5"), "hdf5"),
)


def _load_modules() -> dict[str, ModuleType]:
    modules: dict[str, ModuleType] = {}
    for exts, name in _EXT_GROUPS:
        try:
            mod = importlib.import_module(f"mirage.core.filetype.{name}")
        except ImportError as e:
            _logger.debug("filetype module %s skipped: %s", name, e)
            continue
        for ext in exts:
            modules[ext] = mod
    return modules


_EXT_MODULES = _load_modules()


def _fmt(module: ModuleType) -> str:
    return module.__name__.rsplit(".", 1)[-1]


async def _drop_index(read_bytes: Callable, accessor: object, path: object,
                      index: object) -> bytes:
    return await read_bytes(accessor, path)


async def _ft_cat(resolve_glob, read, module, accessor, paths, *texts,
                  index=None, **kwargs):
    if not paths:
        raise ValueError("cat: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    try:
        raw = await read(accessor, p, index)
        return module.cat(raw), IOResult(reads={p.strip_prefix: raw},
                                         cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"cat: {p.original}: failed to read as {_fmt(module)}: {e}".
            encode(),
        )


async def _ft_head(resolve_glob, read, module, accessor, paths, *texts,
                   n=None, c=None, index=None, **kwargs):
    if not paths:
        raise ValueError("head: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=f"head: -c not supported for {_fmt(module)} files".encode(),
        )
    try:
        lines = int(n) if n is not None else 10
        raw = await read(accessor, p, index)
        return module.head(raw, n=lines), IOResult(
            reads={p.strip_prefix: raw}, cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"head: {p.original}: failed to read as {_fmt(module)}: {e}"
            .encode(),
        )


async def _ft_tail(resolve_glob, read, module, accessor, paths, *texts,
                   n=None, c=None, index=None, **kwargs):
    if not paths:
        raise ValueError("tail: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=f"tail: -c not supported for {_fmt(module)} files".encode(),
        )
    try:
        lines = int(n) if n is not None else 10
        raw = await read(accessor, p, index)
        return module.tail(raw, n=lines), IOResult(
            reads={p.strip_prefix: raw}, cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"tail: {p.original}: failed to read as {_fmt(module)}: {e}"
            .encode(),
        )


async def _ft_wc(resolve_glob, read, module, accessor, paths, *texts,
                 args_l=False, w=False, c=False, m=False, index=None,
                 **kwargs):
    if not paths:
        raise ValueError("wc: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    if w or c or m:
        return None, IOResult(
            exit_code=1,
            stderr=f"wc: -w/-c/-m not supported for {_fmt(module)} files".
            encode(),
        )
    try:
        raw = await read(accessor, p, index)
        return str(module.wc(raw)).encode(), IOResult(
            reads={p.strip_prefix: raw}, cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"wc: {p.original}: failed to read as {_fmt(module)}: {e}".
            encode(),
        )


async def _ft_stat(resolve_glob, read, module, accessor, paths, *texts,
                   index=None, **kwargs):
    if not paths:
        raise ValueError("stat: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    try:
        raw = await read(accessor, p, index)
        return module.stat(raw), IOResult(reads={p.strip_prefix: raw},
                                          cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"stat: {p.original}: failed to read as {_fmt(module)}: {e}"
            .encode(),
        )


async def _ft_cut(resolve_glob, read, module, accessor, paths, *texts,
                  f=None, d=None, c=None, index=None, **kwargs):
    if not paths:
        raise ValueError("cut: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    if f is None:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: -f required for {_fmt(module)} files (column names)".
            encode(),
        )
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: -c not supported for {_fmt(module)}; use -f".encode(),
        )
    try:
        columns = [col.strip() for col in f.split(",")]
        raw = await read(accessor, p, index)
        return module.cut(raw, columns=columns), IOResult(
            reads={p.strip_prefix: raw}, cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"cut: {p.original}: {e}".encode(),
        )


async def _ft_file(resolve_glob, read, module, accessor, paths, *texts,
                   index=None, **kwargs):
    if not paths:
        raise ValueError("file: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    try:
        raw = await read(accessor, p, index)
        return module.file(raw), IOResult(reads={p.strip_prefix: raw},
                                          cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"file: {p.original}: failed to read as {_fmt(module)}: {e}"
            .encode(),
        )


_BUILDERS = (
    ("cat", _ft_cat),
    ("head", _ft_head),
    ("tail", _ft_tail),
    ("wc", _ft_wc),
    ("stat", _ft_stat),
    ("cut", _ft_cut),
    ("file", _ft_file),
)


def make_filetype_commands(
    resource: str,
    resolve_glob: Callable,
    read_bytes: Callable,
    *,
    read_takes_index: bool = False,
    provision: Callable | None = None,
) -> list[Callable]:
    read = (read_bytes if read_takes_index else functools.partial(
        _drop_index, read_bytes))
    commands: list[Callable] = []
    for ext, module in _EXT_MODULES.items():
        for name, fn in _BUILDERS:
            bound = functools.partial(fn, resolve_glob, read, module)
            commands.append(
                command(name,
                        resource=resource,
                        spec=SPECS[name],
                        filetype=ext,
                        provision=provision)(bound))
    return commands

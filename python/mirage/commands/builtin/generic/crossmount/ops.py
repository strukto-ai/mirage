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
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import FileType, PathSpec

CrossResult = tuple[ByteSource | None, IOResult]


def _as_pathspec(path: PathSpec | str) -> PathSpec:
    if isinstance(path, PathSpec):
        return path
    return PathSpec.from_str_path(path, "")


async def _op(dispatch: Callable,
              op: str,
              accessor: object,
              path: PathSpec,
              index: object = None,
              **kwargs: Any) -> Any:
    # The one primitive: route any op for any path to its owning mount. The
    # generics call ops as (accessor, path, index); dispatch ignores both and
    # keys off the path, so this is also the single place a raw str is coerced.
    data, _ = await dispatch(op, _as_pathspec(path), **kwargs)
    return data


async def _stream(dispatch: Callable,
                  accessor: object,
                  path: PathSpec,
                  index: object = None) -> AsyncIterator[bytes]:
    yield await _op(dispatch, "read", accessor, path)


async def _is_dir(dispatch: Callable, path: PathSpec) -> bool:
    try:
        file_stat = await _op(dispatch, "stat", None, path)
    except FileNotFoundError:
        return False
    return file_stat.type == FileType.DIRECTORY


async def _walk(dispatch: Callable, src: PathSpec) -> list[tuple[str, bool]]:
    # Top-down (parents before children) list of (path, is_dir). The type is
    # captured here, while the tree is intact, so a caller that deletes as it
    # goes never re-stats a path whose virtual parent dir has since vanished
    # (e.g. on S3, where an empty prefix stops existing).
    src_path = _as_pathspec(src).original
    file_stat = await _op(dispatch, "stat", None, src_path)
    if file_stat.type != FileType.DIRECTORY:
        return [(src_path, False)]
    entries = [(src_path, True)]
    queue = [src_path]
    while queue:
        directory = queue.pop(0)
        for child in await _op(dispatch, "readdir", None, directory):
            child_stat = await _op(dispatch, "stat", None, child)
            is_dir = child_stat.type == FileType.DIRECTORY
            entries.append((child, is_dir))
            if is_dir:
                queue.append(child)
    return entries


async def _find(dispatch: Callable,
                accessor: object,
                src: PathSpec,
                type: str | None = None,
                index: object = None) -> list[str]:
    return [path for path, _ in await _walk(dispatch, src)]


async def _copy(dispatch: Callable, accessor: object, src: PathSpec,
                target: PathSpec) -> None:
    file_stat = await _op(dispatch, "stat", None, src)
    if file_stat.type == FileType.DIRECTORY:
        # cp -r merges into an existing directory; only create when absent so a
        # real conflict (a file already at the target) still raises.
        if not await _is_dir(dispatch, target):
            await _op(dispatch, "mkdir", None, target)
        return
    data = await _op(dispatch, "read", None, src)
    await _op(dispatch, "write", None, target, data=data)


async def _rename(dispatch: Callable, accessor: object, src: PathSpec,
                  target: PathSpec) -> None:
    file_stat = await _op(dispatch, "stat", None, src)
    if file_stat.type != FileType.DIRECTORY:
        data = await _op(dispatch, "read", None, src)
        await _op(dispatch, "write", None, target, data=data)
        await _op(dispatch, "unlink", None, src)
        return
    # No atomic rename across mounts: copy the tree (parents first), then
    # remove the source (children first), using types captured by the single
    # walk so a vanished virtual dir is never re-stat'd.
    src_base = _as_pathspec(src).original.rstrip("/")
    dst_base = _as_pathspec(target).original.rstrip("/")
    entries = await _walk(dispatch, src)
    for path, _ in entries:
        await _copy(dispatch, accessor, path, dst_base + path[len(src_base):])
    for path, is_dir in reversed(entries):
        await _op(dispatch, "rmdir" if is_dir else "unlink", None, path)


@dataclass(frozen=True, slots=True)
class DispatchIO:
    read_bytes: Callable
    read_stream: Callable
    stat: Callable
    readdir: Callable
    copy: Callable
    find: Callable
    rename: Callable


def build_dispatch_io(dispatch: Callable) -> DispatchIO:
    return DispatchIO(
        read_bytes=functools.partial(_op, dispatch, "read"),
        read_stream=functools.partial(_stream, dispatch),
        stat=functools.partial(_op, dispatch, "stat"),
        readdir=functools.partial(_op, dispatch, "readdir"),
        copy=functools.partial(_copy, dispatch),
        find=functools.partial(_find, dispatch),
        rename=functools.partial(_rename, dispatch),
    )

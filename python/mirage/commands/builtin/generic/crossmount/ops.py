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
from typing import Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import FileType, PathSpec

CrossResult = tuple[ByteSource | None, IOResult]


def _as_pathspec(path: PathSpec | str) -> PathSpec:
    if isinstance(path, PathSpec):
        return path
    return PathSpec.from_str_path(path, "")


async def _fetch(dispatch: Callable, path: PathSpec) -> bytes:
    data, _ = await dispatch("read", _as_pathspec(path))
    return data


async def _read_bytes(dispatch: Callable,
                      reads: dict[str, bytes],
                      accessor: object,
                      path: PathSpec,
                      index: object = None) -> bytes:
    path_ps = _as_pathspec(path)
    data = await _fetch(dispatch, path_ps)
    if isinstance(data, bytes):
        reads[path_ps.original] = data
    return data


async def _read_stream(dispatch: Callable,
                       reads: dict[str, bytes],
                       accessor: object,
                       path: PathSpec,
                       index: object = None) -> AsyncIterator[bytes]:
    yield await _read_bytes(dispatch, reads, accessor, path, index)


async def _stat(dispatch: Callable,
                accessor: object,
                path: PathSpec,
                index: object = None):
    file_stat, _ = await dispatch("stat", _as_pathspec(path))
    return file_stat


async def _readdir(dispatch: Callable,
                   accessor: object,
                   path: PathSpec,
                   index: object = None) -> list[str]:
    children, _ = await dispatch("readdir", _as_pathspec(path))
    return children


async def _find(dispatch: Callable,
                accessor: object,
                src: PathSpec,
                type: str | None = None,
                index: object = None) -> list[str]:
    src = _as_pathspec(src)
    file_stat, _ = await dispatch("stat", src)
    if file_stat.type != FileType.DIRECTORY:
        return [src.original]
    entries = [src.original]
    queue = [src]
    while queue:
        directory = queue.pop(0)
        children, _ = await dispatch("readdir", directory)
        for child in children:
            child_ps = _as_pathspec(child)
            entries.append(child_ps.original)
            child_stat, _ = await dispatch("stat", child_ps)
            if child_stat.type == FileType.DIRECTORY:
                queue.append(child_ps)
    return entries


async def _copy(dispatch: Callable, accessor: object, src: PathSpec,
                target: PathSpec) -> None:
    src_ps = _as_pathspec(src)
    dst_ps = _as_pathspec(target)
    file_stat, _ = await dispatch("stat", src_ps)
    if file_stat.type == FileType.DIRECTORY:
        try:
            await dispatch("mkdir", dst_ps)
        except FileExistsError:
            pass
        return
    data = await _fetch(dispatch, src_ps)
    await dispatch("write", dst_ps, data=data)


async def _copy_tree(dispatch: Callable, src_dir: PathSpec,
                     dst_dir: PathSpec) -> None:
    try:
        await dispatch("mkdir", dst_dir)
    except FileExistsError:
        pass
    children, _ = await dispatch("readdir", src_dir)
    for child in children:
        name = child.rstrip("/").rsplit("/", 1)[-1]
        child_src = _as_pathspec(child)
        child_dst = _as_pathspec(dst_dir.child(name))
        child_stat, _ = await dispatch("stat", child_src)
        if child_stat.type == FileType.DIRECTORY:
            await _copy_tree(dispatch, child_src, child_dst)
        else:
            data = await _fetch(dispatch, child_src)
            await dispatch("write", child_dst, data=data)


async def _remove_tree(dispatch: Callable, src_dir: PathSpec) -> None:
    children, _ = await dispatch("readdir", src_dir)
    for child in children:
        child_src = _as_pathspec(child)
        child_stat, _ = await dispatch("stat", child_src)
        if child_stat.type == FileType.DIRECTORY:
            await _remove_tree(dispatch, child_src)
        else:
            await dispatch("unlink", child_src)
    await dispatch("rmdir", src_dir)


async def _rename(dispatch: Callable, accessor: object, src: PathSpec,
                  target: PathSpec) -> None:
    src_ps = _as_pathspec(src)
    dst_ps = _as_pathspec(target)
    file_stat, _ = await dispatch("stat", src_ps)
    if file_stat.type == FileType.DIRECTORY:
        await _copy_tree(dispatch, src_ps, dst_ps)
        await _remove_tree(dispatch, src_ps)
        return
    data = await _fetch(dispatch, src_ps)
    await dispatch("write", dst_ps, data=data)
    await dispatch("unlink", src_ps)


@dataclass(frozen=True, slots=True)
class DispatchIO:
    reads: dict[str, bytes]
    read_bytes: Callable
    read_stream: Callable
    stat: Callable
    readdir: Callable
    copy: Callable
    find: Callable
    rename: Callable


def build_dispatch_io(dispatch: Callable) -> DispatchIO:
    reads: dict[str, bytes] = {}
    return DispatchIO(
        reads=reads,
        read_bytes=functools.partial(_read_bytes, dispatch, reads),
        read_stream=functools.partial(_read_stream, dispatch, reads),
        stat=functools.partial(_stat, dispatch),
        readdir=functools.partial(_readdir, dispatch),
        copy=functools.partial(_copy, dispatch),
        find=functools.partial(_find, dispatch),
        rename=functools.partial(_rename, dispatch),
    )

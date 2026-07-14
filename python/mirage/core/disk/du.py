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

import asyncio
import os
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.types import PathSpec


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


def _du_sync(root: Path, path: str) -> int:
    p = _resolve(root, path)
    if p.is_file():
        return p.stat().st_size
    total = 0
    for dirpath, _dirnames, filenames in os.walk(p):
        for f in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                # unreadable entry: GNU du skips it and totals the rest
                pass
    return total


def _du_all_sync(root: Path, path: str) -> tuple[list[tuple[str, int]], int]:
    p = _resolve(root, path)
    if p.is_file():
        size = p.stat().st_size
        return [(("/" + path.strip("/")), size)], size
    entries: list[tuple[str, int]] = []
    total = 0
    for dirpath, _dirnames, filenames in os.walk(p):
        for f in filenames:
            full = os.path.join(dirpath, f)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            rel = os.path.relpath(full, root)
            entry_path = "/" + rel
            entries.append((entry_path, size))
            total += size
    entries.sort()
    return entries, total


async def du(accessor: DiskAccessor, path: PathSpec) -> int:
    if isinstance(path, PathSpec):
        path = path.mount_path
    return await asyncio.to_thread(_du_sync, accessor.root, path)


async def du_all(
    accessor: DiskAccessor,
    path: PathSpec,
) -> tuple[list[tuple[str, int]], int]:
    if isinstance(path, PathSpec):
        path = path.mount_path
    return await asyncio.to_thread(_du_all_sync, accessor.root, path)

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

import os
from pathlib import Path


def resolve(root: Path, path: str) -> Path:
    """Resolve a mount-relative path under the disk root.

    Args:
        root (Path): the mount root.
        path (str): mount-relative path.
    """
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


def size_sync(root: Path, path: str) -> int:
    """Recursive byte size of a path, run on a worker thread.

    Args:
        root (Path): the mount root.
        path (str): mount-relative path.
    """
    p = resolve(root, path)
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


def entries_sync(root: Path, path: str) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a path plus their total, on a worker thread.

    Args:
        root (Path): the mount root.
        path (str): mount-relative path.
    """
    p = resolve(root, path)
    if p.is_file():
        file_size = p.stat().st_size
        return [(("/" + path.strip("/")), file_size)], file_size
    found: list[tuple[str, int]] = []
    total = 0
    for dirpath, _dirnames, filenames in os.walk(p):
        for f in filenames:
            full = os.path.join(dirpath, f)
            try:
                file_size = os.path.getsize(full)
            except OSError:
                continue
            found.append(("/" + os.path.relpath(full, root), file_size))
            total += file_size
    found.sort()
    return found, total

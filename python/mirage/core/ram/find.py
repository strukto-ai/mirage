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

from fnmatch import fnmatch

from mirage.accessor.ram import RAMAccessor
from mirage.types import PathSpec


def _norm(path: str) -> str:
    return "/" + path.strip("/")


async def find(
    accessor: RAMAccessor,
    path: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    store = accessor.store
    p = _norm(path)
    prefix = p.rstrip("/") + "/"
    base_depth = 0 if p == "/" else p.count("/")
    results: list[str] = []

    candidates: list[tuple[str, str]] = []
    if type != "d":
        for key in store.files:
            candidates.append((key, "f"))
    if type != "f":
        for key in store.dirs:
            if key != "/":
                candidates.append((key, "d"))

    for key, kind in candidates:
        if key != p and not key.startswith(prefix):
            continue
        if key == p and kind == "d":
            continue

        depth = key.count("/") - base_depth

        if maxdepth is not None and depth > maxdepth:
            continue

        if mindepth is not None and depth < mindepth:
            continue

        basename = key.rsplit("/", 1)[-1]
        if name is not None and not fnmatch(basename, name):
            continue

        if iname is not None and not fnmatch(basename.lower(), iname.lower()):
            continue

        if path_pattern is not None and not fnmatch(key, path_pattern):
            continue

        if or_names is not None and not any(
                fnmatch(basename, pat) for pat in or_names):
            continue

        if name_exclude is not None and fnmatch(basename, name_exclude):
            continue

        if kind == "f" and (min_size is not None or max_size is not None):
            size = len(store.files[key])
            if min_size is not None and size < min_size:
                continue
            if max_size is not None and size > max_size:
                continue

        results.append(key)

    return sorted(results)

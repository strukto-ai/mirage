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

from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.types import PathSpec


async def find(
    accessor: HfBucketsAccessor,
    path: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    target = path.strip_prefix
    pfx = target.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    base = "/" + pfx if pfx else "/"
    base_depth = 0 if base == "/" else base.count("/")

    op = accessor.operator()
    results: list[str] = []
    seen_dirs: set[str] = set()
    try:
        async for entry in await op.scan(scan_path):
            rel = entry.path
            if not rel:
                continue
            is_dir = (rel.endswith("/") or getattr(entry.metadata, "mode",
                                                   None) == EntryMode.Dir)
            entry_path = "/" + rel.rstrip("/").lstrip("/")
            kind = "d" if is_dir else "f"

            file_entries: list[tuple[str, str]] = [(entry_path, kind)]
            if not is_dir:
                parent = entry_path.rsplit("/", 1)[0] or "/"
                while parent and parent != base and parent != "/":
                    if parent not in seen_dirs:
                        seen_dirs.add(parent)
                        file_entries.append((parent, "d"))
                    parent = parent.rsplit("/", 1)[0] or "/"

            for ep, k in file_entries:
                en = ep.rsplit("/", 1)[-1]

                if type == "f" or type == "file":
                    if k != "f":
                        continue
                elif type == "d" or type == "directory":
                    if k != "d":
                        continue

                if or_names:
                    if not any(fnmatch(en, pat) for pat in or_names):
                        continue
                elif name is not None and not fnmatch(en, name):
                    continue

                if iname is not None and not fnmatch(en.lower(),
                                                     iname.lower()):
                    continue

                if path_pattern is not None and not fnmatch(ep, path_pattern):
                    continue

                if name_exclude is not None and fnmatch(en, name_exclude):
                    continue

                depth = ep.count("/") - base_depth
                if maxdepth is not None and depth > maxdepth:
                    continue
                if mindepth is not None and depth < mindepth:
                    continue

                if k == "f" and (min_size is not None or max_size is not None):
                    size = getattr(entry.metadata, "content_length", 0) or 0
                    if min_size is not None and size < min_size:
                        continue
                    if max_size is not None and size > max_size:
                        continue

                if mtime_min is not None or mtime_max is not None:
                    lm = getattr(entry.metadata, "last_modified", None)
                    if lm is None:
                        continue
                    mt = lm.timestamp()
                    if mtime_min is not None and mt < mtime_min:
                        continue
                    if mtime_max is not None and mt > mtime_max:
                        continue

                results.append(ep)
    except NotFound:
        return []
    return sorted(set(results))

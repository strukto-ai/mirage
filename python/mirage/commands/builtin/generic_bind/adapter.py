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

import fnmatch
import logging
import posixpath
from collections.abc import Callable
from dataclasses import dataclass

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def make_resolve_glob(readdir: Callable,
                      max_glob_matches: int | None = None) -> Callable:
    """Build a resolve_glob generic over a backend's readdir.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``.
        max_glob_matches (int | None): cap on matches per pattern before
            truncation.
    """

    async def resolve_glob(accessor: Accessor, paths: list[PathSpec],
                           index: IndexCacheStore | None) -> list[PathSpec]:
        result: list[PathSpec] = []
        for p in paths:
            if isinstance(p, str):
                result.append(
                    PathSpec(original=p, directory=posixpath.dirname(p)))
                continue
            if p.resolved:
                result.append(p)
            elif p.pattern:
                entries = await readdir(accessor, p.dir, index)
                matched = [
                    PathSpec.from_str_path(e, p.prefix) for e in entries
                    if fnmatch.fnmatch(e.rsplit("/", 1)[-1], p.pattern)
                ]
                if (max_glob_matches is not None
                        and len(matched) > max_glob_matches):
                    logger.warning(
                        "%s: %d matches exceeds limit (%d), truncating",
                        p.directory, len(matched), max_glob_matches)
                    matched = matched[:max_glob_matches]
                result.extend(matched)
            else:
                result.append(p)
        return result

    return resolve_glob


@dataclass(frozen=True)
class CommandIO:
    readdir: Callable
    read_bytes: Callable
    read_stream: Callable
    stat: Callable
    is_mounted: Callable
    local: bool = True
    max_glob_matches: int | None = None
    write: Callable | None = None
    exists: Callable | None = None
    mkdir: Callable | None = None
    unlink: Callable | None = None
    rmdir: Callable | None = None
    rm_r: Callable | None = None
    rename: Callable | None = None
    copy: Callable | None = None
    create: Callable | None = None
    truncate: Callable | None = None
    find: Callable | None = None
    du_total: Callable | None = None
    du_all: Callable | None = None

    @property
    def resolve_glob(self) -> Callable:
        return make_resolve_glob(self.readdir, self.max_glob_matches)

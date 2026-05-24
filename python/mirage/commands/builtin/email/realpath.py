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

import posixpath

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.email.stat import stat as stat_impl
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _exists(accessor: EmailAccessor,
                  path: str,
                  index: IndexCacheStore = None,
                  prefix="") -> bool:
    try:
        spec = PathSpec(original=path, directory=path, prefix=prefix)
        await stat_impl(accessor, spec, index)
        return True
    except (FileNotFoundError, ValueError, Exception):
        return False


@command("realpath", resource="email", spec=SPECS["realpath"])
async def realpath(
    accessor: EmailAccessor,
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    e: bool = False,
    m: bool = False,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    full = [prefix + p if prefix else p for p in (paths or [])]
    lines: list[str] = []
    for p in full:
        resolved = posixpath.normpath(p)
        if e and not await _exists(accessor, resolved, index, prefix=prefix):
            raise FileNotFoundError(
                f"realpath: '{p.original}': No such file or directory")
        lines.append(resolved)
    return ("\n".join(lines) + "\n").encode(), IOResult()

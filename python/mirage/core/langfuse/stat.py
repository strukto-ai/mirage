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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.langfuse.read import fetch_trace_file
from mirage.core.langfuse.readdir import EXTRAS
from mirage.core.langfuse.scope import detect_scope
from mirage.core.render.json import json_bytes
from mirage.types import ContentType, FileStat, FileType, PathSpec


async def _stat_trace(
    accessor: LangfuseAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> FileStat:
    # A trace listing stops at default_trace_limit and
    # default_from_timestamp while read fetches any trace by id, so a
    # trace the listing left out is probed the way read reaches it; the
    # probe fetched the whole trace, so its rendered size is exact.
    if entry is not None:
        return entry
    data = await fetch_trace_file(accessor, match, path)
    return FileStat(
        name=path.vfs_path.strip("/").split("/")[-1],
        type=FileType.FILE,
        content=ContentType.JSON,
        size=len(json_bytes(data)),
    )


stat = make_stat(
    detect_scope,
    overrides={
        "trace": _stat_trace,
        "session_trace": _stat_trace,
    },
    extras=EXTRAS,
)

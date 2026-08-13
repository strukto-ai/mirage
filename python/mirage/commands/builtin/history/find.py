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

from functools import partial

from mirage.accessor.history import HistoryAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.find import find_generic
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue
from mirage.core.history.find import find as find_core
from mirage.core.history.stat import stat as stat_core
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import NamespaceView, StatPath
from mirage.types import PathSpec


@command("find", resource="history", spec=SPECS["find"])
async def find(
    accessor: HistoryAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = NULL_INDEX,
    ns: NamespaceView | None = None,
    stat_path: StatPath | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    links = ns.links if ns is not None else None
    return await find_generic(list(paths),
                              list(texts),
                              CommandOpts(stdin=stdin, flags=flags),
                              find_core=partial(find_core, accessor),
                              stat=partial(stat_core, accessor),
                              stat_path=stat_path,
                              links=links)

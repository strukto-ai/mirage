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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.ls import ls_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          overlaid_stat)
from mirage.commands.config import CommandOpts
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import ChildMounts, LinkView, StatOverlay
from mirage.types import PathSpec


async def ls(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = NULL_INDEX,
    cwd: PathSpec | str = "/",
    stat_overlay: StatOverlay | None = None,
    links: LinkView | None = None,
    child_mounts: ChildMounts | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("ls: no resource")
    if not paths:
        cwd_virtual = cwd.virtual if isinstance(cwd, PathSpec) else cwd
        cwd_rp = (cwd.resource_path
                  if isinstance(cwd, PathSpec) else cwd.strip("/"))
        paths = [
            PathSpec(virtual=cwd_virtual,
                     directory=cwd_virtual,
                     resolved=False,
                     resource_path=cwd_rp)
        ]
    resolved = await ops.resolve_glob(accessor, paths, index)
    stat_fn = partial(ops.stat, accessor)
    if stat_overlay is not None:
        stat_fn = partial(overlaid_stat, stat_fn, stat_overlay)
    return await ls_generic(resolved,
                            list(texts),
                            CommandOpts(stdin=stdin, flags=flags, cwd=cwd),
                            partial(ops.readdir, accessor),
                            stat_fn,
                            index=index,
                            links=links,
                            child_mounts=child_mounts)


BUILDER = Builder('ls', ls, None, False, None)

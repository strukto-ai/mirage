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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.commands.errors import UsageError
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def unlink(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or not paths:
        raise UsageError(
            "unlink: missing operand\n"
            "Try 'unlink --help' for more information.", 1)
    paths = await ops.resolve_glob(accessor, paths, index)
    if len(paths) > 1:
        raise extra_operand_error("unlink", paths[1].raw_path)
    p = paths[0]
    try:
        s = await ops.stat(accessor, p)
    except FileNotFoundError:
        return None, IOResult(exit_code=1,
                              stderr=(f"unlink: cannot unlink '{p.virtual}': "
                                      "No such file or directory\n").encode())
    if s.type == FileType.DIRECTORY:
        return None, IOResult(exit_code=1,
                              stderr=(f"unlink: cannot unlink '{p.virtual}': "
                                      "Is a directory\n").encode())
    await ops.require(Operation.UNLINK)(accessor, p)
    return None, IOResult(writes={p.mount_path: b""})


BUILDER = Builder('unlink',
                  unlink,
                  write=True,
                  requirements=frozenset({Operation.UNLINK}))

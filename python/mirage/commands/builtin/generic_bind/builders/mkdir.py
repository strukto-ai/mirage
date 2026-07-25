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
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.mode import DEFAULT_DIR_MODE, parse_mode


async def mkdir(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    p: bool = False,
    v: bool = False,
    m: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["mkdir"])
    parents = p or fl.as_bool("parents")
    verbose = v or fl.as_bool("verbose")
    mode_text = m or fl.as_str("mode")
    if not ops.is_mounted(accessor) or not paths:
        raise ValueError("mkdir: missing operand")
    mode: int | None = None
    if mode_text is not None:
        # Symbolic clauses build on what mirage renders for a new
        # directory, since there is no umask to subtract from.
        mode = parse_mode(mode_text, DEFAULT_DIR_MODE)
        if mode is None:
            raise ValueError(f"mkdir: invalid mode '{mode_text}'")
        if ops.set_attrs is None:
            raise NotImplementedError(
                "mkdir: --mode is not supported on this backend")
    mkdir_fn = ops.require(Operation.MKDIR)
    paths = await ops.resolve_glob(accessor, paths, index)
    lines: list[str] = []
    for path in paths:
        await mkdir_fn(accessor, path, parents=parents)
        if mode is not None and ops.set_attrs is not None:
            # -m applies to the named directory only; any parents made by
            # -p keep the default mode (GNU).
            await ops.set_attrs(accessor, path, mode=mode)
        if verbose:
            lines.append(f"mkdir: created directory '{path.virtual}'")
    output = ("\n".join(lines) + "\n").encode() if lines else None
    return output, IOResult()


BUILDER = Builder('mkdir',
                  mkdir,
                  write=True,
                  requirements=frozenset({Operation.MKDIR}))

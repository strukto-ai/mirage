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
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.sed import sed_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.provision import make_sed_provision
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _resolve(ops: CommandIO, accessor: Accessor, index: IndexCacheStore,
                   targets: list[PathSpec]) -> list[PathSpec]:
    return await ops.resolve_glob(accessor, targets, index)


async def sed(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
              texts: list[str],
              opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    return await sed_generic(
        paths, list(texts), opts, partial(_resolve, ops, accessor, opts.index),
        bound_op(ops.read_bytes, accessor, opts.index),
        (partial(ops.write, accessor) if ops.write is not None else None))


BUILDER = Builder('sed', sed, make_sed_provision)

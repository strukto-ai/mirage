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
from mirage.commands.builtin.generic.mktemp import mktemp_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.commands.config import CommandOpts
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def mktemp(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    return await mktemp_generic(
        paths, list(texts), CommandOpts(stdin=stdin, flags=flags),
        partial(ops.require(Operation.MKDIR), accessor),
        partial(ops.require(Operation.WRITE), accessor))


BUILDER = Builder('mktemp',
                  mktemp,
                  write=True,
                  requirements=frozenset({Operation.MKDIR, Operation.WRITE}))

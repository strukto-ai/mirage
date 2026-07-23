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
from mirage.commands.builtin.generic.mktemp import mktemp as generic_mktemp
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def mktemp(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    d: bool = False,
    p: PathSpec | None = None,
    t: bool = False,
    u: bool = False,
    q: bool = False,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["mktemp"])
    tmpdir_flag = fl.raw("tmpdir")
    tmpdir: str | PathSpec | None
    if isinstance(tmpdir_flag, (str, PathSpec)):
        tmpdir = tmpdir_flag
    elif tmpdir_flag is True:
        tmpdir = "/tmp"
    else:
        tmpdir = p
    return await generic_mktemp(
        *texts,
        mkdir_fn=partial(ops.require(Operation.MKDIR), accessor),
        write_bytes_fn=partial(ops.require(Operation.WRITE), accessor),
        d=d or fl.as_bool("directory"),
        p=tmpdir,
        t=t,
        dry_run=u or fl.as_bool("dry_run"),
        suffix=fl.as_str("suffix") or "",
        quiet=q or fl.as_bool("quiet"),
    )


BUILDER = Builder('mktemp',
                  mktemp,
                  write=True,
                  requirements=frozenset({Operation.MKDIR, Operation.WRITE}))

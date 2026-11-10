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
from mirage.commands.builtin.generic.zcompare import zcompare_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    dir_aware_stream,
)
from mirage.commands.config import CommandFn, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _comparer(command: str) -> CommandFn:
    async def compare(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        files = command_files(ctx, paths)
        resolved = await files.resolve_glob(paths)
        return await zcompare_generic(
            resolved,
            list(texts),
            ctx,
            dir_aware_stream(files, ctx),
            files.stat,
            files.readdir,
            command,
        )

    return compare


BUILDERS = tuple(
    GenericCommand(name, _comparer(name), read=True, streams=True)
    for name in ("zcmp", "zdiff")
)

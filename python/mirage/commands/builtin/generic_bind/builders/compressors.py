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
from mirage.commands.builtin.generic.bzip2 import bzip2_generic
from mirage.commands.builtin.generic.compressor import (
    CompressorFiles,
    compressor_facts,
)
from mirage.commands.builtin.generic.xz import xz_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import link_resolver
from mirage.commands.config import CommandFn, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

GENERICS = {
    "xz": xz_generic,
    "unxz": xz_generic,
    "bzip2": bzip2_generic,
    "bunzip2": bzip2_generic,
}


def _compressor(command: str) -> CommandFn:
    async def compress(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        files = command_files(ctx, paths)
        resolved = await files.resolve_glob(paths) if paths else []
        return await GENERICS[command](
            resolved,
            ctx,
            CompressorFiles(
                read=files.read,
                write=files.write,
                unlink=files.unlink,
                stat=files.stat,
                set_attrs=files.set_attrs,
            ),
            link_resolver(ctx),
            command,
        )

    return compress


BUILDERS = tuple(
    GenericCommand(name, _compressor(name), write=True, facts=compressor_facts)
    for name in GENERICS
)

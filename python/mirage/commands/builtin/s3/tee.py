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

from mirage.accessor.s3 import S3Accessor
from mirage.commands.builtin.generic.tee import tee as generic_tee
from mirage.commands.builtin.s3.io import resolve_glob
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.stream import read_stream
from mirage.core.s3.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tee", resource="s3", spec=SPECS["tee"], write=True)
async def tee(accessor: S3Accessor, paths: list[PathSpec], texts: list[str],
              opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    paths = await resolve_glob(accessor, paths, opts.index)
    # The wrapper is wiring only: every flag semantic, the write to each
    # operand and the append fallback live in the generic. This file used
    # to restate them and wrote only paths[0].
    return await generic_tee(paths,
                             texts,
                             read_stream=partial(read_stream,
                                                 accessor,
                                                 index=opts.index),
                             write_bytes=partial(write_bytes, accessor),
                             stdin=opts.stdin,
                             flags=opts.flags)

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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.commands.builtin.generic_bind.adapter import scan_io
from mirage.commands.builtin.generic_bind.search import run_search
from mirage.commands.builtin.mongodb.io import IO
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


# The $regex push-down prints each matching document as a whole line;
# pushdown_operand defers shaping flags and multi-operand lines to the
# generic scan, which streams documents rather than reading whole
# collections.
@command("grep", vfs="mongodb", spec=SPECS["grep"])
async def grep(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    scan, _ = scan_io(IO, opts.ns, opts.mount_prefix)
    return await run_search(scan, "grep", accessor, paths, texts, opts)

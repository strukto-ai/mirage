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
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

BOTH = b"sync: cannot specify both --data and --file-system\n"
NO_DATA = b"sync: --data needs at least one argument\n"


@command("sync", vfs=None, spec=SPECS["sync"])
async def sync(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Every write has landed by the time its command ends, so only the
    operands are checked.
    """
    fl = FlagView(ctx.flags, spec=SPECS["sync"])
    if fl.as_bool("data") and fl.as_bool("file_system"):
        return None, IOResult(exit_code=1, stderr=BOTH)
    if fl.as_bool("data") and not paths:
        return None, IOResult(exit_code=1, stderr=NO_DATA)
    err: list[str] = []
    if ctx.vfs is not None:
        for path in paths:
            try:
                await ctx.vfs.stat(path)
            except FS_ERRORS as exc:
                err.append(
                    f"sync: error opening '{quote_text(path.raw_path)}': "
                    f"{fs_strerror(exc)}\n"
                )
    if err:
        return None, IOResult(exit_code=1, stderr="".join(err).encode())
    return None, IOResult()

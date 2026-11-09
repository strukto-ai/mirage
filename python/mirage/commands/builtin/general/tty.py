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
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

NOT_A_TTY = b"not a tty\n"


@command("tty", vfs=None, spec=SPECS["tty"])
async def tty(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """A session has no terminal, so ``tty`` always says so and exits 1."""
    if texts:
        raise extra_operand_error("tty", texts[0])
    silent = FlagView(ctx.flags, spec=SPECS["tty"]).as_bool("silent")
    return None if silent else NOT_A_TTY, IOResult(exit_code=1)

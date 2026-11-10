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
import re

from mirage.accessor.base import Accessor
from mirage.commands.builtin.constants import CPUS, HOSTNAME
from mirage.commands.builtin.utils.threads import thread_limit
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

DIGITS = re.compile(r"[0-9]+")


@command("nproc", vfs=None, spec=SPECS["nproc"])
async def nproc(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Print the processors a session has, less ``--ignore``; ``--all``
    leaves out the OpenMP limits. Pinned against coreutils 9.7.
    """
    fl = FlagView(ctx.flags, spec=SPECS["nproc"])
    ignore = fl.as_str("ignore")
    if ignore is not None and DIGITS.fullmatch(ignore) is None:
        line = f"nproc: invalid number: '{quote_text(ignore)}'\n"
        return None, IOResult(exit_code=1, stderr=line.encode())
    if texts:
        raise extra_operand_error("nproc", texts[0])
    machine = fl.as_str("machine")
    if machine is not None and machine != HOSTNAME:
        line = f"nproc: {quote_text(machine)}: no such machine\n"
        return None, IOResult(exit_code=1, stderr=line.encode())
    count = CPUS
    if not fl.as_bool("all"):
        count = thread_limit(ctx.env or {}, CPUS)
    return f"{max(1, count - int(ignore or 0))}\n".encode(), IOResult()

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
from mirage.commands.builtin.general.hostname import HOSTNAME
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# What uname reports, in GNU's print order and keyed by each option's
# dest. Mirage is no kernel: it answers as the GNU/Linux userland its
# commands implement, the way gVisor and WSL1 answer `Linux` for the
# interface they emulate, and names itself in the node, release and
# version fields. Fixed, so every host (the browser included) prints
# the same line and no host detail leaks.
UNAME_FIELDS = (
    ("kernel_name", "Linux"),
    ("nodename", HOSTNAME),
    ("kernel_release", "mirage"),
    ("kernel_version", "#1 Mirage"),
    ("machine", "x86_64"),
    ("processor", "unknown"),
    ("hardware_platform", "unknown"),
    ("operating_system", "GNU/Linux"),
)
UNKNOWN = "unknown"


@command("uname", vfs=None, spec=SPECS["uname"])
async def uname(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``uname``: one field per option, in GNU's order, never the
    order typed.

    No option is ``-s``. ``-a`` prints every field except an ``unknown``
    processor or hardware platform, which only ``-p`` and ``-i`` without
    ``-a`` print, as GNU does. Pinned against coreutils 9.7.
    """
    fl = FlagView(opts.flags, spec=SPECS["uname"])
    if texts:
        raise extra_operand_error(CommandName.UNAME, texts[0])
    if fl.as_bool("all"):
        chosen = [value for _, value in UNAME_FIELDS if value != UNKNOWN]
    else:
        chosen = [value for dest, value in UNAME_FIELDS if fl.as_bool(dest)]
    if not chosen:
        chosen = [UNAME_FIELDS[0][1]]
    return (" ".join(chosen) + "\n").encode(), IOResult()

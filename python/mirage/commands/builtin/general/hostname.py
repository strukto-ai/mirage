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
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.usage import usage_exit_code, usage_hint
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# The one name every host answers with; uname -n prints it too.
HOSTNAME = "mirage"

# What each display option prints, as a Debian host with no DNS domain
# whose /etc/hosts maps its name to 127.0.1.1; None is the unset NIS
# domain.
DISPLAY: dict[str, str | None] = {
    "short": f"{HOSTNAME}\n",
    "fqdn": f"{HOSTNAME}\n",
    "long": f"{HOSTNAME}\n",
    "domain": "",
    "alias": "\n",
    "all_fqdns": "\n",
    "ip_address": "127.0.1.1\n",
    "all_ip_addresses": "\n",
    "yp": None,
    "nis": None,
}
NOT_ROOT = b"hostname: you must be root to change the host name\n"
NO_NIS_DOMAIN = b"hostname: Local domain name not set\n"
USAGE = f"Usage: {SYNOPSES['hostname']}\n{usage_hint('hostname')}\n"


@command("hostname", vfs=None, spec=SPECS["hostname"])
async def hostname(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """hostname 3.25 (Debian): the name uname -n prints, never the host's. The
    last display option wins, and setting a name is the refusal an unprivileged
    user gets. Misfit operands print the usage line and the ``--help`` hint,
    exit 255, where hostname dumps its whole help.
    """
    fl = FlagView(opts.flags, spec=SPECS["hostname"])
    typed = fl.typed_order(*DISPLAY)
    if len(texts) > 1 or (texts and typed):
        return None, IOResult(
            exit_code=usage_exit_code("hostname"), stderr=USAGE.encode()
        )
    if texts or fl.as_str("file") is not None:
        return None, IOResult(exit_code=1, stderr=NOT_ROOT)
    shown = DISPLAY[typed[-1] if typed else "short"]
    if shown is None:
        return NO_NIS_DOMAIN, IOResult(exit_code=1)
    return shown.encode(), IOResult()

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
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# The node name uname -n prints: the one name every host answers with.
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
# hostname 3.25's usage block, stderr and exit 255 for misfit operands.
USAGE = (
    "Usage: hostname [-b] {hostname|-F file}         set host name (from "
    "file)\n"
    "       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name\n"
    "       hostname                                 display host name\n\n"
    "       {yp,nis,}domainname {nisdomain|-F file}  set NIS domain name "
    "(from file)\n"
    "       {yp,nis,}domainname                      display NIS domain "
    "name\n\n"
    "       dnsdomainname                            display dns domain "
    "name\n\n"
    "       hostname -V|--version|-h|--help          print info and exit\n\n"
    "Program name:\n"
    "       {yp,nis,}domainname=hostname -y\n"
    "       dnsdomainname=hostname -d\n\n"
    "Program options:\n"
    "    -a, --alias            alias names\n"
    "    -A, --all-fqdns        all long host names (FQDNs)\n"
    "    -b, --boot             set default hostname if none available\n"
    "    -d, --domain           DNS domain name\n"
    "    -f, --fqdn, --long     long host name (FQDN)\n"
    "    -F, --file             read host name or NIS domain name from "
    "given file\n"
    "    -i, --ip-address       addresses for the host name\n"
    "    -I, --all-ip-addresses all addresses for the host\n"
    "    -s, --short            short host name\n"
    "    -y, --yp, --nis        NIS/YP domain name\n\n"
    "Description:\n"
    "   This command can get or set the host name or the NIS domain name. "
    "You can\n"
    "   also get the DNS domain or the FQDN (fully qualified domain name).\n"
    "   Unless you are using bind or NIS for host lookups you can change "
    "the\n"
    "   FQDN (Fully Qualified Domain Name) and the DNS domain name (which "
    "is\n"
    "   part of the FQDN) in the /etc/hosts file.\n"
)


@command("hostname", vfs=None, spec=SPECS["hostname"])
async def hostname(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """hostname 3.25 (Debian): the name uname -n prints, never the host's. The
    last display option wins, and setting a name is the refusal an unprivileged
    user gets.
    """
    fl = FlagView(opts.flags, spec=SPECS["hostname"])
    typed = fl.typed_order(*DISPLAY)
    if len(texts) > 1 or (texts and typed):
        return None, IOResult(exit_code=255, stderr=USAGE.encode())
    if texts or fl.as_str("file") is not None:
        return None, IOResult(exit_code=1, stderr=NOT_ROOT)
    shown = DISPLAY[typed[-1] if typed else "short"]
    if shown is None:
        return NO_NIS_DOMAIN, IOResult(exit_code=1)
    return shown.encode(), IOResult()

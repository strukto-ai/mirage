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

from mirage.commands.cli.builtin.gh.constants import BOOLEAN
from mirage.commands.spec.types import Argument

REPO = Argument(
    "-R",
    "--repo",
    help="Select another repository using the [HOST/]OWNER/REPO format",
)
JSON = Argument(
    "--json", metavar="fields", help="Output JSON with the specified fields"
)
JQ = Argument(
    "-q",
    "--jq",
    metavar="expression",
    help="Filter JSON output using a jq expression",
)
TEMPLATE = Argument(
    "-t",
    "--template",
    help='Format JSON output using a Go template; see "gh help formatting"',
)


def flag(
    short: str | None = None,
    long: str = "",
    description: str | None = None,
    metavar: str | None = None,
) -> Argument:
    """One of gh's boolean flags, which are pflag's.

    A bare ``--draft`` is true, and ``--draft=true`` or ``--draft=false``
    spells the value out, which is how a script turns one off. The
    shorts still cluster (``-sd``). Read one with ``gh_bool``.

    Args:
        short (str | None): the short spelling.
        long (str): the long spelling.
        description (str | None): the help line.
        metavar (str | None): the value's name in the usage block.
    """
    names = (short, long) if short is not None else (long,)
    return Argument(
        *names,
        nargs="?",
        attached_only=True,
        short_value=False,
        choices=BOOLEAN,
        metavar=metavar,
        help=description,
    )

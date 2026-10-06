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
from mirage.commands.builtin.utils.identity import (
    UNKNOWN_NAME,
    identity_of,
)
from mirage.commands.config import CommandOpts, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

CONTEXT = "id: --context (-Z) works only on an SELinux-enabled kernel\n"
ONE_CHOICE = 'id: cannot print "only" of more than one choice\n'
NAMES_NEED = "id: printing only names or real IDs requires -u, -g, or -G\n"
ZERO_DEFAULT = "id: option --zero not permitted in default format\n"


@command("id", vfs=None, spec=SPECS["id"])
async def id_cmd(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``id`` over mirage's identity: the workspace user, and the session's
    profile as its group. Mirage has names but no numbers, so every id slot
    holds the name, ``-`` for a part nobody claimed; errors and their order are
    coreutils 9.7's.
    """
    fl = FlagView(opts.flags, spec=SPECS["id"])
    if fl.as_bool("context"):
        return None, IOResult(exit_code=1, stderr=CONTEXT.encode())
    only = [d for d in ("user", "group", "groups") if fl.as_bool(d)]
    if len(only) > 1:
        return None, IOResult(exit_code=1, stderr=ONE_CHOICE.encode())
    use_name = fl.as_bool("name")
    zero = fl.as_bool("zero")
    if not only and (use_name or fl.as_bool("real")):
        return None, IOResult(exit_code=1, stderr=NAMES_NEED.encode())
    if not only and zero:
        return None, IOResult(exit_code=1, stderr=ZERO_DEFAULT.encode())
    identity = identity_of(opts)
    user = identity.user or UNKNOWN_NAME
    group = identity.profile or UNKNOWN_NAME
    end = "\0" if zero else "\n"
    out: list[str] = []
    err: list[str] = []
    names: list[str | None] = [*texts] if texts else [None]
    for name in names:
        if name is not None and name != identity.user:
            why = ": No such file or directory" if name == "" else ""
            err.append(f"id: '{quote_text(name)}': no such user{why}\n")
            continue
        if not only:
            out.append(f"uid={user} gid={group} groups={group}{end}")
            continue
        kind = "user" if only[0] == "user" else "group"
        known = identity.user if kind == "user" else identity.profile
        if use_name and known is None:
            err.append(f"id: cannot find name for {kind} ID\n")
        many = zero and only[0] == "groups" and len(texts) > 1
        out.append(
            (user if kind == "user" else group) + ("\0\0" if many else end)
        )
    return "".join(out).encode() or None, IOResult(
        exit_code=1 if err else 0, stderr="".join(err).encode()
    )

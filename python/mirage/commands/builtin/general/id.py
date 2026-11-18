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
    Account,
    find_user,
    identity_of,
    own_account,
    session_gid,
    session_uid,
)
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

CONTEXT = "id: --context (-Z) works only on an SELinux-enabled kernel\n"
ONE_CHOICE = 'id: cannot print "only" of more than one choice\n'
NAMES_NEED = "id: printing only names or real IDs requires -u, -g, or -G\n"
ZERO_DEFAULT = "id: option --zero not permitted in default format\n"


def _named(number: int, name: str | None) -> str:
    return str(number) if name is None else f"{number}({name})"


@command("id", vfs=None, spec=SPECS["id"])
async def id_cmd(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``id`` over the session's user database: root for a session
    with no profile, the profile's user (uid 1000) for a named one, and
    uid 1000 with no name for a document passed without one. Each user
    is in its own group alone; errors and their order are coreutils
    9.7's.
    """
    fl = FlagView(ctx.flags, spec=SPECS["id"])
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
    identity = identity_of(ctx)
    end = "\0" if zero else "\n"
    out: list[str] = []
    err: list[str] = []
    rows: list[tuple[int, str | None, int, str | None]] = []
    names: list[str | None] = [*texts] if texts else [None]
    for name in names:
        found: Account | None
        if name is None:
            found = own_account(identity)
            if found is None:
                rows.append(
                    (session_uid(identity), None, session_gid(identity), None)
                )
                continue
        else:
            found = find_user(identity, name)
            if found is None:
                why = ": No such file or directory" if name == "" else ""
                err.append(f"id: '{quote_text(name)}': no such user{why}\n")
                continue
        rows.append((found.uid, found.name, found.gid, found.group))
    many = zero and only == ["groups"] and len(texts) > 1
    for uid, user, gid, group in rows:
        if not only:
            out.append(
                f"uid={_named(uid, user)} gid={_named(gid, group)} "
                f"groups={_named(gid, group)}{end}"
            )
            continue
        kind = "user" if only[0] == "user" else "group"
        number, label = (uid, user) if kind == "user" else (gid, group)
        if use_name and label is None:
            err.append(f"id: cannot find name for {kind} ID {number}\n")
        shown = label if use_name and label is not None else str(number)
        out.append(shown + ("\0\0" if many else end))
    return "".join(out).encode() or None, IOResult(
        exit_code=1 if err else 0, stderr="".join(err).encode()
    )

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
    identity_of,
    own_account,
    session_gid,
    user_named,
)
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("groups", vfs=None, spec=SPECS["groups"])
async def groups(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Print each user's groups, as ``id -Gn`` names them: every user is
    in its own group alone, and an operand is a name, never a uid. With
    no operand, the session's, by number where the user database holds
    no name for it.
    """
    identity = identity_of(ctx)
    if not texts:
        own = own_account(identity)
        if own is not None:
            return f"{own.group}\n".encode(), IOResult()
        gid = session_gid(identity)
        return f"{gid}\n".encode(), IOResult(
            exit_code=1,
            stderr=f"groups: cannot find name for group ID {gid}\n".encode(),
        )
    out: list[str] = []
    err: list[str] = []
    for name in texts:
        found = user_named(identity, name)
        if found is None:
            err.append(f"groups: '{quote_text(name)}': no such user\n")
        else:
            out.append(f"{name} : {found.group}\n")
    return "".join(out).encode() or None, IOResult(
        exit_code=1 if err else 0, stderr="".join(err).encode() or None
    )

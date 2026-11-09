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
from mirage.commands.builtin.utils.identity import UNKNOWN_NAME, identity_of
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
    """Print the session's one group, its profile, as ``id`` does."""
    profile = identity_of(ctx).profile
    if not texts:
        return f"{profile or UNKNOWN_NAME}\n".encode(), IOResult()
    out: list[str] = []
    err: list[str] = []
    for name in texts:
        if name == profile:
            out.append(f"{name} : {name}\n")
        else:
            err.append(f"groups: '{quote_text(name)}': no such user\n")
    return "".join(out).encode() or None, IOResult(
        exit_code=1 if err else 0, stderr="".join(err).encode() or None
    )

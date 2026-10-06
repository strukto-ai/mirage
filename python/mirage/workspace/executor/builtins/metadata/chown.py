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

from mirage.commands.spec.usage import missing_operand_error
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.metadata.metadata import (
    change_owner,
    parse_owner,
)
from mirage.workspace.executor.builtins.shared import fail, parse_line
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState


async def handle_chown(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """chown OWNER[:GROUP] FILE...: set ownership via setattr.

    Ownership is stored, not enforced (mirage has no user model); names
    are kept verbatim, numeric ids become ints. ``-R`` walks the
    operand's subtree; POSIX gives it an implicit ``-P``, so a symlink
    is changed itself rather than followed, whether it is the operand
    or reached during the walk.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): session whose cwd resolves operands.
        args (list[str | PathSpec]): args after the command name.
    """
    parsed, fl, refused = parse_line("chown", args, session.cwd)
    if refused is not None:
        return refused
    if not parsed.texts or not parsed.paths:
        last = parsed.texts[0] if parsed.texts else None
        error = missing_operand_error("chown", last)
        return fail("chown", f"{error}\n", error.exit_code)
    owner_text = parsed.texts[0]
    uid, gid = parse_owner(owner_text)
    if uid is None and gid is None:
        return fail("chown", f"chown: invalid spec: '{owner_text}'\n", 1)
    return await change_owner(
        namespace, dispatch, session, "chown", fl, parsed.paths, uid, gid
    )

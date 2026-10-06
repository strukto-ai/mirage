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
    parse_group,
)
from mirage.workspace.executor.builtins.shared import fail, parse_line
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState


async def handle_chgrp(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """chgrp GROUP FILE...: set group ownership via setattr.

    The group half of chown: writes gid and leaves uid untouched. Group is
    stored, not enforced (mirage has no group model); a name is kept
    verbatim, a numeric id becomes an int. ``-h`` writes the link node's
    own group, and ``-R`` walks the subtree under the same implicit
    ``-P`` as chown.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): session whose cwd resolves operands.
        args (list[str | PathSpec]): args after the command name.
    """
    parsed, fl, refused = parse_line("chgrp", args, session.cwd)
    if refused is not None:
        return refused
    if not parsed.texts or not parsed.paths:
        last = parsed.texts[0] if parsed.texts else None
        error = missing_operand_error("chgrp", last)
        return fail("chgrp", f"{error}\n", error.exit_code)
    group_text = parsed.texts[0]
    gid = parse_group(group_text)
    if gid is None:
        return fail("chgrp", f"chgrp: invalid group: '{group_text}'\n", 1)
    return await change_owner(
        namespace, dispatch, session, "chgrp", fl, parsed.paths, None, gid
    )

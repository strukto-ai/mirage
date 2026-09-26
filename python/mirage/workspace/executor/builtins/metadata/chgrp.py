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

from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.metadata.metadata import (
    apply_attrs, apply_link_attrs, parse_group, resolve_operand, walk_owned)
from mirage.workspace.executor.builtins.shared import (expand_operands, fail,
                                                       finish, operand_text,
                                                       split_value_flags)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace


async def handle_chgrp(
    namespace: Namespace,
    dispatch: DispatchFn,
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
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvfh", "")
    if bad is not None:
        return fail("chgrp", f"chgrp: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chgrp", "chgrp: missing operand\n", 2)
    group_text = operand_text(operands[0])
    gid = parse_group(group_text)
    if gid is None:
        return fail("chgrp", f"chgrp: invalid group: '{group_text}'\n", 1)

    recursive = "R" in flags
    no_deref = recursive or "h" in flags
    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        if no_deref and namespace.is_link(target.virtual):
            await apply_link_attrs(dispatch, "chgrp", target, errors, gid=gid)
            continue
        found = await resolve_operand(namespace, dispatch, "chgrp", target,
                                      errors)
        if found is None:
            continue
        resolved, stat = found
        if recursive:
            paths, links = await walk_owned(namespace, dispatch, resolved,
                                            stat)
        else:
            paths, links = [resolved], []
        for path in paths:
            await apply_attrs(dispatch, "chgrp", path, errors, gid=gid)
        for link in links:
            await apply_link_attrs(dispatch,
                                   "chgrp",
                                   PathSpec.from_str_path(link),
                                   errors,
                                   gid=gid)
    return finish("chgrp", errors)

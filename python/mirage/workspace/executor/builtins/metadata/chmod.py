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
from mirage.types import FileType, PathSpec
from mirage.utils.mode import DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parse_chmod
from mirage.workspace.executor.builtins.metadata.metadata import (
    apply_attrs, resolve_operand, walk_stats)
from mirage.workspace.executor.builtins.shared import (expand_operands, fail,
                                                       finish, operand_text,
                                                       split_value_flags)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace


async def handle_chmod(
    namespace: Namespace,
    dispatch: DispatchFn,
    args: list[str | PathSpec],
) -> Result:
    """chmod MODE FILE...: set permission bits via setattr.

    Follows symlinks (GNU chmod always dereferences). Stored, not
    enforced: mount mode does real access control. ``-R`` walks the
    operand's subtree and applies the mode to every entry, skipping
    symlinks the way GNU does (a traversed link changes neither itself
    nor its referent); a command-line link to a directory is still
    followed and its target walked.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvf", "")
    if bad is not None:
        return fail("chmod", f"chmod: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chmod", "chmod: missing operand\n", 2)
    mode_text = operand_text(operands[0])
    if parse_chmod(mode_text, 0) is None:
        return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)

    recursive = "R" in flags
    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        found = await resolve_operand(namespace, dispatch, "chmod", target,
                                      errors)
        if found is None:
            continue
        resolved, stat = found
        if recursive:
            entries = await walk_stats(namespace, dispatch, resolved, stat)
        else:
            entries = [(resolved, stat)]
        for path, path_stat in entries:
            # Backends without a mode default to what ls renders: 755 for
            # directories, 644 for files (symbolic clauses build on this).
            if path_stat.mode is not None:
                current = path_stat.mode
            else:
                current = (DEFAULT_DIR_MODE if path_stat.type
                           == FileType.DIRECTORY else DEFAULT_FILE_MODE)
            new_mode = parse_chmod(mode_text, current)
            if new_mode is None:
                return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n",
                            1)
            await apply_attrs(dispatch, "chmod", path, errors, mode=new_mode)
    return finish("chmod", errors)

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

import posixpath

from mirage.io import IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.utils.path import CycleError
from mirage.workspace.executor.builtins.links.probe import path_exists
from mirage.workspace.executor.builtins.shared import (abs_path, fail,
                                                       split_flags)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_readlink(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """Print a symlink's target, GNU readlink semantics.

    The three canonicalizing flags differ only in how much of the
    resolved path has to exist: ``-m`` requires nothing, ``-f`` requires
    every component but the last, and ``-e`` requires all of it. A path
    that falls short prints nothing and exits 1.

    Args:
        namespace (Namespace): addressing authority holding the links.
        dispatch (DispatchFn): op dispatcher, used for the existence check.
        session (SessionState): current session, for the working directory.
        args (list[str | PathSpec]): the command's words after the name.
    """
    flags, operands = split_flags(args, "fenm")
    if not operands:
        return fail("readlink", "readlink: missing operand\n")
    canonical = any(f in flags for f in "fem")
    lines: list[str] = []
    exit_code = 0
    for op in operands:
        abs_op = abs_path(op, session.cwd)
        if canonical:
            # -f/-e/-m canonicalize: resolve every symlink (including a
            # trailing one) and normalize the path, GNU realpath-style.
            # A link operand still clears the op door first: -m probes
            # nothing, so without this a scoped session read an
            # ungranted link's target out of the resolved path.
            if namespace.is_link(abs_op):
                try:
                    await dispatch("readlink", PathSpec.from_str_path(abs_op))
                except OSError:
                    exit_code = 1
                    continue
            try:
                resolved = posixpath.normpath(namespace.follow(abs_op))
            except CycleError:
                exit_code = 1
                continue
            probe = (resolved if "e" in flags else
                     posixpath.dirname(resolved) if "f" in flags else None)
            if probe is not None and not await path_exists(dispatch, probe):
                exit_code = 1
                continue
            lines.append(resolved)
            continue
        # The link entry is namespace state behind the op door: session
        # grants and admission policies decide whether this session may
        # read the target at all. EINVAL (not a link) and a refusal both
        # land on GNU readlink's silent exit 1.
        try:
            target, _ = await dispatch("readlink",
                                       PathSpec.from_str_path(abs_op))
        except OSError:
            exit_code = 1
            continue
        lines.append(target)
    if "n" in flags:
        text = "".join(lines)
    else:
        text = "".join(line + "\n" for line in lines)
    return (text.encode() if text else None, IOResult(exit_code=exit_code),
            ExecutionNode(command="readlink", exit_code=exit_code))

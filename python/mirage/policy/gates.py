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

import errno
from typing import Any

from mirage.policy.errors import PolicyDenied
from mirage.policy.policies import Policies
from mirage.policy.types import (Deny, ExecuteContext, ExecuteResultContext,
                                 OpsContext, OpsResultContext, Route)
from mirage.types import Limit, PathSpec


async def pre_execute_gate(
        policies: Policies,
        ctx: ExecuteContext) -> tuple[Deny | None, Route | None]:
    """Fire pre_execute before a typed line runs.

    Returns the first Deny (the line is refused, exit 126) or the first
    Route (the line is placed on that runtime); both None passes the
    line to entry scripts and static bindings.

    Args:
        policies (Policies): the workspace's policies.
        ctx (ExecuteContext): the parsed line's facts.
    """
    if not policies.wants("pre_execute"):
        return None, None
    return await policies.pre_execute(ctx)


async def pre_ops_gate(policies: Policies, op: str, path: PathSpec,
                       write: bool, prefix: str) -> None:
    """Fire pre_ops at an op door; a Deny becomes EACCES.

    The one seam helper both doors (the ops facade and the dispatcher)
    call, so a refusal is byte-identical however the mount is reached:
    PermissionError with errno EACCES and the virtual path as filename,
    which the shell renders as "<cmd>: <path>: Permission denied" and
    FUSE translates to -EACCES.

    Args:
        policies (Policies): the workspace's admission policies.
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
    """
    if not policies.wants("pre_ops"):
        return
    deny = await policies.pre_ops(
        OpsContext(op=op, path=path, write=write, prefix=prefix))
    if deny is not None:
        raise PolicyDenied(errno.EACCES, deny.message.rstrip("\n"),
                           path.virtual)


async def post_ops_gate(policies: Policies, op: str, path: PathSpec,
                        write: bool, prefix: str, result: Any) -> Limit | None:
    """Fire post_ops at an op door; a Deny suppresses the result.

    Returns the merged Limit bound (tightest per field across every
    opining policy) for the door to apply to a byte-producing result,
    or None when no policy bounds this op.

    Args:
        policies (Policies): the workspace's admission policies.
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutated the mount.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result, offered to the hooks.
    """
    if not policies.wants("post_ops"):
        return None
    deny, bound = await policies.post_ops(
        OpsResultContext(op=op,
                         path=path,
                         write=write,
                         prefix=prefix,
                         result=result))
    if deny is not None:
        raise PolicyDenied(errno.EACCES, deny.message.rstrip("\n"),
                           path.virtual)
    return bound


async def post_execute_gate(
        policies: Policies,
        ctx: ExecuteResultContext) -> tuple[Deny | None, Limit | None]:
    """Fire post_execute at the workspace boundary.

    Returns the fail-closed Deny (a raising policy) if any, and the
    merged Limit bound for the boundary to enforce on the line's
    output stream.

    Args:
        policies (Policies): the workspace's policies.
        ctx (ExecuteResultContext): the finished line's facts.
    """
    if not policies.wants("post_execute"):
        return None, None
    return await policies.post_execute(ctx)

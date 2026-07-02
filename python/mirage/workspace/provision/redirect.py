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

from typing import Any

from mirage.provision import Precision, ProvisionResult
from mirage.shell.types import RedirectKind
from mirage.types import PathSpec
from mirage.workspace.mount import MountRegistry
from mirage.workspace.provision.command import handle_command_provision
from mirage.workspace.provision.rollup import rollup_list
from mirage.workspace.session import Session


async def handle_redirect_provision(
    provision_node_fn,
    registry: MountRegistry,
    command: Any,
    targets: list[tuple[RedirectKind, PathSpec]],
    session: Session,
) -> ProvisionResult:
    """Plan a redirect: the inner command plus the redirect I/O.

    A `< file` source is read fully, so it is planned as a cat of the
    source (exact when the size resolves). A `>`/`>>` target writes
    the inner command's stdout, whose size is only knowable when the
    inner read total is: the write is bracketed 0..inner read high as
    a RANGE, or UNKNOWN when the inner plan has no usable ceiling.
    stderr redirects, fd duplications, /dev targets, and heredocs are
    filtered out by the caller and cost nothing.

    Args:
        provision_node_fn: recursive planner.
        registry (MountRegistry): mount registry for the source read.
        command (Any): the redirected command node.
        targets (list[tuple[RedirectKind, PathSpec]]): resolved
            stdin/stdout redirect targets on mounts.
        session (Session): shell session state.
    """
    inner = await provision_node_fn(command, session)
    if not targets:
        return inner
    children = [inner]
    for kind, target in targets:
        if kind == RedirectKind.STDIN:
            children.append(await
                            handle_command_provision(registry, ["cat", target],
                                                     session))
            continue
        if inner.network_read_high > 0:
            children.append(
                ProvisionResult(
                    network_write_low=0,
                    network_write_high=inner.network_read_high,
                    precision=Precision.RANGE,
                ))
        else:
            children.append(ProvisionResult(precision=Precision.UNKNOWN))
    return rollup_list(";", children)

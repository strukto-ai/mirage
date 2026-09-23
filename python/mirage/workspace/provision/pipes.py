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

from mirage.provision import ProvisionResult
from mirage.provision.rollup import rollup_list, rollup_pipe
from mirage.workspace.session import SessionState


async def handle_pipe_provision(
    provision_node_fn,
    commands: list[Any],
    session: SessionState,
) -> ProvisionResult:
    """Plan a pipe: all commands run."""
    children = []
    for cmd in commands:
        children.append(await provision_node_fn(cmd, session))
    return rollup_pipe(children)


async def handle_connection_provision(
    provision_node_fn,
    left: Any,
    op: str,
    right: Any,
    session: SessionState,
) -> ProvisionResult:
    """Plan &&, ||"""
    children = []
    children.append(await provision_node_fn(left, session))
    children.append(await provision_node_fn(right, session))
    return rollup_list(str(op), children)

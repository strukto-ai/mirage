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
from mirage.workspace.provision.rollup import rollup_list
from mirage.workspace.session import Session


async def _plan_body(provision_node_fn, body: list,
                     session) -> ProvisionResult:
    """Plan a multi-statement body."""
    children = []
    for cmd in body:
        children.append(await provision_node_fn(cmd, session))
    if not children:
        return ProvisionResult(precision=Precision.EXACT)
    if len(children) == 1:
        return children[0]
    return rollup_list(";", children)


async def handle_if_provision(
    provision_node_fn,
    branches: list[tuple[Any, Any]],
    else_body: Any | None,
    session: Session,
) -> ProvisionResult:
    """Plan an if: range between branches."""
    children = []
    for condition, body in branches:
        children.append(await provision_node_fn(condition, session))
        children.append(await provision_node_fn(body, session))
    if else_body is not None:
        children.append(await provision_node_fn(else_body, session))
    return rollup_list("||", children)


async def handle_for_provision(
    provision_node_fn,
    body: list,
    n: int,
    session: Session,
) -> ProvisionResult:
    """Plan a for loop: body cost x iteration count."""
    result = await _plan_body(provision_node_fn, body, session)
    return result.scaled(n, command="for")


async def handle_while_provision(
    provision_node_fn,
    body: list,
    session: Session,
) -> ProvisionResult:
    """Plan while: unknown iterations."""
    result = await _plan_body(provision_node_fn, body, session)
    result.precision = Precision.UNKNOWN
    return result

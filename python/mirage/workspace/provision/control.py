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


async def _plan_body(provision_node_fn, body: list[Any],
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


async def handle_function_provision(
    provision_node_fn,
    name: str,
    body: list[Any],
    planning: set[str],
    session: Session,
) -> ProvisionResult:
    """Plan a shell function call: the body's cost.

    Recursive functions would loop the planner, so a function already
    being planned reports UNKNOWN instead of recursing again.

    Args:
        provision_node_fn: recursive planner.
        name (str): function name.
        body (list): function body statement nodes.
        planning (set[str]): names currently being planned (guard).
        session (Session): shell session state.
    """
    if name in planning:
        return ProvisionResult(command=name, precision=Precision.UNKNOWN)
    planning.add(name)
    try:
        result = await _plan_body(provision_node_fn, body, session)
    finally:
        planning.discard(name)
    if not result.command:
        result.command = name
    return result


async def handle_if_provision(
    provision_node_fn,
    branches: list[tuple[Any, Any]],
    else_body: Any | None,
    session: Session,
) -> ProvisionResult:
    """Plan an if: branches bracket as alternatives.

    Taking branch i evaluates conditions 1..i plus body i, so each
    alternative sums its condition ladder with its body. The else (or,
    without one, the fall-through) still pays every condition.
    """
    cond_costs: list[ProvisionResult] = []
    children = []
    for condition, body in branches:
        cond_costs.append(await provision_node_fn(condition, session))
        body_result = await _plan_body(provision_node_fn, body, session)
        children.append(rollup_list(";", cond_costs + [body_result]))
    else_result = (await _plan_body(provision_node_fn, else_body, session)
                   if else_body is not None else ProvisionResult(
                       precision=Precision.EXACT))
    children.append(rollup_list(";", cond_costs + [else_result]))
    return rollup_list("||", children)


async def handle_for_provision(
    provision_node_fn,
    body: list[Any],
    n: int,
    session: Session,
) -> ProvisionResult:
    """Plan a for loop: body cost x iteration count."""
    result = await _plan_body(provision_node_fn, body, session)
    return result.scaled(n, command="for")


async def handle_while_provision(
    provision_node_fn,
    body: list[Any],
    session: Session,
) -> ProvisionResult:
    """Plan while: unknown iterations."""
    result = await _plan_body(provision_node_fn, body, session)
    result.precision = Precision.UNKNOWN
    return result

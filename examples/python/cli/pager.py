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

import asyncio
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from mirage import (CLIInvocation, CLISpec, Operand, Option, RAMResource,
                    Workspace)
from mirage.io import IOResult


class PagerConfig(BaseModel):
    """Configuration belonging to one installed account."""
    account: Literal["engineering", "support"]


@dataclass
class Incident:
    summary: str
    acknowledged_by: str | None = None


# A real CLI would construct its service client from inv.config. This
# deterministic service keeps the example runnable without credentials or
# network access while preserving the same per-account semantics.
INCIDENTS: dict[str, dict[str, Incident]] = {
    "engineering": {
        "INC-101": Incident("Database latency"),
    },
    "support": {
        "INC-202": Incident("Checkout retries"),
    },
}


async def list_incidents(
        inv: CLIInvocation[PagerConfig]) -> tuple[bytes, IOResult]:
    incidents = INCIDENTS[inv.config.account]
    lines = []
    for incident_id, incident in sorted(incidents.items()):
        state = ("open" if incident.acknowledged_by is None else
                 f"acknowledged-by={incident.acknowledged_by}")
        lines.append(
            f"[{inv.config.account}] {incident_id} {state} {incident.summary}")
    return ("\n".join(lines) + "\n").encode(), IOResult()


# A leaf is a plain function or a coroutine function, whichever its body
# needs: the executor awaits whatever it returns, so a handler that never
# awaits is not made async for the executor's sake, and one that raises
# before any await is refused exactly like one that raises after.
def acknowledge(
        inv: CLIInvocation[PagerConfig]) -> tuple[bytes | None, IOResult]:
    # Operand.required is enforced by the executor only under the CLAP
    # dialect; an argparse-style leaf words its own missing-operand refusal.
    if not inv.texts:
        raise ValueError("INCIDENT_ID is required")
    incident_id = inv.texts[0]
    by = inv.flags["by"]
    if not isinstance(by, str):
        raise TypeError("--by must be a string")
    incident = INCIDENTS[inv.config.account].get(incident_id)
    if incident is None:
        return None, IOResult(
            exit_code=1,
            stderr=f"pager: unknown incident {incident_id}\n".encode(),
        )
    incident.acknowledged_by = by
    message = f"[{inv.config.account}] acknowledged {incident_id} by {by}\n"
    return message.encode(), IOResult()


PAGER = CLISpec(
    name="pager",
    description="Task-specific incident CLI",
    config_model=PagerConfig,
    subcommands=(
        CLISpec(
            name="list",
            description="List incidents for this installed account",
            fn=list_incidents,
        ),
        CLISpec(
            name="ack",
            description="Acknowledge an incident",
            fn=acknowledge,
            # write labels the leaf for policy; the handler still owns the
            # service mutation and its cache/invalidation semantics.
            write=True,
            positional=(Operand(name="INCIDENT_ID", type="str",
                                required=True), ),
            options=(Option(
                long="--by",
                type="str",
                required=True,
                description="Person acknowledging the incident",
            ), ),
        ),
    ),
)


async def show(ws: Workspace, line: str) -> None:
    print(f"$ {line}")
    result = await ws.execute(line)
    stdout = await result.stdout_str()
    stderr = await result.stderr_str()
    if stdout:
        print(stdout, end="" if stdout.endswith("\n") else "\n")
    if stderr:
        print(stderr, end="" if stderr.endswith("\n") else "\n")
    print()


async def main() -> None:
    ws = Workspace({"/workspace": RAMResource()})

    # One immutable program tree can be installed more than once. Each head
    # word gets independently validated configuration: two accounts, one CLI.
    ws.register_cli("pager-eng", PAGER, {"account": "engineering"})
    ws.register_cli("pager-support", PAGER, {"account": "support"})

    try:
        await show(ws, "type -t pager-eng")
        await show(ws, "pager-eng --help")
        await show(ws, "pager-eng list")
        await show(ws, "pager-support list")
        await show(ws, "pager-eng ack --by Mina")
        await show(ws, "pager-eng ack __proto__ --by Mina")
        await show(ws, "pager-eng ack INC-101 --by Mina")
        await show(ws, "pager-eng list")
        await show(ws, "pager-support list")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())

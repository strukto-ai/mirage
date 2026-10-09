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

from mirage import (
    CLI,
    RAMVFS,
    Argument,
    CLIHandler,
    CLIInvocation,
    CommandSpec,
    FlagView,
    Workspace,
)
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
    inv: CLIInvocation[PagerConfig],
) -> tuple[bytes, IOResult]:
    incidents = INCIDENTS[inv.config.account]
    wanted = set(inv.texts)
    status = FlagView(inv.flags, inv.spec).as_str("state")
    lines = []
    for incident_id, incident in sorted(incidents.items()):
        if wanted and incident_id not in wanted:
            continue
        if status and status != (
            "open" if incident.acknowledged_by is None else "acknowledged"
        ):
            continue
        state = (
            "open"
            if incident.acknowledged_by is None
            else f"acknowledged-by={incident.acknowledged_by}"
        )
        lines.append(
            f"[{inv.config.account}] {incident_id} {state} {incident.summary}"
        )
    return ("\n".join(lines) + ("\n" if lines else "")).encode(), IOResult()


# A leaf is a plain function or a coroutine function, whichever its body
# needs: the executor awaits whatever it returns, so a handler that never
# awaits is not made async for the executor's sake, and one that raises
# before any await is refused exactly like one that raises after.
def acknowledge(
    inv: CLIInvocation[PagerConfig],
) -> tuple[bytes | None, IOResult]:
    if not inv.texts:
        raise ValueError("INCIDENT_ID is required")
    incident_id = inv.texts[0]
    by = FlagView(inv.flags, inv.spec).as_str("by")
    incident = INCIDENTS[inv.config.account].get(incident_id)
    if incident is None:
        return None, IOResult(
            exit_code=1,
            stderr=f"pager: unknown incident {incident_id}\n".encode(),
        )
    incident.acknowledged_by = by
    message = f"[{inv.config.account}] acknowledged {incident_id} by {by}\n"
    return message.encode(), IOResult()


PAGER = CLI(
    spec=CommandSpec(
        name="pager",
        description="Task-specific incident CLI",
        subcommands=(
            CommandSpec(
                name="list",
                description="List incidents for this installed account",
                arguments=(
                    Argument("INCIDENT_ID", nargs="*"),
                    Argument("--state", choices=("open", "acknowledged")),
                ),
            ),
            CommandSpec(
                name="ack",
                description="Acknowledge an incident",
                arguments=(
                    Argument("INCIDENT_ID"),
                    Argument(
                        "--by",
                        required=True,
                        help="Person acknowledging the incident",
                    ),
                ),
            ),
        ),
    ),
    handlers={
        "list": CLIHandler(fn=list_incidents),
        "ack": CLIHandler(fn=acknowledge, write=True),
    },
    config_model=PagerConfig,
)


async def show(ws: Workspace, line: str, expected_exit: int = 0) -> None:
    print(f"$ {line}")
    result = await ws.shell(line)
    stdout = await result.stdout_str()
    stderr = await result.stderr_str()
    assert result.exit_code == expected_exit, (line, result.exit_code, stderr)
    if stdout:
        print(stdout, end="" if stdout.endswith("\n") else "\n")
    if stderr:
        print(stderr, end="" if stderr.endswith("\n") else "\n")
    print()


async def main() -> None:
    ws = Workspace({"/workspace": RAMVFS()})

    # One immutable program tree can be installed more than once. Each head
    # word gets independently validated configuration: two accounts, one CLI.
    ws.register_cli("pager-eng", PAGER, {"account": "engineering"})
    ws.register_cli("pager-support", PAGER, {"account": "support"})

    try:
        await show(ws, "type -t pager-eng")
        await show(ws, "pager-eng --help")
        await show(ws, "pager-eng list")
        await show(ws, "pager-support list")
        await show(ws, "pager-eng list INC-101 INC-404 --state open")
        await show(ws, "pager-eng list --state invalid", expected_exit=2)
        await show(ws, "pager-eng ack --by Mina", expected_exit=2)
        await show(ws, "pager-eng ack __proto__ --by Mina", expected_exit=1)
        await show(ws, "pager-eng ack INC-101 --by Mina")
        await show(ws, "pager-eng list --state acknowledged INC-101")
        await show(ws, "pager-eng list INC-101 --state open")
        await show(ws, "pager-eng list")
        await show(ws, "pager-support list")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())

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

from fastapi import APIRouter, Request
from pydantic import BaseModel

from mirage.execution.machine.types import Machine, MachineState
from mirage.execution.types import MachineId
from mirage.server.errors import ErrorCode, HttpError, loader_error
from mirage.server.routers.processes import ProcessResponse, to_response
from mirage.server.routers.vfs import require_entry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/machines")


class MachineResponse(BaseModel):
    id: str
    state: MachineState
    checked_at: float


class MachineDetailResponse(MachineResponse):
    processes: list[ProcessResponse]


def _to_response(record: Machine) -> MachineResponse:
    return MachineResponse(
        id=str(record.id), state=record.state, checked_at=record.checked_at
    )


@router.get("", response_model=list[MachineResponse])
async def list_machines(
    workspace_id: str, request: Request
) -> list[MachineResponse]:
    """The machines the workspace runs programs on, its own host first,
    each checked now: ``managed`` when Mirage sees and stops every process
    its programs start there, ``reachable`` when only what it started
    itself, ``unreachable`` when the check failed. Run on the workspace's
    own loop."""
    runner = require_entry(request, workspace_id).runner

    async def read() -> list[MachineResponse]:
        return [_to_response(r) for r in await runner.ws.machines()]

    return await runner.call(read())


@router.get("/{machine_id}", response_model=MachineDetailResponse)
async def get_machine(
    workspace_id: str, machine_id: str, request: Request
) -> MachineDetailResponse:
    """One machine, by its id (``provider:name``), checked now, with the
    processes the workspace keeps that ran on it. Run on the workspace's
    own loop."""
    runner = require_entry(request, workspace_id).runner
    try:
        machine = MachineId.parse(machine_id)
    except ValueError as exc:
        raise loader_error(exc) from exc

    async def read() -> MachineDetailResponse | None:
        found = await runner.ws.machines(machine)
        if not found:
            return None
        processes = await runner.ws.processes(machine=machine)
        return MachineDetailResponse(
            **_to_response(found[0]).model_dump(),
            processes=[to_response(p) for p in processes],
        )

    detail = await runner.call(read())
    if detail is None:
        raise HttpError(ErrorCode.NOT_FOUND, "machine not found")
    return detail

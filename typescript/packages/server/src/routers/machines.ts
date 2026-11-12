// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { Machine, MachineState } from '@struktoai/mirage-core/execution/machine/types'
import { MachineId } from '@struktoai/mirage-core/execution/types'
import type { RouteApp } from '../routes.ts'
import { msToRfc3339 } from '@struktoai/mirage-core/utils/dates'
import type { WorkspaceRegistry } from '../registry.ts'
import type { Instant } from '../schemas.ts'
import { HttpError, loaderError, WorkspaceMissing } from '../errors.ts'
import { toResponse as processResponse, type ProcessResponse } from './processes.ts'

interface WsIdParams {
  wsId: string
}

interface WsMachineParams {
  wsId: string
  machineId: string
}

interface MachineResponse {
  id: string
  state: MachineState
  checked_at: Instant
}

interface MachineList {
  items: MachineResponse[]
}

interface MachineDetailResponse extends MachineResponse {
  processes: ProcessResponse[]
}

function toResponse(record: Machine): MachineResponse {
  return {
    id: record.id.toString(),
    state: record.state,
    checked_at: msToRfc3339(record.checkedAt * 1000),
  }
}

export function registerMachinesRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
  },
): void {
  app.get<{ Params: WsIdParams }>(
    '/v1/workspaces/:wsId/machines',
    async (req): Promise<MachineList> => {
      // The machines the workspace runs programs on, its own host first, each
      // checked now: `managed` when Mirage sees and stops every process its
      // programs start there, `reachable` when only what it started itself,
      // `unreachable` when the check failed.
      const { wsId } = req.params
      if (deps.registry.visible(wsId, req.account) === null) {
        throw new WorkspaceMissing(wsId)
      }
      const ws = deps.registry.get(wsId).runner.ws
      return { items: (await ws.machines()).map(toResponse) }
    },
  )

  app.get<{ Params: WsMachineParams }>('/v1/workspaces/:wsId/machines/:machineId', async (req) => {
    // One machine, by its id (`provider:name`), checked now, with the
    // processes the workspace keeps that ran on it.
    const { wsId, machineId } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      throw new WorkspaceMissing(wsId)
    }
    let machine: MachineId
    try {
      machine = MachineId.parse(machineId)
    } catch (err) {
      throw loaderError(err)
    }
    const ws = deps.registry.get(wsId).runner.ws
    const [found] = await ws.machines(machine)
    if (found === undefined) throw new HttpError('not_found', 'machine not found')
    const processes = await ws.processes({ machine })
    const detail: MachineDetailResponse = {
      ...toResponse(found),
      processes: processes.map((process) => processResponse(process, ws)),
    }
    return detail
  })
}

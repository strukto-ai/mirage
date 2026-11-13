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
import { MachineName } from '@struktoai/mirage-core/execution/types'
import type { RouteApp } from '../routes.ts'
import { msToRfc3339 } from '@struktoai/mirage-core/utils/dates'
import type { WorkspaceRegistry } from '../registry.ts'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { Instant } from '../schemas.ts'
import { HttpError, loaderError, WorkspaceMissing } from '../errors.ts'
import {
  toResponse as processResponse,
  type ProcessMachineResponse,
  type ProcessResponse,
} from './processes.ts'

interface WsIdParams {
  wsId: string
}

interface WsMachineParams {
  wsId: string
  machine: string
}

interface MachineResponse extends ProcessMachineResponse {
  state: MachineState
  checked_at: Instant
}

interface MachineList {
  items: MachineResponse[]
}

interface MachineDetailResponse extends MachineResponse {
  processes: ProcessResponse[]
}

function toResponse(record: Machine, ws: Workspace): MachineResponse {
  return {
    type: record.name.provider,
    name: record.name.name,
    id: ws.machineTable.instance(record.name),
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
      return { items: (await ws.machines()).map((record) => toResponse(record, ws)) }
    },
  )

  app.get<{ Params: WsMachineParams }>('/v1/workspaces/:wsId/machines/:machine', async (req) => {
    // One machine, by its name (`provider:name`), checked now, with the
    // processes the workspace keeps that ran on it.
    const { wsId, machine } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      throw new WorkspaceMissing(wsId)
    }
    let where: MachineName
    try {
      where = MachineName.parse(machine)
    } catch (err) {
      throw loaderError(err)
    }
    const ws = deps.registry.get(wsId).runner.ws
    const [found] = await ws.machines(where)
    if (found === undefined) throw new HttpError('not_found', 'machine not found')
    const processes = await ws.processes({ machine: where })
    const detail: MachineDetailResponse = {
      ...toResponse(found, ws),
      processes: processes.map((process) => processResponse(process, ws)),
    }
    return detail
  })
}

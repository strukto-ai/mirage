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

import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { miragePlugin } from '@struktoai/mirage-agents/opencode'

async function makeWs(sessionID: string): Promise<Workspace> {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
  await ws.fs.writeFile('/hello.txt', `hi from session ${sessionID}`)
  return ws
}

const workspaces = new Map<string, Workspace>()
const pending = new Map<string, Promise<Workspace>>()

async function wsFor(ctx: { sessionID: string }): Promise<Workspace> {
  const cached = workspaces.get(ctx.sessionID)
  if (cached !== undefined) return cached
  const inflight = pending.get(ctx.sessionID)
  if (inflight !== undefined) return inflight
  const p = makeWs(ctx.sessionID).then((ws) => {
    workspaces.set(ctx.sessionID, ws)
    pending.delete(ctx.sessionID)
    return ws
  })
  pending.set(ctx.sessionID, p)
  return p
}

export default miragePlugin(wsFor)

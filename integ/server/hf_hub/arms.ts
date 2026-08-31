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

import { authorityHost, advertiseHost } from '../kit/typescript/index.ts'
import type { Arm, Runtime } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { MCP_PATH, listenMcp, mcpServerFor } from './mcp.ts'

// The MCP arm, over the SAME runtime the REST arm serves. Shared by `main.ts`
// and the multi-fake launcher so the announced URL is built once: it carries
// the /mcp path because that is the only path the arm answers, and a harness
// handed the bare origin would get a 404 that reads as a dead server.
export async function startHubArms(runtime: Runtime<C>, mcpPort: number): Promise<Arm> {
  const server = mcpServerFor(runtime)
  const port = await listenMcp(server, mcpPort)
  const host = authorityHost(advertiseHost())
  return {
    announces: [{ token: 'HF_MCP_URL', url: `http://${host}:${String(port)}${MCP_PATH}` }],
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

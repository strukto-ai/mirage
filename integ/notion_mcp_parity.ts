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

// TS-only check with no golden file: the notion backend is reachable over two
// transports (the REST API and an MCP server), and both must render the exact
// same virtual filesystem. The REST rendering is asserted against the shared
// JSON harness (target `notion`); this asserts the MCP-backed resource is
// byte-identical to the REST one over the same command battery. Python has no
// MCP notion transport, so this cannot live in the cross-language harness.

import { NotionResource as BrowserNotionResource } from '@struktoai/mirage-browser'
import { MemoryOAuthClientProvider } from '@struktoai/mirage-core'
import { MountMode, NotionResource, Workspace } from '@struktoai/mirage-node'
import {
  CASES,
  EXIT_CODE_CASES,
  startMockMcpServer,
  startMockServer,
} from './server/notion_server.ts'

const MOUNT = '/notion'
const DEC = new TextDecoder()

async function render(ws: Workspace, cmd: string, withExit: boolean): Promise<string> {
  const result = await ws.execute(cmd)
  const out = DEC.decode(result.stdout)
  const tail = out.endsWith('\n') || out === '' ? out : out + '\n'
  return withExit ? `exit=${String(result.exitCode)}\n${tail}` : tail
}

async function main(): Promise<void> {
  const { server, port } = await startMockServer()
  const { server: mcpServer, port: mcpPort } = await startMockMcpServer()
  const restWs = new Workspace(
    { [MOUNT]: new NotionResource({ apiKey: 'integ-test', baseUrl: `http://127.0.0.1:${String(port)}/v1` }) },
    { mode: MountMode.READ },
  )
  const authProvider = new MemoryOAuthClientProvider({
    clientMetadata: { redirect_uris: ['http://127.0.0.1/cb'] },
    redirect: () => {},
  })
  const mcpWs = new Workspace(
    {
      [MOUNT]: new BrowserNotionResource({
        authProvider,
        serverUrl: `http://127.0.0.1:${String(mcpPort)}/mcp`,
      }),
    },
    { mode: MountMode.READ },
  )
  let mismatches = 0
  try {
    const all: ReadonlyArray<readonly [string, string, boolean]> = [
      ...CASES.map(([name, cmd]) => [name, cmd, false] as const),
      ...EXIT_CODE_CASES.map(([name, cmd]) => [name, cmd, true] as const),
    ]
    for (const [name, cmd, withExit] of all) {
      const restOut = await render(restWs, cmd, withExit)
      const mcpOut = await render(mcpWs, cmd, withExit)
      if (mcpOut !== restOut) {
        mismatches += 1
        process.stderr.write(
          `MCP/REST MISMATCH in ${name}:\n--- rest ---\n${restOut}--- mcp ---\n${mcpOut}`,
        )
      }
    }
    const n = String(all.length)
    if (mismatches === 0) process.stderr.write(`notion mcp parity: ${n}/${n} cases byte-identical\n`)
  } finally {
    await restWs.close()
    await mcpWs.close()
    server.close()
    mcpServer.close()
  }
  // The MCP transport leaves open handles, so exit explicitly rather than
  // waiting for the event loop to drain (which would hang the CI step).
  process.exit(mismatches > 0 ? 1 : 0)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

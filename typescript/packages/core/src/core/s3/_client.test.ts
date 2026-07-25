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

import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import type { S3HttpAgents } from '../../resource/s3/config.ts'
import { createS3Client } from './_client.ts'

interface ResolvedHandlerConfig {
  connectionTimeout?: number
  requestTimeout?: number
  httpAgent?: unknown
  httpAgentProvider?: () => Promise<unknown>
  httpsAgent?: unknown
}

function makeAgents(): S3HttpAgents {
  return { httpAgent: { destroy: () => undefined }, httpsAgent: { destroy: () => undefined } }
}

// The SDK builds the NodeHttpHandler itself from the options object we hand it
// and resolves that config lazily, so read it back through `configProvider`.
function resolvedHandlerConfig(client: S3Client): Promise<ResolvedHandlerConfig> {
  const handler = client.config.requestHandler as unknown as {
    configProvider: Promise<ResolvedHandlerConfig>
  }
  return handler.configProvider
}

describe('S3 client', () => {
  it('forwards runtime-provided agents into the request handler', async () => {
    const agents = makeAgents()
    const client = await createS3Client({ bucket: 'b', httpAgentProvider: () => agents })
    const resolved = await resolvedHandlerConfig(client)
    const httpAgent = (await resolved.httpAgentProvider?.()) ?? resolved.httpAgent
    expect(httpAgent).toBe(agents.httpAgent)
    expect(resolved.httpsAgent).toBe(agents.httpsAgent)
    client.destroy()
  })

  // Every S3 op destroys its own client when it finishes. Agents must therefore
  // be per-client: a shared pair would let one op's cleanup tear down sockets a
  // concurrent op is still using (e.g. `ls -l`, which stats entries in parallel).
  it('asks the provider for fresh agents per client so destroy() stays scoped', async () => {
    const seen: unknown[] = []
    const provider = (): S3HttpAgents => {
      const agents = makeAgents()
      seen.push(agents.httpsAgent)
      return agents
    }
    const config = { bucket: 'b', httpAgentProvider: provider }
    const a = await createS3Client(config)
    const b = await createS3Client(config)
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(await resolvedHandlerConfig(a)).not.toBe(await resolvedHandlerConfig(b))
    a.destroy()
    b.destroy()
  })

  it('keeps timeouts alongside provided agents', async () => {
    const agents = makeAgents()
    const client = await createS3Client({
      bucket: 'b',
      timeoutMs: 1234,
      httpAgentProvider: () => agents,
    })
    const resolved = await resolvedHandlerConfig(client)
    expect(resolved.requestTimeout).toBe(1234)
    expect(resolved.connectionTimeout).toBe(1234)
    expect(resolved.httpsAgent).toBe(agents.httpsAgent)
    client.destroy()
  })
})

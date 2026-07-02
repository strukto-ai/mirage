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

import { mountKey } from '../../utils/key_prefix.ts'
import { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { normalizeDatabricksVolumeConfig } from '../../resource/databricks_volume/config.ts'
import { PathSpec } from '../../types.ts'

export const TEST_ROOT = '/Volumes/main/default/agent_files/root'

export function makeAccessor(rootPath = '/root'): DatabricksVolumeAccessor {
  const config = normalizeDatabricksVolumeConfig({
    catalog: 'main',
    schema: 'default',
    volume: 'agent_files',
    root_path: rootPath,
  })
  return new DatabricksVolumeAccessor(config, 'https://dbc.example.com', 'tok-123')
}

export function spec(virtual: string, prefix = '/volume'): PathSpec {
  return PathSpec.fromStrPath(virtual, mountKey(virtual, prefix))
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function notFoundResponse(): Response {
  return jsonResponse({ error_code: 'NOT_FOUND', message: 'does not exist' }, 404)
}

export interface FetchCall {
  method: string
  url: string
  headers: Record<string, string>
  body: Uint8Array | string | undefined
}

export function routedFetch(route: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as Uint8Array | string | undefined,
    }
    calls.push(call)
    return route(call)
  }
  return { fetch: impl as typeof fetch, calls }
}

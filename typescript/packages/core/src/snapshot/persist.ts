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

import { decodeBase64, encodeBase64 } from '../utils/base64.ts'
import { FORMAT_VERSION } from '../workspace/snapshot/utils.ts'
import type { WorkspaceStateDict } from './state.ts'

const BLOB_MARKER = '__bytes_b64'

interface JsonObject {
  [key: string]: JsonValue
}
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

function encodeBlobs(value: unknown): JsonValue {
  if (value instanceof Uint8Array) {
    return { [BLOB_MARKER]: encodeBase64(value) }
  }
  if (Array.isArray(value)) return value.map((v) => encodeBlobs(v))
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeBlobs(v)
    }
    return out
  }
  return value as JsonValue
}

function decodeBlobs(value: JsonValue): unknown {
  if (Array.isArray(value)) return value.map((v) => decodeBlobs(v))
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === BLOB_MARKER) {
      const b64 = value[BLOB_MARKER]
      if (typeof b64 !== 'string') throw new Error('invalid blob ref')
      return decodeBase64(b64)
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeBlobs(v)
    }
    return out
  }
  return value
}

export function encodeSnapshot(state: WorkspaceStateDict): Uint8Array {
  const encoded = encodeBlobs(state)
  const json = JSON.stringify(encoded, null, 2)
  return new TextEncoder().encode(json)
}

export function decodeSnapshot(bytes: Uint8Array): WorkspaceStateDict {
  const json = new TextDecoder().decode(bytes)
  const parsed = JSON.parse(json) as JsonValue
  const decoded = decodeBlobs(parsed) as Record<string, unknown>
  const version = decoded.version
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `snapshot format v${String(version)} not supported ` +
        `(loader expects v${String(FORMAT_VERSION)})`,
    )
  }
  return decoded as unknown as WorkspaceStateDict
}

interface NodeFs {
  readFileSync(path: string): Uint8Array
  writeFileSync(path: string, data: Uint8Array): void
}

async function tryLoadFs(): Promise<NodeFs | null> {
  const g = globalThis as unknown as { process?: { versions?: { node?: string } } }
  if (g.process?.versions?.node === undefined) return null
  try {
    const modName = 'node:fs'
    const mod = (await import(/* @vite-ignore */ modName)) as NodeFs
    return mod
  } catch {
    return null
  }
}

const nodeFs: NodeFs | null = await tryLoadFs()

export function saveSnapshotToFile(state: WorkspaceStateDict, path: string): void {
  if (nodeFs === null) throw new Error('saveSnapshotToFile: not available (node:fs unavailable)')
  nodeFs.writeFileSync(path, encodeSnapshot(state))
}

export function loadSnapshotFromFile(path: string): WorkspaceStateDict {
  if (nodeFs === null) throw new Error('loadSnapshotFromFile: not available (node:fs unavailable)')
  return decodeSnapshot(nodeFs.readFileSync(path))
}

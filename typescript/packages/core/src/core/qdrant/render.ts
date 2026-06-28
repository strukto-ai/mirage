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

import type { QdrantRow } from './_client.ts'
import type { QdrantConfigResolved } from '../../resource/qdrant/config.ts'

const ENC = new TextEncoder()
const SKIP_KEYS = new Set(['_score', '_rowid', '_distance'])

export function renderJson(row: QdrantRow, config: QdrantConfigResolved): Uint8Array {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (SKIP_KEYS.has(key)) continue
    if (key === config.vectorField || key === config.blobField) continue
    data[key] = value
  }
  return ENC.encode(JSON.stringify(data) + '\n')
}

export function renderText(row: QdrantRow, config: QdrantConfigResolved): Uint8Array {
  const value = config.textField !== null ? row[config.textField] : undefined
  if (value === undefined || value === null) return new Uint8Array()
  const text =
    typeof value === 'object'
      ? JSON.stringify(value)
      : String(value as string | number | boolean | bigint)
  return ENC.encode(text + '\n')
}

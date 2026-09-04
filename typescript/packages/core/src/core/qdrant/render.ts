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

import type { QdrantRow } from './client.ts'
import type { QdrantConfigResolved } from '../../resource/qdrant/config.ts'
import { decodeBase64 } from '../../utils/base64.ts'
import { compactJsonText } from '../render/json.ts'
import { fieldValue, withoutField } from './fields.ts'

const ENC = new TextEncoder()
const SKIP_KEYS = new Set(['_score', '_rowid', '_distance'])

export function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return decodeBase64(value)
  throw new Error('blob column is not bytes or base64 string')
}

export function renderJson(row: QdrantRow, config: QdrantConfigResolved): Uint8Array {
  let data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (SKIP_KEYS.has(key)) continue
    data[key] = value
  }
  data = withoutField(data, config.vectorField)
  data = withoutField(data, config.blobField)
  return ENC.encode(compactJsonText(data) + '\n')
}

export function renderText(row: QdrantRow, config: QdrantConfigResolved): Uint8Array {
  const value = fieldValue(row, config.textField)
  if (value === undefined || value === null) return new Uint8Array()
  const text =
    typeof value === 'object'
      ? JSON.stringify(value)
      : String(value as string | number | boolean | bigint)
  return ENC.encode(text + '\n')
}

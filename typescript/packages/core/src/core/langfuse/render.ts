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

const encoder = new TextEncoder()

export function toJsonBytes(data: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(data, null, 2))
}

export function toJsonlBytes(items: readonly Record<string, unknown>[]): Uint8Array {
  // Single renderer for every .jsonl path: read() and the readdir-time
  // sizing must produce the same bytes for the same rows, so the advertised
  // size is exact by construction.
  if (items.length === 0) return new Uint8Array()
  return encoder.encode(items.map((item) => JSON.stringify(item)).join('\n') + '\n')
}

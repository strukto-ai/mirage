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

import type { ChromaChunk } from './_client.ts'

const encoder = new TextEncoder()

export function renderPage(chunks: readonly ChromaChunk[]): Uint8Array {
  // Single renderer for a page: read() and the size the directory scan
  // records must produce the same bytes for the same chunks, so the
  // advertised size is exact by construction.
  return encoder.encode(chunks.map((chunk) => chunk.document).join('\n'))
}

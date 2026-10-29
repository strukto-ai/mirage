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

import { createAsyncContext } from '../utils/async_context.ts'
import { MemoryExhausted } from './errors.ts'

// The running line's `max_memory`, null outside a line or once lifted.
const limit = createAsyncContext<number | null>()

/**
 * `fn` run under a line's `max_memory`, which every object it holds is
 * checked against. Mirrors Python's `run_with_memory_limit`.
 */
export function runWithMemoryLimit<T>(bytes: number | null, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(limit.run(bytes, fn))
}

/**
 * The bytes one object the running line holds may reach, null for no cap.
 * Mirrors Python's `line_memory_limit`.
 */
export function lineMemoryLimit(): number | null {
  return limit.getStore() ?? null
}

/**
 * Refuse an object that grew to `size` bytes past the running line's
 * `max_memory`. Mirrors Python's `check_memory`.
 */
export function checkMemory(size: number): void {
  const bytes = lineMemoryLimit()
  if (bytes !== null && size > bytes) throw new MemoryExhausted()
}

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

export function makeAbortError(): DOMException {
  return new DOMException('execute aborted', 'AbortError')
}

/** Fold two optional abort signals into one; either aborting aborts. */
export function mergeSignals(
  a: AbortSignal | null | undefined,
  b: AbortSignal | null | undefined,
): AbortSignal | undefined {
  if (a != null && b != null) return AbortSignal.any([a, b])
  return a ?? b ?? undefined
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(makeAbortError())
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer)
      reject(makeAbortError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

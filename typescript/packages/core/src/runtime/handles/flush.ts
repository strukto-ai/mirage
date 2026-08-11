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

export type FlushKind = 'append' | 'write'

// The lowest offset a handle has written at, before it writes anything.
// A sentinel rather than a null because every write takes the minimum of
// it and the new offset, and "nothing yet" has to lose that comparison.
export const NO_WRITE = Number.MAX_SAFE_INTEGER

/**
 * Decide what a closing whole-file buffer owes the mount.
 *
 * Every encoder buffers a whole file and has to answer the same
 * question at close: did this handle only add to the end, or did it
 * rewrite what was already there? Only the first can travel as a
 * delta, and answering "write" always is what makes an append loop
 * quadratic.
 *
 * Args:
 *   baseLen: length the file had when the handle opened.
 *   lowWrite: lowest offset this handle wrote at, or the NO_WRITE
 *     sentinel when it never wrote.
 *   buf: the handle's whole buffer.
 *
 * Returns:
 *   ['append', tail] when the handle only extended the file, else
 *   ['write', whole buffer].
 */
export function planFlush(
  baseLen: number,
  lowWrite: number,
  buf: Uint8Array,
): [FlushKind, Uint8Array] {
  if (baseLen > 0 && lowWrite >= baseLen && buf.length >= baseLen) {
    return ['append', buf.slice(baseLen)]
  }
  return ['write', buf.slice()]
}

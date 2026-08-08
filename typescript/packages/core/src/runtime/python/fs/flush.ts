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

/**
 * Decide what a closing handle owes the mount.
 *
 * The mirror of `plan_flush` in `python/mirage/runtime/vfs.py`: a handle
 * that only ever wrote at or past the length it opened over has extended
 * the file, so the tail is enough. Anything else rewrote history the tail
 * cannot express and ships whole.
 *
 * Args:
 *   baseLen: length the file had when the handle opened.
 *   lowWrite: lowest offset this handle wrote at.
 *   buf: the file's whole current content.
 */
export function planFlush(
  baseLen: number,
  lowWrite: number,
  buf: Uint8Array,
): ['append', Uint8Array] | ['write', Uint8Array] {
  if (baseLen > 0 && lowWrite >= baseLen && buf.length >= baseLen) {
    return ['append', buf.slice(baseLen)]
  }
  return ['write', buf.slice()]
}

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
 * What an fopen-style mode string says about a handle.
 *
 * One vocabulary for every dialect that opens by mode: quickjs's
 * `std.open` passes these strings verbatim, and Python's preview1
 * oflags/rights/fdflags translate onto the same five facts.
 */
export interface OpenMode {
  /** The handle may mutate its buffer (w, a, x, +). */
  writable: boolean
  /** Opening discards existing content (w). */
  truncate: boolean
  /** The position starts at the end (a). */
  append: boolean
  /** A missing file is created (w, a, x). */
  create: boolean
  /** An existing file refuses the open (x). */
  exclusive: boolean
}

/**
 * Read an fopen-style mode string into its five facts.
 *
 * Args:
 *   mode: the mode as the guest spelled it (`r`, `w+b`, `a`, ...);
 *     unknown letters are ignored, matching fopen.
 */
export function parseMode(mode: string): OpenMode {
  return {
    writable: /[wax+]/.test(mode),
    truncate: mode.includes('w'),
    append: mode.includes('a'),
    create: /[wax]/.test(mode),
    exclusive: mode.includes('x'),
  }
}

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

import { PathSpec } from '../../../../types.ts'

/**
 * Where extraction lands: the explicit operand, else the cwd.
 *
 * The explicit operand is tar's last -C or unzip's -d, already validated
 * before extracting any members, as a virtual path. Mirrors Python's
 * extract_dest.
 */
export function extractDest(explicit: PathSpec | string | null, cwd: string): string {
  const target = explicit ?? cwd
  return target instanceof PathSpec ? target.virtual : target || '/'
}

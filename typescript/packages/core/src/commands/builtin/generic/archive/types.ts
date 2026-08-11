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

import type { PathSpec } from '../../../../types.ts'

// What a member is, which is the whole of what an archive records beyond
// its name: a regular file carries bytes, a directory carries none and
// ends in a slash, a symlink carries its target string instead.
export type MemberKind = 'file' | 'dir' | 'link'

// One thing found under an operand, before it is named or filtered.
// `namePath` and `read` are two different paths whenever a link is being
// followed: the member keeps the link's own name while its bytes come
// from the target.
export interface Entry {
  namePath: string
  kind: MemberKind
  target?: string
  read?: PathSpec | null
}

// One thing the scan could not archive, in the order it was met.
// `reason` is empty when `fatal` says the path could not be stat'd at
// all, since each archiver words that case itself.
export interface Problem {
  path: string
  reason?: string
  fatal?: boolean
}

// What one operand contributed, in virtual path space.
//
// Nothing here is named yet: naming is where the two archive formats
// part company (tar warns about a leading slash, zip strips it in
// silence and can junk the path entirely), so the scan reports paths and
// the caller spells them. `missing` says the operand itself was
// unreachable, in which case it contributed no entries.
export interface Scan {
  entries: Entry[]
  crossings: string[]
  problems: Problem[]
  missing: boolean
}

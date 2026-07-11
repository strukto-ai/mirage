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

import { parseIdName } from '../../utils/naming.ts'
import { sanitizeName } from '../../utils/sanitize.ts'

export { sanitizeName } from '../../utils/sanitize.ts'

export function stripDashes(id: string): string {
  return id.replace(/-/g, '')
}

export function formatSegment(page: { id: string; title: string }): string {
  const label = page.title !== '' ? sanitizeName(page.title) : 'untitled'
  return `${label}__${page.id}`
}

export function parseSegment(segment: string): { title: string; id: string } {
  const [title, id] = parseIdName(segment)
  return { title, id }
}

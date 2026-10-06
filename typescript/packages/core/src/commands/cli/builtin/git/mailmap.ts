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

import type { FlagView } from '../../../spec/flag_view.ts'
import { readOptional } from './io.ts'
import type { Dispatch, MailmapEntry, RepoLocation } from './types.ts'

const MAILMAP_LINE = /^\s*([^<>]*?)\s*<([^<>]+)>(?:\s*([^<>]*?)\s*<([^<>]*)>)?/
const IDENTITY = /(.*?)\s*<([^<>]*)>/

/**
 * Read Git's four mailmap identity forms.
 *
 * Pinned against git 2.47.3 (Debian stable) and 2.50.1: only a `#` in the
 * first column starts a comment, and the second email may be empty (`<>`)
 * while the first may not.
 */
export function parseMailmap(text: string): readonly MailmapEntry[] {
  const entries: MailmapEntry[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue
    const match = MAILMAP_LINE.exec(line)
    if (!match) continue
    const [, name = '', email = '', oldName, oldEmail] = match
    entries.push({
      email: (oldEmail ?? email).toLowerCase(),
      name: oldName ? oldName.toLowerCase() : null,
      mappedName: name || null,
      mappedEmail: oldEmail === undefined ? null : email,
    })
  }
  return entries
}

/**
 * Map one `Name <email>` identity the way git's `map_user` does.
 *
 * An entry naming both the recorded name and email wins outright, the last
 * such line replacing any earlier one. Without one, the entries naming the
 * email alone apply, each later line overriding the part it spells.
 */
export function mappedIdentity(identity: string, entries: readonly MailmapEntry[]): string {
  const match = IDENTITY.exec(identity)
  if (!match) return identity
  const [, name = '', email = ''] = match
  let simpleName: string | null = null
  let simpleEmail: string | null = null
  let specific: MailmapEntry | null = null
  for (const entry of entries) {
    if (entry.email !== email.toLowerCase()) continue
    if (entry.name === null) {
      simpleName = entry.mappedName ?? simpleName
      simpleEmail = entry.mappedEmail ?? simpleEmail
    } else if (entry.name === name.toLowerCase()) {
      specific = entry
    }
  }
  if (specific !== null) {
    simpleName = specific.mappedName
    simpleEmail = specific.mappedEmail
  }
  return `${simpleName ?? name} <${simpleEmail ?? email}>`
}

/** Read the worktree mailmap through the workspace data plane. */
export async function loadMailmap(
  dispatch: Dispatch,
  location: RepoLocation,
): Promise<readonly MailmapEntry[]> {
  const data = await readOptional(dispatch, location.worktree.join(`.mailmap`))
  return parseMailmap(new TextDecoder().decode(data ?? new Uint8Array()))
}

/** Apply explicit mailmap switches in command-line order. */
export function useMailmap(fl: FlagView, enabled: boolean): boolean {
  for (const [key] of fl.occurrences('mailmap', 'use_mailmap', 'no_mailmap', 'no_use_mailmap'))
    enabled = !key.startsWith('no_')
  return enabled
}

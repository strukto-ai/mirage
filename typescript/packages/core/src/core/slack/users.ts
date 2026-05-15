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

import type { SlackAccessor } from '../../accessor/slack.ts'
import { cursorPages } from './paginate.ts'

export interface SlackUser {
  id: string
  name?: string
  real_name?: string
  deleted?: boolean
  is_bot?: boolean
  profile?: { email?: string; [key: string]: unknown }
  [key: string]: unknown
}

function isRealUser(m: SlackUser): boolean {
  return m.deleted !== true && m.is_bot !== true && m.id !== 'USLACKBOT'
}

export async function* listUsersStream(
  accessor: SlackAccessor,
  options: { limit?: number } = {},
): AsyncIterableIterator<SlackUser[]> {
  const limit = options.limit ?? 200
  for await (const page of cursorPages<SlackUser>(
    accessor.transport,
    'users.list',
    { limit: String(limit) },
    'members',
  )) {
    yield page.filter(isRealUser)
  }
}

export async function listUsers(
  accessor: SlackAccessor,
  options: { limit?: number } = {},
): Promise<SlackUser[]> {
  const out: SlackUser[] = []
  for await (const page of listUsersStream(accessor, options)) {
    out.push(...page)
  }
  return out
}

export async function getUserProfile(
  accessor: SlackAccessor,
  userId: string,
): Promise<SlackUser | Record<string, never>> {
  const data = await accessor.transport.call('users.info', { user: userId })
  return (data.user as SlackUser | undefined) ?? {}
}

export async function searchUsers(
  accessor: SlackAccessor,
  query: string,
  options: { limit?: number } = {},
): Promise<SlackUser[]> {
  const all = await listUsers(accessor, options)
  const q = query.toLowerCase()
  return all.filter((u) => {
    if ((u.name ?? '').toLowerCase().includes(q)) return true
    if ((u.real_name ?? '').toLowerCase().includes(q)) return true
    const email = u.profile?.email ?? ''
    if (email.toLowerCase().includes(q)) return true
    return false
  })
}

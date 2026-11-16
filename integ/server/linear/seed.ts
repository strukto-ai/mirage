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

import type { Prisma } from '../../generated/linear/index.js'
import { tenantWhere } from '../kit/typescript/tenant.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import { identifierNumber } from './nodes.ts'
import { writeLabelLinks } from './world.ts'
import type { Db } from './world.ts'

function parseLabelIds(raw: string | null): string[] {
  if (raw === null || raw === '') return []
  const parsed = JSON.parse(raw) as unknown
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
}

// Two facts the fixture states only implicitly, resolved once per seeded
// tenant rather than on every read.
//
// The issue number is the identifier's trailing digits (PLAT-2 -> 2, and 0
// for anything that does not end in -<digits>), which is what issueCreate
// counts up from. The generic seeder cannot derive it, because it is a
// function of another column.
//
// The label list arrives as a scalar array on the issue, which the seeder
// JSON-stringifies into Issue.labelIds. Expanding it here into IssueLabel
// rows and clearing the column leaves the link table as the only place a
// label membership lives, so a read never has to decide which of the two to
// believe.
//
// Issue.seq is renumbered across teams into one global ordinal, because the
// old fake held every issue in one insertion-ordered dict and IssueSearch
// pages out of it. The seeder can only count within a team's nested list.
export async function afterSeed(db: C, tenant: string, sql: Db): Promise<void> {
  const where = tenantWhere(tenant, config.tenantKind)
  const teams = await db.team.findMany({ where, orderBy: { seq: 'asc' } })
  let ordinal = 0
  for (const team of teams) {
    const issues = await db.issue.findMany({
      where: { ...where, teamId: team.id },
      orderBy: { seq: 'asc' },
    })
    for (const issue of issues) {
      const data: Prisma.IssueUncheckedUpdateInput = {
        number: identifierNumber(issue.identifier),
        labelIds: null,
        seq: ordinal,
      }
      ordinal += 1
      await db.issue.update({
        where: { tenant_id: { tenant, id: issue.id } },
        data,
      })
      await writeLabelLinks(sql, tenant, issue.id, parseLabelIds(issue.labelIds))
    }
  }
}

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

import { FlagView } from '../../../spec/types.ts'
import { forkRepo, login, readReadme, renameRepo, viewRepo } from '../../../../core/github/repo.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { ghRepo, ghTransport, textOut } from './accessor.ts'

/**
 * gh's own text view of a repository: two tab-separated header lines and
 * then the README verbatim, with the `--` separator omitted entirely when
 * there is no README. Probed against gh 2.85, whose description line is
 * present and empty for a repository that has none.
 */
export function summary(repo: unknown, readme: string | null): string {
  const fields = (repo ?? {}) as { full_name?: unknown; description?: unknown }
  const name = typeof fields.full_name === 'string' ? fields.full_name : ''
  const description = typeof fields.description === 'string' ? fields.description : ''
  const head = `name:\t${name}\ndescription:\t${description}\n`
  return readme === null ? head : `${head}--\n${readme}`
}

export async function view(inv: CLIInvocation): Promise<CommandFnResult> {
  const transport = ghTransport(inv.config)
  const ref = ghRepo(inv.config, inv.texts[0])
  const repo = await viewRepo(transport, ref)
  return textOut(summary(repo, await readReadme(transport, ref)))
}

export async function fork(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  const source = ghRepo(inv.config, inv.texts[0])
  const name = fl.asStr('fork_name') ?? undefined
  const forked = (await forkRepo(transport, source, name)) as { full_name?: string }
  const full = forked.full_name ?? `${await login(transport)}/${name ?? source.repo}`
  return textOut(`✓ Created fork ${full}\n`)
}

export async function rename(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  // gh takes the *new name* as the operand and the repository to rename as
  // -R, which is the reverse of what the shape of the line suggests.
  const target = ghRepo(inv.config, fl.asStr('repo') ?? undefined)
  const name = inv.texts[0] ?? ''
  if (name === '') throw new Error('a new repository name is required')
  const renamed = (await renameRepo(transport, target, name)) as { full_name?: string }
  return textOut(`✓ Renamed repository ${renamed.full_name ?? name}\n`)
}

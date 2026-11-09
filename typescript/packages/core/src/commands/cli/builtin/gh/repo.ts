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

import { NOOPAccessor } from '../../../../accessor/base.ts'
import type { GitHubAccount } from '../../../../accessor/github.ts'
import { login, parseRepo, repoHost, type RepoRef } from '../../../../core/github/repo.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { parseCommand, parseToKwargs } from '../../../spec/parser.ts'
import { COBRA_EXIT, cobraRefusal } from '../../cobra.ts'
import { findNode } from '../../walk.ts'
import { clone as gitClone } from '../git/clone.ts'
import { GIT } from '../git/index.ts'
import { splitMarked } from '../git/util.ts'
import { GIST_ORIGIN, GITHUB_HOST } from './constants.ts'
import { checkHost, webOrigin } from './host.ts'

function tokenHeader(accessor: GitHubAccount): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x-access-token:${accessor.config.token}`)}` }
}

/**
 * `gh repo clone`: mirage's `git clone` of the repository. As gh does, the
 * words after the repository that are not gh's own flags go to git: the first
 * one, when it has no leading dash, is the directory, put after the URL unless
 * it is empty, and the rest go before the URL. The token rides only as the
 * request's Authorization, never on the line, in the config or in the output,
 * and only when git clones from the install's origin, as gh's credential
 * helper is scoped to it; a fork's `upstream` remote is not added.
 */
export async function cloneCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const [names, gitflags] = splitMarked(texts, ctx.argv ?? [])
  const spec = names[0]
  if (spec === undefined) {
    return usageRefusal('cannot clone: repository argument required', 'repo clone', ctx)
  }
  let ref: RepoRef
  try {
    checkHost(accessor, repoHost(spec))
    ref =
      !spec.includes('/') && !spec.includes(':')
        ? { owner: await login(accessor.transport), repo: spec }
        : parseRepo(spec)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    return [null, new IOResult({ exitCode: COBRA_EXIT, stderr: encodeText(`${err.message}\n`) })]
  }
  const origin = webOrigin(accessor)
  const url = `${origin}/${ref.owner}/${ref.repo}.git`
  return clone(accessor, url, [...names.slice(1), ...gitflags], ctx, origin)
}

/** `gh gist clone`: mirage's `git clone` of a gist, its id or URL first. */
export async function gistCloneCmd(
  accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const [names, gitflags] = splitMarked(texts, ctx.argv ?? [])
  const spec = names[0]
  if (spec === undefined) {
    return usageRefusal('cannot clone: gist argument required', 'gist clone', ctx)
  }
  const gist = (spec.replace(/\/+$/, '').split('/').at(-1) ?? '').replace(/\.git$/, '')
  const origin = webOrigin(accessor)
  const host = origin === `https://${GITHUB_HOST}` ? GIST_ORIGIN : `${origin}/gist`
  return clone(accessor, `${host}/${gist}.git`, [...names.slice(1), ...gitflags], ctx, host)
}

function usageRefusal(message: string, leaf: string, ctx: Context): CommandFnResult {
  const text =
    ctx.spec === undefined ? `${message}\n` : cobraRefusal(message, `gh ${leaf}`, ctx.spec)
  return [null, new IOResult({ exitCode: COBRA_EXIT, stderr: encodeText(text) })]
}

async function clone(
  accessor: GitHubAccount,
  url: string,
  rest: string[],
  ctx: Context,
  origin: string,
): Promise<CommandFnResult> {
  const target = rest[0] !== undefined && !rest[0].startsWith('-') ? rest.slice(0, 1) : []
  const leaf = findNode(GIT.spec, ['clone'])?.node ?? GIT.spec
  const words = [...rest.slice(target.length), url, ...target.filter(Boolean)]
  const parsed = parseCommand(leaf, words, ctx.cwd.virtual, 'git clone', ctx.env, true)
  const git: Context = {
    argv: ['clone', ...words],
    cwd: ctx.cwd,
    flags: { ...parseToKwargs(parsed), C: ctx.cwd },
    stdin: ctx.stdin,
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    ...(ctx.vfs !== undefined ? { vfs: ctx.vfs } : {}),
    ...(ctx.session !== undefined ? { session: ctx.session } : {}),
    ...(ctx.processes !== undefined ? { processes: ctx.processes } : {}),
    spec: leaf,
  }
  const operands = parsed.args.map(([word]) => word)
  const sameOrigin = operands[0]?.startsWith(`${origin}/`) ?? false
  return gitClone(new NOOPAccessor(), [], operands, git, sameOrigin ? tokenHeader(accessor) : {})
}

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

import { getText } from '../../../../shell/helpers.ts'
import type { TSNodeLike } from '../../../../shell/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { SHOPT_DEFAULTS } from '../../../../shell/constants.ts'
import type { SessionState } from '../../../session/session.ts'
import { ownRecord, sessionEntry, setSessionEntry } from '../../../session/session.ts'
import { singleQuote } from '../../../../utils/quote.ts'
import { scanOptions } from '../getopt.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { ExecutionNode } from '../../../types.ts'
import { fail } from '../shared.ts'
import { ALIAS_USAGE, BAD_NAME_CHARS, FIRST_WORD, UNALIAS_USAGE } from './constants.ts'
import type { AliasMark } from './types.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/** Whether a name holds a character bash refuses in an alias name. */
function hasBadChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (BAD_NAME_CHARS.includes(name.charAt(i))) return true
  }
  return false
}

/** Define or print aliases. */
export function handleAlias(args: string[], session: SessionState, mark: AliasMark): Result {
  const scan = scanOptions(args, 'p')
  if (scan.bad !== null)
    return fail('alias', `bash: alias: ${scan.bad}: invalid option\n${ALIAS_USAGE}\n`, 2)
  const operands = scan.operands
  const lines: string[] = []
  const errors: string[] = []
  if (operands.length === 0 || scan.letters.includes('p')) {
    for (const name of Object.keys(session.aliases).sort(compareCodePoints)) {
      lines.push(`alias ${name}=${singleQuote(session.aliases[name] ?? '')}`)
    }
  }
  for (const word of operands) {
    const eq = word.indexOf('=')
    if (eq >= 0) {
      const name = word.slice(0, eq)
      if (name === '' || hasBadChar(name)) {
        errors.push(
          name === ''
            ? `bash: alias: ${word}: not found`
            : `bash: alias: \`${name}': invalid alias name`,
        )
        continue
      }
      setSessionEntry(session.aliases, name, word.slice(eq + 1))
      session.aliasMarks.set(name, mark)
      continue
    }
    if (hasBadChar(word)) {
      errors.push(`bash: alias: \`${word}': invalid alias name`)
      continue
    }
    const val = sessionEntry(session.aliases, word)
    if (val !== undefined) lines.push(`alias ${word}=${singleQuote(val)}`)
    else errors.push(`bash: alias: ${word}: not found`)
  }
  const out = lines.length > 0 ? encodeText(lines.join('\n') + '\n') : null
  const err = errors.length > 0 ? encodeText(errors.join('\n') + '\n') : null
  const code = errors.length > 0 ? 1 : 0
  return [
    out,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({
      command: 'alias',
      exitCode: code,
      ...(err !== null ? { stderr: err } : {}),
    }),
  ]
}

/** Remove aliases: the named ones, or all under `-a`. */
export function handleUnalias(args: string[], session: SessionState): Result {
  const scan = scanOptions(args, 'a')
  if (scan.bad !== null)
    return fail('unalias', `bash: unalias: ${scan.bad}: invalid option\n${UNALIAS_USAGE}\n`, 2)
  const operands = scan.operands
  if (scan.letters.includes('a')) {
    session.aliases = ownRecord<string>()
    session.aliasMarks.clear()
    return [null, new IOResult(), new ExecutionNode({ command: 'unalias', exitCode: 0 })]
  }
  if (operands.length === 0) return fail('unalias', `${UNALIAS_USAGE}\n`, 2)
  const errors: string[] = []
  for (const name of operands) {
    if (sessionEntry(session.aliases, name) !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.aliases[name]
      session.aliasMarks.delete(name)
    } else errors.push(`bash: unalias: ${name}: not found`)
  }
  const err = errors.length > 0 ? encodeText(errors.join('\n') + '\n') : null
  const code = errors.length > 0 ? 1 : 0
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({
      command: 'unalias',
      exitCode: code,
      ...(err !== null ? { stderr: err } : {}),
    }),
  ]
}

function aliasesOn(session: SessionState): boolean {
  return session.shopts.expand_aliases ?? SHOPT_DEFAULTS.get('expand_aliases') ?? false
}

/**
 * The alias names a command word would expand as right now. bash checks a
 * word where a command starts for an alias before it checks for a reserved
 * word, so one of these names is a command there even when it is spelled
 * `fi` or `do`. Mirrors Python's expanding_aliases.
 */
export function expandingAliases(session: SessionState): ReadonlySet<string> {
  const blocked = session.aliasExpansion?.names
  const view = session.aliasView
  const names = view !== null ? Object.keys(view) : aliasesOn(session) ? Object.keys(session.aliases) : []
  return new Set(names.filter((name) => blocked?.has(name) !== true))
}

/**
 * The aliases a function defined at `mark` keeps for its body. bash expands
 * a function's aliases as it reads the definition, so the body runs them as
 * they were then, whatever is defined or removed later: the aliases a use
 * at `mark` would expand, none while `expand_aliases` is off, and inside
 * another function's body that body's own. What is read later (`eval`,
 * `source`, a trap action, `$( )`) reads the aliases as they are then.
 * Mirrors Python.
 */
export function aliasView(session: SessionState, mark: AliasMark): Record<string, string> {
  if (session.aliasView !== null) return { ...session.aliasView }
  if (!aliasesOn(session)) return {}
  const view: Record<string, string> = {}
  for (const [name, value] of Object.entries(session.aliases)) {
    const seen = session.aliasMarks.get(name)
    if (seen?.[0] !== mark[0] || seen[1] !== mark[1]) view[name] = value
  }
  return view
}

/** The alias text a command word expands to, or null. In a function's body
 * the aliases are the ones its definition saw (`aliasView`). */
export function aliasValue(
  session: SessionState,
  name: string,
  mark: AliasMark,
  blocked: ReadonlySet<string>,
): string | null {
  const view = session.aliasView
  if (view !== null) return blocked.has(name) ? null : (sessionEntry(view, name) ?? null)
  if (!aliasesOn(session)) return null
  const value = sessionEntry(session.aliases, name)
  if (value === undefined || blocked.has(name)) return null
  const seen = session.aliasMarks.get(name)
  if (seen?.[0] === mark[0] && seen[1] === mark[1]) return null
  return value
}

/**
 * Replace alias words, preserving the rest of the command and its guards.
 * Each insertion inherits the replaced word's guards and adds its name.
 * A trailing blank checks the next caller word through the same loop.
 */
export function aliasCommandText(
  session: SessionState,
  node: TSNodeLike,
  head: TSNodeLike,
  mark: AliasMark,
): [string, readonly ReadonlySet<string>[]] | null {
  const source = getText(node)
  const scope = session.aliasExpansion
  let root = node
  while (root.parent != null) root = root.parent
  const base = node.startIndex ?? 0
  const inherited =
    scope !== null && root.id === scope.root
      ? scope.owners.slice(base, node.endIndex)
      : Array<ReadonlySet<string>>(source.length).fill(scope?.names ?? new Set())
  let at = (head.startIndex ?? 0) - base
  let end = (head.endIndex ?? 0) - base
  let name = getText(head)
  const seen = new Set<string>()
  const parts: string[] = []
  const owners: ReadonlySet<string>[] = []
  let cursor = 0
  while (!seen.has(name)) {
    const blocked = inherited[at]
    if (blocked === undefined) throw new Error('alias word has no source')
    const value = aliasValue(session, name, mark, blocked)
    if (value === null) break
    seen.add(name)
    parts.push(source.slice(cursor, at), value)
    for (const owner of inherited.slice(cursor, at)) owners.push(owner)
    const guard = new Set([...blocked, name])
    for (const owner of Array<ReadonlySet<string>>(value.length).fill(guard)) owners.push(owner)
    cursor = end
    if (!value.endsWith(' ') && !value.endsWith('\t')) break
    const match = FIRST_WORD.exec(source.slice(cursor))
    if (match === null) break
    name = match[0]
    at = cursor + match.index
    end = at + name.length
  }
  if (seen.size === 0) return null
  parts.push(source.slice(cursor))
  for (const owner of inherited.slice(cursor)) owners.push(owner)
  return [parts.join(''), owners]
}

/** The `alias` arm; the row marks where the definition was made. */
export function aliasBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(
    handleAlias([...call.argv.args], call.context.session, [
      call.context.session.parseCurrent,
      call.context.session.parseRow + call.row,
    ]),
  )
}

/** The `unalias` arm. */
export function unaliasBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleUnalias([...call.argv.args], call.context.session))
}

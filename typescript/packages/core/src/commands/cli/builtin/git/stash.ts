import git from 'isomorphic-git'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { diff } from './diff.ts'
import { GitError } from './errors.ts'
import { readOptional } from './io.ts'

import { repoArgs } from './repo.ts'
import { opened } from './session.ts'
import { resolveCommit } from './revparse.ts'
import { fatal } from './util.ts'

/** Read the same newest-first stash reflog that real Git writes. */
export async function stashList(inv: CLIInvocation): Promise<CommandFnResult> {
  try {
    const repo = await opened(new FlagView(inv.flags), inv.view ?? {})
    const data = await readOptional(repo.dispatch, repo.location.commondir.join('logs/refs/stash'))
    const rows = new TextDecoder()
      .decode(data ?? new Uint8Array())
      .split('\n')
      .filter(Boolean)
      .reverse()
    const text = rows
      .map((row, index) => `stash@{${String(index)}}: ${row.slice(row.indexOf('\t') + 1)}\n`)
      .join('')
    return [new TextEncoder().encode(text), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/** Compare the saved working tree with the stash's first parent, never current HEAD. */
export async function stashShow(inv: CLIInvocation): Promise<CommandFnResult> {
  try {
    const repo = await opened(new FlagView(inv.flags), inv.view ?? {})
    let selector = inv.texts[0] ?? 'stash@{0}'
    const match = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(selector)
    if (match !== null) {
      const data = await readOptional(
        repo.dispatch,
        repo.location.commondir.join('logs/refs/stash'),
      )
      const rows = new TextDecoder()
        .decode(data ?? new Uint8Array())
        .split('\n')
        .filter(Boolean)
        .reverse()
      const index = Number(match[1] ?? match[2])
      if (rows.length === 0)
        return [
          null,
          new IOResult({
            exitCode: 1,
            stderr: new TextEncoder().encode('No stash entries found.\n'),
          }),
        ]
      if (index >= rows.length)
        throw new GitError(`log for 'stash' only has ${String(rows.length)} entries`)
      const selected = rows[index]?.split(' ')[1]
      if (selected === undefined) throw new GitError('invalid stash reflog')
      selector = selected
    }
    const oid = await resolveCommit(repo, selector)
    const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
    const parent = commit.parent[0]
    if (parent === undefined || commit.parent.length < 2)
      throw new GitError(`'${selector}' is not a stash-like commit`)
    const flags = { ...inv.flags }
    const view = new FlagView(flags)
    if (
      !['patch', 'name_only', 'name_status', 'stat', 'numstat', 'shortstat', 'summary', 'raw'].some(
        (name) => view.asBool(name),
      )
    )
      flags.stat = true
    return await diff({ ...inv, texts: [parent, oid], flags })
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

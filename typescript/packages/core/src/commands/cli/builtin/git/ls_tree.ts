import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  AmbiguousArgumentError,
  EmptyPathspecError,
  GitError,
  InvalidRevisionNameError,
  UsageError,
} from './errors.ts'
import { repoRelative, visiblePath } from './pathspec.ts'
import { quotePath, relativePath } from './render.ts'
import { configBool } from './repo.ts'
import { opened } from './session.ts'
import { listedTree, resolveTree } from './tree.ts'
import { checkSwitches, fatal, startPoint, verbUsage } from './util.ts'

/** List tree metadata without reading file contents. */
export async function lsTree(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkSwitches(inv, inv.texts)
    const [name, ...paths] = inv.texts
    if (name === undefined) throw new UsageError('', verbUsage(inv))
    const repo = await opened(fl, inv.doors ?? {})
    let tree: string
    try {
      tree = await resolveTree(repo, name)
    } catch (err) {
      if (err instanceof AmbiguousArgumentError || err instanceof InvalidRevisionNameError)
        throw new GitError(`Not a valid object name ${name}`)
      throw err
    }
    const fullTree = fl.asBool('full_tree')
    const start = fullTree ? repo.location.worktree.virtual : startPoint(fl).virtual
    const prefix = repoRelative(repo.location, start, '.')
    let patterns = paths.map((path) => {
      if (path === '') throw new EmptyPathspecError()
      const relative = repoRelative(repo.location, start, path)
      const directory = /(?:^|\/)(?:\.\.?|)$/.test(path)
      return relative + (relative && directory ? '/' : '')
    })
    if (!patterns.length && prefix) patterns = [prefix + '/']
    const rows = await listedTree(
      repo,
      tree,
      patterns,
      fl.asBool('r'),
      fl.asBool('t'),
      fl.asBool('d'),
    )
    const fully = await configBool(repo, 'core.quotepath', true)
    const nul = fl.asBool('z')
    const names = fl.asBool('name_only') || fl.asBool('name_status')
    const fullName = fullTree || fl.asBool('full_name')
    const terminator = nul ? '\0' : '\n'
    const out: string[] = []
    for (const [path, mode, oid] of rows) {
      if (!visiblePath(repo.location, path)) continue
      const relative = fullName ? path : relativePath(path, prefix)
      const label = nul ? relative : quotePath(relative, false, fully)
      const kind = mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'
      out.push((names ? '' : `${mode} ${kind} ${oid}\t`) + label + terminator)
    }
    return [encodeText(out.join('')), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

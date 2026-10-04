import { IOResult } from '../../../../io/types.ts'
import { FileType } from '../../../../types.ts'
import { isErofs } from '../../../../utils/errors.ts'
import { resolvePath } from '../../../../utils/path.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { discover } from './discover.ts'
import {
  CannotMkdirError,
  ConfigLockError,
  GitError,
  InitReadOnlyError,
  NoWorkspaceError,
  NoWorkingDirectoryError,
} from './errors.ts'
import { ensureDir, readOptional, takeLock, under, writeFile } from './io.ts'
import { validRefName } from './refs.ts'
import type { Dispatch } from './types.ts'
import { fatal, startPoint } from './util.ts'

/** Write a new git directory's skeleton, keeping what is there. */
export async function layOut(
  dispatch: Dispatch,
  gitdir: string,
  branch: string,
  config: string,
): Promise<void> {
  for (const directory of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags', 'info'])
    await ensureDir(dispatch, under(gitdir, directory))
  const files = {
    HEAD: `ref: refs/heads/${branch}\n`,
    config,
    description: "Unnamed repository; edit this file 'description' to name the repository.\n",
  }
  for (const [name, text] of Object.entries(files)) {
    const path = under(gitdir, name)
    if ((await readOptional(dispatch, path)) === null)
      await writeFile(dispatch, path, new TextEncoder().encode(text))
  }
}

/**
 * The git directory an `init` line names: `--git-dir`, the directory itself
 * under `--bare`, and its `.git` otherwise.
 */
function namedGitdir(fl: FlagView, texts: readonly string[]): string {
  const start = startPoint(fl)
  const explicit = fl.asStr('git_dir')
  if (explicit !== undefined) return resolvePath(explicit, start)
  const target = resolvePath(texts[0] ?? '.', start)
  return fl.asBool('bare') ? target : under(target, '.git')
}

/**
 * Initialize through the dispatcher; no host templates, hooks or branch advisory.
 *
 * Reinitializing takes the config's lock as git does, so a read-only mount
 * refuses a re-init too, in git's words for where it stopped: the directory an operand
 * names, the config's lock, or the first other directory it had to make
 * (pinned against git 2.47.3). With no templates, a bare repository in an
 * existing directory stops at `objects` where git stops at its first template
 * directory.
 */
export async function init(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const doors = inv.doors ?? {}
  try {
    if (
      doors.dispatch === undefined ||
      doors.statPath === undefined ||
      doors.ns?.mounts === undefined
    )
      throw new NoWorkspaceError()
    const dispatch = doors.dispatch
    const mounts = doors.ns.mounts
    const start = startPoint(fl)
    const here = await doors.statPath(start)
    if (here?.type !== FileType.DIRECTORY)
      throw new NoWorkingDirectoryError(
        start,
        here === null ? 'No such file or directory' : 'Not a directory',
      )
    const target = resolvePath(inv.texts[0] ?? '.', start)
    const bare = fl.asBool('bare')
    let gitdir = namedGitdir(fl, inv.texts)
    const branch = fl.asStr('initial_branch') ?? 'master'
    if (!validRefName(`refs/heads/${branch}`) || branch.startsWith('-'))
      throw new GitError(`invalid branch name: '${branch}'`)
    const info = await doors.statPath(gitdir)
    if (
      info !== null &&
      (info.type !== FileType.DIRECTORY ||
        (await readOptional(dispatch, under(gitdir, 'HEAD'))) !== null)
    ) {
      const location = await discover(
        dispatch,
        doors.statPath,
        (path) => mounts.rootOf(path),
        target,
        gitdir,
        fl.asStr('work_tree') ?? null,
      )
      gitdir = location.commondir
    }
    const existing = (await readOptional(dispatch, under(gitdir, 'HEAD'))) !== null
    const [typed] = inv.texts
    const made = typed !== undefined && (await doors.statPath(target)) === null
    const settings = under(gitdir, 'config')
    try {
      await layOut(
        dispatch,
        gitdir,
        branch,
        `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${bare ? 'true' : 'false'}\n`,
      )
      if (existing) await takeLock(dispatch, settings)
    } catch (err) {
      if (!isErofs(err)) throw err
      if (made) throw new CannotMkdirError(typed)
      const path = (err as { virtualPath?: string }).virtualPath
      if (path === `${settings}.lock`) throw new ConfigLockError(settings)
      throw new InitReadOnlyError(path ?? gitdir)
    }
    const text = existing
      ? `Reinitialized existing Git repository in ${gitdir}/\n`
      : `Initialized empty Git repository in ${gitdir}/\n`
    const warning =
      existing && fl.asStr('initial_branch')
        ? `warning: re-init: ignored --initial-branch=${branch}\n`
        : ''
    return [
      new TextEncoder().encode(fl.asBool('quiet') ? '' : text),
      new IOResult({ stderr: new TextEncoder().encode(warning) }),
    ]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { PathSpec, FileType } from '../../../../types.ts'

import { IOResult } from '../../../../io/types.ts'
import { isEexist, isErofs } from '../../../../errors/fs.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { discover } from './discover.ts'
import {
  CannotMkdirError,
  ConfigLockError,
  GitError,
  InitReadOnlyError,
  NoWorkspaceError,
  NoWorkingDirectoryError,
} from './errors.ts'
import { ensureDir, readOptional, statOf, takeLock, writeFile } from './io.ts'
import { DEFAULT_BRANCH } from './constants.ts'
import { validRefName } from './refs.ts'
import type { Files } from '../../../../workspace/files.ts'
import { fatal, startPoint } from './util.ts'

/** Write a new git directory's skeleton, keeping what is there. */
export async function layOut(
  vfs: Files,
  gitdir: PathSpec,
  branch: string,
  config: string,
): Promise<void> {
  for (const directory of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags', 'info'])
    await ensureDir(vfs, gitdir.join(directory))
  const files = {
    HEAD: `ref: refs/heads/${branch}\n`,
    config,
    description: "Unnamed repository; edit this file 'description' to name the repository.\n",
  }
  for (const [name, text] of Object.entries(files)) {
    const path = gitdir.join(name)
    if ((await readOptional(vfs, path)) === null)
      await writeFile(vfs, path, new TextEncoder().encode(text))
  }
}

/**
 * The git directory an `init` line names: `--git-dir`, the directory itself
 * under `--bare`, and its `.git` otherwise.
 */
function namedGitdir(fl: FlagView, texts: readonly string[]): PathSpec {
  const start = startPoint(fl)
  const explicit = fl.asPath('git_dir')
  if (explicit !== undefined) return explicit
  const target = PathSpec.fromStrPath(texts[0] ?? '.', undefined, start)
  return fl.asBool('bare') ? target : target.join('.git')
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
export async function init(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  try {
    if (ctx.vfs === undefined) throw new NoWorkspaceError()
    const vfs = ctx.vfs
    const start = startPoint(fl)
    const here = await statOf(vfs, start)
    if (here?.type !== FileType.DIRECTORY)
      throw new NoWorkingDirectoryError(start.rawPath, here === null ? 'ENOENT' : 'ENOTDIR')
    const target = PathSpec.fromStrPath(texts[0] ?? '.', undefined, start)
    if (target.walkError === 'ENOENT')
      throw new CannotMkdirError(target.rawPath, 'No such file or directory')
    const bare = fl.asBool('bare')
    let gitdir = namedGitdir(fl, texts)
    const branch = fl.asStr('initial_branch', DEFAULT_BRANCH)
    // The ref rules alone: unlike a branch made later, the first one may be
    // named HEAD or start with a dash (pinned against git 2.47.3 and 2.50.1).
    if (!validRefName(`refs/heads/${branch}`))
      throw new GitError(`invalid initial branch name: '${branch}'`)
    const info = await statOf(vfs, gitdir)
    if (
      info !== null &&
      (info.type !== FileType.DIRECTORY || (await readOptional(vfs, gitdir.join('HEAD'))) !== null)
    ) {
      const location = await discover(vfs, target, gitdir, fl.asPath('work_tree') ?? null)
      gitdir = location.commondir
    }
    const existing = (await readOptional(vfs, gitdir.join('HEAD'))) !== null
    const [typed] = texts
    const made = typed !== undefined && (await statOf(vfs, target)) === null
    const settings = gitdir.join('config')
    try {
      await layOut(
        vfs,
        gitdir,
        branch,
        `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${bare ? 'true' : 'false'}\n`,
      )
      if (existing) await takeLock(vfs, settings)
    } catch (err) {
      const path = (err as { virtualPath?: string }).virtualPath
      const locked = path === `${settings.virtual}.lock`
      if (locked && isEexist(err)) throw new ConfigLockError(settings.virtual, 'EEXIST')
      if (!isErofs(err)) throw err
      if (made) throw new CannotMkdirError(typed)
      if (locked) throw new ConfigLockError(settings.virtual, 'EROFS')
      throw new InitReadOnlyError(path ?? gitdir.virtual)
    }
    const text = existing
      ? `Reinitialized existing Git repository in ${gitdir.virtual}/\n`
      : `Initialized empty Git repository in ${gitdir.virtual}/\n`
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

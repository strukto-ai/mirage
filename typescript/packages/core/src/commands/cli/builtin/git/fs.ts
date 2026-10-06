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

import { GitConfigManager } from 'isomorphic-git/managers'
import { FileSystem } from 'isomorphic-git/models'

import { FileType, PathSpec } from '../../../../types.ts'
import type { FileStat } from '../../../../types.ts'
import { enoent } from '../../../../errors/fs.ts'
import { basename, ensureDir, exists, readNames, removeFile, under } from './io.ts'
import type { Dispatch, RepoLocation } from './types.ts'
import { posixNormpath } from '../../../../utils/path.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** The fields of one line of isomorphic-git's parsed config that a raw read needs. */
export interface ConfigLine {
  readonly path: string
  readonly name: string | null
  readonly value: string | null
}

/** A parsed line as isomorphic-git leaves it, its subsection still escaped. */
interface ParsedLine extends ConfigLine {
  readonly section: string | null
  readonly subsection?: string | null
}

/**
 * The lines that hold a variable, each keyed the way git reads it.
 *
 * isomorphic-git keeps a quoted subsection's escapes, so `[branch "q\"x"]`
 * came back as `branch.q\"x.remote` and a lookup for the branch `q"x` found
 * nothing; git drops the backslash before any character.
 */
function variables(parsed: readonly ParsedLine[]): ConfigLine[] {
  return parsed
    .filter((line) => line.name !== null)
    .map((line) => {
      const { section, subsection, name } = line
      if (typeof subsection !== 'string' || section === null || name === null) return line
      const unescaped = subsection.replace(/\\(.)/g, '$1')
      return { ...line, path: `${section.toLowerCase()}.${unescaped}.${name.toLowerCase()}` }
    })
}

/**
 * The variables of one config file's text, in file order, as isomorphic-git
 * parses them: `path` is the dotted key, section and name folded, and `value`
 * the raw string git prints. Read from text rather than a git directory
 * because `--global` names files that are not called `config`.
 *
 * @param text the file's contents
 */
export async function configLines(text: string): Promise<readonly ConfigLine[]> {
  const config = await GitConfigManager.get({
    fs: { read: () => Promise.resolve(text) } as never,
    gitdir: '',
  })
  return variables(config.parsedConfig as readonly ParsedLine[])
}

/**
 * The stat shape isomorphic-git reads. It consults `type`, `mode`, `size` and
 * the mtime, and calls `isDirectory()`/`isFile()`/`isSymbolicLink()`; the
 * numeric device fields feed its index stat cache, which mirage zeroes on
 * purpose so nothing downstream trusts it (see IndexEntry in types.ts).
 */
class GitStat {
  readonly type: 'file' | 'dir'
  readonly mode: number
  readonly size: number
  readonly ino = 0
  readonly dev = 0
  readonly uid = 0
  readonly gid = 0
  readonly ctimeMs: number
  readonly mtimeMs: number
  readonly ctimeSeconds: number
  readonly mtimeSeconds: number
  readonly ctimeNanoseconds = 0
  readonly mtimeNanoseconds = 0

  constructor(stat: FileStat) {
    const dir = stat.type === FileType.DIRECTORY
    this.type = dir ? 'dir' : 'file'
    this.mode = stat.mode ?? (dir ? 0o040755 : 0o100644)
    this.size = stat.size ?? 0
    const ms = stat.modified === null ? 0 : Date.parse(stat.modified) || 0
    this.ctimeMs = ms
    this.mtimeMs = ms
    this.ctimeSeconds = Math.floor(ms / 1000)
    this.mtimeSeconds = Math.floor(ms / 1000)
  }

  isDirectory(): boolean {
    return this.type === 'dir'
  }

  isFile(): boolean {
    return this.type === 'file'
  }

  isSymbolicLink(): boolean {
    return false
  }
}

/**
 * A `PromiseFsClient` whose bytes come from a mirage mount.
 *
 * isomorphic-git reaches a repository through nothing but this object, so a
 * repository on S3, in RAM or over SSH is the same repository to it. That is
 * the whole bridge, and it is why the TypeScript side needs no counterpart to
 * Python's `objects.py`/`lazyfile.py`: dulwich's object store is synchronous, so
 * Python has to hand-build a lazy store and marshal every read onto the
 * workspace loop, while isomorphic-git is async to begin with and reads
 * packfiles, loose objects and the index itself.
 *
 * Symlinks are refused rather than faked. mirage keeps links in the namespace
 * rather than in any backend, so a `readlink` here would have to consult a
 * different layer than every other call, and no verb mirrored so far writes or
 * follows one inside a `.git` directory.
 */
export function gitFs(
  source: Dispatch,
  location?: RepoLocation,
): {
  promises: Record<string, (...args: never[]) => Promise<unknown>>
} {
  // isomorphic-git accepts one gitdir and does not follow commondir itself.
  // Route shared storage here so every library operation keeps the selected
  // checkout's HEAD/index while using the common objects, refs and config.
  const dispatch: Dispatch = (op, path, args, kwargs) => {
    let virtual = posixNormpath(path.virtual)
    if (location !== undefined && location.gitdir !== location.commondir) {
      const prefix = `${location.gitdir}/`
      if (virtual.startsWith(prefix)) {
        const relative = virtual.slice(prefix.length)
        const shared = ['objects', 'refs', 'packed-refs', 'config', 'shallow'].some(
          (name) => relative === name || relative.startsWith(`${name}/`),
        )
        const local = ['refs/bisect', 'refs/worktree', 'refs/rewritten'].some(
          (name) => relative === name || relative.startsWith(`${name}/`),
        )
        if (shared && !local) virtual = under(location.commondir, relative)
      }
    }
    return source(op, PathSpec.fromStrPath(virtual), args, kwargs)
  }
  const readFile = async (path: string, options?: string | { encoding?: string }) => {
    const encoding = typeof options === 'string' ? options : options?.encoding
    const [data] = await dispatch('read', PathSpec.fromStrPath(path))
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
    return encoding === undefined ? bytes : DEC.decode(bytes)
  }

  const writeFile = async (path: string, data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? ENC.encode(data) : data
    await ensureDir(dispatch, path.slice(0, path.lastIndexOf('/')) || '/')
    await dispatch('write', PathSpec.fromStrPath(path), [bytes])
  }

  const stat = async (path: string) => {
    const [got] = await dispatch('stat', PathSpec.fromStrPath(path))
    if (got === null) throw enoent(path)
    return new GitStat(got as FileStat)
  }

  return {
    promises: {
      readFile,
      writeFile,
      unlink: async (path: string) => {
        await removeFile(dispatch, path)
      },
      // isomorphic-git wants bare names; backends may report either those or
      // whole paths, with or without a trailing slash.
      readdir: async (path: string) => (await readNames(dispatch, path)).map(basename),
      mkdir: async (path: string) => {
        await ensureDir(dispatch, path)
      },
      rmdir: async (path: string) => {
        await dispatch('rmdir', PathSpec.fromStrPath(path))
      },
      stat,
      // A mount has no links below it, so lstat is stat.
      lstat: stat,
      readlink: () => Promise.reject(new Error('mirage git: symlinks are not read here')),
      symlink: () => Promise.reject(new Error('mirage git: symlinks are not written here')),
      // git chmods a loose object to 0444; the mount decides its own modes and
      // writeOnce never rewrites one, so there is nothing to enforce.
      chmod: () => Promise.resolve(),
      exists: (path: string) => exists(dispatch, path),
    } as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
  }
}

/**
 * Every value a variable takes in the repository's config, as written.
 *
 * Read below `git.getConfig`, which casts `core.bare` and a few other keys
 * itself, and only when they are spelled in lowercase and hold a word:
 * `[Core] Bare = true` came back a string and `bare = 1` threw. A linked
 * worktree's config is its repository's.
 *
 * @param dispatch workspace op dispatcher
 * @param location the discovered repository
 * @param path the variable, e.g. `core.bare`; its section and name in any case
 */
export async function configValues(
  dispatch: Dispatch,
  location: RepoLocation,
  path: string,
): Promise<string[]> {
  const config = await GitConfigManager.get({
    fs: new FileSystem(gitFs(dispatch)) as never,
    gitdir: location.commondir,
  })
  // Section and name fold case; a subsection between them does not.
  const first = path.indexOf('.')
  const last = path.lastIndexOf('.')
  const key =
    path.slice(0, first).toLowerCase() + path.slice(first, last) + path.slice(last).toLowerCase()
  return variables(config.parsedConfig as readonly ParsedLine[])
    .filter((line) => line.path === key)
    .map((line) => line.value ?? '')
}

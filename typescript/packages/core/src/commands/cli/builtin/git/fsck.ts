import git from 'isomorphic-git'
import Hash from 'sha.js'
import type { StatPath } from '../../../../ops/types.ts'
import { type PathSpec, FileType, type FileStat } from '../../../../types.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { sha1Hex } from '../../../../utils/hash.ts'
import { isWalkError, gnuStrerror } from '../../../../utils/errors.ts'
import { toHex } from '../../../../utils/hex.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError, NoWorkspaceError } from './errors.ts'
import { readIndex } from './index_file.ts'
import { basename, readFile, readNames, readOptional, readRange } from './io.ts'

import { loadRefs } from './refs.ts'
import { repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import type { Dispatch } from './types.ts'
import { fatal } from './util.ts'

const PACK_BLOCK = 1 << 18

/** Hash bounded ranges, retaining only the trailing SHA-1 between reads. */
export async function checkPack(
  dispatch: Dispatch,
  path: PathSpec,
  expected: Uint8Array,
): Promise<void> {
  const digest = new Hash.sha1()
  let tail = new Uint8Array()
  let offset = 0
  try {
    const [info] = await dispatch('stat', path)
    const size = (info as FileStat | null)?.size ?? null
    while (size === null || offset < size) {
      const count = size === null ? PACK_BLOCK : Math.min(PACK_BLOCK, size - offset)
      const chunk = await readRange(dispatch, path, offset, count)
      if (chunk.length === 0) {
        if (size !== null && offset < size) throw new GitError(`truncated pack: ${path.virtual}`)
        break
      }
      offset += chunk.length
      const buffered = new Uint8Array(tail.length + chunk.length)
      buffered.set(tail)
      buffered.set(chunk, tail.length)
      if (buffered.length > 20) digest.update(buffered.subarray(0, -20))
      tail = buffered.slice(-20)
      if (offset % (4 * PACK_BLOCK) === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (size === null && chunk.length < count) break
    }
  } catch (err) {
    if (!isWalkError(err)) throw err
    const detail =
      gnuStrerror((err as { code?: string }).code) ??
      (err instanceof Error ? err.message : String(err))
    const failure = new GitError(`cannot read pack ${path.virtual}: ${detail}`)
    failure.cause = err
    throw failure
  }
  if (offset < 32) throw new GitError(`truncated pack: ${path.virtual}`)
  if (digest.digest('hex') !== toHex(tail) || toHex(tail) !== toHex(expected))
    throw new GitError(`pack checksum mismatch: ${path.virtual}`)
}

async function objectIds(repo: Repo): Promise<Set<string>> {
  const root = repo.location.commondir.join('objects')
  const ids = new Set<string>()
  for (const entry of await readNames(repo.dispatch, root)) {
    const fanout = basename(entry)
    if (!/^[0-9a-f]{2}$/.test(fanout)) continue
    for (const name of await readNames(repo.dispatch, root.join(fanout))) {
      const oid = fanout + basename(name)
      if (/^[0-9a-f]{40}$/.test(oid)) ids.add(oid)
    }
  }
  for (const entry of await readNames(repo.dispatch, root.join('pack'))) {
    const name = basename(entry)
    if (!name.endsWith('.idx')) continue
    const data = await readFile(repo.dispatch, root.join(`pack/${name}`))
    if (data.length < 1064) throw new GitError(`truncated pack index: ${name}`)
    if ((await sha1Hex(data.subarray(0, -20))) !== toHex(data.subarray(-20)))
      throw new GitError(`pack index checksum mismatch: ${name}`)
    const packName = name.slice(0, -4) + '.pack'
    await checkPack(repo.dispatch, root.join(`pack/${packName}`), data.subarray(-40, -20))
    const view = new DataView(data.buffer, data.byteOffset, data.length)
    const v2 = view.getUint32(0) === 0xff744f63
    if (v2 && view.getUint32(4) !== 2) throw new GitError(`unsupported pack index: ${name}`)
    const count = view.getUint32((v2 ? 8 : 0) + 255 * 4)
    for (let index = 0; index < count; index += 1) {
      const offset = v2 ? 1032 + index * 20 : 1024 + index * 24 + 4
      if (offset + 20 > data.length - 40) throw new GitError(`truncated pack index: ${name}`)
      ids.add(toHex(data.subarray(offset, offset + 20)))
    }
  }
  return ids
}

async function logRoots(
  dispatch: Dispatch,
  statPath: StatPath,
  path: PathSpec,
): Promise<Set<string>> {
  const found = new Set<string>()
  for (const entry of await readNames(dispatch, path)) {
    const target = path.join(basename(entry))
    if ((await statPath(target))?.type === FileType.DIRECTORY) {
      for (const oid of await logRoots(dispatch, statPath, target)) found.add(oid)
    } else {
      const data = await readOptional(dispatch, target)
      for (const line of new TextDecoder().decode(data ?? new Uint8Array()).split('\n')) {
        for (const oid of line.split(' ').slice(0, 2))
          if (/^[0-9a-f]{40}$/.test(oid) && oid !== '0'.repeat(40)) found.add(oid)
      }
    }
  }
  return found
}

/** Hash and decode every object, including unreachable objects and packed objects. */
export async function fsck(inv: CLIInvocation): Promise<CommandFnResult> {
  try {
    const fl = new FlagView(inv.flags)
    const doors = inv.doors ?? {}
    const statPath = doors.statPath
    if (statPath === undefined) throw new NoWorkspaceError()
    const repo = await opened(fl, doors)
    const args = repoArgs(repo)
    const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
    const roots = new Set([...refs.values()].filter((oid) => !oid.startsWith('ref: ')))
    const index = await readIndex(repo, repo.dispatch)
    for (const entry of index.entries.values()) if (entry.mode !== 0o160000) roots.add(entry.oid)
    for (const directory of new Set([repo.location.gitdir, repo.location.commondir])) {
      for (const oid of await logRoots(repo.dispatch, statPath, directory.join('logs')))
        roots.add(oid)
    }
    const referenced = new Set(roots)
    const objects = new Map<string, string>()
    const errors: string[] = []
    const ids = await objectIds(repo)
    for (const oid of roots) ids.add(oid)
    for (const oid of [...ids].sort(compareCodePoints)) {
      try {
        // fsck must inspect unknown object types and their exact encoded content.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const result = await git.readObject({ ...args, oid, format: 'content' })
        const body = result.object as Uint8Array
        const header = new TextEncoder().encode(`${result.type} ${String(body.length)}\0`)
        const wrapped = new Uint8Array(header.length + body.length)
        wrapped.set(header)
        wrapped.set(body, header.length)
        if ((await sha1Hex(wrapped)) !== oid) throw new Error('hash mismatch')
        if (result.type === 'commit') {
          const { commit } = await git.readCommit({ ...args, oid })
          referenced.add(commit.tree)
          for (const parent of commit.parent) referenced.add(parent)
        } else if (result.type === 'tree') {
          const { tree } = await git.readTree({ ...args, oid })
          for (const entry of tree) if (entry.mode !== '160000') referenced.add(entry.oid)
        } else if (result.type === 'tag') {
          const { tag } = await git.readTag({ ...args, oid })
          referenced.add(tag.object)
        } else if (result.type !== 'blob') throw new Error(`invalid object type: ${result.type}`)
        objects.set(oid, result.type)
      } catch (err) {
        errors.push(`error: object ${oid}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
    for (const oid of [...referenced].sort(compareCodePoints))
      if (!objects.has(oid) && !roots.has(oid)) errors.push(`missing object ${oid}\n`)
    let stderr = errors.join('')
    if (roots.size === 0) {
      const head = await readOptional(repo.dispatch, repo.location.gitdir.join('HEAD'))
      const branch = new TextDecoder()
        .decode(head ?? new Uint8Array())
        .trim()
        .replace(/^ref: refs\/heads\//, '')
      stderr =
        `notice: HEAD points to an unborn branch (${branch})\nnotice: No default references\n` +
        stderr
    }
    const stdout = fl.asBool('no_dangling')
      ? ''
      : [...objects]
          .filter(([oid]) => !referenced.has(oid))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([oid, type]) => `dangling ${type} ${oid}\n`)
          .join('')
    return [
      new TextEncoder().encode(stdout),
      new IOResult({ exitCode: errors.length ? 1 : 0, stderr: new TextEncoder().encode(stderr) }),
    ]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

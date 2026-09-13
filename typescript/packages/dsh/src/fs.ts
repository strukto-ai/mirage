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

import { Buffer } from 'node:buffer'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { DiskResource } from '@struktoai/mirage-node'
import type { MountEntry } from '@struktoai/mirage-core/workspace/mount/mount'
import type { Ops } from '@struktoai/mirage-core/ops/ops'
import { FileType } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { isMissingPath } from '@struktoai/mirage-core/utils/errors'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { assertNotAborted, mapMirageError } from './errors.ts'
import {
  applyLiteralEdit,
  decodeStrictText,
  detectsCrlf,
  normalizeLineEndings,
  restoreLineEndings,
} from './text.ts'
import type {} from './service.ts'

type LinksSeam = NonNullable<Ops['links']>

// Read off the seam's own signature rather than imported: the policy type
// lives in `@deepseek-ai/dsh-sandbox`, which reaches this package only as a
// transitive dependency of dsh-fs, and naming a fourth exact-pinned peer to
// spell one parameter would couple the adapter to a package it never calls.
type SandboxPolicy = Parameters<FileSystem['writeText']>[4]

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** Configuration for the mirage filesystem backend. */
export interface MirageFsConfig {
  /** Virtual base directory for relative paths. Defaults to `/`. */
  cwd?: string
  /** Exclusive byte limit on each overwrite-diff side. Defaults to 10 MiB. */
  diffBasisMaxBytes?: number
}

// The freshness token behind FsVersion. Backends that report a fingerprint
// or revision get a content-derived token; the rest fall back to metadata
// (modified + size), and a backend reporting neither yields a constant, so
// stale guards degrade to always-fresh there instead of always-stale.
function versionOf(stat: FileStat): FsVersion {
  if (stat.fingerprint !== null) return FsVersion(`fp:${stat.fingerprint}`)
  if (stat.revision !== null) return FsVersion(`rev:${stat.revision}`)
  if (stat.modified !== null || stat.size !== null) {
    return FsVersion(`meta:${stat.modified ?? ''}:${String(stat.size ?? '')}`)
  }
  return FsVersion('unversioned')
}

function typeOf(stat: FileStat): FsInfo['type'] {
  switch (stat.type) {
    case FileType.DIRECTORY:
      return 'directory'
    case FileType.SYMLINK:
      return 'other'
    default:
      return 'file'
  }
}

async function* singleChunk(text: string): AsyncGenerator<string, void, void> {
  yield await Promise.resolve(text)
}

function tooLarge(displayPath: string, maxBytes: number, size?: number): FsError {
  const found = size === undefined ? '' : `${String(size)} bytes `
  return new FsError(
    `cannot read "${displayPath}": ${found}exceeds the ${String(maxBytes)} byte cap`,
    'FS_TOO_LARGE',
  )
}

/**
 * Whether a `relative()` result leaves the directory it was taken from.
 *
 * Only a bare `..` or a leading `..` SEGMENT escapes: a name may itself
 * begin with two dots (`..draft`), and testing the prefix alone reads
 * that ordinary file as an escape.
 *
 * @param rel the result of `relative(root, target)`.
 * @returns true when the target lies outside the root.
 */
function escapesRoot(rel: string): boolean {
  // An absolute answer means there was no relative route at all, which on
  // win32 is a different drive.
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * The prefix of the mount a virtual path actually dispatches to.
 *
 * The deepest mount whose prefix covers the path wins, which is the rule
 * dispatch itself follows; a mount nested inside another's tree owns its
 * subtree outright.
 *
 * @param virtual an absolute virtual path.
 * @param mounts the workspace's mount table.
 * @returns the winning mount's prefix, or undefined when none covers it.
 */
function ownerPrefixOf(virtual: string, mounts: readonly MountEntry[]): string | undefined {
  const probe = virtual.endsWith('/') ? virtual : `${virtual}/`
  let winner: string | undefined
  for (const mount of mounts) {
    if (!probe.startsWith(mount.prefix)) continue
    if (winner === undefined || mount.prefix.length > winner.length) winner = mount.prefix
  }
  return winner
}

/**
 * Mirage-backed implementation of `ctx.fs`. Targets are canonical virtual
 * paths (namespace symlinks followed), every operation walks the workspace
 * op door — session grants, admission policies, cache read-through and
 * post-write invalidation all fire exactly as they do for a shell command —
 * and `processPath` answers in the same virtual path space the mirage shell
 * executes in, so the two providers share one execution world.
 *
 * One limit worth stating: mirage's op facade takes no `AbortSignal`, so
 * cancellation is honored at this adapter's own boundaries (before a
 * dispatch, between listing entries) and not inside a single op. A long
 * read from a remote backend therefore runs to completion after the
 * signal fires, and the caller learns of the abort when it returns.
 */
export class MirageFileSystem extends FileSystem {
  static readonly inject = ['mirage']

  private fsOps: Ops | null = null
  private readonly cwd: string
  private readonly diffBasisMaxBytes: number
  // Per-targetKey tail promise: serializes mutating ops so the
  // read -> guard -> write window cannot interleave (one concurrent writer
  // wins, the rest observe the new version and reject as stale).
  private readonly locks = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: MirageFsConfig = {}) {
    super(ctx)
    this.cwd = config.cwd ?? '/'
    this.diffBasisMaxBytes = config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES
  }

  // The workspace may still be building (declarative mounts resolve
  // asynchronously), so every entry point awaits the service's `ready`
  // once and caches the op door. The caller's signal can fire during
  // that wait, after its entry assertion passed, so it is asserted
  // again here, before the op it guards dispatches.
  private async ops(signal?: AbortSignal, operation = 'ready'): Promise<Ops> {
    this.fsOps ??= (await this.ctx.mirage.ready).fs
    assertNotAborted(signal, operation)
    return this.fsOps
  }

  private get links(): LinksSeam | null {
    if (this.fsOps === null) {
      throw new Error('mirage: filesystem used before the workspace is ready')
    }
    return this.fsOps.links
  }

  /**
   * The same confinement claim `MirageShellExecutor` makes, off the same
   * fact and for the same reason: with every runtime reaching only the
   * vfs, a mutation cannot land anywhere but a mount, under its mode.
   *
   * The two seams sit over one world, so answering differently here
   * would let dsh fence a bash write and wave an identical `ctx.fs`
   * write straight through.
   */
  override get sandboxMode(): FileSystem['sandboxMode'] {
    return this.ctx.mirage.vfsOnly ? 'workspace-write' : undefined
  }

  /**
   * Refuse a mutation the call's sandbox policy does not allow.
   *
   * `workspaceRoot` is deliberately not consulted: it is a directory on
   * the harness's own machine, so containment against it says nothing
   * about this world. The mounts and their modes are the boundary, and
   * `read-only` is the one mode that narrows them further. Wording and
   * code mirror `dsh-fs-sandbox`, so the tool layer renders one denial
   * marker whichever backend refused.
   *
   * @param policy the per-call policy, absent for an unguarded mutation.
   * @param displayPath the path to name in the refusal.
   */
  private assertMutable(policy: SandboxPolicy, displayPath: string): void {
    if (policy?.mode !== 'read-only') return
    throw new FsError(
      `cannot write "${displayPath}": file access denied under read-only mode`,
      'FS_SANDBOX_DENIED',
    )
  }

  /**
   * The base a relative path resolves against.
   *
   * dsh hands `ctx.fs` either the calling session's cwd or the sandbox
   * policy's workspace root, and both are directories on the harness's
   * own machine that name nothing here. Resolving `notes.txt` against
   * one yields `/Users/.../notes.txt`, which every read then reports as
   * absent. So a base that is not a directory in this world falls back
   * to the configured one, the same rule the shell executor applies to
   * a workdir.
   *
   * An absolute path ignores its base, so it never pays for the probe.
   *
   * @param path the path being resolved.
   * @param cwd the caller's base, if any.
   * @returns the base to resolve against.
   */
  private async resolveBase(path: string, cwd: string | undefined): Promise<string> {
    if (cwd === undefined || posix.isAbsolute(path)) return this.cwd
    const ws = await this.ctx.mirage.ready
    return (await ws.fs.isDir(cwd)) ? cwd : this.cwd
  }

  private normalize(path: string, base: string): string {
    return posix.resolve(base, path)
  }

  private follow(path: string): string {
    const links = this.links
    if (links === null) return path
    try {
      return links.follow(path)
    } catch (err) {
      throw mapMirageError(err, 'resolve', path)
    }
  }

  private withLock<T>(key: FsTargetKey, body: () => Promise<T>): Promise<T> {
    const mapKey = String(key)
    const previous = this.locks.get(mapKey) ?? Promise.resolve()
    const next = previous.then(body, body)
    // The stored tail is void (an outcome would pin whole file contents in
    // the map) and drops on settlement unless a newer op queued behind it.
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(mapKey, tail)
    void tail.then(() => {
      if (this.locks.get(mapKey) === tail) this.locks.delete(mapKey)
    })
    return next
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    await this.ops(opts?.signal, 'resolve')
    const followed = this.follow(this.normalize(path, await this.resolveBase(path, opts?.cwd)))
    return { targetKey: FsTargetKey(followed), displayPath: followed }
  }

  processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  /**
   * The workspace path naming the same file as `hostPath`, when a mount
   * puts one there.
   *
   * Most of this world has no host spelling at all: an S3 key, a Slack
   * message and a Notion row are not files the harness could open, and
   * claiming otherwise would hand the caller a path that reads as the
   * wrong bytes. A disk mount is the one place the two worlds hold the
   * same file, so it is the one place a host path is answerable; every
   * other mount declines, and so does a workspace still building.
   *
   * @param hostPath absolute path in the harness host filesystem.
   * @returns the virtual path for the same file, or undefined when no
   *   mount maps it.
   */
  override processPathFromHostPath(hostPath: string): string | undefined {
    if (!isAbsolute(hostPath)) return undefined
    const workspace = this.ctx.mirage.workspaceIfReady
    if (workspace === null) return undefined
    const host = resolve(hostPath)
    const mounts = workspace.mounts()
    for (const entry of mounts) {
      const { resource } = entry
      if (!(resource instanceof DiskResource)) continue
      const rel = relative(resource.root, host)
      if (escapesRoot(rel)) continue
      // `prefix` always carries a trailing slash, and `rel` is empty for
      // the root itself, so the join is a concatenation and the slash is
      // trimmed back off unless the mount is the workspace root.
      const joined = `${entry.prefix}${rel.split(sep).join('/')}`
      const virtual = joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined
      // A mount nested under this one owns its own subtree, and dispatch
      // routes the path there, so the disk file at this host location is
      // not what the virtual path reads. Keep looking rather than name a
      // path that answers with another resource's bytes.
      if (ownerPrefixOf(virtual, mounts) !== entry.prefix) continue
      return virtual
    }
    return undefined
  }

  fileUrl(target: FsTarget): string {
    const encoded = String(target.targetKey).split('/').map(encodeURIComponent).join('/')
    return `file://${encoded}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const parentKey = String(parent.targetKey)
    const childKey = String(child.targetKey)
    if (parentKey === childKey) return true
    const prefix = parentKey === '/' ? '/' : `${parentKey}/`
    return childKey.startsWith(prefix)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const key = String(target.targetKey)
    let stat: FileStat
    try {
      stat = await (await this.ops(signal, 'stat')).stat(key)
    } catch (err) {
      if (isMissingPath(err)) return undefined
      throw mapMirageError(err, 'stat', target.displayPath)
    }
    return {
      version: versionOf(stat),
      type: typeOf(stat),
      ...(stat.size !== null ? { size: stat.size } : {}),
    }
  }

  async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    await this.ops(signal, 'lstat')
    const normalized = this.normalize(path, await this.resolveBase(path, opts?.cwd))
    // Follow every component except the last: the probe is about the path
    // entry itself, so a link at the leaf must report as one.
    const parentFollowed =
      normalized === '/'
        ? '/'
        : posix.join(this.follow(posix.dirname(normalized)), posix.basename(normalized))
    const links = this.links
    if (links?.isLink(parentFollowed) === true) {
      const linkTarget = links.readlink(parentFollowed) ?? ''
      return {
        version: FsVersion(`link:${linkTarget}`),
        type: 'symlink',
        size: new TextEncoder().encode(linkTarget).byteLength,
      }
    }
    let stat: FileStat
    try {
      stat = await (await this.ops(signal, 'lstat')).stat(parentFollowed)
    } catch (err) {
      if (isMissingPath(err)) return undefined
      throw mapMirageError(err, 'lstat', normalized)
    }
    return {
      version: versionOf(stat),
      type: typeOf(stat) === 'directory' ? 'directory' : typeOf(stat),
      ...(stat.size !== null ? { size: stat.size } : {}),
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal, 'read')
    const key = String(target.targetKey)
    let bytes: Uint8Array
    try {
      bytes = await (await this.ops(signal, 'read')).readFile(key)
    } catch (err) {
      throw mapMirageError(err, 'read', target.displayPath)
    }
    return decodeStrictText(bytes, target.displayPath)
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // mirage reads land as one rendered buffer, so streaming is a single
    // chunk with readText's exact text semantics.
    const text = await this.readText(target, signal)
    return singleChunk(text)
  }

  /**
   * Stat a read target and refuse anything that is not a regular file.
   *
   * A backend read of a directory key surfaces as a missing path, which
   * would report a path that plainly exists as absent.
   *
   * @param target the resolved target about to be read.
   * @param signal aborts the stat.
   * @returns the stat row, or undefined when the mount reports none.
   */
  private async statRegularFile(
    target: FsTarget,
    signal: AbortSignal | undefined,
  ): Promise<FsInfo | undefined> {
    const info = await this.stat(target, signal)
    if (info !== undefined && info.type !== 'file') {
      throw new FsError(
        `cannot read "${target.displayPath}": not a regular file`,
        'FS_NOT_REGULAR_FILE',
      )
    }
    return info
  }

  async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    assertNotAborted(signal, 'read')
    const info = await this.statRegularFile(target, signal)
    if (info?.size !== undefined && info.size > maxBytes) {
      throw tooLarge(target.displayPath, maxBytes, info.size)
    }
    // Ask for one byte past the cap rather than the whole object: a backend
    // with a native range fetches only that window, and a full-length answer
    // is itself the proof the file is over the cap, which is what a mount
    // reporting no size (most API mounts) has no other way to establish.
    const key = String(target.targetKey)
    let bytes: Uint8Array
    try {
      bytes = await (await this.ops(signal, 'read')).readFile(key, { size: maxBytes + 1 })
    } catch (err) {
      throw mapMirageError(err, 'read', target.displayPath)
    }
    if (bytes.byteLength > maxBytes) {
      throw tooLarge(target.displayPath, maxBytes)
    }
    return bytes
  }

  async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    assertNotAborted(signal, 'read')
    await this.statRegularFile(target, signal)
    // No store can spell an empty range, so the known answer is given here
    // rather than sent to a backend that would have to refuse it.
    if (range.length === 0) return new Uint8Array(0)
    // The window is the bound, not the file: the op door asks a native range
    // when the backend has one and slices a rendered read when it does not,
    // and turns a store's past-EOF refusal into the empty POSIX answer either
    // way, so every mount answers this the same.
    try {
      return await (
        await this.ops(signal, 'read')
      ).readFile(String(target.targetKey), { offset: range.offset, size: range.length })
    } catch (err) {
      throw mapMirageError(err, 'read', target.displayPath)
    }
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(signal, 'list')
    const key = String(target.targetKey)
    const info = await this.stat(target, signal)
    if (info === undefined) {
      throw new FsError(
        `cannot list "${target.displayPath}": no such file or directory`,
        'FS_NOT_FOUND',
      )
    }
    if (info.type !== 'directory') {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    }
    let children: string[]
    try {
      children = await (await this.ops(signal, 'list')).readdir(key)
    } catch (err) {
      throw mapMirageError(err, 'list', target.displayPath)
    }
    const names = new Set<string>()
    for (const childPath of children) {
      names.add(posix.basename(childPath))
    }
    // Namespace symlinks live above every backend, so a listing merges
    // them in here exactly as mirage's own ls does.
    const links = this.links
    if (links !== null) {
      const base = key === '/' ? '/' : `${key}/`
      for (const linkPath of links.symlinkTargets().keys()) {
        if (linkPath.startsWith(base) && !linkPath.slice(base.length).includes('/')) {
          names.add(linkPath.slice(base.length))
        }
      }
    }
    const entries: FsDirEntry[] = []
    for (const name of [...names].sort(compareCodePoints)) {
      // Per entry, not just at the door: a listing is one classification
      // round trip per child on a backend the readdir did not warm, and
      // a caller that gave up should stop paying for them.
      assertNotAborted(signal, 'list')
      entries.push(await this.dirEntry(key, name, signal))
    }
    return entries
  }

  private async dirEntry(
    parentKey: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<FsDirEntry> {
    const childPath = parentKey === '/' ? `/${name}` : `${parentKey}/${name}`
    let followed: string
    try {
      followed = this.follow(childPath)
    } catch {
      // A cyclic link must not reject the whole listing; it lists as an
      // entry of unknown kind keyed on its own path.
      return {
        name,
        type: 'other',
        target: { targetKey: FsTargetKey(childPath), displayPath: childPath },
      }
    }
    const target: FsTarget = { targetKey: FsTargetKey(followed), displayPath: childPath }
    let stat: FileStat
    try {
      stat = await (await this.ops(signal, 'list')).stat(followed)
    } catch (err) {
      // An abort is the caller withdrawing, not a child this listing
      // failed to classify, so it ends the walk instead of landing as
      // one more entry of unknown kind.
      if (err instanceof FsError && err.code === 'FS_ABORTED') throw err
      // A child the listing named but stat cannot classify (a broken link,
      // a race with a delete) still lists, as an entry of unknown kind.
      return { name, type: 'other', target }
    }
    return {
      name,
      type: typeOf(stat),
      target,
      version: versionOf(stat),
      ...(stat.size !== null ? { size: stat.size } : {}),
    }
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicy,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      assertNotAborted(signal, 'write')
      this.assertMutable(sandboxPolicy, target.displayPath)
      const key = String(target.targetKey)
      const existing = await this.stat(target, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(
          `cannot write "${target.displayPath}": not a regular file`,
          'FS_NOT_REGULAR_FILE',
        )
      }
      if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(
          `cannot write "${target.displayPath}": file already exists`,
          'FS_NOT_OBSERVED',
        )
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing?.version !== expected.version) {
          throw new FsError(
            `cannot write "${target.displayPath}": file changed since it was read`,
            'FS_STALE_VERSION',
          )
        }
      }
      const before = existing === undefined ? null : await this.diffBasis(target, content)
      const crlf = before !== null && detectsCrlf(before)
      try {
        await (
          await this.ops(signal, 'write')
        ).writeFile(key, restoreLineEndings(normalizeLineEndings(content), crlf))
      } catch (err) {
        throw mapMirageError(err, 'write', target.displayPath)
      }
      return {
        operation: existing === undefined ? ('create' as const) : ('update' as const),
        version: await this.versionAfterWrite(target),
        before: before === null ? null : normalizeLineEndings(before),
        after: normalizeLineEndings(content),
      }
    })
  }

  // The overwrite-diff basis: the prior content when it is text and both
  // sides fit the exclusive limit, else null (dsh renders a whole-file
  // diff then). Never fails the write itself.
  private async diffBasis(target: FsTarget, content: string): Promise<string | null> {
    if (Buffer.byteLength(content, 'utf8') >= this.diffBasisMaxBytes) return null
    let bytes: Uint8Array
    try {
      bytes = await (await this.ops()).readFile(String(target.targetKey))
    } catch {
      return null
    }
    if (bytes.byteLength >= this.diffBasisMaxBytes) return null
    try {
      return decodeStrictText(bytes, target.displayPath)
    } catch {
      return null
    }
  }

  private async versionAfterWrite(target: FsTarget): Promise<FsVersion> {
    const after = await this.stat(target)
    return after?.version ?? FsVersion(`missing:${String(target.targetKey)}`)
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicy,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      assertNotAborted(signal, 'edit')
      this.assertMutable(sandboxPolicy, target.displayPath)
      const key = String(target.targetKey)
      const existing = await this.stat(target, signal)
      // Stale guard before literal matching: an edit based on an old read
      // reports FS_STALE_VERSION, not a match failure against newer content.
      if (existing === undefined) {
        throw new FsError(
          `cannot edit "${target.displayPath}": file changed since it was read`,
          'FS_STALE_VERSION',
        )
      }
      if (existing.type !== 'file') {
        throw new FsError(
          `cannot edit "${target.displayPath}": not a regular file`,
          'FS_NOT_REGULAR_FILE',
        )
      }
      if (expected !== undefined && existing.version !== expected.version) {
        throw new FsError(
          `cannot edit "${target.displayPath}": file changed since it was read`,
          'FS_STALE_VERSION',
        )
      }
      let bytes: Uint8Array
      try {
        bytes = await (await this.ops(signal, 'edit')).readFile(key)
      } catch (err) {
        throw mapMirageError(err, 'edit', target.displayPath)
      }
      const raw = decodeStrictText(bytes, target.displayPath)
      const original = normalizeLineEndings(raw)
      const edited = applyLiteralEdit(
        original,
        normalizeLineEndings(edit.oldString),
        normalizeLineEndings(edit.newString),
        edit.replaceAll,
        target.displayPath,
      )
      try {
        await (
          await this.ops(signal, 'edit')
        ).writeFile(key, restoreLineEndings(edited, detectsCrlf(raw)))
      } catch (err) {
        throw mapMirageError(err, 'edit', target.displayPath)
      }
      return {
        version: await this.versionAfterWrite(target),
        before: original,
        after: edited,
      }
    })
  }
}

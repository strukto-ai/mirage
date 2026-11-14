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
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { type Files, readerOf } from '@struktoai/mirage-core/workspace/files'
import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { isMissingPath } from '@struktoai/mirage-core/errors/fs'
import { makeStorageKey } from '@struktoai/mirage-core/workspace/mount/storage'
import { posixNormpath } from '@struktoai/mirage-core/utils/path'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { assertNotAborted, mapMirageError } from './errors.ts'
import type { RemoteFiles } from './remote/client.ts'
import {
  applyLiteralEdit,
  decodeStrictText,
  detectsCrlf,
  normalizeLineEndings,
  restoreLineEndings,
} from './text.ts'

// Read off the seam's own signature rather than imported: the policy type
// lives in `@deepseek-ai/dsh-sandbox`, which reaches this package only as a
// transitive dependency of dsh-fs, and naming a fourth exact-pinned peer to
// spell one parameter would couple the adapter to a package it never calls.
type SandboxPolicy = Parameters<FileSystem['writeText']>[4]

/**
 * The fields of a dsh Session the working-directory bridge reads and
 * writes. Structural, like the approval channel in `approval.ts`: the
 * session and working-directory packages stay out of this one's
 * dependencies, and any composition's Session satisfies it.
 */
interface WorkingDirectorySession {
  readonly header: { readonly cwd?: string | null }
  append(type: 'working-directory/change', data: { cwd: string }): unknown
}

/** What dsh's working-directory service asks its access listeners. */
interface WorkingDirectoryAccess {
  agent: { session: WorkingDirectorySession }
  path: string | null
  signal: AbortSignal
}

/** dsh's `ctx.workingDirectory`, narrowed to what the bridge reads. */
interface WorkingDirectoryOwner {
  readonly defaultDirectory: string
  get(session: WorkingDirectorySession): string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'working-directory/access'(
      request: WorkingDirectoryAccess,
      next: () => Promise<string>,
    ): Promise<string>
  }
}

/**
 * dsh's working-directory owner, or null when the composition has none.
 * Read through `ctx.get` for the reason `approverOf` gives: the bridge
 * must not make the service a load requirement.
 *
 * @param ctx the cordis context to read.
 * @returns the owner, or null when nothing provides one.
 */
function workingDirectoryOf(ctx: Context): WorkingDirectoryOwner | null {
  const held: unknown = ctx.get('workingDirectory')
  if (held === null || typeof held !== 'object') return null
  const { get } = held as { get?: unknown }
  return typeof get === 'function' ? (held as WorkingDirectoryOwner) : null
}

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** Configuration for the mirage filesystem backend. */
export interface MirageFsConfig {
  /** Virtual base directory for relative paths. Defaults to `/`. */
  cwd?: string
  /**
   * Read and write as this named workspace session, so the profile
   * that confines the session's shell confines its file tools too. The
   * workspace's default session otherwise.
   */
  sessionId?: string
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

function patched(target: FsTarget, text: string, hunks: readonly PatchHunk[]): string {
  const result = applyHunks(text, hunks)
  if (!result.ok) {
    const { hunkLineNumber, stage } = result.failure
    throw new FsError(
      `cannot patch "${target.displayPath}": hunk at patch line ${String(hunkLineNumber)} (${stage}) does not match`,
      'FS_PATCH_MISMATCH',
    )
  }
  return result.after
}

function tooLarge(displayPath: string, maxBytes: number, size?: number): FsError {
  const found = size === undefined ? '' : `${String(size)} bytes `
  return new FsError(
    `cannot read "${displayPath}": ${found}exceeds the ${String(maxBytes)} byte cap`,
    'FS_TOO_LARGE',
  )
}

/**
 * Mirage-backed implementation of `ctx.fs`. Targets are canonical virtual
 * paths (namespace symlinks followed), every operation walks the workspace
 * dispatcher — session grants, admission policies, cache read-through and
 * post-write invalidation all fire exactly as they do for a shell command —
 * and `processPath` answers in the same virtual path space the mirage shell
 * executes in, so the two providers share one execution world.
 *
 * One limit worth stating: mirage's `ws.vfs` takes no `AbortSignal`, so
 * cancellation is honored at this adapter's own boundaries (before a
 * dispatch, between listing entries) and not inside a single op. A long
 * read from a remote backend therefore runs to completion after the
 * signal fires, and the caller learns of the abort when it returns.
 */
/**
 * The file calls this adapter makes: a workspace's own `Files` here, or the
 * same calls made over a Mirage server's API.
 */
type FsOps = Pick<Files, 'stat' | 'read' | 'write' | 'unlink' | 'isDir' | 'readdir'> | RemoteFiles

export class MirageFileSystem extends FileSystem {
  static readonly inject = ['mirage']

  private fsOps: FsOps | null = null
  // The local `Files` behind `fsOps`, whose reader follows namespace links;
  // null for a remote world, where the server follows them on every call.
  private localFiles: Files | null = null
  private readonly cwd: string
  private readonly sessionId: string | undefined
  private readonly diffBasisMaxBytes: number
  // Per-targetKey tail promise: serializes mutating ops so the
  // read -> guard -> write window cannot interleave (one concurrent writer
  // wins, the rest observe the new version and reject as stale).
  private readonly locks = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: MirageFsConfig = {}) {
    super(ctx)
    this.cwd = config.cwd ?? '/'
    this.sessionId = config.sessionId
    this.diffBasisMaxBytes = config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES
    ctx.on('working-directory/access', async (request, next) => {
      await this.placeInWorld(request.agent.session, request.signal)
      return next()
    })
  }

  /**
   * Keep a dsh Session's working directory a directory of this world.
   *
   * dsh records the directory the harness was launched in, a path on
   * its own machine, and validates it through this seam before every
   * bash, file and search call. Here it names nothing, so left alone
   * every call fails as an unavailable directory. Before dsh looks, a
   * recorded directory this world cannot enter is replaced: by the
   * original project's twin when a disk mount holds it, so launching in
   * a mounted project lands in its mount, else by this adapter's `cwd`.
   * A directory the agent moved to inside this world is kept, and so is
   * dsh's own handling of every other access.
   *
   * @param session the Session whose directory is being accessed.
   * @param signal the access's cancellation.
   */
  private async placeInWorld(session: WorkingDirectorySession, signal: AbortSignal): Promise<void> {
    const owner = workingDirectoryOf(this.ctx)
    if (owner === null) return
    const recorded = owner.get(session)
    if (await this.isWorldDirectory(recorded, signal)) return
    const twin = this.processPathFromHostPath(session.header.cwd ?? owner.defaultDirectory)
    const place =
      twin !== undefined && (await this.isWorldDirectory(twin, signal)) ? twin : this.cwd
    if (place !== recorded) session.append('working-directory/change', { cwd: place })
  }

  /**
   * Whether a path is a directory this world can enter. A path that
   * cannot be resolved or entered (a parent replaced by a file, a link
   * cycle) is not one; only the caller's own cancellation is raised.
   *
   * @param path the candidate absolute path.
   * @param signal the access's cancellation.
   * @returns true for a directory.
   */
  private async isWorldDirectory(path: string, signal: AbortSignal): Promise<boolean> {
    if (!posix.isAbsolute(path)) return false
    let target: FsTarget
    try {
      target = await this.resolve(path, { signal })
    } catch (err) {
      if (err instanceof FsError && err.code !== 'FS_ABORTED') return false
      throw err
    }
    return (await this.files(signal, 'stat')).isDir(String(target.targetKey))
  }

  // The workspace may still be building (declarative mounts resolve
  // asynchronously), so every entry point awaits the service's `ready`
  // once and caches the dispatcher. The caller's signal can fire during
  // that wait, after its entry assertion passed, so it is asserted
  // again here, before the op it guards dispatches.
  //
  // `ready` does not hydrate: a workspace freshly attached to a shared
  // store still holds a minted default session and an empty link table
  // until its first op loads both. This adapter reads the links off the
  // dispatcher's reader outside a dispatch, so it hydrates before they are
  // consulted, or a persisted hide would be judged by the wrong session.
  private async files(signal?: AbortSignal, operation = 'ready'): Promise<FsOps> {
    if (this.fsOps === null) {
      const remote = this.ctx.mirage.remote
      if (remote !== null) {
        this.fsOps = remote.files(this.sessionId)
      } else {
        const host = await this.ctx.mirage.ready
        await host.ensureSessionsLoaded()
        await host.namespace.ensureLoaded()
        const files =
          this.sessionId === undefined ? host.vfs : new Session(host, this.sessionId).vfs
        this.localFiles = files
        this.fsOps = files
      }
    }
    assertNotAborted(signal, operation)
    return this.fsOps
  }

  /**
   * The namespace as the session this adapter's ops run as sees it: the
   * dispatcher's reader, so a link the session cannot see is never followed
   * (the typed path reaches the dispatcher and is refused as absent, not
   * resolved to the visible target it points at), and never listed.
   */
  private get reader(): ReturnType<typeof readerOf> | null {
    if (this.fsOps === null) {
      throw new Error('mirage: filesystem used before the workspace is ready')
    }
    return this.localFiles === null ? null : readerOf(this.localFiles)
  }

  /**
   * The target of a link at `path`, read as this adapter's session sees it,
   * or null when no link is there.
   *
   * @param path a path whose parent is already followed.
   * @returns the link's target, or null.
   */
  private async readlink(path: string): Promise<string | null> {
    const reader = this.reader
    if (reader !== null) return reader.readlink(path)
    const ops = this.fsOps as RemoteFiles
    return ops.readlink(path)
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
    // Probed as the session this adapter reads as: a directory only the
    // named session can see is a base here, and one it cannot see is not.
    return (await (await this.files()).isDir(cwd)) ? cwd : this.cwd
  }

  private normalize(path: string, base: string): string {
    return posix.resolve(base, path)
  }

  // A remote world's links are followed by the server on every call, so a
  // path is its own target here.
  private follow(path: string): string {
    const reader = this.reader
    if (reader === null) return posixNormpath(path)
    try {
      return posixNormpath(reader.follow(path))
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
    await this.files(opts?.signal, 'resolve')
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
    return this.ctx.mirage.hostPathToVirtual(hostPath)
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
      stat = await (await this.files(signal, 'stat')).stat(key)
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
    await this.files(signal, 'lstat')
    const normalized = this.normalize(path, await this.resolveBase(path, opts?.cwd))
    // Follow every component except the last: the probe is about the path
    // entry itself, so a link at the leaf must report as one.
    const parentFollowed =
      normalized === '/'
        ? '/'
        : posix.join(this.follow(posix.dirname(normalized)), posix.basename(normalized))
    // The leaf is read off the dispatcher's reader: a link the session cannot
    // see is not a link here, and the stat below reports it absent.
    const linkTarget = await this.readlink(parentFollowed)
    if (linkTarget !== null) {
      return {
        version: FsVersion(`link:${linkTarget}`),
        type: 'symlink',
        size: new TextEncoder().encode(linkTarget).byteLength,
      }
    }
    let stat: FileStat
    try {
      stat = await (await this.files(signal, 'lstat')).stat(parentFollowed)
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
      bytes = await (await this.files(signal, 'read')).read(key)
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
      bytes = await (await this.files(signal, 'read')).read(key, { size: maxBytes + 1 })
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
    // The window is the bound, not the file: the dispatcher asks a native range
    // when the backend has one and slices a rendered read when it does not,
    // and turns a store's past-EOF refusal into the empty POSIX answer either
    // way, so every mount answers this the same.
    try {
      return await (
        await this.files(signal, 'read')
      ).read(String(target.targetKey), { offset: range.offset, size: range.length })
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
      children = await (await this.files(signal, 'list')).readdir(key)
    } catch (err) {
      throw mapMirageError(err, 'list', target.displayPath)
    }
    const names = new Set<string>()
    for (const childPath of children) {
      names.add(posix.basename(childPath))
    }
    // Namespace symlinks live above every backend, so a listing merges
    // them in here exactly as mirage's own ls does.
    for (const name of this.reader?.linkNamesUnder(key) ?? []) names.add(name)
    const entries: FsDirEntry[] = []
    for (const name of [...names].sort(compareCodePoints)) {
      // Per entry, not just at the entry point: a listing is one classification
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
      stat = await (await this.files(signal, 'list')).stat(followed)
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
      const existing = await this.writeTarget(target, expected, signal)
      const before =
        existing === undefined || this.overBasis(content) ? null : await this.diffBasis(target)
      const crlf = before !== null && detectsCrlf(before)
      await this.store(
        target,
        restoreLineEndings(normalizeLineEndings(content), crlf),
        'write',
        signal,
      )
      return {
        operation: existing === undefined ? ('create' as const) : ('update' as const),
        version: await this.versionAfterWrite(target),
        before: before === null ? null : normalizeLineEndings(before),
        after: normalizeLineEndings(content),
      }
    })
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
      await this.requireFile(target, expected, 'edit', signal)
      const raw = await this.readEditable(target, 'edit', signal)
      const original = normalizeLineEndings(raw)
      const edited = applyLiteralEdit(
        original,
        normalizeLineEndings(edit.oldString),
        normalizeLineEndings(edit.newString),
        edit.replaceAll,
        target.displayPath,
      )
      await this.store(target, restoreLineEndings(edited, detectsCrlf(raw)), 'edit', signal)
      return {
        version: await this.versionAfterWrite(target),
        before: original,
        after: edited,
      }
    })
  }

  async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicy,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      assertNotAborted(signal, 'patch')
      this.assertMutable(sandboxPolicy, target.displayPath)
      await this.requireFile(target, expected, 'patch', signal)
      const raw = await this.readEditable(target, 'patch', signal)
      const original = normalizeLineEndings(raw)
      const after = patched(target, original, hunks)
      await this.store(target, restoreLineEndings(after, detectsCrlf(raw)), 'patch', signal)
      return { version: await this.versionAfterWrite(target), before: original, after }
    })
  }

  async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicy,
  ): Promise<FsDeleteOutcome> {
    return this.withLock(target.targetKey, async () => {
      assertNotAborted(signal, 'delete')
      this.assertMutable(sandboxPolicy, target.displayPath)
      await this.requireFile(target, expected, 'delete', signal)
      const before = await this.diffBasis(target)
      assertNotAborted(signal, 'delete')
      try {
        await (await this.files(signal, 'delete')).unlink(String(target.targetKey))
      } catch (err) {
        throw mapMirageError(err, 'delete', target.displayPath)
      }
      return { before: before === null ? null : normalizeLineEndings(before) }
    })
  }

  /**
   * Publish the source, optionally patched, at the destination, then
   * unlink the source.
   *
   * Two workspace ops rather than one rename, because the destination
   * may sit on another mount (a rename there is EXDEV) and the contract
   * is a text move: the hunks apply to the normalized text and the
   * source's line endings carry over. Two paths that address one stored
   * file (mounts over nested roots) are the same target, as for `mv`,
   * or the unlink would delete the only copy. Past the last abort check
   * both effects run, and a source the unlink could not remove, or one
   * that changed while the destination was written, is reported as
   * retained rather than raised, since the destination is published.
   *
   * @param source the resolved regular file to move.
   * @param destination where its text is published.
   * @param options the hunks to apply and the guard on each side.
   * @param signal aborts before the destination is written.
   * @param sandboxPolicy the call's mode; `read-only` refuses the move.
   * @returns the source basis, the destination outcome and whether the
   *   source is gone.
   */
  async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: {
      hunks?: readonly PatchHunk[]
      expectedSource?: { version: FsVersion }
      expectedDestination?: FsWriteIntent
    },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicy,
  ): Promise<FsMoveOutcome> {
    // A remote world's storage table is the server's, so two paths are the
    // same target when they are the same path.
    const storageKey =
      this.ctx.mirage.remote !== null
        ? (path: PathSpec): string => path.virtual
        : makeStorageKey((await this.ctx.mirage.ready).registry)
    const sourceKey = storageKey(PathSpec.fromStrPath(String(source.targetKey)))
    if (sourceKey === storageKey(PathSpec.fromStrPath(String(destination.targetKey)))) {
      throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
    }
    return this.withLocks([source.targetKey, destination.targetKey], async () => {
      assertNotAborted(signal, 'move')
      this.assertMutable(sandboxPolicy, source.displayPath)
      const read = await this.requireFile(source, options.expectedSource, 'move', signal)
      const existing = await this.writeTarget(destination, options.expectedDestination, signal)
      const raw = await this.readEditable(source, 'move', signal)
      const original = normalizeLineEndings(raw)
      const after =
        options.hunks === undefined ? original : patched(source, original, options.hunks)
      const content = restoreLineEndings(after, detectsCrlf(raw))
      const replaced =
        existing === undefined || this.overBasis(content) ? null : await this.diffBasis(destination)
      assertNotAborted(signal, 'move')
      await this.store(destination, content, 'move')
      const published: FsWriteOutcome = {
        operation: existing === undefined ? 'create' : 'update',
        version: await this.versionAfterWrite(destination),
        before: replaced === null ? null : normalizeLineEndings(replaced),
        after,
      }
      const sourceBefore = this.overBasis(original) ? null : original
      const retained = (failure: FsError): FsMoveOutcome => ({
        sourceBefore,
        destination: published,
        sourceDeleted: false,
        sourceFailure: { code: failure.code, message: failure.message },
      })
      let now: FsInfo | undefined
      try {
        now = await this.stat(source)
      } catch (err) {
        return retained(mapMirageError(err, 'stat', source.displayPath))
      }
      if (now?.version !== read.version) {
        return retained(
          new FsError(
            `cannot delete "${source.displayPath}": file changed since it was read`,
            'FS_STALE_VERSION',
          ),
        )
      }
      try {
        await (await this.files()).unlink(String(source.targetKey))
      } catch (err) {
        return retained(mapMirageError(err, 'delete', source.displayPath))
      }
      return { sourceBefore, destination: published, sourceDeleted: true }
    })
  }

  /**
   * Hold the per-target locks of every key, taken in one canonical
   * order so two moves over the same pair cannot each hold the lock the
   * other waits for.
   *
   * @param keys the targets the body mutates.
   * @param body the work done under every lock.
   * @returns what the body resolved with.
   */
  private withLocks<T>(keys: readonly FsTargetKey[], body: () => Promise<T>): Promise<T> {
    const [first, ...rest] = [...keys].sort((a, b) => compareCodePoints(String(a), String(b)))
    if (first === undefined) return body()
    return this.withLock(first, () => this.withLocks(rest, body))
  }

  /**
   * Stat a mutation's target and refuse it unless it is the regular
   * file the caller last observed.
   *
   * @param target the resolved target about to be changed.
   * @param expected the version guard; omitted for an unconditional change.
   * @param verb the operation named in a refusal.
   * @param signal aborts the stat.
   * @returns the file's row as observed.
   */
  private async requireFile(
    target: FsTarget,
    expected: { version: FsVersion } | undefined,
    verb: string,
    signal: AbortSignal | undefined,
  ): Promise<FsInfo> {
    const existing = await this.stat(target, signal)
    if (existing === undefined) {
      throw new FsError(
        `cannot ${verb} "${target.displayPath}": file changed since it was read`,
        'FS_STALE_VERSION',
      )
    }
    if (existing.type !== 'file') {
      throw new FsError(
        `cannot ${verb} "${target.displayPath}": not a regular file`,
        'FS_NOT_REGULAR_FILE',
      )
    }
    if (expected !== undefined && existing.version !== expected.version) {
      throw new FsError(
        `cannot ${verb} "${target.displayPath}": file changed since it was read`,
        'FS_STALE_VERSION',
      )
    }
    return existing
  }

  /**
   * Stat a write's destination and check it against the write intent.
   *
   * @param target the resolved destination.
   * @param expected the intent; omitted for an unconditional write.
   * @param signal aborts the stat.
   * @returns the existing file's row, or undefined when there is none.
   */
  private async writeTarget(
    target: FsTarget,
    expected: FsWriteIntent | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FsInfo | undefined> {
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
    if (expected?.kind === 'replaceIfVersion' && existing?.version !== expected.version) {
      throw new FsError(
        `cannot write "${target.displayPath}": file changed since it was read`,
        'FS_STALE_VERSION',
      )
    }
    return existing
  }

  private async readEditable(
    target: FsTarget,
    verb: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let bytes: Uint8Array
    try {
      bytes = await (await this.files(signal, verb)).read(String(target.targetKey))
    } catch (err) {
      throw mapMirageError(err, verb, target.displayPath)
    }
    return decodeStrictText(bytes, target.displayPath)
  }

  private async store(
    target: FsTarget,
    content: string,
    verb: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await (await this.files(signal, verb)).write(String(target.targetKey), content)
    } catch (err) {
      throw mapMirageError(err, verb, target.displayPath)
    }
  }

  private overBasis(content: string): boolean {
    return Buffer.byteLength(content, 'utf8') >= this.diffBasisMaxBytes
  }

  // The diff basis of a file about to change: its prior content when it
  // is text under the exclusive limit, else null (dsh renders a
  // whole-file diff then). Only the limit's window is read, so a large
  // file costs no more than that. Never fails the mutation itself.
  private async diffBasis(target: FsTarget): Promise<string | null> {
    let bytes: Uint8Array
    try {
      bytes = await (
        await this.files()
      ).read(String(target.targetKey), {
        size: this.diffBasisMaxBytes,
      })
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
}

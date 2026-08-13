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
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { compareCodePoints, FileType, isMissingPath } from '@struktoai/mirage-core'
import type { FileStat, Ops } from '@struktoai/mirage-core'
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

/**
 * Mirage-backed implementation of `ctx.fs`. Targets are canonical virtual
 * paths (namespace symlinks followed), every operation walks the workspace
 * op door — session grants, admission policies, cache read-through and
 * post-write invalidation all fire exactly as they do for a shell command —
 * and `processPath` answers in the same virtual path space the mirage shell
 * executes in, so the two providers share one execution world.
 */
export class MirageFileSystem extends FileSystem {
  static readonly inject = ['mirage']

  private readonly fsOps: Ops
  private readonly cwd: string
  private readonly diffBasisMaxBytes: number
  // Per-targetKey tail promise: serializes mutating ops so the
  // read -> guard -> write window cannot interleave (one concurrent writer
  // wins, the rest observe the new version and reject as stale).
  private readonly locks = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: MirageFsConfig = {}) {
    super(ctx)
    this.fsOps = ctx.mirage.workspace.fs
    this.cwd = config.cwd ?? '/'
    this.diffBasisMaxBytes = config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES
  }

  private get links(): LinksSeam | null {
    return this.fsOps.links
  }

  private normalize(path: string, cwd?: string): string {
    return posix.resolve(cwd ?? this.cwd, path)
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

  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    const followed = this.follow(this.normalize(path, opts?.cwd))
    return Promise.resolve({ targetKey: FsTargetKey(followed), displayPath: followed })
  }

  processPath(target: FsTarget): string {
    return String(target.targetKey)
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
      stat = await this.fsOps.stat(key)
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
    const normalized = this.normalize(path, opts?.cwd)
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
      stat = await this.fsOps.stat(parentFollowed)
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
      bytes = await this.fsOps.readFile(key)
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
      children = await this.fsOps.readdir(key)
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
      entries.push(await this.dirEntry(key, name))
    }
    return entries
  }

  private async dirEntry(parentKey: string, name: string): Promise<FsDirEntry> {
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
      stat = await this.fsOps.stat(followed)
    } catch {
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
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      assertNotAborted(signal, 'write')
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
        await this.fsOps.writeFile(key, restoreLineEndings(normalizeLineEndings(content), crlf))
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
      bytes = await this.fsOps.readFile(String(target.targetKey))
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
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      assertNotAborted(signal, 'edit')
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
        bytes = await this.fsOps.readFile(key)
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
        await this.fsOps.writeFile(key, restoreLineEndings(edited, detectsCrlf(raw)))
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

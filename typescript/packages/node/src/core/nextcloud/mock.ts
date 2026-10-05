import type { Operator } from 'opendal'
import { vi } from 'vitest'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'

interface FakeMetadata {
  isDirectory: () => boolean
  isFile: () => boolean
  contentLength: bigint | null
  etag: string | null
  lastModified: string | null
}

interface FakeEntry {
  path: () => string
  metadata: () => FakeMetadata
}

function notFound(operation: string, key: string): Error {
  return new Error(
    `NotFound (permanent) at ${operation}, context: { service: webdav, path: ${key} }`,
  )
}

function fileMetadata(data: Buffer): FakeMetadata {
  return {
    isDirectory: () => false,
    isFile: () => true,
    contentLength: BigInt(data.byteLength),
    etag: `etag-${String(data.byteLength)}`,
    lastModified: '2026-07-11T12:00:00Z',
  }
}

const DIRECTORY_METADATA: FakeMetadata = {
  isDirectory: () => true,
  isFile: () => false,
  contentLength: 0n,
  etag: null,
  lastModified: '2026-07-11T12:00:00Z',
}

export class FakeNextcloudOperator {
  readonly files = new Map<string, Buffer>()
  // Collections that hold no key of their own. WebDAV can represent one and
  // the python fake tracks the same set; without it the mock could not model
  // an empty directory at all, so nothing that removes one was testable.
  readonly directories = new Set<string>()

  constructor(initial: Record<string, string | Buffer> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.files.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value))
    }
  }

  createDir(key: string): Promise<void> {
    this.directories.add(`${rstripSlash(key)}/`)
    return Promise.resolve()
  }

  // MKCOL creates missing parents, so the fake records them too.
  delete(key: string): Promise<void> {
    if (key.endsWith('/')) {
      this.directories.delete(key)
      return Promise.resolve()
    }
    this.files.delete(key)
    return Promise.resolve()
  }

  removeAll(prefix: string): Promise<void> {
    const stem = rstripSlash(prefix)
    for (const key of [...this.files.keys()]) {
      if (key === stem || key.startsWith(`${stem}/`)) this.files.delete(key)
    }
    for (const key of [...this.directories]) {
      if (key === `${stem}/` || key.startsWith(`${stem}/`)) this.directories.delete(key)
    }
    return Promise.resolve()
  }

  private hasDirectory(key: string): boolean {
    const prefix = key === '' ? '' : key.endsWith('/') ? key : `${key}/`
    if (prefix === '' || this.directories.has(prefix)) return true
    return [...this.files.keys()].some((path) => path.startsWith(prefix))
  }

  stat(key: string): Promise<FakeMetadata> {
    const normalized = rstripSlash(key)
    const data = this.files.get(normalized)
    if (data !== undefined) return Promise.resolve(fileMetadata(data))
    if (this.hasDirectory(normalized)) return Promise.resolve(DIRECTORY_METADATA)
    return Promise.reject(notFound('stat', key))
  }

  list(path: string, options?: { recursive?: boolean }): Promise<FakeEntry[]> {
    const prefix = path === '/' ? '' : path
    // A missing path lists empty rather than raising, and PROPFIND on a
    // collection lists the collection itself, so an empty directory yields
    // one entry. Probed against Nextcloud 30: op.list("emptydir/") answers
    // ["emptydir/"] and op.list("never/") answers [].
    if (prefix !== '' && !this.hasDirectory(prefix)) return Promise.resolve([])
    const recursive = options?.recursive === true
    const entries = new Map<string, FakeEntry>()
    if (prefix !== '') {
      entries.set(prefix, { path: () => prefix, metadata: () => DIRECTORY_METADATA })
    }
    for (const [key, data] of this.files) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest === '') continue
      const slash = rest.indexOf('/')
      if (recursive) {
        entries.set(key, { path: () => key, metadata: () => fileMetadata(data) })
        const separator = key.lastIndexOf('/')
        let parent = separator >= 0 ? key.slice(0, separator) : ''
        while (parent !== '' && parent.startsWith(rstripSlash(prefix))) {
          const directory = `${parent}/`
          entries.set(directory, { path: () => directory, metadata: () => DIRECTORY_METADATA })
          parent = parent.slice(0, parent.lastIndexOf('/'))
        }
      } else if (slash < 0) {
        entries.set(key, { path: () => key, metadata: () => fileMetadata(data) })
      } else {
        const directory = `${prefix}${rest.slice(0, slash)}/`
        entries.set(directory, { path: () => directory, metadata: () => DIRECTORY_METADATA })
      }
    }
    return Promise.resolve([...entries.values()])
  }
}

export function installFakeOperator(
  accessor: NextcloudAccessor,
  fake: FakeNextcloudOperator,
): void {
  vi.spyOn(accessor, 'operator').mockResolvedValue(fake as unknown as Operator)
}

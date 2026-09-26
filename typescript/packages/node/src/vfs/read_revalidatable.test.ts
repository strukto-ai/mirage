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

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ContextModule from '@struktoai/mirage-core/observe/context'
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import type * as ClientModule from '../core/gridfs/client.ts'
import type { Accessor } from '@struktoai/mirage-core/accessor/base'
import type { S3Accessor } from '@struktoai/mirage-core/accessor/s3'
import { applyIo } from '@struktoai/mirage-core/cache/file/io'
import { CachableAsyncIterator } from '@struktoai/mirage-core/io/cachable_iterator'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { S3_IO } from '@struktoai/mirage-core/commands/builtin/s3/io'
import { ONEDRIVE_IO } from '@struktoai/mirage-core/commands/builtin/onedrive/io'
import { SHAREPOINT_IO } from '@struktoai/mirage-core/commands/builtin/sharepoint/io'
import type { OneDriveAccessor } from '@struktoai/mirage-core/accessor/onedrive'
import type { SharePointAccessor } from '@struktoai/mirage-core/accessor/sharepoint'
import { GITHUB_IO } from '@struktoai/mirage-core/commands/builtin/github/io'
import { stream as githubStream } from '@struktoai/mirage-core/core/github/read'
import type { GitHubAccessor } from '@struktoai/mirage-core/accessor/github'
import { DRIVER as S3_DRIVER } from '@struktoai/mirage-core/core/s3/driver'
import { recordingActive, runWithRecording } from '@struktoai/mirage-core/observe/context'
import { type FileStat, MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import type { GridFSAccessor } from '../accessor/gridfs.ts'
import type { HfHubAccessor } from '../accessor/hf_hub.ts'
import { HF_HUB_IO } from '../commands/builtin/hf_hub/io.ts'
import { FakeHub, blobOid, serveHub, xetHash } from '../core/hf_hub/_test_util.ts'
import {
  DRIVE_ID,
  DRIVE_NAME,
  FakeGraph,
  ME,
  SITE_NAME,
  serveGraph,
} from '../core/msgraph/_test_util.ts'
import { GRIDFS_IO } from '../commands/builtin/gridfs/io.ts'
import { Workspace } from '../workspace.ts'
import { buildVfs, knownVfsNames } from './registry.ts'
import { installS3Mock, type S3Mock } from './s3/mock.ts'
import { AliyunVFS } from './aliyun/aliyun.ts'
import { BackblazeVFS } from './backblaze/backblaze.ts'
import { CephVFS } from './ceph/ceph.ts'
import { DigitalOceanVFS } from './digitalocean/digitalocean.ts'
import { GCSVFS } from './gcs/gcs.ts'
import { MinIOVFS } from './minio/minio.ts'
import { OCIVFS } from './oci/oci.ts'
import { QingStorVFS } from './qingstor/qingstor.ts'
import { R2VFS } from './r2/r2.ts'
import { S3VFS } from './s3/s3.ts'
import { ScalewayVFS } from './scaleway/scaleway.ts'
import { SeaweedFSVFS } from './seaweedfs/seaweedfs.ts'
import { SupabaseVFS } from './supabase/supabase.ts'
import { TencentVFS } from './tencent/tencent.ts'
import { WasabiVFS } from './wasabi/wasabi.ts'
import { GDriveVFS } from '@struktoai/mirage-core/vfs/gdrive/gdrive'
import { GridFSVFS } from './gridfs/gridfs.ts'
import { SSHVFS } from './ssh/ssh.ts'
import { readRevalidatable, type VFS } from '@struktoai/mirage-core/vfs/base'
import { checkReadCapability } from '@struktoai/mirage-core/workspace/mount/read_policy'
import { DEFAULT_READ_TTL, ReadPolicy } from '@struktoai/mirage-core/types'

interface GridFSDoc {
  _id: { toString(): string }
  filename: string
  length: number
  uploadDate: Date
  data: Uint8Array
}

// Shared with the two module mocks below; vitest hoists all three above
// the imports.
const H = vi.hoisted(() => ({
  unrecorded: false,
  slots: [] as [string, string][],
  captured: [] as OpRecord[],
  gridfs: new Map<string, GridFSDoc>(),
  opened: 0,
  reach: [] as string[],
  // Replaces the token a read records, to stage a backend stamping a token of
  // another kind than its stat's.
  stampOverride: null as string | null,
}))

// One seam for both contracts. A spies on which read slot recorded, and
// otherwise delegates; B turns `unrecorded` on and captures what a read
// would have recorded while no recorder is bound.
vi.mock('@struktoai/mirage-core/observe/context', async (importOriginal) => {
  const actual = await importOriginal<typeof ContextModule>()
  const { OpRecord: Record } = await import('@struktoai/mirage-core/observe/record')
  const capture = (
    op: string,
    path: string,
    source: string,
    bytes: number,
    options: ContextModule.RecordOptions,
  ): OpRecord =>
    new Record({
      op,
      path,
      source,
      bytes,
      timestamp: 0,
      durationMs: 0,
      fingerprint: options.fingerprint ?? null,
      revision: options.revision ?? null,
      mountId: null,
    })
  return {
    ...actual,
    record: (
      op: string,
      path: string,
      source: string,
      nbytes: number,
      timer: ContextModule.OpTimer,
      options: ContextModule.RecordOptions = {},
    ): void => {
      if (op === 'read') H.slots.push(['bytes', path])
      if (op === 'read' && H.stampOverride !== null)
        options = { ...options, fingerprint: H.stampOverride }
      if (!H.unrecorded) {
        actual.record(op, path, source, nbytes, timer, options)
        return
      }
      H.captured.push(capture(op, path, source, nbytes, options))
    },
    recordStream: (
      op: string,
      path: string,
      source: string,
      options: ContextModule.RecordOptions = {},
    ): OpRecord | null => {
      if (op === 'read') H.slots.push(['stream', path])
      if (!H.unrecorded) return actual.recordStream(op, path, source, options)
      const rec = capture(op, path, source, 0, options)
      H.captured.push(rec)
      return rec
    },
  }
})

vi.mock('../core/gridfs/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../core/gridfs/client.ts')
  // A listing or a collection query means the path under test reached for
  // something no read or stat should need; refuse it loudly. The mock is
  // file-wide, so a gridfs listing anywhere in this file throws.
  const refuse = (name: string) => (): never => {
    H.reach.push(name)
    throw new Error(`stray reach: ${name}`)
  }
  return {
    ...actual,
    latestFile: (_accessor: unknown, key: string) => Promise.resolve(H.gridfs.get(key) ?? null),
    bucket: () =>
      Promise.resolve({
        openDownloadStream: (id: { toString(): string }) => {
          H.opened += 1
          const doc = [...H.gridfs.values()].find((d) => d._id.toString() === id.toString())
          if (doc === undefined) throw new Error(`no file ${id.toString()}`)
          return Readable.from(chunked(doc.data))
        },
      }),
    iterLatest: refuse('iterLatest'),
    filesColl: refuse('filesColl'),
  }
})

// Python declares READ_REVALIDATABLE as a class attribute, so its twin asserts
// it straight off each alias class. A TypeScript class field is per-instance,
// so the equivalent proof is structural: the flag is declared once on S3VFS,
// and every provider reaches it through the prototype chain without
// redeclaring. A provider that stopped extending S3VFS -- the only way to lose
// the flag -- fails here.
const ALIASES = {
  AliyunVFS,
  BackblazeVFS,
  CephVFS,
  DigitalOceanVFS,
  GCSVFS,
  MinIOVFS,
  OCIVFS,
  QingStorVFS,
  R2VFS,
  ScalewayVFS,
  SeaweedFSVFS,
  SupabaseVFS,
  TencentVFS,
  WasabiVFS,
}

describe('readRevalidatable', () => {
  it('is declared on S3VFS itself', () => {
    const vfs = new S3VFS({ bucket: 'b' })
    expect(vfs.readRevalidatable).toBe(true)
    expect(vfs.cachesReads).toBe(true)
  })

  for (const [name, cls] of Object.entries(ALIASES)) {
    it(`${name} inherits it from S3VFS`, () => {
      expect(cls.prototype instanceof S3VFS).toBe(true)
      // On the instance, not only the chain. A class field redeclared on
      // the alias would shadow the inherited one and still satisfy the
      // `instanceof` above, which is the one way this can regress
      // without a provider leaving the hierarchy.
      // The union of what the providers' own endpoint rules require;
      // each ignores the fields it has no use for.
      const vfs = new cls({
        bucket: 'b',
        endpoint: 'http://127.0.0.1:9000',
        accountId: 'acct',
        projectRef: 'proj',
        namespace: 'ns',
        region: 'us-east-1',
      })
      expect(vfs.readRevalidatable).toBe(true)
      expect(vfs.cachesReads).toBe(true)
    })
  }

  // The flag on the class is one line asserting itself; running the
  // verdict on an instance is what proves gridfs can actually declare
  // `fresh`.
  it('GridFS declares it on its own and is allowed fresh', () => {
    const vfs = new GridFSVFS({ uri: 'mongodb://127.0.0.1:27017', database: 'd' })
    expect(vfs.readRevalidatable).toBe(true)
    expect(vfs.cachesReads).toBe(true)
    expect(() => {
      checkReadCapability('/g/', vfs, { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL })
    }).not.toThrow()
  })
})

// Rule 3 of the verdict -- `fresh` refused on a backend that caches but
// stamps no comparable token -- is otherwise exercised only against a
// stub object cast to VFS. Rule 2 has real backends behind it
// (fingerprint_spike.test.ts uses DiskVFS and RAMVFS), so this is the
// hole. Roughly 25 node backends set cachesReads and not readRevalidatable;
// these two are the documented cases: ssh stamps nothing on a read, and
// gdrive's stat returns a timestamp where its read returns an md5.
describe('a backend that caches but cannot revalidate refuses fresh', () => {
  const CASES: [string, () => VFS][] = [
    ['ssh', () => new SSHVFS({ host: 'h', username: 'u' })],
    ['gdrive', () => new GDriveVFS({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })],
  ]

  for (const [name, make] of CASES) {
    it(`${name} caches reads, does not revalidate, and is refused`, () => {
      const vfs = make()
      expect(vfs.cachesReads).toBe(true)
      expect(readRevalidatable(vfs)).toBe(false)
      expect(() => {
        checkReadCapability('/r/', vfs, { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL })
      }).toThrow(/comparable content token/)
    })
  }
})

// The read-token contract (#1165). The flag is a claim that stat and an
// ordinary read stamp the same kind of content token. The blocks above
// check the flag; these check the claim, for every backend declaring it.
// Twin of python/tests/vfs/test_read_revalidatable.py, with the same row ids.

const S3_FAMILY = [
  's3',
  'aliyun',
  'backblaze',
  'ceph',
  'digitalocean',
  'gcs',
  'minio',
  'oci',
  'qingstor',
  'r2',
  'scaleway',
  'seaweedfs',
  'supabase',
  'tencent',
  'wasabi',
]

const HF_FAMILY: Record<string, string> = {
  hf_models: 'models',
  hf_datasets: 'datasets',
  hf_spaces: 'spaces',
}

const HARNESSES: Record<
  string,
  's3' | 'gridfs' | 'hf_models' | 'onedrive' | 'sharepoint' | 'github'
> = {
  ...Object.fromEntries(S3_FAMILY.map((name) => [name, 's3' as const])),
  gridfs: 'gridfs',
  ...Object.fromEntries(Object.keys(HF_FAMILY).map((name) => [name, 'hf_models' as const])),
  onedrive: 'onedrive',
  sharepoint: 'sharepoint',
  github: 'github',
}

// github has no key_prefix, so the prefixed shape has nothing to test there.
const SHAPES: Record<string, Shape[]> = { github: ['root', 'nested'] }

// The drive each Graph backend addresses in the fake: OneDrive the signed-in
// user's own, SharePoint one library of one site, mounted scoped so the keys
// stay drive-relative (unscoped, `a.txt` would name a site).
const GRAPH: Record<string, string> = { onedrive: ME, sharepoint: DRIVE_ID }

// One document per family, identical in the python twin. oci is the one
// alias with a required field beyond these; every other one-of (r2's
// account_id, supabase's project_ref) is satisfied by the endpoint.
const S3_CONFIG = { bucket: 'b', region: 'us-east-1', endpoint_url: 'http://127.0.0.1:9000' }
const S3_EXTRA: Record<string, Record<string, string>> = { oci: { namespace: 'ns' } }
const GRIDFS_CONFIG = { uri: 'mongodb://127.0.0.1:27017', database: 'd' }

const PREFIX = 'pfx/'

// A non-empty suffix makes the mock's ETag differ from md5(content), so a
// token the backend returned is distinguishable from a fabricated md5.
const SUFFIX = '-2'

type Shape = 'root' | 'listed' | 'nested' | 'prefixed'

const KEYS: Record<Shape, string> = {
  root: 'a.txt',
  listed: 'a.txt',
  nested: 'm/a.txt',
  prefixed: 'a.txt',
}

const ENC = new TextEncoder()
const SEED = ENC.encode('name,age\nalice,30\n')
const CHANGED = ENC.encode('name,age\nalice,31\n')
const DECOY = ENC.encode('decoy at the unprefixed key\n')
// Several download chunks, so the background drain has bytes left to pull
// after the first chunk is consumed.
const BIG = ENC.encode(('x'.repeat(1023) + '\n').repeat(300))

type Row = 'bytes' | 'stream' | 'drain'

const COMMANDS: Record<Row, (v: string) => string> = {
  bytes: (v) => `cp ${v} /r/a.txt`,
  stream: (v) => `cat ${v}`,
  drain: (v) => `cat ${v}`,
}
const SLOTS: Record<Row, string> = { bytes: 'bytes', stream: 'stream', drain: 'stream' }

const SPEC_VFS = resolve(
  fileURLToPath(import.meta.url),
  '../../../../../../spec/typescript/node/vfs.json',
)

interface Fake {
  vfs: VFS
  accessor: Accessor
  key: string
  fetches: () => number
  rewrite: (data: Uint8Array) => void
  readBytes: (path: PathSpec) => Promise<Uint8Array>
  readStream: (path: PathSpec) => AsyncIterable<Uint8Array>
  stat: (path: PathSpec) => Promise<FileStat>
  // The slot a stream read records in: github's stream delegates to its
  // whole read, which records through `record`.
  streamSlot: 'stream' | 'bytes'
}

function slotOf(fake: Fake, row: Row): string {
  return row === 'bytes' ? SLOTS[row] : fake.streamSlot
}

function sha1Blob(data: Uint8Array): string {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${String(data.byteLength)}\0`), data]))
    .digest('hex')
}

// A github repository behind a fetch router: the recursive tree, one
// directory's tree by `{ref}:{dir}` (or the ref itself for the root), and
// blobs by sha. Inlined because core's FakeGitHub (_test_util.ts) is left out
// of core's build and so cannot be imported from node.
class InlineGitHub {
  readonly files = new Map<string, Uint8Array>()
  readonly blobs = new Map<string, Uint8Array>()
  readonly log: string[] = []

  private row(path: string, name: string): Record<string, unknown> {
    const data = this.files.get(path)
    if (data === undefined) return { path: name, type: 'tree', sha: `tree-${path}` }
    const sha = sha1Blob(data)
    this.blobs.set(sha, data)
    return { path: name, type: 'blob', sha, size: data.byteLength }
  }

  private dirs(): Set<string> {
    const out = new Set<string>()
    for (const path of this.files.keys()) {
      const parts = path.split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join('/'))
    }
    return out
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(new Request(input, init).url)
    const reply = (body: unknown, status = 200): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const tree = /\/git\/trees\/([^/]+)$/.exec(url.pathname)
    if (tree !== null) {
      const segment = decodeURIComponent(tree[1] ?? '')
      if (url.searchParams.get('recursive') === '1') {
        this.log.push('recursive')
        const paths = [...this.files.keys(), ...this.dirs()].sort()
        return reply({ tree: paths.map((p) => this.row(p, p)), truncated: false })
      }
      this.log.push('dir')
      const at = segment.includes(':') ? segment.slice(segment.indexOf(':') + 1) : ''
      const prefix = at === '' ? '' : `${at}/`
      const names = new Set<string>()
      for (const p of [...this.files.keys(), ...this.dirs()]) {
        if (p.startsWith(prefix) && p !== at) names.add(p.slice(prefix.length).split('/')[0] ?? '')
      }
      return reply({
        tree: [...names].sort().map((n) => this.row(prefix + n, n)),
        truncated: false,
      })
    }
    const blob = /\/git\/blobs\/([^/]+)$/.exec(url.pathname)
    if (blob !== null) {
      this.log.push('blob')
      for (const data of this.files.values()) this.blobs.set(sha1Blob(data), data)
      const data = this.blobs.get(blob[1] ?? '')
      if (data === undefined) return reply({ message: 'Not Found' }, 404)
      return reply({ content: Buffer.from(data).toString('base64'), encoding: 'base64' })
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return reply({ default_branch: 'main' })
    throw new Error(`InlineGitHub: unrouted ${url.pathname}`)
  }
}

function chunked(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < data.byteLength; i += 16384) out.push(data.slice(i, i + 16384))
  return out
}

function gridfsDoc(key: string, data: Uint8Array, oid: string, year: number): GridFSDoc {
  return {
    _id: { toString: () => oid },
    filename: key,
    length: data.byteLength,
    uploadDate: new Date(Date.UTC(year, 0, 2)),
    data,
  }
}

function md5Hex(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex')
}

let s3: S3Mock
let hubs: FakeHub[] = []
let graphs: FakeGraph[] = []

async function makeFake(name: string, shape: Shape, data: Uint8Array): Promise<Fake> {
  if (HARNESSES[name] === 'github') {
    // The nested key's parent is two or more lowercase letters, the spelling
    // Octokit rewrites when the point request goes unencoded; the python twin
    // keeps the same key.
    const key = shape === 'nested' ? 'docs/a.txt' : 'a.txt'
    const gh = new InlineGitHub()
    gh.files.set(key, data)
    gh.files.set('other.txt', DECOY)
    vi.stubGlobal('fetch', gh.fetch)
    const vfs = await buildVfs('github', {
      token: 't',
      owner: 'o',
      repo: 'r',
      ref: 'main',
      base_url: 'http://github.test',
    })
    const accessor = vfs.accessor as GitHubAccessor
    expect(readRevalidatable(vfs)).toBe(true)
    const invalidate = Object.getOwnPropertyDescriptor(
      RAMIndexCacheStore.prototype,
      'invalidatePrefix',
    )?.value as (this: RAMIndexCacheStore, path: string) => Promise<void>
    vi.spyOn(RAMIndexCacheStore.prototype, 'invalidatePrefix').mockImplementation(function (
      this: RAMIndexCacheStore,
      path: string,
    ) {
      if (this !== vfs.index) H.reach.push('tree walk on a throwaway index')
      return invalidate.call(this, path)
    })
    const blobs = (): number => gh.log.filter((r) => r === 'blob').length
    const before = blobs()
    // github's stat has nothing to answer from without an index, so the
    // direct calls pass the mount's.
    return {
      vfs,
      accessor,
      key,
      fetches: () => blobs() - before,
      rewrite: (next) => {
        gh.files.set(key, next)
      },
      readBytes: (p) => GITHUB_IO.readBytes(accessor, p, vfs.index),
      readStream: (p) => GITHUB_IO.readStream(accessor, p, vfs.index),
      stat: (p) => GITHUB_IO.stat(accessor, p, vfs.index),
      streamSlot: 'bytes',
    }
  }
  const key = KEYS[shape]
  const prefix = shape === 'prefixed' ? PREFIX : null
  const stored = (prefix ?? '') + key
  const drive = GRAPH[name]
  if (drive !== undefined) {
    const files: Record<string, Uint8Array> = { [stored]: data }
    if (prefix !== null) files[key] = DECOY
    // A children listing is a walk no read or stat should make; the listed
    // shape's own `ls` is the one allowed.
    const graph = await serveGraph(new FakeGraph({ [drive]: files }, H.reach))
    graph.childrenAllowed = shape === 'listed' ? 1 : 0
    graphs.push(graph)
    const vfs = await buildVfs(name, {
      access_token: 't',
      graph_base_url: graph.url,
      ...(name === 'sharepoint' ? { site: SITE_NAME, drive: DRIVE_NAME } : {}),
      ...(prefix === null ? {} : { key_prefix: prefix }),
    })
    expect(readRevalidatable(vfs)).toBe(true)
    const before = graph.fetches()
    const rewrite = (next: Uint8Array): void => {
      graph.write(drive, stored, next)
    }
    if (name === 'onedrive') {
      const accessor = vfs.accessor as OneDriveAccessor
      expect(accessor.config.keyPrefix).toBe(prefix === null ? '' : 'pfx')
      return {
        vfs,
        accessor,
        key,
        fetches: () => graph.fetches() - before,
        rewrite,
        readBytes: (p) => ONEDRIVE_IO.readBytes(accessor, p),
        readStream: (p) => ONEDRIVE_IO.readStream(accessor, p),
        stat: (p) => ONEDRIVE_IO.stat(accessor, p),
        streamSlot: 'stream',
      }
    }
    const accessor = vfs.accessor as SharePointAccessor
    expect(accessor.config.keyPrefix).toBe(prefix === null ? '' : 'pfx')
    return {
      vfs,
      accessor,
      key,
      fetches: () => graph.fetches() - before,
      rewrite,
      readBytes: (p) => SHAREPOINT_IO.readBytes(accessor, p),
      readStream: (p) => SHAREPOINT_IO.readStream(accessor, p),
      stat: (p) => SHAREPOINT_IO.stat(accessor, p),
      streamSlot: 'stream',
    }
  }
  if (HARNESSES[name] === 'hf_models') {
    // Files are served Xet-shaped, so the download's ETag is the xet hash, not
    // the oid stat stamps: a read that trusted only the oid would stamp
    // nothing. The repo is filed under the family's own API segment, so a
    // request built for another repo type gets no answer.
    const hub = await serveHub(new FakeHub())
    hubs.push(hub)
    const files = hub.files(HF_FAMILY[name], 'acme/widget')
    files.set(stored, data)
    if (prefix !== null) files.set(key, DECOY)
    const vfs = await buildVfs(name, {
      repo_id: 'acme/widget',
      endpoint: hub.url,
      ...(prefix === null ? {} : { key_prefix: prefix }),
    })
    const accessor = vfs.accessor as HfHubAccessor
    expect(readRevalidatable(vfs)).toBe(true)
    expect(accessor.keyPrefix).toBe(prefix ?? '')
    // A whole-tree refill is the one thing that invalidates a store's prefix.
    // On the mount's own index a cold read does it legitimately; on any other
    // store it is the reconcile probe walking the tree.
    // The original, taken before the spy replaces it and typed with its `this`,
    // so the spy can forward to it for every store.
    const invalidate = Object.getOwnPropertyDescriptor(
      RAMIndexCacheStore.prototype,
      'invalidatePrefix',
    )?.value as (this: RAMIndexCacheStore, path: string) => Promise<void>
    vi.spyOn(RAMIndexCacheStore.prototype, 'invalidatePrefix').mockImplementation(function (
      this: RAMIndexCacheStore,
      path: string,
    ) {
      if (this !== vfs.index) H.reach.push('tree walk on a throwaway index')
      return invalidate.call(this, path)
    })
    const before = hub.count('resolve')
    return {
      vfs,
      accessor,
      key,
      fetches: () => hub.count('resolve') - before,
      rewrite: (next) => {
        files.set(stored, next)
      },
      readBytes: (p) => HF_HUB_IO.readBytes(accessor, p),
      readStream: (p) => HF_HUB_IO.readStream(accessor, p),
      stat: (p) => HF_HUB_IO.stat(accessor, p),
      streamSlot: 'stream',
    }
  }
  if (HARNESSES[name] === 'gridfs') {
    // _id is neither the md5 nor the uploadDate, so a stat or a read that
    // moved to either kind of token no longer matches the other side.
    H.gridfs.set(stored, gridfsDoc(stored, data, '0123456789ab0123456789ab', 2020))
    if (prefix !== null) H.gridfs.set(key, gridfsDoc(key, DECOY, 'ffffffffffffffffffffffff', 2021))
    const vfs = await buildVfs('gridfs', {
      ...GRIDFS_CONFIG,
      ...(prefix === null ? {} : { key_prefix: prefix }),
    })
    const accessor = vfs.accessor as GridFSAccessor
    expect(readRevalidatable(vfs)).toBe(true)
    expect(accessor.config.keyPrefix ?? null).toBe(prefix)
    const before = H.opened
    return {
      vfs,
      accessor,
      key,
      fetches: () => H.opened - before,
      rewrite: (next) => {
        H.gridfs.set(stored, gridfsDoc(stored, next, 'aaaaaaaaaaaaaaaaaaaaaaaa', 2022))
      },
      readBytes: (p) => GRIDFS_IO.readBytes(accessor, p),
      readStream: (p) => GRIDFS_IO.readStream(accessor, p),
      stat: (p) => GRIDFS_IO.stat(accessor, p),
      streamSlot: 'stream',
    }
  }
  s3.store.set('b', stored, data)
  if (prefix !== null) s3.store.set('b', key, DECOY)
  const vfs = await buildVfs(name, {
    ...S3_CONFIG,
    ...(S3_EXTRA[name] ?? {}),
    ...(prefix === null ? {} : { key_prefix: prefix }),
  })
  const accessor = vfs.accessor as S3Accessor
  expect(readRevalidatable(vfs)).toBe(true)
  expect(accessor.config.keyPrefix ?? null).toBe(prefix)
  const before = s3.calls.get('GetObject') ?? 0
  return {
    vfs,
    accessor,
    key,
    fetches: () => (s3.calls.get('GetObject') ?? 0) - before,
    rewrite: (next) => {
      s3.store.set('b', stored, next)
    },
    readBytes: (p) => S3_IO.readBytes(accessor, p),
    readStream: (p) => S3_IO.readStream(accessor, p),
    stat: (p) => S3_IO.stat(accessor, p),
    streamSlot: 'stream',
  }
}

interface Case {
  name: string
  shape: Shape
  row: Row
}

function cases(rows: readonly Row[]): Case[] {
  const out: Case[] = []
  for (const [name, family] of Object.entries(HARNESSES)) {
    // The aliases share every read and stat path with s3, so the key
    // shapes run once per family.
    const shapes: Shape[] =
      name === family ? (SHAPES[name] ?? ['root', 'nested', 'prefixed']) : ['root']
    for (const shape of shapes) for (const row of rows) out.push({ name, shape, row })
  }
  return out
}

const A_CASES = [
  ...cases(['bytes', 'stream', 'drain']),
  ...['s3', ...Object.keys(GRAPH)].map((name) => ({
    name,
    shape: 'listed' as const,
    row: 'stream' as const,
  })),
]

// A Graph listing leaves each file's cTag in the mount index, so the listed
// rows put a token-bearing row in front of the probe: only a probe that stats
// through a throwaway index sees the rewrite.
const CHANGED_CASES: { name: string; shape: Shape }[] = [
  ...[...new Set(Object.values(HARNESSES))]
    .sort()
    .map((name) => ({ name, shape: 'root' as const })),
  ...Object.keys(GRAPH).map((name) => ({ name, shape: 'listed' as const })),
]
const B_CASES = cases(['bytes', 'stream'])

function specFor(virtual: string, key: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/') + 1),
    vfsPath: key,
  })
}

function freshWorkspace(vfs: VFS): Workspace {
  return new Workspace({
    '/m': new Mount(vfs, {
      mode: MountMode.WRITE,
      read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
    }),
    '/r': [new RAMVFS(), MountMode.WRITE],
  })
}

async function line(ws: Workspace, command: string): Promise<Uint8Array> {
  const result = await ws.shell(command)
  expect([result.exitCode, new TextDecoder().decode(result.stderr)], command).toEqual([0, ''])
  return result.stdout
}

async function partialRead(ws: Workspace, fake: Fake, virtual: string): Promise<Uint8Array> {
  // Exercise the cache handoff directly, independent of pipe cancellation.
  const [[source, first], records] = await runWithRecording(async () => {
    const source = new CachableAsyncIterator(fake.readStream(specFor(virtual, fake.key)))
    const first = await source.next()
    if (first.done === true) throw new Error('Expected a nonempty backend stream')
    expect(source.exhausted).toBe(false)
    return [source, first.value.subarray(0, 1)] as const
  })
  await applyIo(
    ws.cache,
    new IOResult({ reads: { [virtual]: source }, cache: [virtual] }),
    undefined,
    records,
  )
  return first
}

// Reconcile stats through a fresh index (workspace/reconcile.ts), so a
// listing's index row, which carries no token, cannot answer for it.
async function reconcileStat(ws: Workspace, fake: Fake, virtual: string): Promise<FileStat> {
  const stat = await ws.opsRegistry.call(
    'stat',
    fake.vfs,
    fake.accessor,
    specFor(virtual, fake.key),
    [],
    { index: new RAMIndexCacheStore() },
  )
  return stat as FileStat
}

function readsOnMount(): [string, string][] {
  return H.slots.filter(([, path]) => path.startsWith('/m/'))
}

describe('the read-token contract', () => {
  beforeAll(() => {
    s3 = installS3Mock(undefined, { etagSuffix: SUFFIX })
  })

  afterAll(() => {
    s3.restore()
  })

  beforeEach(() => {
    for (const b of s3.store.allBuckets()) s3.store.objects(b).clear()
    H.unrecorded = false
    H.slots.length = 0
    H.captured.length = 0
    H.gridfs.clear()
    H.reach.length = 0
    H.stampOverride = null
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await Promise.all(hubs.map((hub) => hub.close()))
    hubs = []
    await Promise.all(graphs.map((graph) => graph.close()))
    graphs = []
  })

  /**
   * Every readRevalidatable backend runs the read-token contract.
   *
   * The flag lets a mount declare `read: fresh`, which is a claim that stat
   * and an ordinary read stamp the same kind of content token. For a long
   * time nothing checked the read half: a backend could set the flag, stamp
   * nothing on reads, and the suite stayed green while every fresh read
   * refetched (#1165). The roster is read from the committed spec, so a new
   * declarer fails this test until it has a harness, and a harness
   * outliving its flag fails it too; each harness also asserts the flag on
   * the instance it builds.
   */
  it('every declaring backend has a harness', () => {
    const manifest = JSON.parse(readFileSync(SPEC_VFS, 'utf8')) as {
      capabilities: Record<string, { read_revalidatable?: boolean }>
    }
    const known = new Set(knownVfsNames())
    const declared = Object.entries(manifest.capabilities)
      .filter(([name, caps]) => caps.read_revalidatable === true && known.has(name))
      .map(([name]) => name)
    expect(declared.length).toBeGreaterThan(0)
    expect(Object.keys(HARNESSES).sort()).toEqual(declared.sort())
  })

  for (const { name, shape, row } of A_CASES) {
    it(`a read leaves an entry reconcile calls fresh: ${name}-${shape}-${row}`, async () => {
      const data = row === 'drain' ? BIG : SEED
      const fake = await makeFake(name, shape, data)
      const virtual = `/m/${fake.key}`
      const command = COMMANDS[row](virtual)
      const ws = freshWorkspace(fake.vfs)
      const add = vi.spyOn(ws.cache, 'add')
      try {
        if (shape === 'listed') await line(ws, 'ls /m')
        expect(await ws.cache.exists(virtual)).toBe(false)
        let first = await (row === 'drain' ? partialRead(ws, fake, virtual) : line(ws, command))
        await Promise.all([...(ws.cache.drainTasks?.values() ?? [])])
        // Only the background drain fills through `add`; the synchronous
        // fills use `set`.
        expect(add).toHaveBeenCalledTimes(row === 'drain' ? 1 : 0)
        expect(readsOnMount()).toEqual([[slotOf(fake, row), virtual]])
        expect(fake.fetches()).toBe(1)
        if (row === 'bytes') first = await line(ws, 'cat /r/a.txt')
        expect(first).toEqual(row === 'drain' ? data.slice(0, 1) : data)

        const stat = await reconcileStat(ws, fake, virtual)
        expect(stat.fingerprint).not.toBeNull()
        expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(true)

        // The drain row's second run reads the whole entry back, so a drain
        // that cached a truncated buffer cannot pass.
        let second = await line(ws, command)
        if (row === 'bytes') second = await line(ws, 'cat /r/a.txt')
        // Reconcile answered FRESH: the warm read made no content fetch.
        expect(fake.fetches()).toBe(1)
        expect(second).toEqual(data)
        expect(H.reach).toEqual([])
      } finally {
        await ws.close()
      }
    })
  }

  for (const { name, shape, row } of cases(['drain'])) {
    it(`an early pipe exit never caches a prefix: ${name}-${shape}`, async () => {
      const fake = await makeFake(name, shape, BIG)
      const virtual = `/m/${fake.key}`
      const ws = freshWorkspace(fake.vfs)
      try {
        expect(await line(ws, `cat ${virtual} | head -c 1`)).toEqual(BIG.slice(0, 1))
        await Promise.all([...(ws.cache.drainTasks?.values() ?? [])])
        expect(readsOnMount()).toEqual([[slotOf(fake, row), virtual]])
        expect(fake.fetches()).toBe(1)
        const cached = await ws.cache.get(virtual)
        if (cached !== null) expect(cached).toEqual(BIG)
        expect(await line(ws, `cat ${virtual}`)).toEqual(BIG)
        expect(fake.fetches()).toBe(cached === null ? 2 : 1)
        expect(H.reach).toEqual([])
      } finally {
        await ws.close()
      }
    })
  }

  for (const { name, shape, row } of B_CASES) {
    it(`an unrecorded read stamps the stat token: ${name}-${shape}-${row}`, async () => {
      const fake = await makeFake(name, shape, SEED)
      const virtual = `/m/${fake.key}`
      const spec = specFor(virtual, fake.key)
      expect(recordingActive()).toBe(false)
      H.unrecorded = true
      let data: Uint8Array
      if (row === 'bytes') {
        data = await fake.readBytes(spec)
      } else {
        const parts: Uint8Array[] = []
        for await (const chunk of fake.readStream(spec)) parts.push(chunk)
        data = Buffer.concat(parts)
      }
      const stat = await fake.stat(spec)
      expect(new Uint8Array(data)).toEqual(SEED)
      expect(H.captured.map((r) => r.path)).toEqual([virtual])
      // The real recordStream returns null with no recorder bound, so no
      // stream read can stamp a token outside a capture at all. This row can
      // only show the stamp does not depend on the recorder check itself.
      expect(H.captured[0]?.fingerprint).not.toBeNull()
      expect(stat.fingerprint).not.toBeNull()
      expect(H.captured[0]?.fingerprint).toBe(stat.fingerprint)
    })
  }

  for (const { name, shape } of CHANGED_CASES) {
    const id = shape === 'listed' ? `${name}-listed-changed-stream` : `${name}-changed-stream`
    it(`a changed object is refetched: ${id}`, async () => {
      // The rows above prove stat and read agree; this proves what they agree
      // on is the content. A backend stamping a constant, or the key, on both
      // sides passes every other row and serves stale bytes here.
      const fake = await makeFake(name, shape, SEED)
      const virtual = `/m/${fake.key}`
      const ws = freshWorkspace(fake.vfs)
      try {
        if (shape === 'listed') await line(ws, 'ls /m')
        await line(ws, `cat ${virtual}`)
        fake.rewrite(CHANGED)
        const stat = await reconcileStat(ws, fake, virtual)
        expect(stat.fingerprint).not.toBeNull()
        expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(false)
        let before = fake.fetches()
        expect(await line(ws, `cat ${virtual}`)).toEqual(CHANGED)
        expect(fake.fetches() - before).toBe(1)
        // The refetch has to stamp the new token, or every later read
        // refetches as well and the backend never serves warm.
        const restat = await reconcileStat(ws, fake, virtual)
        expect(restat.fingerprint).not.toBeNull()
        expect(await ws.cache.isFresh(virtual, restat.fingerprint ?? '')).toBe(true)
        before = fake.fetches()
        expect(await line(ws, `cat ${virtual}`)).toEqual(CHANGED)
        expect(fake.fetches() - before).toBe(0)
        expect(H.reach).toEqual([])
      } finally {
        await ws.close()
      }
    })
  }

  it('the contract goes red on a backend with two token kinds', async () => {
    // The python twin forces gdrive to claim the flag. Its fake cannot back
    // a node Workspace (captureFileMetadata calls an unmocked googleGet), so
    // this stats a timestamp while the read returns the ETag, which is the
    // same mismatch. The contract must fail it, or it could not tell a
    // backend that keeps the promise from one that only makes it.
    const fake = await makeFake('s3', 'root', SEED)
    const head = S3_DRIVER.head
    vi.spyOn(S3_DRIVER, 'head').mockImplementation(async (conn, key) => {
      const meta = await head(conn, key)
      return meta === null ? null : { ...meta, fingerprint: '2026-04-16T00:00:00Z' }
    })
    const virtual = '/m/a.txt'
    const ws = freshWorkspace(fake.vfs)
    try {
      await line(ws, `cat ${virtual}`)
      // The entry does hold the read's token, so a helper that compared the
      // entry with itself would call it fresh.
      expect(await ws.cache.isFresh(virtual, md5Hex(SEED) + SUFFIX)).toBe(true)
      const stat = await reconcileStat(ws, fake, virtual)
      // The stat token exists and is another kind; a missing one would also
      // read as not fresh without showing a mismatch go red.
      expect(stat.fingerprint).not.toBeNull()
      expect(stat.fingerprint).not.toBe(md5Hex(SEED) + SUFFIX)
      expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(false)
      await line(ws, `cat ${virtual}`)
      expect(fake.fetches()).toBeGreaterThan(1)
    } finally {
      await ws.close()
    }
  })

  it('the contract goes red on hf stamping another kind', async () => {
    // hf forced to stamp the download's own ETag (the xet hash) while stat
    // reports the git oid: both tokens exist and differ, the mismatch the
    // verified stamp exists to prevent.
    const fake = await makeFake('hf_models', 'root', SEED)
    H.stampOverride = xetHash(SEED)
    const virtual = '/m/a.txt'
    const ws = freshWorkspace(fake.vfs)
    try {
      await line(ws, `cp ${virtual} /r/a.txt`)
      expect(await ws.cache.isFresh(virtual, xetHash(SEED))).toBe(true)
      const stat = await reconcileStat(ws, fake, virtual)
      expect(stat.fingerprint).toBe(blobOid(SEED))
      expect(stat.fingerprint).not.toBe(xetHash(SEED))
      expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('the contract goes red on msgraph stamping another kind', async () => {
    // onedrive forced to stamp the item's eTag on the read while stat reports
    // its cTag: both tokens exist and differ as strings on every write, so the
    // contract must call the entry stale. A bytes read, because the override
    // replaces only what `record` stamps.
    const fake = await makeFake('onedrive', 'root', SEED)
    H.stampOverride = 'e1'
    const virtual = '/m/a.txt'
    const ws = freshWorkspace(fake.vfs)
    try {
      await line(ws, `cp ${virtual} /r/a.txt`)
      expect(await ws.cache.isFresh(virtual, 'e1')).toBe(true)
      const stat = await reconcileStat(ws, fake, virtual)
      expect(stat.fingerprint).toBe('c1')
      expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it("github's stream is its read, so it records through record", () => {
    // Its expected stream slot is "bytes" for that reason. A native stream
    // that forgot to record would otherwise hide behind that slot.
    expect(GITHUB_IO.readStream).toBe(githubStream)
  })

  it('the contract goes red on github stamping another kind', async () => {
    // github forced to stamp an md5 of the bytes while stat reports the blob
    // sha: both tokens exist and differ.
    const fake = await makeFake('github', 'root', SEED)
    H.stampOverride = md5Hex(SEED)
    const virtual = '/m/a.txt'
    const ws = freshWorkspace(fake.vfs)
    try {
      await line(ws, `cat ${virtual}`)
      expect(await ws.cache.isFresh(virtual, md5Hex(SEED))).toBe(true)
      const stat = await reconcileStat(ws, fake, virtual)
      expect(stat.fingerprint).toBe(sha1Blob(SEED))
      expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(false)
    } finally {
      await ws.close()
    }
  })
})

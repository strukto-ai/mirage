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
import type * as DriveModule from '@struktoai/mirage-core/core/google/drive'
import * as googleDrive from '@struktoai/mirage-core/core/google/drive'
import type * as DriveVersionsModule from '@struktoai/mirage-core/core/gdrive/versions'
import type * as DocsReadModule from '@struktoai/mirage-core/core/gdocs/read'
import type * as GoogleClientModule from '@struktoai/mirage-core/core/google/client'
import type * as JsonRenderModule from '@struktoai/mirage-core/core/render/json'
import type { Accessor } from '@struktoai/mirage-core/accessor/base'
import type { S3Accessor } from '@struktoai/mirage-core/accessor/s3'
import { applyIo } from '@struktoai/mirage-core/cache/file/io'
import { CachableAsyncIterator } from '@struktoai/mirage-core/io/cachable_iterator'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import * as s3Io from '@struktoai/mirage-core/commands/builtin/s3/io'
import * as onedriveIo from '@struktoai/mirage-core/commands/builtin/onedrive/io'
import * as sharepointIo from '@struktoai/mirage-core/commands/builtin/sharepoint/io'
import type { OneDriveAccessor } from '@struktoai/mirage-core/accessor/onedrive'
import type { SharePointAccessor } from '@struktoai/mirage-core/accessor/sharepoint'
import * as dropboxIo from '@struktoai/mirage-core/commands/builtin/dropbox/io'
import type { DropboxAccessor } from '@struktoai/mirage-core/accessor/dropbox'
import * as gdocsIo from '@struktoai/mirage-core/commands/builtin/gdocs/io'
import * as gdriveIo from '@struktoai/mirage-core/commands/builtin/gdrive/io'
import * as gsheetsIo from '@struktoai/mirage-core/commands/builtin/gsheets/io'
import * as gslidesIo from '@struktoai/mirage-core/commands/builtin/gslides/io'
import type { CommandIO } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { GDriveAccessor } from '@struktoai/mirage-core/accessor/gdrive'
import * as githubIo from '@struktoai/mirage-core/commands/builtin/github/io'
import { readStream as githubStream } from '@struktoai/mirage-core/core/github/read'
import type { GitHubAccessor } from '@struktoai/mirage-core/accessor/github'
import { DRIVER as S3_DRIVER } from '@struktoai/mirage-core/core/s3/driver'
import { recordingActive, runWithRecording } from '@struktoai/mirage-core/observe/context'
import { type FileStat, MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import type { GridFSAccessor } from '../accessor/gridfs.ts'
import type { HfBucketsAccessor } from '../accessor/hf_buckets.ts'
import type { HfHubAccessor } from '../accessor/hf_hub.ts'
import * as hfBucketsIo from '../commands/builtin/hf_buckets/io.ts'
import { fakeHfOperator } from '../core/hf_buckets/mock.ts'
import * as hfHubIo from '../commands/builtin/hf_hub/io.ts'
import { FakeHub, blobOid, serveHub, xetHash } from '../core/hf_hub/_test_util.ts'
import {
  DRIVE_ID,
  DRIVE_NAME,
  FakeGraph,
  ME,
  SITE_NAME,
  serveGraph,
} from '../core/msgraph/_test_util.ts'
import * as gridfsIo from '../commands/builtin/gridfs/io.ts'
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
import { makeFilename as docFilename } from '@struktoai/mirage-core/vfs/gdocs/doc_entry'
import { makeFilename as sheetFilename } from '@struktoai/mirage-core/vfs/gsheets/sheet_entry'
import { makeFilename as slideFilename } from '@struktoai/mirage-core/vfs/gslides/slide_entry'
import { GridFSVFS } from './gridfs/gridfs.ts'
import { SSHVFS } from './ssh/ssh.ts'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { checkReadCapability } from '@struktoai/mirage-core/workspace/mount/read_policy'
import { DEFAULT_READ_TTL, ReadPolicy } from '@struktoai/mirage-core/types'
import { InlineDropbox } from './fixtures/dropbox.ts'
import { InlineGitHub, blobSha } from './fixtures/github.ts'

interface GDriveItem {
  id: string
  name: string
  mimeType: string
  parents: string[]
  modifiedTime: string
  content: Uint8Array
}

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
  // A Drive folder tree keyed by id, served through the mocked Drive calls
  // below; the counters are what the rows assert a warm read avoids.
  gdrive: new Map<string, GDriveItem>(),
  gdriveDownloads: 0,
  gdriveRenders: 0,
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

const GDRIVE_FOLDER = 'application/vnd.google-apps.folder'
const GDRIVE_NATIVE = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

// Drive serves md5Checksum and headRevisionId only for a file with binary
// content, and computes them from what is stored now.
async function gdriveResource(item: GDriveItem): Promise<Record<string, unknown>> {
  const { createHash: hash } = await import('node:crypto')
  const out: Record<string, unknown> = {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    parents: item.parents,
    modifiedTime: item.modifiedTime,
    size: String(item.content.byteLength),
  }
  if (item.mimeType !== GDRIVE_FOLDER && !GDRIVE_NATIVE.has(item.mimeType)) {
    out.md5Checksum = hash('md5').update(item.content).digest('hex')
    out.headRevisionId = `${item.id}-r1`
  }
  return out
}

vi.mock('@struktoai/mirage-core/core/google/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof DriveModule>()
  const item = (id: string): GDriveItem => {
    const found = H.gdrive.get(id)
    if (found === undefined) throw new Error(`no drive item ${id}`)
    return found
  }
  return {
    ...actual,
    listFiles: async (_tm: unknown, opts: { folderId?: string; name?: string | null } = {}) => {
      const folder = opts.folderId ?? 'root'
      const children = [...H.gdrive.values()].filter(
        (i) =>
          i.parents.includes(folder) &&
          (opts.name === undefined || opts.name === null || i.name === opts.name),
      )
      return Promise.all(children.map(gdriveResource))
    },
    listSharedDrives: () => Promise.resolve([]),
    // Each of gdocs, gsheets and gslides lists only its own kind.
    listAllFiles: async (_tm: unknown, opts: { mimeType?: string | null } = {}) => ({
      files: await Promise.all(
        [...H.gdrive.values()]
          .filter(
            (i) =>
              i.mimeType !== GDRIVE_FOLDER &&
              (opts.mimeType === undefined ||
                opts.mimeType === null ||
                i.mimeType === opts.mimeType),
          )
          .map(gdriveResource),
      ),
      complete: true,
    }),
    getFile: async (_tm: unknown, id: string) => gdriveResource(item(id)),
    downloadFile: (_tm: unknown, id: string) => {
      H.gdriveDownloads += 1
      return Promise.resolve(item(id).content)
    },
  }
})

vi.mock('@struktoai/mirage-core/core/gdrive/versions', async (importOriginal) => {
  const actual = await importOriginal<typeof DriveVersionsModule>()
  return {
    ...actual,
    captureFileMetadata: async (_tm: unknown, id: string) => {
      const found = H.gdrive.get(id)
      if (found === undefined) throw new Error(`no drive item ${id}`)
      const r = await gdriveResource(found)
      return [r.md5Checksum ?? null, r.headRevisionId ?? null]
    },
  }
})

vi.mock('@struktoai/mirage-core/core/gdocs/read', async (importOriginal) => {
  const actual = await importOriginal<typeof DocsReadModule>()
  return {
    ...actual,
    readDoc: (_tm: unknown, id: string) => {
      const found = H.gdrive.get(id)
      if (found === undefined) throw new Error(`no drive item ${id}`)
      H.gdriveRenders += 1
      return Promise.resolve(found.content)
    },
  }
})

// gdocs, gsheets and gslides render inside their own module, where a mocked
// export does not reach, so the fake stands in at the two seams the render
// crosses: the editor API hands back the stored bytes, and the renderer passes
// bytes through. python patches the render functions themselves.
const EDITOR_GET = /\/(?:documents|spreadsheets|presentations)\/([^/?]+)$/

vi.mock('@struktoai/mirage-core/core/google/client', async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleClientModule>()
  return {
    ...actual,
    googleGet: (_tm: unknown, url: string) => {
      const id = EDITOR_GET.exec(url)?.[1]
      const found = id === undefined ? undefined : H.gdrive.get(id)
      if (found === undefined) throw new Error(`unrouted google get ${url}`)
      H.gdriveRenders += 1
      return Promise.resolve(found.content)
    },
  }
})

vi.mock('@struktoai/mirage-core/core/render/json', async (importOriginal) => {
  const actual = await importOriginal<typeof JsonRenderModule>()
  return {
    ...actual,
    compactJsonBytes: (value: unknown) =>
      value instanceof Uint8Array ? value : actual.compactJsonBytes(value),
  }
})

// Python declares read_revalidatable as a class attribute, so its twin asserts
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
// stub object cast to BaseVFS. Rule 2 has real backends behind it
// (fingerprint_spike.test.ts uses DiskVFS and RAMVFS), so this is the
// hole. Roughly 25 node backends set cachesReads and not readRevalidatable;
// ssh is the documented case: it stamps nothing at all on a read.
//
describe('a backend that caches but cannot revalidate refuses fresh', () => {
  const CASES: [string, () => BaseVFS][] = [['ssh', () => new SSHVFS({ host: 'h', username: 'u' })]]

  for (const [name, make] of CASES) {
    it(`${name} caches reads, does not revalidate, and is refused`, () => {
      const vfs = make()
      expect(vfs.cachesReads).toBe(true)
      expect(vfs.readRevalidatable).toBe(false)
      expect(() => {
        checkReadCapability('/r/', vfs, { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL })
      }).toThrow(/comparable content token/)
    })
  }

  it('gdrive declares the flag and is allowed fresh', () => {
    // The other side of the pair: one backend refused, one allowed, so the
    // verdict is shown to discriminate rather than merely to refuse.
    const vfs = new GDriveVFS({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })
    expect(vfs.cachesReads).toBe(true)
    expect(vfs.readRevalidatable).toBe(true)
    expect(() => {
      checkReadCapability('/gd/', vfs, { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL })
    }).not.toThrow()
  })
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

type Family =
  | 's3'
  | 'gridfs'
  | 'hf_models'
  | 'onedrive'
  | 'sharepoint'
  | 'hf_buckets'
  | 'github'
  | 'gdrive'
  | 'gdocs'
  | 'gsheets'
  | 'gslides'
  | 'dropbox'

const HARNESSES: Record<string, Family> = {
  ...Object.fromEntries(S3_FAMILY.map((name) => [name, 's3' as const])),
  gridfs: 'gridfs',
  ...Object.fromEntries(Object.keys(HF_FAMILY).map((name) => [name, 'hf_models' as const])),
  onedrive: 'onedrive',
  sharepoint: 'sharepoint',
  hf_buckets: 'hf_buckets',
  github: 'github',
  gdrive: 'gdrive',
  gdocs: 'gdocs',
  gsheets: 'gsheets',
  gslides: 'gslides',
  dropbox: 'dropbox',
}

// The mounts that render a Drive file through its editor API: the mime type
// they list, the door, and the name their listing gives the file.
const GAPPS: Record<
  string,
  [string, CommandIO, (title: string, id: string, modified: string) => string]
> = {
  gdocs: ['application/vnd.google-apps.document', gdocsIo.IO as CommandIO, docFilename],
  gsheets: ['application/vnd.google-apps.spreadsheet', gsheetsIo.IO as CommandIO, sheetFilename],
  gslides: ['application/vnd.google-apps.presentation', gslidesIo.IO as CommandIO, slideFilename],
}

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
const GDRIVE_CONFIG = { client_id: 'i', client_secret: 's', refresh_token: 'r' }
const DROPBOX_CONFIG = { client_id: 'i', client_secret: 's', refresh_token: 'r' }

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

const ALL_SHAPES: Shape[] = ['root', 'nested', 'prefixed']
const ALL_ROWS: Row[] = ['bytes', 'stream', 'drain']

// What each family can run, fixed when the rows are built. github and gdrive
// have no key_prefix, and their stream is their read handed over whole, one
// chunk, so a drain row would pass without draining. The GAPPS mounts also
// have one flat listing, so only one shape.
const FAMILY_SHAPES: Partial<Record<Family, Shape[]>> = {
  github: ['root', 'nested'],
  gdrive: ['root', 'nested'],
  gdocs: ['root'],
  gsheets: ['root'],
  gslides: ['root'],
}
const FAMILY_ROWS: Partial<Record<Family, Row[]>> = {
  github: ['bytes', 'stream'],
  gdrive: ['bytes', 'stream'],
  gdocs: ['bytes', 'stream'],
  gsheets: ['bytes', 'stream'],
  gslides: ['bytes', 'stream'],
}

const SPEC_VFS = resolve(
  fileURLToPath(import.meta.url),
  '../../../../../../spec/typescript/node/vfs.json',
)

interface Fake {
  vfs: BaseVFS
  accessor: Accessor
  key: string
  fetches: () => number
  rewrite: (data: Uint8Array) => void
  readBytes: (path: PathSpec) => Promise<Uint8Array>
  readStream: (path: PathSpec) => AsyncIterable<Uint8Array>
  stat: (path: PathSpec) => Promise<FileStat>
  // The slot a stream read records in: github's and gdrive's streams are
  // their whole read handed over, which records through `record`.
  streamSlot: 'stream' | 'bytes'
}

// The store each driver's mount runs under, filled when a fresh workspace
// places it. The index is the mount's, so a harness built before the
// workspace reads it here rather than off the driver.
const OWN_INDEX = new WeakMap<BaseVFS, IndexCacheStore>()

// The store `vfs`'s mount runs under, or one kept for direct calls made
// before any workspace placed it.
function ownIndex(vfs: BaseVFS): IndexCacheStore {
  let store = OWN_INDEX.get(vfs)
  if (store === undefined) {
    store = new RAMIndexCacheStore({ ttl: vfs.indexTtl })
    OWN_INDEX.set(vfs, store)
  }
  return store
}

function slotOf(fake: Fake, row: Row): string {
  return row === 'bytes' ? SLOTS[row] : fake.streamSlot
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

let gdriveIds = 0

function gdriveAdd(
  path: string,
  content: Uint8Array,
  mimeType = 'application/octet-stream',
): GDriveItem {
  const parts = path.split('/').filter((p) => p !== '')
  let parent = 'root'
  for (const dir of parts.slice(0, -1)) {
    const existing = [...H.gdrive.values()].find(
      (i) => i.name === dir && i.parents.includes(parent) && i.mimeType === GDRIVE_FOLDER,
    )
    if (existing !== undefined) {
      parent = existing.id
      continue
    }
    gdriveIds += 1
    const id = `d${String(gdriveIds)}`
    H.gdrive.set(id, {
      id,
      name: dir,
      mimeType: GDRIVE_FOLDER,
      parents: [parent],
      modifiedTime: '2026-04-16T00:00:00Z',
      content: new Uint8Array(0),
    })
    parent = id
  }
  gdriveIds += 1
  const item: GDriveItem = {
    id: `f${String(gdriveIds)}`,
    name: parts[parts.length - 1] ?? '',
    mimeType,
    parents: [parent],
    modifiedTime: '2026-04-16T00:00:00Z',
    content,
  }
  H.gdrive.set(item.id, item)
  return item
}

async function makeFake(name: string, shape: Shape, data: Uint8Array): Promise<Fake> {
  if (HARNESSES[name] === 'dropbox') {
    // Dropbox has no key_prefix; the prefixed shape mounts a root_path
    // instead, with a decoy at the same key outside it.
    const key = KEYS[shape]
    const root = shape === 'prefixed' ? `/${PREFIX.replace(/\/+$/, '')}` : '/'
    const stored = `${root.replace(/\/+$/, '')}/${key}`
    const dropbox = new InlineDropbox({ [stored]: data })
    if (shape === 'prefixed') dropbox.write(`/${key}`, DECOY)
    vi.stubGlobal('fetch', dropbox.fetch)
    const vfs = await buildVfs('dropbox', {
      ...DROPBOX_CONFIG,
      root_path: root,
      endpoint: dropbox.url,
    })
    const accessor = vfs.accessor as DropboxAccessor
    expect(vfs.readRevalidatable).toBe(true)
    const index = new RAMIndexCacheStore()
    return {
      vfs,
      accessor,
      key,
      fetches: () => dropbox.count('download'),
      rewrite: (next) => {
        dropbox.write(stored, next)
      },
      readBytes: (p) => dropboxIo.IO.readBytes(accessor, p, index),
      readStream: (p) => dropboxIo.IO.readStream(accessor, p, index),
      stat: (p) => dropboxIo.IO.stat(accessor, p, index),
      streamSlot: 'stream',
    }
  }
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
      base_url: gh.url,
    })
    const accessor = vfs.accessor as GitHubAccessor
    expect(vfs.readRevalidatable).toBe(true)
    const invalidate = Object.getOwnPropertyDescriptor(
      RAMIndexCacheStore.prototype,
      'invalidatePrefix',
    )?.value as (this: RAMIndexCacheStore, path: string) => Promise<void>
    vi.spyOn(RAMIndexCacheStore.prototype, 'invalidatePrefix').mockImplementation(function (
      this: RAMIndexCacheStore,
      path: string,
    ) {
      if (this !== OWN_INDEX.get(vfs)) H.reach.push('tree walk on a throwaway index')
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
      readBytes: (p) => githubIo.IO.readBytes(accessor, p, ownIndex(vfs)),
      readStream: (p) => githubIo.IO.readStream(accessor, p, ownIndex(vfs)),
      stat: (p) => githubIo.IO.stat(accessor, p, ownIndex(vfs)),
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
    expect(vfs.readRevalidatable).toBe(true)
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
        readBytes: (p) => onedriveIo.IO.readBytes(accessor, p),
        readStream: (p) => onedriveIo.IO.readStream(accessor, p),
        stat: (p) => onedriveIo.IO.stat(accessor, p),
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
      readBytes: (p) => sharepointIo.IO.readBytes(accessor, p),
      readStream: (p) => sharepointIo.IO.readStream(accessor, p),
      stat: (p) => sharepointIo.IO.stat(accessor, p),
      streamSlot: 'stream',
    }
  }
  if (HARNESSES[name] === 'gdrive') {
    const item = gdriveAdd(key, data)
    const vfs = await buildVfs('gdrive', GDRIVE_CONFIG)
    const accessor = vfs.accessor as GDriveAccessor
    expect(vfs.readRevalidatable).toBe(true)
    // An id-addressed backend resolves a path only through an index, so its
    // raw reads take one; stat takes none and answers from its own request.
    const index = new RAMIndexCacheStore()
    const before = H.gdriveDownloads
    return {
      vfs,
      accessor,
      key,
      fetches: () => H.gdriveDownloads - before,
      rewrite: (next) => {
        item.content = next
      },
      readBytes: (p) => gdriveIo.IO.readBytes(accessor, p, index),
      readStream: (p) => gdriveIo.IO.readStream(accessor, p, index),
      stat: (p) => gdriveIo.IO.stat(accessor, p),
      streamSlot: 'bytes',
    }
  }
  const gapp = GAPPS[name]
  if (gapp !== undefined) {
    const [mime, io, filename] = gapp
    const item = gdriveAdd('a', data, mime)
    const vfs = await buildVfs(name, GDRIVE_CONFIG)
    const accessor = vfs.accessor
    expect(vfs.readRevalidatable).toBe(true)
    // The fake names no owner, so the file lists under shared/. A rewrite
    // moves modifiedTime within the same day, which keeps the name.
    const fileKey = `shared/${filename('a', item.id, item.modifiedTime)}`
    const index = new RAMIndexCacheStore()
    const before = H.gdriveRenders
    let edits = 0
    return {
      vfs,
      accessor,
      key: fileKey,
      fetches: () => H.gdriveRenders - before,
      rewrite: (next) => {
        edits += 1
        item.content = next
        item.modifiedTime = `2026-04-16T00:00:${String(edits).padStart(2, '0')}Z`
      },
      readBytes: (p) => io.readBytes(accessor, p, index),
      readStream: (p) => io.readStream(accessor, p, index),
      stat: (p) => io.stat(accessor, p),
      streamSlot: 'bytes',
    }
  }
  if (HARNESSES[name] === 'hf_buckets') {
    // One Map behind both doors: the Hub serves it over HTTP and the opendal
    // fake lists and writes it. The opendal fake refuses every read, so a
    // stat or read that fell back to opendal fails here.
    const op = fakeHfOperator()
    const hub = new FakeHub()
    hub.repos.set('buckets|acme/bkt', op.files)
    await serveHub(hub)
    hubs.push(hub)
    op.files.set(stored, Buffer.from(data))
    if (prefix !== null) op.files.set(key, Buffer.from(DECOY))
    const vfs = await buildVfs('hf_buckets', {
      bucket: 'acme/bkt',
      endpoint: hub.url,
      ...(prefix === null ? {} : { key_prefix: prefix }),
    })
    const accessor = vfs.accessor as HfBucketsAccessor
    expect(vfs.readRevalidatable).toBe(true)
    op.root = accessor.operatorOptions().root ?? ''
    op.reach = H.reach
    vi.spyOn(accessor, 'operator').mockResolvedValue(op as never)
    const before = hub.count('bucket_resolve')
    return {
      vfs,
      accessor,
      key,
      fetches: () => hub.count('bucket_resolve') - before,
      rewrite: (next) => {
        op.files.set(stored, Buffer.from(next))
      },
      readBytes: (p) => hfBucketsIo.IO.readBytes(accessor, p),
      readStream: (p) => hfBucketsIo.IO.readStream(accessor, p),
      stat: (p) => hfBucketsIo.IO.stat(accessor, p),
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
    expect(vfs.readRevalidatable).toBe(true)
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
      if (this !== OWN_INDEX.get(vfs)) H.reach.push('tree walk on a throwaway index')
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
      readBytes: (p) => hfHubIo.IO.readBytes(accessor, p),
      readStream: (p) => hfHubIo.IO.readStream(accessor, p),
      stat: (p) => hfHubIo.IO.stat(accessor, p),
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
    expect(vfs.readRevalidatable).toBe(true)
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
      readBytes: (p) => gridfsIo.IO.readBytes(accessor, p),
      readStream: (p) => gridfsIo.IO.readStream(accessor, p),
      stat: (p) => gridfsIo.IO.stat(accessor, p),
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
  expect(vfs.readRevalidatable).toBe(true)
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
    readBytes: (p) => s3Io.IO.readBytes(accessor, p),
    readStream: (p) => s3Io.IO.readStream(accessor, p),
    stat: (p) => s3Io.IO.stat(accessor, p),
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
    const shapes: Shape[] = name === family ? (FAMILY_SHAPES[family] ?? ALL_SHAPES) : ['root']
    for (const shape of shapes)
      for (const row of rows) {
        if (!(FAMILY_ROWS[family] ?? ALL_ROWS).includes(row)) continue
        out.push({ name, shape, row })
      }
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

function freshWorkspace(vfs: BaseVFS): Workspace {
  const ws = new Workspace({
    '/m': new Mount(vfs, {
      mode: MountMode.WRITE,
      read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
    }),
    '/r': [new RAMVFS(), MountMode.WRITE],
  })
  OWN_INDEX.set(vfs, ws.mount('/m').indexStore)
  return ws
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
    H.gdrive.clear()
    H.gdriveDownloads = 0
    H.gdriveRenders = 0
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

  it('each family runs exactly its rows', () => {
    // The per-family table filters the rows as they are built, so a filter
    // bug drops a row silently or hands a whole-read stream a drain row that
    // passes without draining. Pin the ids outright rather than the count.
    const aliases = [...S3_FAMILY.filter((n) => n !== 's3'), 'hf_datasets', 'hf_spaces']
    // Literals, not ALL_SHAPES / ALL_ROWS: the expectation must not move with
    // the tables it checks.
    const shapes = ['root', 'nested', 'prefixed']
    const rows = ['bytes', 'stream', 'drain']
    const expectedA = new Set<string>([
      's3-listed-stream',
      'onedrive-listed-stream',
      'sharepoint-listed-stream',
    ])
    for (const family of [
      's3',
      'gridfs',
      'hf_models',
      'onedrive',
      'sharepoint',
      'hf_buckets',
      'dropbox',
    ])
      for (const shape of shapes) for (const row of rows) expectedA.add(`${family}-${shape}-${row}`)
    for (const n of aliases) for (const row of rows) expectedA.add(`${n}-root-${row}`)
    for (const family of ['github', 'gdrive'])
      for (const shape of ['root', 'nested'])
        for (const row of ['bytes', 'stream']) expectedA.add(`${family}-${shape}-${row}`)
    for (const family of ['gdocs', 'gsheets', 'gslides'])
      for (const row of ['bytes', 'stream']) expectedA.add(`${family}-root-${row}`)
    const ids = (cs: Case[]): Set<string> => new Set(cs.map((c) => `${c.name}-${c.shape}-${c.row}`))
    expect(ids(A_CASES)).toEqual(expectedA)
    expect(ids(B_CASES)).toEqual(
      new Set([...expectedA].filter((i) => !i.endsWith('-drain') && !i.endsWith('-listed-stream'))),
    )
    const whole = ['github', 'gdrive', 'gdocs', 'gsheets', 'gslides']
    expect(cases(['drain']).some((c) => whole.includes(c.name))).toBe(false)
  })

  it('a native gdoc under fresh renders once until it changes', async () => {
    // A native file has no md5 and no head revision; its token is the
    // listing's modifiedTime, and it reaches the cache only through the
    // native read's own record. Twin of the python e2e row.
    const doc = gdriveAdd('doc', ENC.encode('{"v": 1}'), 'application/vnd.google-apps.document')
    const vfs = await buildVfs('gdrive', GDRIVE_CONFIG)
    const ws = freshWorkspace(vfs)
    try {
      expect(await line(ws, 'cat /m/doc.gdoc.json')).toEqual(ENC.encode('{"v": 1}'))
      // The positive control: without it the warm assertion below would also
      // pass if `cat` stopped reaching the counted renderer entirely.
      expect(H.gdriveRenders).toBe(1)
      expect(await line(ws, 'cat /m/doc.gdoc.json')).toEqual(ENC.encode('{"v": 1}'))
      expect(H.gdriveRenders).toBe(1)
      doc.content = ENC.encode('{"v": 2}')
      doc.modifiedTime = '2026-05-01T00:00:00Z'
      expect(await line(ws, 'cat /m/doc.gdoc.json')).toEqual(ENC.encode('{"v": 2}'))
      expect(H.gdriveRenders).toBe(2)
      // The refetch has to stamp the new token, or every later read renders.
      expect(await line(ws, 'cat /m/doc.gdoc.json')).toEqual(ENC.encode('{"v": 2}'))
      expect(H.gdriveRenders).toBe(2)
    } finally {
      await ws.close()
    }
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

        // A cp of a rendered Google file reads through the dispatcher, where a
        // filetype read op always renders and keeps nothing, so its second cp
        // fetches again. Every other read left an entry reconcile calls
        // FRESH, and the warm read made no content fetch.
        const renders = row === 'bytes' && name in GAPPS
        const stat = await reconcileStat(ws, fake, virtual)
        expect(stat.fingerprint).not.toBeNull()
        expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(!renders)

        // The drain row's second run reads the whole entry back, so a drain
        // that cached a truncated buffer cannot pass.
        let second = await line(ws, command)
        if (row === 'bytes') second = await line(ws, 'cat /r/a.txt')
        expect(fake.fetches()).toBe(renders ? 2 : 1)
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

  // The probe stats through a throwaway store, so dropbox answers it with one
  // get_metadata rather than listing the whole folder into it.
  it('a dropbox fresh probe asks for the file, not its folder', async () => {
    const files: Record<string, Uint8Array> = { '/d/a.txt': SEED }
    for (let i = 0; i < 5; i++) files[`/d/f${String(i)}.txt`] = DECOY
    const dropbox = new InlineDropbox(files)
    vi.stubGlobal('fetch', dropbox.fetch)
    const vfs = await buildVfs('dropbox', { ...DROPBOX_CONFIG, endpoint: dropbox.url })
    const ws = freshWorkspace(vfs)
    try {
      await line(ws, 'cat /m/d/a.txt')
      const before = dropbox.log.length
      expect(await line(ws, 'cat /m/d/a.txt')).toEqual(SEED)
      const routes = dropbox.log.slice(before).filter((r) => r !== 'token')
      expect(routes).not.toContain('list_folder')
      expect(routes).not.toContain('download')
      expect(routes).toContain('get_metadata')
    } finally {
      await ws.close()
    }
  })

  // A 409 other than not_found cannot verify the copy: the read fails but the
  // file is not called gone, so chmod's 600 stays. A real miss drops it, so it
  // never carries over to a file re-created at the path.
  it.each([
    ['restricted', false],
    ['deleted', true],
  ])('a dropbox probe drops an overlay only on a miss (%s)', async (_id, gone) => {
    const dropbox = new InlineDropbox({ '/d/a.txt': SEED })
    vi.stubGlobal('fetch', dropbox.fetch)
    const vfs = await buildVfs('dropbox', { ...DROPBOX_CONFIG, endpoint: dropbox.url })
    const ws = freshWorkspace(vfs)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await line(ws, 'cat /m/d/a.txt')
      await line(ws, 'chmod 600 /m/d/a.txt')
      if (gone) dropbox.files.delete('/d/a.txt')
      else dropbox.restricted.add('/d/a.txt')
      const result = await ws.shell('cat /m/d/a.txt')
      dropbox.restricted.clear()
      dropbox.write('/d/a.txt', SEED)
      expect(result.exitCode).toBe(1)
      expect(new TextDecoder().decode(result.stderr).includes('No such file')).toBe(gone)
      expect(new TextDecoder().decode(await line(ws, 'stat -c %a /m/d/a.txt'))).toBe(
        gone ? '644\n' : '600\n',
      )
    } finally {
      warn.mockRestore()
      await ws.close()
    }
  })

  it('the contract goes red on a backend with two token kinds', async () => {
    // s3 forced to stat a timestamp while its read stamps the ETag: both
    // tokens exist and differ. The contract must fail it, or it could not
    // tell a backend that keeps the promise from one that only makes it.
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

  it('the contract goes red on hf_buckets stamping another kind', async () => {
    // hf_buckets forced to stamp a hash of the header rather than the token
    // stat reports: both exist and differ, so the entry must never be called
    // fresh, and the warm read refetches exactly once. The override sits on
    // the bytes slot, so the line is a cp.
    const fake = await makeFake('hf_buckets', 'root', SEED)
    const otherKind = createHash('sha1')
      .update(`"${xetHash(SEED)}"`)
      .digest('hex')
    H.stampOverride = otherKind
    const virtual = '/m/a.txt'
    const ws = freshWorkspace(fake.vfs)
    try {
      await line(ws, `cp ${virtual} /r/a.txt`)
      expect(await ws.cache.isFresh(virtual, otherKind)).toBe(true)
      const stat = await reconcileStat(ws, fake, virtual)
      expect(stat.fingerprint).toBe(xetHash(SEED))
      expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(false)
      const before = fake.fetches()
      await line(ws, `cp ${virtual} /r/b.txt`)
      expect(fake.fetches() - before).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it("github's stream is its read, so it records through record", () => {
    // Its expected stream slot is "bytes" for that reason. A native stream
    // that forgot to record would otherwise hide behind that slot.
    expect(githubIo.IO.readStream).toBe(githubStream)
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
      expect(stat.fingerprint).toBe(blobSha(SEED))
      expect(await ws.cache.isFresh(virtual, stat.fingerprint ?? '')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  describe('partial searches cannot evict live app bytes or overlays', () => {
    it.each(['gdocs', 'gsheets', 'gslides'])('%s', async (name) => {
      const fake = await makeFake(name, 'root', SEED)
      const virtual = `/m/${fake.key}`
      const ws = freshWorkspace(fake.vfs)
      const search = vi.spyOn(googleDrive, 'listAllFiles')
      try {
        await line(ws, `cat ${virtual}`)
        await line(ws, `chmod 600 ${virtual}`)
        search.mockClear().mockResolvedValue({ files: [], complete: false })
        const before = fake.fetches()
        expect(await line(ws, `cat ${virtual}`)).toEqual(SEED)
        expect(new TextDecoder().decode(await line(ws, `stat -c %a ${virtual}`))).toBe('600\n')
        expect(fake.fetches()).toBe(before)
        expect(search).not.toHaveBeenCalled()
      } finally {
        await ws.close()
      }
    })
  })
})

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

import { describe, expect, it } from 'vitest'
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
import { GDriveVFS } from './gdrive/gdrive.ts'
import { GridFSVFS } from './gridfs/gridfs.ts'
import { SSHVFS } from './ssh/ssh.ts'
import { readRevalidatable, type VFS } from '@struktoai/mirage-core/vfs/base'
import { checkReadCapability } from '@struktoai/mirage-core/workspace/mount/read_policy'
import { DEFAULT_READ_TTL, ReadPolicy } from '@struktoai/mirage-core/types'

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

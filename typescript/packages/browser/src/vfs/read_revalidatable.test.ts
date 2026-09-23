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
      const vfs = new cls({
        bucket: 'b',
        endpoint: 'http://127.0.0.1:9000',
        accountId: 'acct',
        projectRef: 'proj',
        // Browser GCS signs in the host, so its config requires one.
        presignedUrlProvider: () => Promise.resolve('http://127.0.0.1/signed'),
      })
      expect(vfs.readRevalidatable).toBe(true)
      expect(vfs.cachesReads).toBe(true)
    })
  }
})

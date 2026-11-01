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

import { redactConfigWithSchema } from '@struktoai/mirage-core/vfs/secrets'
import { describe, expect, it } from 'vitest'
import { AliyunConfig } from './aliyun/config.ts'
import { BackblazeConfig } from './backblaze/config.ts'
import { CephConfig } from './ceph/config.ts'
import { DigitalOceanConfig } from './digitalocean/config.ts'
import { GCSConfig } from './gcs/config.ts'
import { MinIOConfig } from './minio/config.ts'
import { OCIConfig } from './oci/config.ts'
import { QingStorConfig } from './qingstor/config.ts'
import { R2Config } from './r2/config.ts'
import type { S3BrowserPresignedUrlProvider, S3Config } from './s3/config.ts'
import { ScalewayConfig } from './scaleway/config.ts'
import { SeaweedFSConfig } from './seaweedfs/config.ts'
import { SupabaseConfig } from './supabase/config.ts'
import { TencentConfig } from './tencent/config.ts'
import { WasabiConfig } from './wasabi/config.ts'

const provider: S3BrowserPresignedUrlProvider = () => Promise.resolve('https://signed.example.com')

const BASE = { bucket: 'b', presignedUrlProvider: provider }

type ToS3 = (config: never) => S3Config

// One field fills one URL template. `resolved` answers undefined when the
// config lacks the field the rule needs, and an explicit endpoint always
// wins over the derived one.
const DERIVED = [
  {
    name: 'aliyun',
    field: 'region',
    value: 'cn-hangzhou',
    endpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
    resolved: AliyunConfig.resolvedEndpoint as (config: never) => string | undefined,
    toS3: AliyunConfig.toS3Config as ToS3,
  },
  {
    name: 'backblaze',
    field: 'region',
    value: 'us-west-004',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    resolved: BackblazeConfig.resolvedEndpoint as (config: never) => string | undefined,
    toS3: BackblazeConfig.toS3Config as ToS3,
  },
  {
    name: 'digitalocean',
    field: 'region',
    value: 'nyc3',
    endpoint: 'https://nyc3.digitaloceanspaces.com',
    resolved: DigitalOceanConfig.resolvedEndpoint as (config: never) => string | undefined,
    toS3: DigitalOceanConfig.toS3Config as ToS3,
  },
  {
    name: 'qingstor',
    field: 'region',
    value: 'pek3a',
    endpoint: 'https://s3.pek3a.qingstor.com',
    resolved: QingStorConfig.resolvedEndpoint as (config: never) => string | undefined,
    toS3: QingStorConfig.toS3Config as ToS3,
  },
  {
    name: 'scaleway',
    field: 'region',
    value: 'fr-par',
    endpoint: 'https://s3.fr-par.scw.cloud',
    resolved: ScalewayConfig.resolvedEndpoint as (config: never) => string | undefined,
    toS3: ScalewayConfig.toS3Config as ToS3,
  },
  {
    name: 'tencent',
    field: 'region',
    value: 'ap-guangzhou',
    endpoint: 'https://cos.ap-guangzhou.myqcloud.com',
    resolved: TencentConfig.resolvedEndpoint as (config: never) => string | undefined,
    toS3: TencentConfig.toS3Config as ToS3,
  },
  {
    name: 'r2',
    field: 'accountId',
    value: 'account123',
    endpoint: 'https://account123.r2.cloudflarestorage.com',
    resolved: R2Config.resolvedEndpoint as (config: never) => string | undefined,
    toS3: R2Config.toS3Config as ToS3,
  },
  {
    name: 'supabase',
    field: 'projectRef',
    value: 'projref',
    endpoint: 'https://projref.storage.supabase.co/storage/v1/s3',
    resolved: SupabaseConfig.resolvedEndpoint as (config: never) => string | undefined,
    toS3: SupabaseConfig.toS3Config as ToS3,
  },
] as const

describe('derived-endpoint browser S3 aliases', () => {
  for (const c of DERIVED) {
    it(`${c.name}: derives the endpoint from ${c.field}`, () => {
      expect(c.resolved({ ...BASE, [c.field]: c.value } as never)).toBe(c.endpoint)
    })

    it(`${c.name}: an explicit endpoint wins`, () => {
      const config = { ...BASE, [c.field]: c.value, endpoint: 'https://custom.example.com' }
      expect(c.resolved(config as never)).toBe('https://custom.example.com')
    })

    it(`${c.name}: no endpoint at all without ${c.field}`, () => {
      expect(c.resolved(BASE as never)).toBeUndefined()
      expect(c.toS3(BASE as never).endpoint).toBeUndefined()
    })

    it(`${c.name}: toS3Config forwards the shared fields`, () => {
      const s3 = c.toS3({
        ...BASE,
        [c.field]: c.value,
        defaultContentType: 'text/plain',
        keyPrefix: 'team/reports',
      } as never)
      expect(s3.bucket).toBe('b')
      expect(s3.presignedUrlProvider).toBe(provider)
      expect(s3.endpoint).toBe(c.endpoint)
      expect(s3.defaultContentType).toBe('text/plain')
      expect(s3.keyPrefix).toBe('team/reports')
    })
  }
})

describe('pass-through browser S3 aliases (ceph/minio/seaweedfs)', () => {
  const CASES = [
    { name: 'ceph', toS3: CephConfig.toS3Config as ToS3 },
    { name: 'minio', toS3: MinIOConfig.toS3Config as ToS3 },
    { name: 'seaweedfs', toS3: SeaweedFSConfig.toS3Config as ToS3 },
  ] as const

  for (const c of CASES) {
    it(`${c.name}: keeps the caller's endpoint and region verbatim`, () => {
      const s3 = c.toS3({ ...BASE, endpoint: 'http://localhost:9000', region: 'r' } as never)
      expect(s3.endpoint).toBe('http://localhost:9000')
      expect(s3.region).toBe('r')
      expect(s3.forcePathStyle).toBeUndefined()
    })

    it(`${c.name}: derives nothing when the caller gave no endpoint`, () => {
      const s3 = c.toS3(BASE as never)
      expect(s3.endpoint).toBeUndefined()
      expect(s3.region).toBeUndefined()
    })
  }
})

describe('browser S3 aliases with their own rule', () => {
  it('gcs defaults both the region and the endpoint', () => {
    const s3 = GCSConfig.toS3Config(BASE)
    expect(s3.region).toBe('auto')
    expect(s3.endpoint).toBe('https://storage.googleapis.com')
  })

  it('gcs still honors an explicit endpoint and region', () => {
    const s3 = GCSConfig.toS3Config({
      ...BASE,
      region: 'eu',
      endpoint: 'https://custom.example.com',
    })
    expect(s3.region).toBe('eu')
    expect(s3.endpoint).toBe('https://custom.example.com')
  })

  it('r2 reports region auto while deriving from the account id', () => {
    expect(R2Config.toS3Config({ ...BASE, accountId: 'acct' }).region).toBe('auto')
  })

  it('oci needs both a namespace and a region', () => {
    expect(OCIConfig.resolvedEndpoint({ ...BASE, namespace: 'ns' })).toBeUndefined()
    expect(OCIConfig.resolvedEndpoint({ ...BASE, region: 'us-ashburn-1' })).toBeUndefined()
    expect(OCIConfig.resolvedEndpoint({ ...BASE, namespace: 'ns', region: 'us-ashburn-1' })).toBe(
      'https://ns.compat.objectstorage.us-ashburn-1.oci.customer-oci.com',
    )
  })

  it('oci forwards the region it derived from', () => {
    expect(OCIConfig.toS3Config({ ...BASE, namespace: 'ns', region: 'us-ashburn-1' }).region).toBe(
      'us-ashburn-1',
    )
  })

  // supabase is the one alias whose gateway does not serve virtual-hosted
  // style, so it pins path style on where the others leave it unset.
  it('supabase forces path style', () => {
    expect(SupabaseConfig.toS3Config({ ...BASE, projectRef: 'p' }).forcePathStyle).toBe(true)
  })

  it('wasabi always resolves an endpoint, defaulting to the us-east-1 host', () => {
    expect(WasabiConfig.resolvedEndpoint(BASE)).toBe('https://s3.wasabisys.com')
    expect(WasabiConfig.resolvedEndpoint({ ...BASE, region: 'us-east-1' })).toBe(
      'https://s3.wasabisys.com',
    )
    expect(WasabiConfig.resolvedEndpoint({ ...BASE, region: 'us-west-1' })).toBe(
      'https://s3.us-west-1.wasabisys.com',
    )
  })

  // The endpoint default does not leak into the region: an unset region
  // stays unset on the S3Config, which is where wasabi differs from node's.
  it('wasabi leaves an unset region unset', () => {
    expect(WasabiConfig.toS3Config(BASE).region).toBeUndefined()
    expect(WasabiConfig.toS3Config(BASE).endpoint).toBe('https://s3.wasabisys.com')
  })
})

describe('browser S3 alias redaction', () => {
  it('hides the presigned-url provider', () => {
    const redacted = redactConfigWithSchema(AliyunConfig, {
      ...BASE,
      region: 'cn-hangzhou',
    }) as unknown as Record<string, unknown>
    expect(redacted.bucket).toBe('b')
    expect(redacted.presignedUrlProvider).not.toBe(provider)
    expect(JSON.stringify(redacted).includes('<REDACTED>')).toBe(true)
  })
})

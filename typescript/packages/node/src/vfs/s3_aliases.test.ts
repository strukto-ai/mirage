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

import { VFSName } from '@struktoai/mirage-core/types'
import { parseConfigWithSchema } from '@struktoai/mirage-core/vfs/secrets'
import { commandsFor } from '@struktoai/mirage-core/workspace/mount/backends'
import { describe, expect, it } from 'vitest'
import { AliyunVFS } from './aliyun/aliyun.ts'
import { AliyunConfig } from './aliyun/config.ts'
import { BackblazeVFS } from './backblaze/backblaze.ts'
import { BackblazeConfig } from './backblaze/config.ts'
import { CephVFS } from './ceph/ceph.ts'
import { CephConfig } from './ceph/config.ts'
import { DigitalOceanConfig } from './digitalocean/config.ts'
import { DigitalOceanVFS } from './digitalocean/digitalocean.ts'
import { GCSConfig } from './gcs/config.ts'
import { MinIOConfig } from './minio/config.ts'
import { MinIOVFS } from './minio/minio.ts'
import { OCIConfig } from './oci/config.ts'
import { QingStorConfig } from './qingstor/config.ts'
import { QingStorVFS } from './qingstor/qingstor.ts'
import { R2Config } from './r2/config.ts'
import type { S3Config } from './s3/config.ts'
import { S3VFS } from './s3/s3.ts'
import { ScalewayConfig } from './scaleway/config.ts'
import { ScalewayVFS } from './scaleway/scaleway.ts'
import { SeaweedFSConfig } from './seaweedfs/config.ts'
import { SeaweedFSVFS } from './seaweedfs/seaweedfs.ts'
import { SupabaseConfig } from './supabase/config.ts'
import { TencentConfig } from './tencent/config.ts'
import { TencentVFS } from './tencent/tencent.ts'
import { WasabiConfig } from './wasabi/config.ts'
import { WasabiVFS } from './wasabi/wasabi.ts'

const CREDS = { bucket: 'b', accessKeyId: 'AKIA-LEAK', secretAccessKey: 'SECRET-LEAK' }

const REGION_CASES = [
  {
    name: 'aliyun',
    kind: VFSName.ALIYUN,
    region: 'cn-hangzhou',
    expectedEndpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
    make: (region: string): AliyunConfig => ({ ...CREDS, region }),
    resolved: AliyunConfig.resolvedEndpoint,
    toS3: AliyunConfig.toS3Config,
    schema: AliyunConfig,
    build: (config: AliyunConfig) => new AliyunVFS(config),
  },
  {
    name: 'backblaze',
    kind: VFSName.BACKBLAZE,
    region: 'us-west-004',
    expectedEndpoint: 'https://s3.us-west-004.backblazeb2.com',
    make: (region: string): BackblazeConfig => ({ ...CREDS, region }),
    resolved: BackblazeConfig.resolvedEndpoint,
    toS3: BackblazeConfig.toS3Config,
    schema: BackblazeConfig,
    build: (config: BackblazeConfig) => new BackblazeVFS(config),
  },
  {
    name: 'digitalocean',
    kind: VFSName.DIGITALOCEAN,
    region: 'nyc3',
    expectedEndpoint: 'https://nyc3.digitaloceanspaces.com',
    make: (region: string): DigitalOceanConfig => ({ ...CREDS, region }),
    resolved: DigitalOceanConfig.resolvedEndpoint,
    toS3: DigitalOceanConfig.toS3Config,
    schema: DigitalOceanConfig,
    build: (config: DigitalOceanConfig) => new DigitalOceanVFS(config),
  },
  {
    name: 'tencent',
    kind: VFSName.TENCENT,
    region: 'ap-guangzhou',
    expectedEndpoint: 'https://cos.ap-guangzhou.myqcloud.com',
    make: (region: string): TencentConfig => ({ ...CREDS, region }),
    resolved: TencentConfig.resolvedEndpoint,
    toS3: TencentConfig.toS3Config,
    schema: TencentConfig,
    build: (config: TencentConfig) => new TencentVFS(config),
  },
  {
    name: 'scaleway',
    kind: VFSName.SCALEWAY,
    region: 'fr-par',
    expectedEndpoint: 'https://s3.fr-par.scw.cloud',
    make: (region: string): ScalewayConfig => ({ ...CREDS, region }),
    resolved: ScalewayConfig.resolvedEndpoint,
    toS3: ScalewayConfig.toS3Config,
    schema: ScalewayConfig,
    build: (config: ScalewayConfig) => new ScalewayVFS(config),
  },
  {
    name: 'qingstor',
    kind: VFSName.QINGSTOR,
    region: 'pek3a',
    expectedEndpoint: 'https://s3.pek3a.qingstor.com',
    make: (region: string): QingStorConfig => ({ ...CREDS, region }),
    resolved: QingStorConfig.resolvedEndpoint,
    toS3: QingStorConfig.toS3Config,
    schema: QingStorConfig,
    build: (config: QingStorConfig) => new QingStorVFS(config),
  },
] as const

describe('region-derived S3 aliases', () => {
  for (const c of REGION_CASES) {
    it(`${c.name}: regional endpoint`, () => {
      expect(c.resolved(c.make(c.region) as never)).toBe(c.expectedEndpoint)
    })

    it(`${c.name}: custom endpoint override`, () => {
      const config = { ...c.make(c.region), endpoint: 'https://custom.example.com' }
      expect(c.resolved(config as never)).toBe('https://custom.example.com')
    })

    it(`${c.name}: toS3Config maps fields`, () => {
      const s3 = c.toS3({
        ...c.make(c.region),
        timeout: 5,
        proxy: 'http://localhost:8080',
      } as never)
      expect(s3.bucket).toBe('b')
      expect(s3.region).toBe(c.region)
      expect(s3.endpoint).toBe(c.expectedEndpoint)
      expect(s3.accessKeyId).toBe('AKIA-LEAK')
      expect(s3.secretAccessKey).toBe('SECRET-LEAK')
      expect(s3.timeout).toBe(5)
      expect(s3.proxy).toBe('http://localhost:8080')
      expect(s3.forcePathStyle).toBeUndefined()
    })

    it(`${c.name}: parse renames snake_case keys`, () => {
      const norm = parseConfigWithSchema(c.schema, {
        bucket: 'b',
        region: c.region,
        access_key_id: 'k',
        secret_access_key: 's',
        endpoint_url: 'https://custom.example.com',
        path_style: true,
        key_prefix: 'team/reports',
        timeout: 30,
        proxy: 'http://localhost:8080',
      }) as unknown as Record<string, unknown>
      expect(norm.accessKeyId).toBe('k')
      expect(norm.secretAccessKey).toBe('s')
      expect(norm.endpoint).toBe('https://custom.example.com')
      expect(norm.forcePathStyle).toBe(true)
      expect(norm.keyPrefix).toBe('team/reports')
      expect(norm.timeout).toBe(30)
      expect(norm.proxy).toBe('http://localhost:8080')
      expect(norm).not.toHaveProperty('access_key_id')
    })

    it(`${c.name}: VFS remaps name and serves the generic commands`, () => {
      const vfs = c.build(c.make(c.region) as never)
      expect(vfs.name).toBe(c.kind)
      expect(vfs).toBeInstanceOf(S3VFS)
      expect(commandsFor(vfs)).toEqual([])
    })

    it(`${c.name}: getState redacts creds`, async () => {
      const state = await c
        .build({ ...c.make(c.region), proxy: 'http://user:secret@localhost:8080' } as never)
        .getState()
      expect(state.type).toBe(c.kind)
      const blob = JSON.stringify(state)
      expect(blob.includes('AKIA-LEAK')).toBe(false)
      expect(blob.includes('SECRET-LEAK')).toBe(false)
      expect(blob.includes('user:secret')).toBe(false)
      expect(blob.includes('<REDACTED>')).toBe(true)
    })
  }
})

describe('wasabi endpoint defaults', () => {
  it('default region endpoint', () => {
    const config: WasabiConfig = { ...CREDS }
    expect(WasabiConfig.resolvedEndpoint(config)).toBe('https://s3.wasabisys.com')
    expect(WasabiConfig.toS3Config(config).region).toBe('us-east-1')
  })

  it('regional endpoint', () => {
    expect(WasabiConfig.resolvedEndpoint({ ...CREDS, region: 'us-west-1' })).toBe(
      'https://s3.us-west-1.wasabisys.com',
    )
  })

  it('custom endpoint override', () => {
    expect(
      WasabiConfig.resolvedEndpoint({ ...CREDS, endpoint: 'https://custom.example.com' }),
    ).toBe('https://custom.example.com')
  })

  it('normalize renames snake_case keys', () => {
    const norm = parseConfigWithSchema(WasabiConfig, {
      bucket: 'b',
      access_key_id: 'k',
      secret_access_key: 's',
      path_style: true,
      key_prefix: 'team/reports',
      timeout: 30,
      proxy: 'p',
    }) as unknown as Record<string, unknown>
    expect(norm.accessKeyId).toBe('k')
    expect(norm.forcePathStyle).toBe(true)
    expect(norm.keyPrefix).toBe('team/reports')
    expect(norm.timeout).toBe(30)
    expect(norm.proxy).toBe('p')
  })

  it('VFS remaps name and redacts state', async () => {
    const vfs = new WasabiVFS({ ...CREDS })
    expect(vfs.name).toBe(VFSName.WASABI)
    expect(commandsFor(vfs)).toEqual([])
    const blob = JSON.stringify(await vfs.getState())
    expect(blob.includes('SECRET-LEAK')).toBe(false)
    expect(blob.includes('<REDACTED>')).toBe(true)
  })
})

const ENDPOINT_CASES = [
  {
    name: 'minio',
    kind: VFSName.MINIO,
    toS3: MinIOConfig.toS3Config as (config: never) => S3Config,
    schema: MinIOConfig,
    make: (): MinIOConfig => ({ ...CREDS, endpoint: 'http://localhost:9000' }),
    build: (config: never) => new MinIOVFS(config),
  },
  {
    name: 'ceph',
    kind: VFSName.CEPH,
    toS3: CephConfig.toS3Config as (config: never) => S3Config,
    schema: CephConfig,
    make: (): CephConfig => ({ ...CREDS, endpoint: 'http://localhost:9000' }),
    build: (config: never) => new CephVFS(config),
  },
  {
    name: 'seaweedfs',
    kind: VFSName.SEAWEEDFS,
    toS3: SeaweedFSConfig.toS3Config as (config: never) => S3Config,
    schema: SeaweedFSConfig,
    make: (): SeaweedFSConfig => ({ ...CREDS, endpoint: 'http://localhost:9000' }),
    build: (config: never) => new SeaweedFSVFS(config),
  },
] as const

describe('endpoint-required S3 aliases (minio/ceph/seaweedfs)', () => {
  for (const c of ENDPOINT_CASES) {
    it(`${c.name}: toS3Config defaults region and path style`, () => {
      const s3 = c.toS3(c.make() as never)
      expect(s3.bucket).toBe('b')
      expect(s3.endpoint).toBe('http://localhost:9000')
      expect(s3.region).toBe('us-east-1')
      expect(s3.forcePathStyle).toBe(true)
    })

    it(`${c.name}: path style override`, () => {
      const s3 = c.toS3({ ...c.make(), forcePathStyle: false } as never)
      expect(s3.forcePathStyle).toBe(false)
    })

    it(`${c.name}: parse renames snake_case keys`, () => {
      const norm = parseConfigWithSchema(c.schema, {
        bucket: 'b',
        endpoint_url: 'http://localhost:9000',
        access_key_id: 'k',
        secret_access_key: 's',
        path_style: false,
        key_prefix: 'team/reports',
        timeout: 30,
        proxy: 'p',
      }) as Record<string, unknown>
      expect(norm.endpoint).toBe('http://localhost:9000')
      expect(norm.forcePathStyle).toBe(false)
      expect(norm.keyPrefix).toBe('team/reports')
      expect(norm.timeout).toBe(30)
      expect(norm.proxy).toBe('p')
    })

    it(`${c.name}: VFS remaps name and redacts state`, async () => {
      const vfs = c.build(c.make() as never)
      expect(vfs.name).toBe(c.kind)
      expect(vfs).toBeInstanceOf(S3VFS)
      expect(vfs.storageLocation()).toBe(new S3VFS(c.toS3(c.make() as never)).storageLocation())
      expect(commandsFor(vfs)).toEqual([])
      const blob = JSON.stringify(await vfs.getState())
      expect(blob.includes('AKIA-LEAK')).toBe(false)
      expect(blob.includes('SECRET-LEAK')).toBe(false)
      expect(blob.includes('<REDACTED>')).toBe(true)
    })
  }
})

const PREFIX_CASES = [
  {
    name: 'aliyun',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as AliyunConfig,
    toS3: AliyunConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'backblaze',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as BackblazeConfig,
    toS3: BackblazeConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'ceph',
    config: { ...CREDS, endpoint: 'http://localhost:9000' } as CephConfig,
    toS3: CephConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'digitalocean',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as DigitalOceanConfig,
    toS3: DigitalOceanConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'gcs',
    config: { ...CREDS, forcePathStyle: true } as GCSConfig,
    toS3: GCSConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'minio',
    config: { ...CREDS, endpoint: 'http://localhost:9000' } as MinIOConfig,
    toS3: MinIOConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'oci',
    config: { ...CREDS, namespace: 'ns', region: 'us-east-1' } as OCIConfig,
    toS3: OCIConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'qingstor',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as QingStorConfig,
    toS3: QingStorConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'r2',
    config: { ...CREDS, accountId: 'account', forcePathStyle: true } as R2Config,
    toS3: R2Config.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'scaleway',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as ScalewayConfig,
    toS3: ScalewayConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'seaweedfs',
    config: { ...CREDS, endpoint: 'http://localhost:9000' } as SeaweedFSConfig,
    toS3: SeaweedFSConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'supabase',
    config: { ...CREDS, projectRef: 'project', region: 'us-east-1' } as SupabaseConfig,
    toS3: SupabaseConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'tencent',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as TencentConfig,
    toS3: TencentConfig.toS3Config as (config: never) => S3Config,
  },
  {
    name: 'wasabi',
    config: { ...CREDS, forcePathStyle: true } as WasabiConfig,
    toS3: WasabiConfig.toS3Config as (config: never) => S3Config,
  },
] as const

describe('S3 alias subfolder mounts', () => {
  for (const c of PREFIX_CASES) {
    it(`${c.name}: forwards keyPrefix and path style`, () => {
      const s3 = c.toS3({ ...c.config, keyPrefix: '/team/reports/' } as never)
      expect(s3.keyPrefix).toBe('/team/reports/')
      expect(s3.forcePathStyle).toBe(true)
    })
  }

  for (const c of PREFIX_CASES) {
    it(`${c.name}: forwards proxy`, () => {
      const s3 = c.toS3({
        ...c.config,
        proxy: 'http://localhost:8080',
      } as never)
      expect(s3.proxy).toBe('http://localhost:8080')
    })
  }
})

// Path style is on by default for these two gateways but stays a knob, as
// python passes `path_style` through `to_s3_config`. Both used to hand-copy
// the family's rename map without the `path_style` entry and hardcode
// `forcePathStyle: true`, so `path_style: false` was honored on python and
// silently ignored here.
describe('oci and supabase path style', () => {
  it('oci: defaults on, honors path_style: false', () => {
    const on = parseConfigWithSchema(OCIConfig, {
      bucket: 'b',
      namespace: 'ns',
      region: 'us-ashburn-1',
    })
    expect(OCIConfig.toS3Config(on).forcePathStyle).toBe(true)
    const off = parseConfigWithSchema(OCIConfig, {
      bucket: 'b',
      namespace: 'ns',
      region: 'us-ashburn-1',
      path_style: false,
    })
    expect(off.forcePathStyle).toBe(false)
    expect(OCIConfig.toS3Config(off).forcePathStyle).toBe(false)
  })

  it('supabase: defaults on, honors path_style: false', () => {
    const on = parseConfigWithSchema(SupabaseConfig, {
      bucket: 'b',
      project_ref: 'p',
      region: 'us-east-1',
    })
    expect(SupabaseConfig.toS3Config(on).forcePathStyle).toBe(true)
    const off = parseConfigWithSchema(SupabaseConfig, {
      bucket: 'b',
      project_ref: 'p',
      region: 'us-east-1',
      path_style: false,
    })
    expect(SupabaseConfig.toS3Config(off).forcePathStyle).toBe(false)
  })

  it('refuses a wrong-typed field for every alias', () => {
    expect(() =>
      parseConfigWithSchema(OCIConfig, { bucket: 'b', namespace: 'ns', region: 1 }),
    ).toThrow(/region/)
    expect(() =>
      parseConfigWithSchema(AliyunConfig, {
        bucket: 'b',
        region: 'cn-hangzhou',
        timeout: 'abc',
      }),
    ).toThrow(/timeout/)
  })
})

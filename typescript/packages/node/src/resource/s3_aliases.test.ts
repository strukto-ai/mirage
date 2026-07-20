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
import { ResourceName, type S3Config as S3CoreConfig } from '@struktoai/mirage-core'
import { S3Resource } from './s3/s3.ts'
import {
  aliyunToS3Config,
  normalizeAliyunConfig,
  resolvedAliyunEndpoint,
  type AliyunConfig,
} from './aliyun/config.ts'
import { AliyunResource } from './aliyun/aliyun.ts'
import {
  backblazeToS3Config,
  normalizeBackblazeConfig,
  resolvedBackblazeEndpoint,
  type BackblazeConfig,
} from './backblaze/config.ts'
import { BackblazeResource } from './backblaze/backblaze.ts'
import { cephToS3Config, normalizeCephConfig, type CephConfig } from './ceph/config.ts'
import { CephResource } from './ceph/ceph.ts'
import {
  digitalOceanToS3Config,
  normalizeDigitalOceanConfig,
  resolvedDigitalOceanEndpoint,
  type DigitalOceanConfig,
} from './digitalocean/config.ts'
import { DigitalOceanResource } from './digitalocean/digitalocean.ts'
import { gcsToS3Config, type GCSConfig } from './gcs/config.ts'
import { ociToS3Config, type OCIConfig } from './oci/config.ts'
import { r2ToS3Config, type R2Config } from './r2/config.ts'
import { supabaseToS3Config, type SupabaseConfig } from './supabase/config.ts'
import { minioToS3Config, normalizeMinIOConfig, type MinIOConfig } from './minio/config.ts'
import { MinIOResource } from './minio/minio.ts'
import {
  normalizeSeaweedFSConfig,
  seaweedfsToS3Config,
  type SeaweedFSConfig,
} from './seaweedfs/config.ts'
import { SeaweedFSResource } from './seaweedfs/seaweedfs.ts'
import {
  normalizeQingStorConfig,
  qingStorToS3Config,
  resolvedQingStorEndpoint,
  type QingStorConfig,
} from './qingstor/config.ts'
import { QingStorResource } from './qingstor/qingstor.ts'
import {
  normalizeScalewayConfig,
  resolvedScalewayEndpoint,
  scalewayToS3Config,
  type ScalewayConfig,
} from './scaleway/config.ts'
import { ScalewayResource } from './scaleway/scaleway.ts'
import {
  normalizeTencentConfig,
  resolvedTencentEndpoint,
  tencentToS3Config,
  type TencentConfig,
} from './tencent/config.ts'
import { TencentResource } from './tencent/tencent.ts'
import {
  normalizeWasabiConfig,
  resolvedWasabiEndpoint,
  wasabiToS3Config,
  type WasabiConfig,
} from './wasabi/config.ts'
import { WasabiResource } from './wasabi/wasabi.ts'

const CREDS = { bucket: 'b', accessKeyId: 'AKIA-LEAK', secretAccessKey: 'SECRET-LEAK' }

const REGION_CASES = [
  {
    name: 'aliyun',
    kind: ResourceName.ALIYUN,
    region: 'cn-hangzhou',
    expectedEndpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
    make: (region: string): AliyunConfig => ({ ...CREDS, region }),
    resolved: resolvedAliyunEndpoint,
    toS3: aliyunToS3Config,
    normalize: normalizeAliyunConfig,
    build: (config: AliyunConfig) => new AliyunResource(config),
  },
  {
    name: 'backblaze',
    kind: ResourceName.BACKBLAZE,
    region: 'us-west-004',
    expectedEndpoint: 'https://s3.us-west-004.backblazeb2.com',
    make: (region: string): BackblazeConfig => ({ ...CREDS, region }),
    resolved: resolvedBackblazeEndpoint,
    toS3: backblazeToS3Config,
    normalize: normalizeBackblazeConfig,
    build: (config: BackblazeConfig) => new BackblazeResource(config),
  },
  {
    name: 'digitalocean',
    kind: ResourceName.DIGITALOCEAN,
    region: 'nyc3',
    expectedEndpoint: 'https://nyc3.digitaloceanspaces.com',
    make: (region: string): DigitalOceanConfig => ({ ...CREDS, region }),
    resolved: resolvedDigitalOceanEndpoint,
    toS3: digitalOceanToS3Config,
    normalize: normalizeDigitalOceanConfig,
    build: (config: DigitalOceanConfig) => new DigitalOceanResource(config),
  },
  {
    name: 'tencent',
    kind: ResourceName.TENCENT,
    region: 'ap-guangzhou',
    expectedEndpoint: 'https://cos.ap-guangzhou.myqcloud.com',
    make: (region: string): TencentConfig => ({ ...CREDS, region }),
    resolved: resolvedTencentEndpoint,
    toS3: tencentToS3Config,
    normalize: normalizeTencentConfig,
    build: (config: TencentConfig) => new TencentResource(config),
  },
  {
    name: 'scaleway',
    kind: ResourceName.SCALEWAY,
    region: 'fr-par',
    expectedEndpoint: 'https://s3.fr-par.scw.cloud',
    make: (region: string): ScalewayConfig => ({ ...CREDS, region }),
    resolved: resolvedScalewayEndpoint,
    toS3: scalewayToS3Config,
    normalize: normalizeScalewayConfig,
    build: (config: ScalewayConfig) => new ScalewayResource(config),
  },
  {
    name: 'qingstor',
    kind: ResourceName.QINGSTOR,
    region: 'pek3a',
    expectedEndpoint: 'https://s3.pek3a.qingstor.com',
    make: (region: string): QingStorConfig => ({ ...CREDS, region }),
    resolved: resolvedQingStorEndpoint,
    toS3: qingStorToS3Config,
    normalize: normalizeQingStorConfig,
    build: (config: QingStorConfig) => new QingStorResource(config),
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
      const s3 = c.toS3({ ...c.make(c.region), timeoutMs: 5000 } as never)
      expect(s3.bucket).toBe('b')
      expect(s3.region).toBe(c.region)
      expect(s3.endpoint).toBe(c.expectedEndpoint)
      expect(s3.accessKeyId).toBe('AKIA-LEAK')
      expect(s3.secretAccessKey).toBe('SECRET-LEAK')
      expect(s3.timeoutMs).toBe(5000)
      expect(s3.forcePathStyle).toBeUndefined()
    })

    it(`${c.name}: normalize renames snake_case keys`, () => {
      const norm = c.normalize({
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
      expect(norm.timeoutMs).toBe(30000)
      expect(norm).not.toHaveProperty('proxy')
      expect(norm).not.toHaveProperty('access_key_id')
    })

    it(`${c.name}: resource remaps kind, ops, and commands`, () => {
      const resource = c.build(c.make(c.region) as never)
      expect(resource.kind).toBe(c.kind)
      expect(resource).toBeInstanceOf(S3Resource)
      expect(resource.ops().length).toBeGreaterThan(0)
      for (const op of resource.ops()) expect(op.resource).toBe(c.kind)
      for (const cmd of resource.commands()) expect(cmd.resource).toBe(c.kind)
    })

    it(`${c.name}: getState redacts creds`, async () => {
      const state = await c.build(c.make(c.region) as never).getState()
      expect(state.type).toBe(c.kind)
      const blob = JSON.stringify(state)
      expect(blob.includes('AKIA-LEAK')).toBe(false)
      expect(blob.includes('SECRET-LEAK')).toBe(false)
      expect(blob.includes('<REDACTED>')).toBe(true)
    })
  }
})

describe('wasabi endpoint defaults', () => {
  it('default region endpoint', () => {
    const config: WasabiConfig = { ...CREDS }
    expect(resolvedWasabiEndpoint(config)).toBe('https://s3.wasabisys.com')
    expect(wasabiToS3Config(config).region).toBe('us-east-1')
  })

  it('regional endpoint', () => {
    expect(resolvedWasabiEndpoint({ ...CREDS, region: 'us-west-1' })).toBe(
      'https://s3.us-west-1.wasabisys.com',
    )
  })

  it('custom endpoint override', () => {
    expect(resolvedWasabiEndpoint({ ...CREDS, endpoint: 'https://custom.example.com' })).toBe(
      'https://custom.example.com',
    )
  })

  it('normalize renames snake_case keys', () => {
    const norm = normalizeWasabiConfig({
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
    expect(norm.timeoutMs).toBe(30000)
    expect(norm).not.toHaveProperty('proxy')
  })

  it('resource remaps kind and redacts state', async () => {
    const resource = new WasabiResource({ ...CREDS })
    expect(resource.kind).toBe(ResourceName.WASABI)
    for (const op of resource.ops()) expect(op.resource).toBe(ResourceName.WASABI)
    const blob = JSON.stringify(await resource.getState())
    expect(blob.includes('SECRET-LEAK')).toBe(false)
    expect(blob.includes('<REDACTED>')).toBe(true)
  })
})

const ENDPOINT_CASES = [
  {
    name: 'minio',
    kind: ResourceName.MINIO,
    toS3: minioToS3Config as (config: never) => S3CoreConfig,
    normalize: normalizeMinIOConfig as (input: Record<string, unknown>) => unknown,
    make: (): MinIOConfig => ({ ...CREDS, endpoint: 'http://localhost:9000' }),
    build: (config: never) => new MinIOResource(config),
  },
  {
    name: 'ceph',
    kind: ResourceName.CEPH,
    toS3: cephToS3Config as (config: never) => S3CoreConfig,
    normalize: normalizeCephConfig as (input: Record<string, unknown>) => unknown,
    make: (): CephConfig => ({ ...CREDS, endpoint: 'http://localhost:9000' }),
    build: (config: never) => new CephResource(config),
  },
  {
    name: 'seaweedfs',
    kind: ResourceName.SEAWEEDFS,
    toS3: seaweedfsToS3Config as (config: never) => S3CoreConfig,
    normalize: normalizeSeaweedFSConfig as (input: Record<string, unknown>) => unknown,
    make: (): SeaweedFSConfig => ({ ...CREDS, endpoint: 'http://localhost:9000' }),
    build: (config: never) => new SeaweedFSResource(config),
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

    it(`${c.name}: normalize renames snake_case keys`, () => {
      const norm = c.normalize({
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
      expect(norm.timeoutMs).toBe(30000)
      expect(norm).not.toHaveProperty('proxy')
    })

    it(`${c.name}: resource remaps kind and redacts state`, async () => {
      const resource = c.build(c.make() as never)
      expect(resource.kind).toBe(c.kind)
      expect(resource).toBeInstanceOf(S3Resource)
      for (const op of resource.ops()) expect(op.resource).toBe(c.kind)
      for (const cmd of resource.commands()) expect(cmd.resource).toBe(c.kind)
      const blob = JSON.stringify(await resource.getState())
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
    toS3: aliyunToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'backblaze',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as BackblazeConfig,
    toS3: backblazeToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'ceph',
    config: { ...CREDS, endpoint: 'http://localhost:9000' } as CephConfig,
    toS3: cephToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'digitalocean',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as DigitalOceanConfig,
    toS3: digitalOceanToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'gcs',
    config: { ...CREDS, forcePathStyle: true } as GCSConfig,
    toS3: gcsToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'minio',
    config: { ...CREDS, endpoint: 'http://localhost:9000' } as MinIOConfig,
    toS3: minioToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'oci',
    config: { ...CREDS, namespace: 'ns', region: 'us-east-1' } as OCIConfig,
    toS3: ociToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'qingstor',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as QingStorConfig,
    toS3: qingStorToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'r2',
    config: { ...CREDS, accountId: 'account', forcePathStyle: true } as R2Config,
    toS3: r2ToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'scaleway',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as ScalewayConfig,
    toS3: scalewayToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'seaweedfs',
    config: { ...CREDS, endpoint: 'http://localhost:9000' } as SeaweedFSConfig,
    toS3: seaweedfsToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'supabase',
    config: { ...CREDS, projectRef: 'project', region: 'us-east-1' } as SupabaseConfig,
    toS3: supabaseToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'tencent',
    config: { ...CREDS, region: 'us-east-1', forcePathStyle: true } as TencentConfig,
    toS3: tencentToS3Config as (config: never) => S3CoreConfig,
  },
  {
    name: 'wasabi',
    config: { ...CREDS, forcePathStyle: true } as WasabiConfig,
    toS3: wasabiToS3Config as (config: never) => S3CoreConfig,
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
})

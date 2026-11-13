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

import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import {
  buildVfsFrom,
  REGISTRY as CORE_REGISTRY,
  type VFSFactory,
} from '@struktoai/mirage-core/vfs/registry'
import { parseConfigWithSchema, refuseUnknownKeys } from '@struktoai/mirage-core/vfs/secrets'
import type { OPFSVFSOptions } from './opfs/opfs.ts'
import type { RedisVFSOptions } from './redis/redis.ts'

/**
 * The browser's VFS table: the backends core implements (`REGISTRY` in
 * `@struktoai/mirage-core/vfs/registry`) plus the ones this package
 * implements for a browser. Mirrors Python's `mirage.vfs.registry.build_vfs`
 * and the Node TS counterpart at `@struktoai/mirage-node/vfs/registry`.
 *
 * Configs are normalized from Python-style snake_case to TS camelCase so
 * the same YAML schema works across both runtimes. A backend that takes its
 * options without a schema names the ones it takes, so a key outside them is
 * refused, as Python refuses a constructor keyword, rather than ignored.
 *
 * The S3 entry expects a browser-shaped config — bucket + a
 * `presignedUrlProvider` function. Since functions can't be encoded
 * in JSON/YAML, browser configs are typically constructed
 * programmatically and passed in directly.
 */
const REGISTRY: Record<string, VFSFactory> = {
  ...CORE_REGISTRY,
  opfs: async (config) => {
    refuseUnknownKeys(config, ['root', 'capacity'] satisfies (keyof OPFSVFSOptions)[])
    const { OPFSVFS } = await import('./opfs/opfs.ts')
    const norm = normalizeFields(config)
    return new OPFSVFS(norm)
  },
  s3: async (config) => {
    const { S3VFS } = await import('./s3/s3.ts')
    const { S3Config } = await import('./s3/config.ts')
    return new S3VFS(parseConfigWithSchema(S3Config, config))
  },
  gcs: async (config) => {
    const { GCSVFS } = await import('./gcs/gcs.ts')
    const { GCSConfig } = await import('./gcs/config.ts')
    return new GCSVFS(parseConfigWithSchema(GCSConfig, config))
  },
  r2: async (config) => {
    const { R2VFS } = await import('./r2/r2.ts')
    const { R2Config } = await import('./r2/config.ts')
    return new R2VFS(parseConfigWithSchema(R2Config, config))
  },
  oci: async (config) => {
    const { OCIVFS } = await import('./oci/oci.ts')
    const { OCIConfig } = await import('./oci/config.ts')
    return new OCIVFS(parseConfigWithSchema(OCIConfig, config))
  },
  supabase: async (config) => {
    const { SupabaseVFS } = await import('./supabase/supabase.ts')
    const { SupabaseConfig } = await import('./supabase/config.ts')
    return new SupabaseVFS(parseConfigWithSchema(SupabaseConfig, config))
  },
  minio: async (config) => {
    const { MinIOVFS } = await import('./minio/minio.ts')
    const { MinIOConfig } = await import('./minio/config.ts')
    return new MinIOVFS(parseConfigWithSchema(MinIOConfig, config))
  },
  ceph: async (config) => {
    const { CephVFS } = await import('./ceph/ceph.ts')
    const { CephConfig } = await import('./ceph/config.ts')
    return new CephVFS(parseConfigWithSchema(CephConfig, config))
  },
  seaweedfs: async (config) => {
    const { SeaweedFSVFS } = await import('./seaweedfs/seaweedfs.ts')
    const { SeaweedFSConfig } = await import('./seaweedfs/config.ts')
    return new SeaweedFSVFS(parseConfigWithSchema(SeaweedFSConfig, config))
  },
  wasabi: async (config) => {
    const { WasabiVFS } = await import('./wasabi/wasabi.ts')
    const { WasabiConfig } = await import('./wasabi/config.ts')
    return new WasabiVFS(parseConfigWithSchema(WasabiConfig, config))
  },
  backblaze: async (config) => {
    const { BackblazeVFS } = await import('./backblaze/backblaze.ts')
    const { BackblazeConfig } = await import('./backblaze/config.ts')
    return new BackblazeVFS(parseConfigWithSchema(BackblazeConfig, config))
  },
  digitalocean: async (config) => {
    const { DigitalOceanVFS } = await import('./digitalocean/digitalocean.ts')
    const { DigitalOceanConfig } = await import('./digitalocean/config.ts')
    return new DigitalOceanVFS(parseConfigWithSchema(DigitalOceanConfig, config))
  },
  tencent: async (config) => {
    const { TencentVFS } = await import('./tencent/tencent.ts')
    const { TencentConfig } = await import('./tencent/config.ts')
    return new TencentVFS(parseConfigWithSchema(TencentConfig, config))
  },
  aliyun: async (config) => {
    const { AliyunVFS } = await import('./aliyun/aliyun.ts')
    const { AliyunConfig } = await import('./aliyun/config.ts')
    return new AliyunVFS(parseConfigWithSchema(AliyunConfig, config))
  },
  scaleway: async (config) => {
    const { ScalewayVFS } = await import('./scaleway/scaleway.ts')
    const { ScalewayConfig } = await import('./scaleway/config.ts')
    return new ScalewayVFS(parseConfigWithSchema(ScalewayConfig, config))
  },
  qingstor: async (config) => {
    const { QingStorVFS } = await import('./qingstor/qingstor.ts')
    const { QingStorConfig } = await import('./qingstor/config.ts')
    return new QingStorVFS(parseConfigWithSchema(QingStorConfig, config))
  },
  slack: async (config) => {
    const { SlackVFS } = await import('./slack/slack.ts')
    const { SlackConfig } = await import('./slack/config.ts')
    return new SlackVFS(parseConfigWithSchema(SlackConfig, config))
  },
  discord: async (config) => {
    const { DiscordVFS } = await import('./discord/discord.ts')
    const { DiscordConfig } = await import('./discord/config.ts')
    return new DiscordVFS(parseConfigWithSchema(DiscordConfig, config))
  },
  postgres: async (config) => {
    const { PostgresVFS } = await import('./postgres/postgres.ts')
    const { PostgresConfig } = await import('@struktoai/mirage-core/vfs/postgres/config')
    return new PostgresVFS(parseConfigWithSchema(PostgresConfig, config))
  },
  mongodb: async (config) => {
    const { MongoDBVFS } = await import('./mongodb/mongodb.ts')
    const { MongoDBConfig } = await import('@struktoai/mirage-core/vfs/mongodb/config')
    return new MongoDBVFS(parseConfigWithSchema(MongoDBConfig, config))
  },
  redis: async (config) => {
    refuseUnknownKeys(config, [
      'url',
      'token',
      'keyPrefix',
      'fetchImpl',
      'capacity',
      'maxRequestBytes',
    ] satisfies (keyof RedisVFSOptions)[])
    const { RedisVFS } = await import('./redis/redis.ts')
    return new RedisVFS(normalizeFields(config) as unknown as RedisVFSOptions)
  },
  lancedb: (_config) => {
    return Promise.reject(
      new Error(
        'LanceDBVFS is not supported in the browser: @lancedb/lancedb is a native ' +
          'Node addon. Use @struktoai/mirage-node from a server.',
      ),
    )
  },
  notion: async (config) => {
    const { NotionVFS } = await import('./notion/notion.ts')
    const { NotionConfig } = await import('./notion/config.ts')
    return new NotionVFS(parseConfigWithSchema(NotionConfig, config))
  },
  dropbox: async (config) => {
    const { DropboxVFS } = await import('@struktoai/mirage-core/vfs/dropbox/dropbox')
    const { DropboxConfig } = await import('@struktoai/mirage-core/vfs/dropbox/config')
    return new DropboxVFS(parseConfigWithSchema(DropboxConfig, config))
  },
  email: (_config) => {
    return Promise.reject(
      new Error(
        'EmailVFS is not supported in the browser: IMAP/SMTP require raw TCP. ' +
          'Use @struktoai/mirage-node from a server, or proxy IMAP/SMTP via a backend.',
      ),
    )
  },
}

export type { VFSFactory }

const CUSTOM: Record<string, VFSFactory> = {}

export function knownVfsNames(): string[] {
  return [...new Set([...Object.keys(REGISTRY), ...Object.keys(CUSTOM)])].sort(compareCodePoints)
}

/**
 * Register a custom VFS factory under `name`. Builtin names cannot
 * be shadowed; re-registering a custom name replaces it. Mirrors
 * Python's `register_vfs` and the Node counterpart.
 */
export function registerVfs(name: string, factory: VFSFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

export async function buildVfs(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<BaseVFS> {
  return buildVfsFrom(REGISTRY, CUSTOM, name, config, sources)
}

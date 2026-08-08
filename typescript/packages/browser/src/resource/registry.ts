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

import {
  normalizeFields,
  type ChromaConfig,
  type DifyConfig,
  type QdrantConfig,
  type Resource,
} from '@struktoai/mirage-core'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

/**
 * Construct a resource by registry name in the browser runtime.
 * Mirrors Python's `mirage.resource.registry.build_resource` and the
 * Node TS counterpart at `@struktoai/mirage-node/resource/registry`.
 *
 * Configs are normalized from Python-style snake_case to TS camelCase so
 * the same YAML schema works across both runtimes.
 *
 * The S3 entry expects a browser-shaped config — bucket + a
 * `presignedUrlProvider` function. Since functions can't be encoded
 * in JSON/YAML, browser configs are typically constructed
 * programmatically and passed in directly.
 */
export type ResourceFactory = (config: Record<string, unknown>) => Promise<Resource>

interface S3BrowserCtorConfig {
  bucket: string
  presignedUrlProvider: (
    path: string,
    op: 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'LIST' | 'COPY',
    opts?: {
      contentType?: string
      ttlSec?: number
      listPrefix?: string
      listDelimiter?: string
      listContinuationToken?: string
      copySource?: string
    },
  ) => Promise<string>
}

type GCSBrowserCtorConfig = S3BrowserCtorConfig & { region?: string; endpoint?: string }
type R2BrowserCtorConfig = S3BrowserCtorConfig & {
  accountId?: string
  region?: string
  endpoint?: string
}
type OCIBrowserCtorConfig = S3BrowserCtorConfig & {
  namespace?: string
  region?: string
  endpoint?: string
}
type SupabaseBrowserCtorConfig = S3BrowserCtorConfig & {
  projectRef?: string
  region?: string
  endpoint?: string
}
type S3AliasBrowserCtorConfig = S3BrowserCtorConfig & {
  region?: string
  endpoint?: string
}
interface SlackBrowserCtorConfig {
  proxyUrl: string
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
}
interface DiscordBrowserCtorConfig {
  proxyUrl: string
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
}
interface NotionBrowserCtorConfig {
  authProvider: OAuthClientProvider
  serverUrl?: string
}
interface TrelloBrowserCtorConfig {
  apiKey: string
  apiToken: string
  workspaceId?: string
  boardIds?: readonly string[]
  baseUrl?: string
}
interface LinearBrowserCtorConfig {
  apiKey: string
  workspace?: string
  teamIds?: readonly string[]
  baseUrl?: string
}
interface LangfuseBrowserCtorConfig {
  publicKey: string
  secretKey: string
  host?: string
  defaultTraceLimit?: number
  defaultSearchLimit?: number
  defaultFromTimestamp?: string
}
interface PostgresBrowserCtorConfig {
  dsn: string
  schemas?: readonly string[]
  defaultRowLimit?: number
  maxReadRows?: number
  maxReadBytes?: number
  defaultSearchLimit?: number
}

const REGISTRY: Record<string, ResourceFactory> = {
  ram: async (_config) => {
    const { RAMResource } = await import('@struktoai/mirage-core')
    return new RAMResource()
  },
  opfs: async (config) => {
    const { OPFSResource } = await import('./opfs/opfs.ts')
    const norm = normalizeFields(config)
    return new OPFSResource(norm)
  },
  s3: async (config) => {
    const { S3Resource } = await import('./s3/s3.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new S3Resource(norm as unknown as S3BrowserCtorConfig)
  },
  gcs: async (config) => {
    const { GCSResource } = await import('./gcs/gcs.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new GCSResource(norm as unknown as GCSBrowserCtorConfig)
  },
  r2: async (config) => {
    const { R2Resource } = await import('./r2/r2.ts')
    const norm = normalizeFields(config, {
      rename: { account_id: 'accountId', endpoint_url: 'endpoint' },
    })
    return new R2Resource(norm as unknown as R2BrowserCtorConfig)
  },
  oci: async (config) => {
    const { OCIResource } = await import('./oci/oci.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new OCIResource(norm as unknown as OCIBrowserCtorConfig)
  },
  supabase: async (config) => {
    const { SupabaseResource } = await import('./supabase/supabase.ts')
    const norm = normalizeFields(config, {
      rename: { project_ref: 'projectRef', endpoint_url: 'endpoint' },
    })
    return new SupabaseResource(norm as unknown as SupabaseBrowserCtorConfig)
  },
  minio: async (config) => {
    const { MinIOResource } = await import('./minio/minio.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new MinIOResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  ceph: async (config) => {
    const { CephResource } = await import('./ceph/ceph.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new CephResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  seaweedfs: async (config) => {
    const { SeaweedFSResource } = await import('./seaweedfs/seaweedfs.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new SeaweedFSResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  wasabi: async (config) => {
    const { WasabiResource } = await import('./wasabi/wasabi.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new WasabiResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  backblaze: async (config) => {
    const { BackblazeResource } = await import('./backblaze/backblaze.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new BackblazeResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  digitalocean: async (config) => {
    const { DigitalOceanResource } = await import('./digitalocean/digitalocean.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new DigitalOceanResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  tencent: async (config) => {
    const { TencentResource } = await import('./tencent/tencent.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new TencentResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  aliyun: async (config) => {
    const { AliyunResource } = await import('./aliyun/aliyun.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new AliyunResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  scaleway: async (config) => {
    const { ScalewayResource } = await import('./scaleway/scaleway.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new ScalewayResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  qingstor: async (config) => {
    const { QingStorResource } = await import('./qingstor/qingstor.ts')
    const norm = normalizeFields(config, {
      rename: { endpoint_url: 'endpoint' },
    })
    return new QingStorResource(norm as unknown as S3AliasBrowserCtorConfig)
  },
  slack: async (config) => {
    const { SlackResource } = await import('./slack/slack.ts')
    const norm = normalizeFields(config, {
      rename: { proxy_url: 'proxyUrl', get_headers: 'getHeaders' },
    })
    return new SlackResource(norm as unknown as SlackBrowserCtorConfig)
  },
  discord: async (config) => {
    const { DiscordResource } = await import('./discord/discord.ts')
    const norm = normalizeFields(config, {
      rename: { proxy_url: 'proxyUrl', get_headers: 'getHeaders' },
    })
    return new DiscordResource(norm as unknown as DiscordBrowserCtorConfig)
  },
  trello: async (config) => {
    const { TrelloResource } = await import('./trello/trello.ts')
    const norm = normalizeFields(config, {
      rename: {
        api_key: 'apiKey',
        api_token: 'apiToken',
        workspace_id: 'workspaceId',
        board_ids: 'boardIds',
        base_url: 'baseUrl',
      },
    })
    return new TrelloResource(norm as unknown as TrelloBrowserCtorConfig)
  },
  linear: async (config) => {
    const { LinearResource } = await import('./linear/linear.ts')
    const norm = normalizeFields(config, {
      rename: {
        api_key: 'apiKey',
        team_ids: 'teamIds',
        base_url: 'baseUrl',
      },
    })
    return new LinearResource(norm as unknown as LinearBrowserCtorConfig)
  },
  postgres: async (config) => {
    const { PostgresResource } = await import('./postgres/postgres.ts')
    const norm = normalizeFields(config, {
      rename: {
        default_row_limit: 'defaultRowLimit',
        max_read_rows: 'maxReadRows',
        max_read_bytes: 'maxReadBytes',
        default_search_limit: 'defaultSearchLimit',
      },
    })
    return new PostgresResource(norm as unknown as PostgresBrowserCtorConfig)
  },
  mongodb: async (config) => {
    const { MongoDBResource } = await import('./mongodb/mongodb.ts')
    const { normalizeMongoDBConfig } = await import('@struktoai/mirage-core')
    return new MongoDBResource(normalizeMongoDBConfig(config))
  },
  chroma: async (config) => {
    const { ChromaResource } = await import('@struktoai/mirage-core')
    return new ChromaResource(normalizeFields(config) as unknown as ChromaConfig)
  },
  dify: async (config) => {
    const { DifyResource } = await import('@struktoai/mirage-core')
    return new DifyResource(normalizeFields(config) as unknown as DifyConfig)
  },
  qdrant: async (config) => {
    const { QdrantResource } = await import('@struktoai/mirage-core')
    return new QdrantResource(normalizeFields(config) as unknown as QdrantConfig)
  },
  lancedb: (_config) => {
    return Promise.reject(
      new Error(
        'LanceDBResource is not supported in the browser: @lancedb/lancedb is a native ' +
          'Node addon. Use @struktoai/mirage-node from a server.',
      ),
    )
  },
  notion: async (config) => {
    const { NotionResource } = await import('./notion/notion.ts')
    const norm = normalizeFields(config, {
      rename: { auth_provider: 'authProvider', server_url: 'serverUrl' },
    })
    return new NotionResource(norm as unknown as NotionBrowserCtorConfig)
  },
  langfuse: async (config) => {
    const { LangfuseResource } = await import('./langfuse/langfuse.ts')
    const norm = normalizeFields(config, {
      rename: {
        public_key: 'publicKey',
        secret_key: 'secretKey',
        default_trace_limit: 'defaultTraceLimit',
        default_search_limit: 'defaultSearchLimit',
        default_from_timestamp: 'defaultFromTimestamp',
      },
    })
    return new LangfuseResource(norm as unknown as LangfuseBrowserCtorConfig)
  },
  github: async (config) => {
    const { GitHubResource } = await import('./github/github.ts')
    const norm = normalizeFields(config, {
      rename: { base_url: 'baseUrl' },
    }) as unknown as { token: string; owner: string; repo: string; ref?: string; baseUrl?: string }
    return GitHubResource.create(norm)
  },
  github_ci: async (config) => {
    const { GitHubCIResource } = await import('./github_ci/github_ci.ts')
    const { normalizeGitHubCIConfig } = await import('./github_ci/config.ts')
    return new GitHubCIResource(normalizeGitHubCIConfig(config))
  },
  gdocs: async (config) => {
    const { GDocsResource } = await import('./gdocs/gdocs.ts')
    const { normalizeGDocsConfig } = await import('./gdocs/config.ts')
    return new GDocsResource(normalizeGDocsConfig(config))
  },
  gsheets: async (config) => {
    const { GSheetsResource } = await import('./gsheets/gsheets.ts')
    const { normalizeGSheetsConfig } = await import('./gsheets/config.ts')
    return new GSheetsResource(normalizeGSheetsConfig(config))
  },
  gslides: async (config) => {
    const { GSlidesResource } = await import('./gslides/gslides.ts')
    const { normalizeGSlidesConfig } = await import('./gslides/config.ts')
    return new GSlidesResource(normalizeGSlidesConfig(config))
  },
  gdrive: async (config) => {
    const { GDriveResource } = await import('./gdrive/gdrive.ts')
    const { normalizeGDriveConfig } = await import('./gdrive/config.ts')
    return new GDriveResource(normalizeGDriveConfig(config))
  },
  onedrive: async (config) => {
    const { OneDriveResource, normalizeOneDriveConfig } = await import('@struktoai/mirage-core')
    return new OneDriveResource(normalizeOneDriveConfig(config))
  },
  sharepoint: async (config) => {
    const { SharePointResource, normalizeSharePointConfig } = await import('@struktoai/mirage-core')
    return new SharePointResource(normalizeSharePointConfig(config))
  },
  mem0: async (config) => {
    const { Mem0Resource, normalizeMem0Config } = await import('@struktoai/mirage-core')
    return new Mem0Resource(normalizeMem0Config(config))
  },
  dropbox: async (config) => {
    const { DropboxResource } = await import('./dropbox/dropbox.ts')
    const { normalizeDropboxConfig } = await import('./dropbox/config.ts')
    return new DropboxResource(normalizeDropboxConfig(config))
  },
  box: async (config) => {
    const { BoxResource } = await import('./box/box.ts')
    const { normalizeBoxConfig } = await import('./box/config.ts')
    return new BoxResource(normalizeBoxConfig(config))
  },
  gmail: async (config) => {
    const { GmailResource } = await import('./gmail/gmail.ts')
    const { normalizeGmailConfig } = await import('./gmail/config.ts')
    return new GmailResource(normalizeGmailConfig(config))
  },
  email: (_config) => {
    return Promise.reject(
      new Error(
        'EmailResource is not supported in the browser: IMAP/SMTP require raw TCP. ' +
          'Use @struktoai/mirage-node from a server, or proxy IMAP/SMTP via a backend.',
      ),
    )
  },
}

const CUSTOM: Record<string, ResourceFactory> = {}

export function knownResources(): string[] {
  return [...new Set([...Object.keys(REGISTRY), ...Object.keys(CUSTOM)])].sort()
}

/**
 * Register a custom resource factory under `name`. Builtin names cannot
 * be shadowed; re-registering a custom name replaces it. Mirrors
 * Python's `register_resource` and the Node counterpart.
 */
export function register(name: string, factory: ResourceFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

export async function buildResource(
  name: string,
  config: Record<string, unknown> = {},
): Promise<Resource> {
  const factory = REGISTRY[name] ?? CUSTOM[name]
  if (factory === undefined) {
    throw new Error(
      `unknown resource ${JSON.stringify(name)}; known: ${knownResources().join(', ')}`,
    )
  }
  return factory(config)
}

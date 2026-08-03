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

import { z } from 'zod'
import { secretSchema } from '../../resource/secrets.ts'
import { rstripSlash } from '../../utils/slash.ts'

export type AccessTokenProvider = () => string | Promise<string>

export const GRAPH_VERSION = 'v1.0'

// A Microsoft Graph national cloud deployment. Each is a network-isolated
// instance with its own service root, and a token minted for one is not
// accepted by another. Microsoft 365 GCC (moderate) is served by the
// worldwide endpoint, so it is 'global'; only GCC High and DoD have their
// own hosts.
export const GRAPH_CLOUDS = ['global', 'usgovhigh', 'usgovdod', 'china'] as const

export type GraphCloud = (typeof GRAPH_CLOUDS)[number]

export const GRAPH_CLOUD_HOSTS: Record<GraphCloud, string> = {
  global: 'https://graph.microsoft.com',
  usgovhigh: 'https://graph.microsoft.us',
  usgovdod: 'https://dod-graph.microsoft.us',
  china: 'https://microsoftgraph.chinacloudapi.cn',
}

// Shared by the OneDrive and SharePoint config schemas, mirroring Python's
// MsGraphConfig base model. `accessToken` accepts a provider callable as well
// as a literal, and either way it is marked secret so the redaction machinery
// keeps it out of snapshot state.
export const MSGRAPH_CONFIG_SHAPE = {
  accessToken: secretSchema(
    z.union([z.string(), z.custom<AccessTokenProvider>((value) => typeof value === 'function')]),
  ),
  tenantHost: z.string().optional(),
  cloud: z.enum(GRAPH_CLOUDS).optional(),
  graphBaseUrl: z.string().optional(),
  timeout: z.number().optional(),
  maxRetries: z.number().optional(),
}

export interface MsGraphConfig {
  accessToken: string | AccessTokenProvider
  tenantHost?: string
  cloud?: GraphCloud
  // Full service root, version segment included, for a deployment the
  // `cloud` table cannot name: a private endpoint or a test server. Wins
  // over `cloud` when set.
  graphBaseUrl?: string
  timeout?: number
  maxRetries?: number
}

export interface MsGraphConfigResolved {
  accessToken: string | AccessTokenProvider
  tenantHost: string | null
  cloud: GraphCloud
  graphBaseUrl: string | null
  timeout: number
  maxRetries: number
}

function optionalText(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? null : normalized
}

export function resolveMsGraphConfig(config: MsGraphConfig): MsGraphConfigResolved {
  const timeout = config.timeout ?? 30
  const maxRetries = config.maxRetries ?? 5
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('timeout must be positive')
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer')
  }
  return {
    accessToken: config.accessToken,
    tenantHost: optionalText(config.tenantHost),
    cloud: config.cloud ?? 'global',
    graphBaseUrl: optionalText(config.graphBaseUrl),
    timeout,
    maxRetries,
  }
}

// The Graph service root every URL for this mount hangs off. Read from the
// config rather than a module constant so two mounts in one process can
// address different deployments, and so a test server is reached by
// configuring a mount instead of rebinding a global in every module that
// spells a URL.
export function graphApi(config: MsGraphConfigResolved): string {
  if (config.graphBaseUrl !== null) return rstripSlash(config.graphBaseUrl)
  return `${GRAPH_CLOUD_HOSTS[config.cloud]}/${GRAPH_VERSION}`
}

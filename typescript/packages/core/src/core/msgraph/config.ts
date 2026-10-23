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
import { secretSchema } from '../../vfs/secrets.ts'
import { rstripSlash } from '../../utils/slash.ts'

export type AccessTokenProvider = () => string | Promise<string>

const GRAPH_VERSION = 'v1.0'

const DEFAULT_GRAPH_API = `https://graph.microsoft.com/${GRAPH_VERSION}`

// Shared by the OneDrive and SharePoint config schemas, mirroring Python's
// MsGraphConfig base model. `accessToken` accepts a provider callable as well
// as a literal, and either way it is marked secret so the redaction machinery
// keeps it out of snapshot state.
export const MSGRAPH_CONFIG_SHAPE = {
  accessToken: secretSchema(
    z.union([z.string(), z.custom<AccessTokenProvider>((value) => typeof value === 'function')]),
  ).describe(
    'Microsoft Graph bearer token, or a function (sync or async) that returns one. A function is called for every request, and once more after a `401`, so it can hand out a refreshed token.',
  ),
  tenantHost: z
    .string()
    .optional()
    .describe(
      'SharePoint host, such as `contoso.sharepoint.com`; the `sharepoint` mount lists only the sites whose `webUrl` is on it. The `onedrive` mount ignores it.',
    ),
  graphBaseUrl: z
    .string()
    .optional()
    .describe(
      'Full Graph service root, version segment included, for any deployment but the worldwide one: a sovereign cloud, a private endpoint or a test server. Unset uses `https://graph.microsoft.com/v1.0`.',
    ),
  timeout: z.number().optional().meta({
    description:
      'Seconds one Graph request may take; also how long a server-side copy is polled before it fails as unconfirmed.',
    default: 30,
  }),
  maxRetries: z.number().optional().meta({
    description:
      'Times a request is retried after a `429`, `503` or `504` response. Each retry waits what `Retry-After` asks or an exponential backoff, at most 30 seconds.',
    default: 5,
  }),
}

export interface MsGraphConfig {
  accessToken: string | AccessTokenProvider
  tenantHost?: string
  // Full service root, version segment included, for any deployment other
  // than the worldwide one: a sovereign cloud, a private endpoint, or a
  // test server.
  graphBaseUrl?: string
  timeout?: number
  maxRetries?: number
}

export interface MsGraphConfigResolved {
  accessToken: string | AccessTokenProvider
  tenantHost: string | null
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
  return DEFAULT_GRAPH_API
}

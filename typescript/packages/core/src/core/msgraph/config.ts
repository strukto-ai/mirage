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
import { rstripSlash } from '../../utils/slash.ts'
import { secretSchema } from '../../vfs/secrets.ts'
import { DEFAULT_TIMEOUT } from '../api/constants.ts'

const GRAPH_VERSION = 'v1.0'

const DEFAULT_GRAPH_API = `https://graph.microsoft.com/${GRAPH_VERSION}`

// Shared by the OneDrive and SharePoint config schemas, mirroring Python's
// MsGraphConfig base model. `accessToken` accepts a provider callable as well
// as a literal, and either way it is marked secret so the redaction machinery
// keeps it out of snapshot state.
export const MsGraphConfig = z.object({
  accessToken: secretSchema(
    z.union([
      z.string(),
      z.custom<() => string | Promise<string>>((value) => typeof value === 'function'),
    ]),
  ).describe(
    'Microsoft Graph bearer token, or a function (sync or async) that returns one; it is called for each request and again after a `401`.',
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
  timeout: z.number().positive('timeout must be positive').optional().meta({
    description:
      'Seconds a Graph request may wait to connect, or between two reads of its answer, before it fails; also how long a server-side copy is polled before it fails as unconfirmed.',
    default: DEFAULT_TIMEOUT,
  }),
  maxRetries: z
    .number()
    .int()
    .nonnegative('maxRetries must be a non-negative integer')
    .optional()
    .meta({
      description:
        'Times a request is retried after a `429`, `503` or `504` response. Each retry waits what `Retry-After` asks or an exponential backoff, at most 30 seconds.',
      default: 5,
    }),
})

export type MsGraphConfig = z.input<typeof MsGraphConfig>

export function optionalText(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? null : normalized
}

export function resolveMsGraphConfig(config: MsGraphConfig) {
  const validated = MsGraphConfig.parse(config)
  return {
    accessToken: validated.accessToken,
    tenantHost: optionalText(validated.tenantHost),
    graphBaseUrl: optionalText(validated.graphBaseUrl),
    timeout: validated.timeout ?? DEFAULT_TIMEOUT,
    maxRetries: validated.maxRetries ?? 5,
  }
}

// The Graph service root every URL for this mount hangs off. Read from the
// config rather than a module constant so two mounts in one process can
// address different deployments, and so a test server is reached by
// configuring a mount instead of rebinding a global in every module that
// spells a URL.
export function graphApi(config: ReturnType<typeof resolveMsGraphConfig>): string {
  if (config.graphBaseUrl !== null) return rstripSlash(config.graphBaseUrl)
  return DEFAULT_GRAPH_API
}

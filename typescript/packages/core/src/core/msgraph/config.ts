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

export type AccessTokenProvider = () => string | Promise<string>

// Shared by the OneDrive and SharePoint config schemas, mirroring Python's
// MsGraphConfig base model. `accessToken` accepts a provider callable as well
// as a literal, and either way it is marked secret so the redaction machinery
// keeps it out of snapshot state.
export const MSGRAPH_CONFIG_SHAPE = {
  accessToken: secretSchema(
    z.union([z.string(), z.custom<AccessTokenProvider>((value) => typeof value === 'function')]),
  ),
  tenantHost: z.string().optional(),
  timeout: z.number().optional(),
  maxRetries: z.number().optional(),
}

export interface MsGraphConfig {
  accessToken: string | AccessTokenProvider
  tenantHost?: string
  timeout?: number
  maxRetries?: number
}

export interface MsGraphConfigResolved {
  accessToken: string | AccessTokenProvider
  tenantHost: string | null
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
    timeout,
    maxRetries,
  }
}

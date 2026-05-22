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

import { normalizeFields, redactConfigWithSchema, secretStr, z } from '@struktoai/mirage-core'

export interface SSHConfig {
  host: string
  hostname?: string
  port?: number
  username?: string
  password?: string
  identityFile?: string
  passphrase?: string
  root?: string
  timeout?: number
  knownHosts?: string
}

export interface SSHConfigRedacted {
  host: string
  hostname?: string
  port?: number
  username?: string
  password?: '<REDACTED>'
  identityFile?: string
  passphrase?: '<REDACTED>'
  root?: string
  timeout?: number
  knownHosts?: string
}

export const SSHConfigSchema = z.object({
  host: z.string(),
  hostname: z.string().optional(),
  port: z.number().optional(),
  username: z.string().optional(),
  password: secretStr().optional(),
  identityFile: z.string().optional(),
  passphrase: secretStr().optional(),
  root: z.string().optional(),
  timeout: z.number().optional(),
  knownHosts: z.string().optional(),
})

export function redactSshConfig(config: SSHConfig): SSHConfigRedacted {
  return redactConfigWithSchema(SSHConfigSchema, config) as unknown as SSHConfigRedacted
}

export function normalizeSshConfig(input: Record<string, unknown>): SSHConfig {
  return normalizeFields(input, {
    rename: {
      identity_file: 'identityFile',
      known_hosts: 'knownHosts',
    },
  }) as unknown as SSHConfig
}

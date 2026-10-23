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
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'

const SSHConfigSchema = z.object({
  host: z.string().describe('DNS name or IP address of the remote.'),
  hostname: z.string().optional().describe('Address to connect to instead of `host`.'),
  port: z.number().optional().meta({ description: 'SSH port.', default: 22 }),
  username: z.string().optional().describe('Login user; unset uses the local user name.'),
  password: secretStr()
    .optional()
    .describe('Password for password authentication; prefer `identityFile`.'),
  identityFile: z
    .string()
    .optional()
    .describe(
      'Path to a private key; `~` is expanded. Unset tries the SSH agent and the default keys in `~/.ssh` (`id_ed25519`, `id_ecdsa`, `id_rsa`, `id_dsa`).',
    ),
  passphrase: secretStr()
    .optional()
    .describe('Passphrase of an encrypted private key, from `identityFile` or a default key.'),
  root: z
    .string()
    .optional()
    .meta({ description: 'Path on the remote that becomes the mount root.', default: '/' }),
  timeout: z.number().optional().meta({
    description: 'Seconds to wait for the connection to be ready, authentication included.',
    default: 30,
  }),
  knownHosts: z
    .string()
    .optional()
    .describe('Accepted but not applied: this backend does not verify host keys.'),
  fullScanLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
    default: 1000,
  }),
})

export type SSHConfig = ConfigOf<typeof SSHConfigSchema>

export type SSHConfigRedacted = RedactedConfig<SSHConfig, 'password' | 'passphrase'>

export function redactSshConfig(config: SSHConfig): SSHConfigRedacted {
  return redactConfigWithSchema(SSHConfigSchema, config) as unknown as SSHConfigRedacted
}

export function normalizeSshConfig(input: Record<string, unknown>): SSHConfig {
  return parseConfigWithSchema(SSHConfigSchema, input)
}

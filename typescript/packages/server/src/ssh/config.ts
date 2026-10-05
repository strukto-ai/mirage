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

import { homedir } from 'node:os'
import { join } from 'node:path'

import { readDaemonTable } from '../daemon_config.ts'
import { mirageHome } from '../paths.ts'
import {
  AUTHORIZED_KEYS_NAME,
  DEFAULT_SSH_HOST,
  HOST_KEY_NAME,
  SSH_DIR,
  SSH_ENV_KEYS,
} from './constants.ts'
import { SSHConfigError } from './errors.ts'

export type SSHSettingKey = keyof typeof SSH_ENV_KEYS

/**
 * Where the daemon's SSH door listens and whom it lets in.
 *
 * `hostKeyFile` is minted on first start and kept, so clients'
 * known_hosts stay valid; `authorizedKeysFile` holds OpenSSH-format public
 * keys and is re-read on every connection, so adding a key needs no
 * restart. A port of 0 asks the OS for a free one; null keeps the TCP door
 * shut, while the HTTPS route carries SSH whatever the port says.
 */
export interface SSHConfig {
  port: number | null
  host: string
  hostKeyFile: string
  authorizedKeysFile: string
}

export interface ResolveSSHOptions {
  env?: Record<string, string | undefined>
  table?: Record<string, string>
  home?: string
}

/** The directory holding the host key and authorized keys: `<home>/ssh`. */
export function defaultSSHDir(home?: string): string {
  return join(home ?? mirageHome(), SSH_DIR)
}

function setting(
  key: SSHSettingKey,
  env: Record<string, string | undefined>,
  table: Record<string, string>,
): string {
  const value = (env[SSH_ENV_KEYS[key]] ?? '').trim()
  if (value !== '') return value
  return (table[key] ?? '').trim()
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function parsePort(raw: string): number {
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new SSHConfigError(`ssh_port must be an integer, got '${raw}'`)
  }
  const port = Number(raw)
  if (!(port > 0 && port < 65536)) {
    throw new SSHConfigError(`ssh_port must be between 1 and 65535, got ${String(port)}`)
  }
  return port
}

/**
 * Resolve the SSH settings.
 *
 * Per key the environment variable wins over the `[daemon]` table in
 * `config.toml`, which wins over the default. The TCP door is off unless a
 * port is set, so a daemon nobody configured for SSH never listens on a
 * second port. An explicit `env` with no `table` stays hermetic and reads
 * no file.
 */
export function resolveSSHConfig(opts?: ResolveSSHOptions): SSHConfig {
  const env = opts?.env ?? process.env
  const table = opts?.table ?? (opts?.env !== undefined ? {} : readDaemonTable(mirageHome()))
  const rawPort = setting('ssh_port', env, table)
  const dir = defaultSSHDir(opts?.home)
  const hostKey = setting('ssh_host_key_file', env, table)
  const authorized = setting('ssh_authorized_keys', env, table)
  const host = setting('ssh_host', env, table)
  return {
    port: rawPort === '' ? null : parsePort(rawPort),
    host: host !== '' ? host : DEFAULT_SSH_HOST,
    hostKeyFile: hostKey !== '' ? expandHome(hostKey) : join(dir, HOST_KEY_NAME),
    authorizedKeysFile:
      authorized !== '' ? expandHome(authorized) : join(dir, AUTHORIZED_KEYS_NAME),
  }
}

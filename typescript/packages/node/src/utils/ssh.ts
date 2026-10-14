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

import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { resolve } from 'node:path'
import { debuglog } from 'node:util'
import type { AnyAuthMethod, ConnectConfig } from 'ssh2'

/** Shared SSH connection and authentication options for the VFS and runtime. */
export async function connectOptions(
  host: string,
  hostname: string | undefined,
  port: number | undefined,
  username: string | undefined,
  identityFile: string | undefined,
  timeout: number,
  password?: string,
  passphrase?: string,
): Promise<ConnectConfig> {
  const user = username ?? userInfo().username
  const options: ConnectConfig = {
    host: hostname ?? host,
    port: port ?? 22,
    username: user,
    readyTimeout: timeout * 1000,
  }
  const methods: AnyAuthMethod[] = [{ type: 'none', username: user }]
  const agent = process.env.SSH_AUTH_SOCK
  if (agent) methods.push({ type: 'agent', username: user, agent })
  const paths =
    identityFile === undefined
      ? ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'].map((key) => resolve(homedir(), '.ssh', key))
      : [
          identityFile === '~'
            ? homedir()
            : identityFile.startsWith('~/')
              ? resolve(homedir(), identityFile.slice(2))
              : identityFile,
        ]
  for (const path of paths) {
    let key: Buffer
    try {
      key = await readFile(path)
    } catch (error) {
      if (identityFile !== undefined) throw error
      debuglog('mirage')('skipping default ssh key %s: %s', path, error)
      continue
    }
    methods.push({
      type: 'publickey',
      username: user,
      key,
      ...(passphrase === undefined ? {} : { passphrase }),
    })
  }
  if (password !== undefined) methods.push({ type: 'password', username: user, password })
  options.authHandler = methods
  return options
}

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

import type { SandboxConfig } from '@struktoai/mirage-core/runtime/sandbox/config'

/**
 * How to reach the machine that runs captured lines.
 *
 * The same knobs as the ssh VFS's config minus `root` (a runtime
 * has no mount root) and password auth (an exec surface holds keys,
 * never a password). `host` doubles as the address unless `hostname`
 * overrides it, mirroring OpenSSH's Host / HostName split.
 */
export interface SSHRuntimeConfig extends SandboxConfig {
  /** The machine to reach; also the address unless hostname is set. */
  host: string
  /** The real address when host is a label. */
  hostname?: string
  /** sshd port; absent means 22. */
  port?: number
  /** Login user; absent lets the client pick. */
  username?: string
  /** Private key path (`~` expands). */
  identityFile?: string
  /** Connect timeout in seconds; absent means 30. */
  timeout?: number
}

export const SSH_RUNTIME_CONFIG_KEYS: readonly string[] = [
  'env',
  'host',
  'hostname',
  'port',
  'username',
  'identityFile',
  'timeout',
]

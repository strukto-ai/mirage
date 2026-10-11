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

import type { MountType } from '../../types.ts'
import type { SandboxConfig } from '../config.ts'

/** How to reach the user's live E2B sandbox. */
export interface E2BConfig extends SandboxConfig {
  /**
   * Id of a sandbox you created (`e2b sandbox spawn` or the SDK),
   * with workspace files visible at matching paths when commands need them.
   */
  sandboxId: string
  /** E2B credential; required in browsers; Node falls back to E2B_API_KEY. */
  apiKey?: string
  /**
   * How the sandbox sees the workspace: `ssh` serves every prefix the
   * session sees from the host over SFTP (the image needs sshfs; node
   * only), `fuse` leaves them to a mirage in the sandbox, `both` serves
   * from the host what the sandbox does not mount itself. Unset serves
   * nothing.
   */
  mountType?: MountType
}

export const E2B_CONFIG_KEYS: readonly string[] = ['env', 'sandboxId', 'apiKey', 'mountType']

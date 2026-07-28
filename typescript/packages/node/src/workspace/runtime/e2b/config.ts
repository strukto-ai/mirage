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

import type { SandboxConfig } from '@struktoai/mirage-core'

/**
 * The E2B machine config, mapped onto Sandbox.create.
 *
 * Images and sizing are deliberately not fields: E2B bakes both into
 * a named template (`e2b template build`).
 */
export interface E2BConfig extends SandboxConfig {
  /** Name or id of the template to boot (E2B's default when omitted). */
  template?: string
  /**
   * Any other Sandbox.create option passed verbatim (timeoutMs,
   * metadata, allowInternetAccess, ...), merged last so it can
   * override anything computed from the fields above.
   */
  params?: Record<string, unknown>
}

export const E2B_CONFIG_KEYS: readonly string[] = ['env', 'template', 'params']

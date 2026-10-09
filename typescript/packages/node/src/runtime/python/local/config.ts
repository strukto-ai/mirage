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

import { HOME_CONFIG_KEYS, type HomeConfig } from '@struktoai/mirage-core/runtime/config'

/**
 * The host interpreter and the environment its program runs with. Mirrors
 * Python's LocalConfig.
 */
export interface LocalConfig extends HomeConfig {
  /**
   * Environment set for the program beside the session's; nothing else of
   * the host's own environment is passed, as for a sandlock child.
   */
  env?: Record<string, string>
}

export const LOCAL_CONFIG_KEYS: readonly string[] = [...HOME_CONFIG_KEYS, 'env']

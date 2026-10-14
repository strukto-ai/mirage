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

import { BASE_CONFIG_KEYS, type SandboxConfig } from '@struktoai/mirage-core/runtime/sandbox/config'

/** How to reach the user's running microVM. */
export interface SmolvmConfig extends SandboxConfig {
  /**
   * Name of a running machine. You start it yourself (`smolvm machine
   * create --name mirage` then `smolvm machine start --name mirage`);
   * the guest needs mirage installed and the workspace served at the
   * host's mount prefixes. Named explicitly rather than leaning on
   * smolvm's own "default" machine, so a line never lands in a VM the
   * config did not choose.
   */
  machine: string
}

export const SMOLVM_CONFIG_KEYS: readonly string[] = [...BASE_CONFIG_KEYS, 'machine']

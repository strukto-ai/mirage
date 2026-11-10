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

import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { BASE_CONFIG_FIELDS, type MachineConfig } from '@struktoai/mirage-core/machine/config'

/** How to reach the user's running pod. */
export interface KubernetesConfig extends MachineConfig {
  /**
   * Name of a running pod. You create it yourself; set
   * `runtimeClassName: isolated-sandbox` on EKS to run it in a Nitro
   * Sandbox.
   */
  pod: string
  /** The pod's namespace; unset keeps the context's. */
  namespace?: string
  /** The container in the pod; unset keeps the pod's default. */
  container?: string
  /** The kubeconfig context; unset keeps the current one. */
  context?: string
}

export const KUBERNETES_CONFIG_FIELDS: ConfigFields = {
  ...BASE_CONFIG_FIELDS,
  pod: { type: 'string', required: true },
  namespace: { type: 'string' },
  container: { type: 'string' },
  context: { type: 'string' },
}

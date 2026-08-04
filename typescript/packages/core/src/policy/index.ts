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

export type { Policy } from './base.ts'
export { PolicyDenied, PolicyDeny, PolicyError } from './errors.ts'
export { MountRootPolicy, hasParentsFlag } from './builtin/mount_root.ts'
export { OutputCapPolicy, resolveProducer, resolveLimit } from './builtin/output_cap.ts'
export { postExecuteGate, postOpsGate, preExecuteGate, preOpsGate } from './gates.ts'
export { Policies } from './policies.ts'
export { SpecPolicy, wildcardRegex } from './spec.ts'
export {
  VALIDITY,
  ctxForRuntime,
  executeContextFromPayload,
  executeContextPayload,
  type Action,
  type CommandContext,
  type Deny,
  type ExecuteContext,
  type ExecuteResultContext,
  type GuardSpec,
  type MountRootQuery,
  type OpsContext,
  type OpsResultContext,
  type ParsedCommand,
  type Route,
  type RuntimeIdentity,
} from './types.ts'

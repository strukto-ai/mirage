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
export { PolicyDenied } from './errors.ts'
export { Decisions, askRule, covers, decisionId, type AskHandler } from './decisions.ts'
export { MountRootPolicy } from './builtin/mount_root.ts'
export { PermissionsPolicy } from './builtin/permissions.ts'
export { decide, outranks, ruleAt, sourceOf } from './match/decide.ts'
export { anchorDepth } from '../utils/hidden.ts'
export {
  betterMatch,
  coversDepth,
  hiddenDepth,
  matchedOperand,
  ruleApplies,
  ruleReach,
  subjects,
  type Subject,
} from './match/rule.ts'
export { OutputCapPolicy, resolveProducer, resolveLimit } from './builtin/output_cap.ts'
export { DEFAULT_ASK_REASON, DEFAULT_DENY_REASON, POLICY_DENIED_EXIT } from './constants.ts'
export {
  Policies,
  postExecuteGate,
  postOpsGate,
  preOpsGate,
  preSessionGate,
  describeRefusal,
  saysWhy,
  refusalOf,
  renderDeny,
  renderPending,
} from './policies.ts'
export {
  type Action,
  type Ask,
  type CommandContext,
  type AdmissionRules,
  type Deny,
  type DenyScope,
  type ExecuteResultContext,
  type Explanation,
  type CommandRule,
  type OpsContext,
  type OpsResultContext,
  Outcome,
  type Abandoned,
  type Pending,
  type Decision,
  type Claim,
  type Claimant,
  type HandOff,
  type Occurrence,
  type Ruling,
  Scope,
  type SessionDecisionsQuery,
  type SessionCommandsQuery,
  type SessionContext,
} from './types.ts'

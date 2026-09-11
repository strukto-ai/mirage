# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.policy.base import Policy
from mirage.policy.builtin import (DEFAULT_COMMAND_LIMITS, FALLBACK_LIMIT,
                                   MountRootPolicy, OutputCapPolicy,
                                   PermissionsPolicy, resolve_across_mounts,
                                   resolve_limit, resolve_producer)
from mirage.policy.constants import (DEFAULT_ASK_REASON, DEFAULT_DENY_REASON,
                                     POLICY_DENIED_EXIT)
from mirage.policy.decisions import (AskHandler, Decisions, ask_rule, covers,
                                     decision_id)
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.policies import (Policies, describe_refusal,
                                    post_execute_gate, post_ops_gate,
                                    pre_ops_gate, pre_session_gate, refusal_of,
                                    render_deny, render_pending, says_why)
from mirage.policy.profile import (CommandsBlock, CompiledProfile,
                                   MountCommandsBlock, PathsBlock,
                                   ProfileMount, SessionProfile, VarsBlock)
from mirage.policy.script import ScriptPolicy

from mirage.policy.types import (  # isort: skip
    VALIDITY, Abandoned, Action, Ask, Claim, Claimant, CommandContext,
    CommandRule, AdmissionRules, Decision, Deny, DenyScope,
    ExecuteResultContext, Explanation, HandOff, Limit, MountRootQuery,
    Occurrence, OpsContext, OpsResultContext, Outcome, Pending, ProfileScript,
    Scope, SessionCommandsQuery, SessionContext, SessionDecisionsQuery,
    SessionScriptsQuery)

__all__ = [
    "Abandoned",
    "Action",
    "AdmissionRules",
    "Ask",
    "ask_rule",
    "AskHandler",
    "CommandContext",
    "CommandRule",
    "CommandsBlock",
    "CompiledProfile",
    "covers",
    "Decision",
    "decision_id",
    "Decisions",
    "DEFAULT_ASK_REASON",
    "DEFAULT_COMMAND_LIMITS",
    "DEFAULT_DENY_REASON",
    "Deny",
    "DenyScope",
    "ExecuteResultContext",
    "Claim",
    "Claimant",
    "Explanation",
    "HandOff",
    "Occurrence",
    "FALLBACK_LIMIT",
    "Limit",
    "MountCommandsBlock",
    "MountRootPolicy",
    "MountRootQuery",
    "OpsContext",
    "OpsResultContext",
    "Outcome",
    "OutputCapPolicy",
    "PathsBlock",
    "Pending",
    "PermissionsPolicy",
    "Policies",
    "Policy",
    "POLICY_DENIED_EXIT",
    "PolicyDenied",
    "PolicyError",
    "post_execute_gate",
    "post_ops_gate",
    "pre_ops_gate",
    "pre_session_gate",
    "ProfileMount",
    "ProfileScript",
    "describe_refusal",
    "refusal_of",
    "render_deny",
    "render_pending",
    "resolve_across_mounts",
    "resolve_limit",
    "resolve_producer",
    "says_why",
    "Scope",
    "ScriptPolicy",
    "SessionCommandsQuery",
    "SessionContext",
    "SessionDecisionsQuery",
    "SessionProfile",
    "SessionScriptsQuery",
    "VALIDITY",
    "VarsBlock",
]

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

# isort: skip_file
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.commands.registry import command
from mirage.commands.cli import CLIInvocation, CLISpec, register_cli_spec
from mirage.commands.spec import Operand, Option
from mirage.types import FileStat, MountBackend, MountMode
from mirage.policy import Action, CommandContext, Deny, Policy
from mirage.workspace import (ExecutionNode, Workspace, WorkspaceRunner)
from mirage.workspace.fuse import FuseManager
from mirage.workspace.mount.spec import Mount
from mirage.types import ConsistencyPolicy
from mirage.utils.ids import new_session_id, new_workspace_id, uuid7
from mirage.version import __version__ as __version__

# The authoring surface: what a host reaches for to bring its own
# resource, CLI, policy, runtime or secrets source, and the types the
# Workspace's own signatures hand back. One front door, the way
# @struktoai/mirage-core's index.ts is. There is no second, narrower
# barrel for one plane: the resource author's kit that `mirage.sdk` once
# held lives here beside the other four.
from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexConfig
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.cli import CLIDoors
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS, CommandSpec, FlagView
from mirage.commands.spec.types import UsageStyle
from mirage.io import IOResult
from mirage.ops.generic import OpsTable, make_generic_ops
from mirage.ops.registry import RegisteredOp, op
from mirage.policy import (Ask, Decision, Decisions, Explanation, Outcome,
                           PolicyDenied, PolicyError, Scope, SessionContext,
                           SessionProfile)
from mirage.policy.types import OpsContext
from mirage.resource.base import BaseResource
from mirage.resource.generic import GenericResource
from mirage.resource.registry import (build_resource, known_resources,
                                      register_resource)
from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import EvaluatorMixin, LineExecutorMixin
from mirage.runtime.routing import DenyResult, RouteContext, RouteResult
from mirage.runtime.sandbox import RemoteSandbox, SandboxConfig
from mirage.runtime.table import (build_runtime, known_runtimes,
                                  register_runtime)
from mirage.runtime.types import RunArgs, RunResult
from mirage.secrets.registry import known_sources, register_secrets
from mirage.types import (ContentType, DriftPolicy, FileType, Limit, PathSpec,
                          ResourceName)
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES, make_resolve_glob
from mirage.workspace import Session

__all__ = [
    "__version__",
    "Workspace",
    "WorkspaceRunner",
    "RAMResource",
    "DiskResource",
    "Action",
    "CommandContext",
    "ConsistencyPolicy",
    "Deny",
    "ExecutionNode",
    "FileStat",
    "FuseManager",
    "Policy",
    "Mount",
    "MountBackend",
    "MountMode",
    "CLIInvocation",
    "CLISpec",
    "Operand",
    "Option",
    "register_cli_spec",
    "command",
    "new_session_id",
    "new_workspace_id",
    "uuid7",
    # authoring surface
    "Accessor",
    "Ask",
    "BaseResource",
    "CLIDoors",
    "CommandIO",
    "CommandSpec",
    "ContentType",
    "DEFAULT_MAX_GLOB_MATCHES",
    "Decision",
    "Decisions",
    "DenyResult",
    "DriftPolicy",
    "EvaluatorMixin",
    "Explanation",
    "FileType",
    "FlagView",
    "GenericResource",
    "IOResult",
    "IndexCacheStore",
    "IndexConfig",
    "LanguageRuntime",
    "Limit",
    "LineExecutorMixin",
    "NULL_INDEX",
    "OpsContext",
    "OpsTable",
    "Outcome",
    "PathSpec",
    "PolicyDenied",
    "PolicyError",
    "RegisteredOp",
    "RemoteSandbox",
    "ResourceName",
    "RouteContext",
    "RouteResult",
    "RunArgs",
    "RunResult",
    "Runtime",
    "RuntimeConfig",
    "SPECS",
    "SandboxConfig",
    "Scope",
    "Session",
    "SessionContext",
    "SessionProfile",
    "UsageError",
    "UsageStyle",
    "build_resource",
    "build_runtime",
    "known_resources",
    "known_runtimes",
    "known_sources",
    "make_generic_commands",
    "make_generic_ops",
    "make_resolve_glob",
    "op",
    "register_resource",
    "register_runtime",
    "register_secrets",
    "stream_from_bytes",
]

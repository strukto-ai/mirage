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

import importlib
from typing import TYPE_CHECKING, Any

from mirage.version import __version__ as __version__

# The authoring surface: what a host reaches for to bring its own
# VFS, CLI, policy, runtime or secrets source, and the types the
# Workspace's own signatures hand back. One front door, the way
# @struktoai/mirage-core's index.ts is. Each name resolves on first use,
# so a leaf such as the `mirage` CLI imports without loading the package.
if TYPE_CHECKING:
    from mirage.accessor.base import Accessor
    from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexConfig
    from mirage.commands.builtin.generic_bind import generic_commands
    from mirage.commands.cli import (
        CLIDoors,
        CLIInvocation,
        CLISpec,
        register_cli_spec,
    )
    from mirage.commands.config import command
    from mirage.commands.errors import UsageError
    from mirage.commands.spec import (
        SPECS,
        CommandSpec,
        FlagView,
        Operand,
        Option,
    )
    from mirage.commands.spec.types import UsageStyle
    from mirage.io import IOResult
    from mirage.io.config import IOConfig
    from mirage.policy import (
        Action,
        Ask,
        CommandContext,
        CommandExplanation,
        Decision,
        Decisions,
        Deny,
        Explanation,
        Outcome,
        Policy,
        PolicyDenied,
        PolicyError,
        Scope,
        SessionContext,
        SessionProfile,
        ShellExplanation,
        ShellNode,
        ShellOperand,
        VfsExplanation,
    )
    from mirage.policy.types import VfsContext
    from mirage.runtime.base import Runtime
    from mirage.runtime.binding import RuntimeContext, WorkspaceBinding
    from mirage.runtime.config import RuntimeConfig
    from mirage.runtime.constants import EXTERNAL_COMMANDS
    from mirage.runtime.errors import UnsupportedExecutionError
    from mirage.runtime.language import LanguageRuntime
    from mirage.runtime.mixin import (
        EvaluatorMixin,
        LineExecutorMixin,
        ProcessExecutorMixin,
    )
    from mirage.runtime.routing import DenyResult, RouteContext, RouteResult
    from mirage.runtime.sandbox import RemoteSandbox, SandboxConfig
    from mirage.runtime.table import (
        build_runtime,
        known_runtimes,
        register_runtime,
    )
    from mirage.runtime.types import (
        CodeExecution,
        ExecutionRequest,
        FilesystemOperation,
        ProcessExecution,
        RunArgs,
        RunResult,
        RuntimeCapabilities,
        ShellRequest,
    )
    from mirage.secrets.registry import known_sources, register_secrets
    from mirage.types import (
        ContentType,
        DriftPolicy,
        FileStat,
        FileType,
        Limit,
        MountBackend,
        MountMode,
        PathSpec,
        ReadPolicy,
        ReadSpec,
        VFSName,
        WritePolicy,
    )
    from mirage.utils.glob_walk import (
        DEFAULT_MAX_GLOB_MATCHES,
        make_resolve_glob,
    )
    from mirage.utils.ids import new_session_id, new_workspace_id, uuid7
    from mirage.vfs.base import BaseVFS
    from mirage.vfs.call import vfs_call
    from mirage.vfs.disk import DiskVFS
    from mirage.vfs.ram import RAMVFS
    from mirage.vfs.registry import build_vfs, known_vfs_names, register_vfs
    from mirage.vfs.testing import (
        ReadFixture,
        check_read_contract,
    )
    from mirage.vfs.types import (
        Effect,
        SearchQuery,
        Target,
    )
    from mirage.workspace import (
        ExecutionNode,
        Session,
        SessionState,
        Workspace,
        WorkspaceRunner,
    )
    from mirage.workspace.fuse import FuseManager
    from mirage.workspace.mount.spec import Mount
    from mirage.workspace.shell_execution import ShellExecution

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.io.config": ("IOConfig",),
    "mirage.workspace.shell_execution": ("ShellExecution",),
    "mirage.vfs.disk": ("DiskVFS",),
    "mirage.vfs.ram": ("RAMVFS",),
    "mirage.commands.config": ("command",),
    "mirage.commands.cli": (
        "CLIInvocation",
        "CLISpec",
        "register_cli_spec",
        "CLIDoors",
    ),
    "mirage.commands.spec": (
        "Operand",
        "Option",
        "SPECS",
        "CommandSpec",
        "FlagView",
    ),
    "mirage.types": (
        "FileStat",
        "MountBackend",
        "MountMode",
        "ReadPolicy",
        "ReadSpec",
        "WritePolicy",
        "ContentType",
        "DriftPolicy",
        "FileType",
        "Limit",
        "PathSpec",
        "VFSName",
    ),
    "mirage.policy": (
        "Action",
        "CommandContext",
        "Deny",
        "Policy",
        "Ask",
        "Decision",
        "Decisions",
        "Explanation",
        "CommandExplanation",
        "ShellExplanation",
        "ShellNode",
        "ShellOperand",
        "VfsExplanation",
        "Outcome",
        "PolicyDenied",
        "PolicyError",
        "Scope",
        "SessionContext",
        "SessionProfile",
    ),
    "mirage.workspace": (
        "ExecutionNode",
        "Workspace",
        "WorkspaceRunner",
        "Session",
        "SessionState",
    ),
    "mirage.workspace.fuse": ("FuseManager",),
    "mirage.workspace.mount.spec": ("Mount",),
    "mirage.utils.ids": ("new_session_id", "new_workspace_id", "uuid7"),
    "mirage.accessor.base": ("Accessor",),
    "mirage.cache.index": ("NULL_INDEX", "IndexCacheStore", "IndexConfig"),
    "mirage.commands.builtin.generic_bind": ("generic_commands",),
    "mirage.commands.errors": ("UsageError",),
    "mirage.commands.spec.types": ("UsageStyle",),
    "mirage.io": ("IOResult",),
    "mirage.policy.types": ("VfsContext",),
    "mirage.vfs.base": ("BaseVFS",),
    "mirage.vfs.testing": (
        "ReadFixture",
        "check_read_contract",
    ),
    "mirage.vfs.call": ("vfs_call",),
    "mirage.vfs.types": (
        "Effect",
        "SearchQuery",
        "Target",
    ),
    "mirage.vfs.registry": ("build_vfs", "known_vfs_names", "register_vfs"),
    "mirage.runtime.base": ("Runtime",),
    "mirage.runtime.config": ("RuntimeConfig",),
    "mirage.runtime.constants": ("EXTERNAL_COMMANDS",),
    "mirage.runtime.binding": ("RuntimeContext", "WorkspaceBinding"),
    "mirage.runtime.errors": ("UnsupportedExecutionError",),
    "mirage.runtime.language": ("LanguageRuntime",),
    "mirage.runtime.mixin": (
        "EvaluatorMixin",
        "LineExecutorMixin",
        "ProcessExecutorMixin",
    ),
    "mirage.runtime.routing": ("DenyResult", "RouteContext", "RouteResult"),
    "mirage.runtime.sandbox": ("RemoteSandbox", "SandboxConfig"),
    "mirage.runtime.table": (
        "build_runtime",
        "known_runtimes",
        "register_runtime",
    ),
    "mirage.runtime.types": (
        "RunArgs",
        "RunResult",
        "CodeExecution",
        "ShellRequest",
        "ProcessExecution",
        "ExecutionRequest",
        "RuntimeCapabilities",
        "FilesystemOperation",
    ),
    "mirage.secrets.registry": ("known_sources", "register_secrets"),
    "mirage.utils.glob_walk": (
        "DEFAULT_MAX_GLOB_MATCHES",
        "make_resolve_glob",
    ),
}
_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "ShellExecution",
    "IOConfig",
    "ReadFixture",
    "check_read_contract",
    "__version__",
    "Workspace",
    "WorkspaceRunner",
    "RAMVFS",
    "DiskVFS",
    "Action",
    "CommandContext",
    "Deny",
    "ExecutionNode",
    "FileStat",
    "FuseManager",
    "Policy",
    "Mount",
    "MountBackend",
    "MountMode",
    "ReadPolicy",
    "ReadSpec",
    "WritePolicy",
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
    "BaseVFS",
    "CLIDoors",
    "CommandSpec",
    "ContentType",
    "DEFAULT_MAX_GLOB_MATCHES",
    "Decision",
    "Decisions",
    "DenyResult",
    "DriftPolicy",
    "EvaluatorMixin",
    "Explanation",
    "CommandExplanation",
    "ShellExplanation",
    "ShellNode",
    "ShellOperand",
    "VfsExplanation",
    "FileType",
    "FlagView",
    "SearchQuery",
    "Effect",
    "Target",
    "vfs_call",
    "IOResult",
    "IndexCacheStore",
    "IndexConfig",
    "LanguageRuntime",
    "Limit",
    "LineExecutorMixin",
    "ProcessExecutorMixin",
    "NULL_INDEX",
    "VfsContext",
    "Outcome",
    "PathSpec",
    "PolicyDenied",
    "PolicyError",
    "RemoteSandbox",
    "VFSName",
    "RouteContext",
    "RouteResult",
    "CodeExecution",
    "ShellRequest",
    "ProcessExecution",
    "ExecutionRequest",
    "RuntimeContext",
    "RuntimeCapabilities",
    "FilesystemOperation",
    "WorkspaceBinding",
    "UnsupportedExecutionError",
    "RunArgs",
    "RunResult",
    "Runtime",
    "RuntimeConfig",
    "EXTERNAL_COMMANDS",
    "SPECS",
    "SandboxConfig",
    "Scope",
    "Session",
    "SessionContext",
    "SessionProfile",
    "SessionState",
    "UsageError",
    "UsageStyle",
    "build_vfs",
    "build_runtime",
    "known_vfs_names",
    "known_runtimes",
    "known_sources",
    "generic_commands",
    "make_resolve_glob",
    "register_vfs",
    "register_runtime",
    "register_secrets",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value

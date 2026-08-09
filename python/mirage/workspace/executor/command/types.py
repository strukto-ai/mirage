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

from collections.abc import Awaitable
from typing import NamedTuple, Protocol

import tree_sitter

from mirage.commands.spec.types import FlagValue
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.types import PathSpec
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


class ExecuteNodeFn(Protocol):
    """The executor's statement runner, re-entered for function bodies.

    ``handle_command`` receives it from the node dispatcher so a shell
    function can execute each statement of its body through the full
    executor without a circular import.
    """

    def __call__(
        self, node: tree_sitter.Node, session: Session,
        stdin: ByteSource | None, call_stack: CallStack
    ) -> Awaitable[tuple[ByteSource | None, IOResult, ExecutionNode]]:
        ...


class ParsedCommand(NamedTuple):
    paths: list[PathSpec]
    texts: list[str]
    flag_kwargs: dict[str, FlagValue]
    warnings: list[str]
    invalid_options: list[str]
    ambiguous_options: list[tuple[str, tuple[str, ...]]]
    option_error_kinds: list[str]
    needs_value_options: list[str]
    invalid_value_options: list[tuple[str, str, tuple[str, ...]]]
    invalid_int_options: list[tuple[str, str]]
    invalid_float_options: list[tuple[str, str]]
    missing_required_options: list[str]
    old_option_needs_value: str | None = None

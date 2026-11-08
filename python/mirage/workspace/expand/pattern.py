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

from collections.abc import Callable
from typing import Any

from mirage.shell.call_stack import CallStack
from mirage.shell.types import TSNodeLike
from mirage.utils.glob_walk import escape_glob
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.node import expand


async def expand_pattern(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> str:
    """Expand one pattern word into the matcher's glob dialect, as case
    patterns and the right side of ``[[ == ]]`` read it: quoted text
    matches only itself.

    Args:
        ts_node (TSNodeLike): one pattern node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): function-call scope, if any.
    """
    runs = await expand(ts_node, "pattern", context, execute_fn, call_stack)
    return "".join(
        escape_glob(text) if quoted else text for text, quoted in runs
    )


async def expand_regex(
    ts_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> str:
    """Expand the right side of ``[[ =~ ]]`` into a POSIX extended
    regex: quoted text matches only itself.

    Args:
        ts_node (TSNodeLike): the regex node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): function-call scope, if any.
    """
    return str(await expand(ts_node, "regex", context, execute_fn, call_stack))

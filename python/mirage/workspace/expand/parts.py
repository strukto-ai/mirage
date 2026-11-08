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

from mirage.io.yield_budget import YieldBudget
from mirage.shell.call_stack import CallStack
from mirage.types import PathSpec
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.classify import classify_word
from mirage.workspace.expand.node import expand
from mirage.workspace.mount import MountRegistry


async def expand_words(
    parts: list[Any],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> list[str]:
    """Expand parsed child nodes to words that still know their quoting.

    Each node brace-expands, expands and splits on IFS, so an unquoted
    expansion anywhere in a word splits (``q$x`` too) and quoted text
    never does. A glob character quoting made literal travels under its
    own mark, so `"/data/"*.txt` still globs while `'/data/*'.txt` does
    not; ``unmark_globs`` takes the marks off.

    Args:
        parts (list[Any]): the word nodes to expand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    result: list[str] = []
    # Each word expands in one step; the line yields between words, so a
    # cancel or its deadline lands before the last.
    budget = YieldBudget()
    for part in parts:
        result.extend(
            await expand(part, "fields", context, execute_fn, call_stack)
        )
        await budget.run()
    return result


async def expand_and_classify(
    words: list[Any],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    cwd: str,
    call_stack: CallStack | None = None,
) -> list[str | PathSpec]:
    """Expand words, classify as PathSpec or text.

    Used by for/select where concrete values are needed before
    iteration. Words keep their glob marks, because the loop list is
    glob-resolved next (``resolve_globs``, which is where the marks come
    off): `for f in '/data/*.txt'` iterates once over the name as typed,
    like bash, while `for f in '/data/*'?.txt` still globs on the `?`.
    """
    expanded = await expand_words(words, context, execute_fn, call_stack)
    # One word can expand to a million (`a=($x)`), so classifying them
    # yields too.
    budget = YieldBudget()
    classified: list[str | PathSpec] = []
    for word in expanded:
        classified.append(classify_word(word, registry, cwd))
        await budget.run()
    return classified

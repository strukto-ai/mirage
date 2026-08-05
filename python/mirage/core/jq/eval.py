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

import re
from collections.abc import Mapping, Sequence
from typing import Any

import jq as _libjq

from mirage.core.jq.types import ARGS_VAR, INPUTS_VAR, JqOptions

INPUTS_REF = re.compile(r"\binputs\b")
ARGS_REF = re.compile(r"\$ARGS\b")
TO_STREAM = "tostream"


def references_args(expr: str) -> bool:
    """Report whether a jq program mentions the `$ARGS` variable.

    Args:
        expr (str): jq program text.
    """
    return ARGS_REF.search(expr) is not None


def args_object(opts: JqOptions) -> dict[str, Any]:
    """The value `$ARGS` resolves to for a run.

    Args:
        opts (JqOptions): resolved options carrying both binding kinds.
    """
    return {
        "positional": list(opts.positional_args),
        "named": dict(opts.named_args),
    }


def stream_events(doc: object) -> list[object]:
    """The `[path, leaf]` events `--stream` reads a document as.

    jq's own `tostream` emits exactly the events `--stream` produces for
    a complete document; the two differ only for input too truncated to
    parse, which never reaches here because mirage reads whole values.

    Args:
        doc (object): one parsed input document.
    """
    return jq_eval(doc, TO_STREAM)


def references_inputs(expr: str) -> bool:
    """Report whether a jq program mentions the `inputs` builtin.

    Binding the remaining documents is what makes `inputs` work, and
    that binding is one copy of the stream per evaluation, so it is only
    paid for by a program that asks for it. A mention inside a string
    literal reads as a reference, which costs a binding and changes
    nothing else.

    Args:
        expr (str): jq program text.
    """
    return INPUTS_REF.search(expr) is not None


def jq_eval(
    obj: object,
    expr: str,
    named_args: Mapping[str, Any] | None = None,
    inputs: Sequence[object] | None = None,
    args_value: Mapping[str, Any] | None = None,
) -> list[object]:
    """Evaluate a jq expression against obj using libjq.

    A jq program is a stream transformer: it emits zero, one or many
    values, and jq prints each on its own line. That arity is preserved
    here rather than collapsed, so two outputs are never confused with
    one output that happens to be an array. `.a, .b` yields two values;
    `[.a, .b]` yields one.

    Args:
        obj (object): JSON-like input value (dict / list / scalar).
        expr (str): jq program text.
        named_args (Mapping[str, Any] | None): $name bindings from
            --arg / --argjson.
        inputs (Sequence[object] | None): documents the `inputs`
            builtin should yield, i.e. the ones still unread at this
            point in the stream. libjq's Python binding owns no input
            stream, so `inputs` is bound as a definition over a named
            argument instead; a user program that defines its own
            `inputs` shadows it, as it would shadow the builtin.
        args_value (Mapping[str, Any] | None): the value `$ARGS` should
            resolve to, bound the same way and for the same reason
            (libjq's binding defines no `$ARGS` of its own).

    Returns:
        list[object]: every output value, in order. Empty when the
            program produces no output at all, which real jq reports as
            exit 0 with empty stdout.
    """
    args: dict[str, Any] = dict(named_args) if named_args else {}
    # A prelude shifts every line and column a syntax error reports, so
    # neither is added unless the program asked for what it binds.
    prelude = ""
    body = expr
    if inputs is not None:
        args[INPUTS_VAR] = list(inputs)
        prelude = f"def inputs: ${INPUTS_VAR}[];\n"
    if args_value is not None:
        args[ARGS_VAR] = dict(args_value)
        prelude = f"{prelude}${ARGS_VAR} as $ARGS |\n"
        body = f"({expr})"
    program = _libjq.compile(prelude + body if prelude else expr, args=args)
    return list(program.input_value(obj))

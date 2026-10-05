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

from functools import partial

from mirage.commands.builtin.generic.realpath import canonicalize
from mirage.commands.builtin.utils.paths import (
    dispatch_stat,
    dot_refusal,
    typed_spec,
)
from mirage.commands.spec.usage import missing_operand_error
from mirage.io import IOResult
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec
from mirage.utils.errors import fs_error_line, fs_strerror, walk_refusal
from mirage.workspace.executor.builtins.links.ln import operand_abs
from mirage.workspace.executor.builtins.shared import (
    fail,
    operand_text,
    parse_line,
)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

# The last canonicalizing flag decides how much of the path must exist,
# in the mode letters ``canonicalize`` takes ("" is -f).
CANONICAL_MODES = {
    "canonicalize": "",
    "canonicalize_existing": "e",
    "canonicalize_missing": "m",
}


def operand_words(args: list[str | PathSpec]) -> list[str | PathSpec]:
    """readlink's operands as received: every word that is not an option,
    the words after ``--`` included. None of its options takes a value.

    Args:
        args (list[str | PathSpec]): the command's words after the name.
    """
    words: list[str | PathSpec] = []
    options = True
    for arg in args:
        text = operand_text(arg)
        if options and text == "--":
            options = False
        elif not (options and text.startswith("-") and text != "-"):
            words.append(arg)
    return words


async def handle_readlink(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """Print a symlink's target, GNU readlink semantics.

    The three canonicalizing flags differ only in how much of the
    resolved path has to exist: ``-m`` requires nothing, ``-f`` requires
    every component but the last, and ``-e`` requires all of it. A path
    that falls short prints nothing and exits 1, and says why under
    ``-v`` (the last of -q, -s and -v wins).

    Args:
        namespace (Namespace): addressing authority holding the links.
        dispatch (DispatchFn): op dispatcher, used for the existence check.
        session (SessionState): current session, for the working directory.
        args (list[str | PathSpec]): the command's words after the name.
    """
    _parsed, fl, refused = parse_line("readlink", args, session.cwd)
    if refused is not None:
        return refused
    operands = operand_words(args)
    if not operands:
        error = missing_operand_error("readlink", None)
        return fail("readlink", f"{error}\n", error.exit_code)
    canon = fl.typed_order(
        "canonicalize", "canonicalize_existing", "canonicalize_missing"
    )
    mode = None if not canon else CANONICAL_MODES[canon[-1]]
    voice = fl.typed_order("quiet", "silent", "verbose")
    verbose = bool(voice) and voice[-1] == "verbose"
    errors: list[str] = []
    newline = not fl.as_bool("no_newline")
    if len(operands) > 1 and not newline:
        errors.append(
            "readlink: ignoring --no-newline with multiple arguments\n"
        )
        newline = True
    lines: list[str] = []
    exit_code = 0
    for op in operands:
        abs_op = operand_abs(namespace, op, session.cwd)
        spec = typed_spec(op, session.cwd)
        # The link entry is namespace state behind the op door: session
        # grants and admission policies decide whether this session may
        # read the target at all, so a link operand clears it even under
        # -f, -e and -m. EINVAL (not a link), a refusal and a failed walk
        # all land on GNU readlink's exit 1, said only under -v.
        try:
            if mode is not None:
                if namespace.is_link(abs_op):
                    await dispatch("readlink", PathSpec.from_str_path(abs_op))
                lines.append(
                    await canonicalize(
                        spec.raw_path,
                        session.cwd,
                        mode,
                        False,
                        namespace.readlink,
                        partial(dispatch_stat, dispatch),
                    )
                )
                continue
            refusal = (
                walk_refusal(spec)
                if spec.walk_error is not None
                else await dot_refusal(
                    partial(dispatch_stat, dispatch), spec, namespace.follow
                )
            )
            if refusal is not None:
                raise refusal
            target, _ = await dispatch(
                "readlink", PathSpec.from_str_path(abs_op)
            )
        except OSError as exc:
            exit_code = 1
            if verbose:
                line = fs_error_line("readlink", spec.raw_path, exc)
                if fs_strerror(exc) is None and exc.strerror:
                    line = f"{line.rstrip()}: {exc.strerror}\n"
                errors.append(line)
            continue
        lines.append(target)
    end = ("\0" if fl.as_bool("zero") else "\n") if newline else ""
    text = "".join(line + end for line in lines)
    err = encode_text("".join(errors))
    return (
        encode_text(text) if text else None,
        IOResult(exit_code=exit_code, stderr=err),
        ExecutionNode(command="readlink", exit_code=exit_code, stderr=err),
    )

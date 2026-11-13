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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import SET_OPTION_DEFAULTS, SET_OPTION_NAMES
from mirage.shell.options import parse_option_word
from mirage.shell.voice import shell_voice
from mirage.workspace.executor.builtins.declare.declare import function_lines
from mirage.workspace.executor.builtins.shared import (
    builtin_error,
    builtin_usage,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (
    prefix_temporaries,
    set_positional_params,
)
from mirage.workspace.types import ExecutionNode


def _unknown_letter(args: list[str]) -> str | None:
    """The first option letter of a `set` line that names no option, with
    the sign it was given under, None when there is none.

    bash reads every option word before it acts on any, so one such letter
    refuses the whole line and nothing it sets is set.

    Args:
        args (list[str]): the words after `set`.
    """
    i = 0
    while i < len(args) and args[i] != "--":
        nxt = args[i + 1] if i + 1 < len(args) else None
        word = parse_option_word(args[i], nxt)
        if word is None:
            return None
        if word.other:
            return args[i][0] + word.other[0]
        i += word.consumed
    return None


async def handle_set(
    args: list[str],
    session: SessionState,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        out = encode_text("".join(f"{line}\n" for line in _listing(session)))
        return out, IOResult(), ExecutionNode(command="set", exit_code=0)
    bad = _unknown_letter(args)
    if bad is not None:
        err = builtin_error("set", f"{bad}: invalid option") + encode_text(
            builtin_usage("set")
        )
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command="set", exit_code=2, stderr=err),
        )
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            if call_stack is not None:
                call_stack.current.replaced_args = True
            set_positional_params(session, call_stack, args[i + 1 :])
            return None, IOResult(), ExecutionNode(command="set", exit_code=0)
        # `-o` and `+o` with nothing after them print the option table
        # instead of setting anything, in two different spellings: `-o`
        # as a padded name/value column, `+o` as lines that can be fed
        # back to `set`. Both are checked before the option grammar,
        # since a bare `-o` is not a setting.
        if tok in ("-o", "+o") and i + 1 >= len(args):
            out = _option_listing(session, plus=tok == "+o")
            return out, IOResult(), ExecutionNode(command="set", exit_code=0)
        word = parse_option_word(
            tok, args[i + 1] if i + 1 < len(args) else None
        )
        if word is None:
            if call_stack is not None:
                call_stack.current.replaced_args = True
            set_positional_params(session, call_stack, args[i:])
            break
        for option, enable in word.settings:
            # `-o` takes a name rather than a letter, and a name bash does
            # not have is the one thing it refuses: exit 2, and the
            # settings already applied stay applied while the rest of the
            # line is dropped. Without this a typo -- or an option mirage
            # has yet to wire, as `physical` once was -- reads as success.
            if option not in SET_OPTION_NAMES:
                err = encode_text(
                    f"{shell_voice()}set: {option}: invalid option name\n"
                )
                return (
                    None,
                    IOResult(exit_code=2, stderr=err),
                    ExecutionNode(command="set", exit_code=2, stderr=err),
                )
            session.shell_options[option] = enable
        # Every letter bash has names an option here, the ones mirage does
        # not act on (`-a`, `-B`, `-H`) included, so a script can still
        # turn those on. A nested shell answers a letter bash lacks
        # differently, which is why the grammar hands it back.
        i += word.consumed
    return None, IOResult(), ExecutionNode(command="set", exit_code=0)


def _listing(session: SessionState) -> list[str]:
    """What a bare ``set`` prints: every visible variable by name, an
    array's value as ``declare -p`` writes it, then each function as
    ``declare -f`` prints it, which posix mode leaves out.

    Args:
        session (SessionState): shell session state.
    """
    lines = session.vars.shell.assignments(prefix_temporaries(session))
    if not session.shell_options.get("posix"):
        lines += function_lines(
            session, sorted(session.functions), True, False
        )
    return lines


def _option_listing(session: SessionState, plus: bool) -> bytes:
    """Render `set -o` or `set +o` with no name after it.

    GNU 5.2.37 prints every option it knows, alphabetically, whether or
    not the shell has been told anything about it: `-o` as a name padded
    to 15 columns, a tab, then `on`/`off`, and `+o` as `set -o NAME` /
    `set +o NAME` lines a script can source back. `interactive-comments`
    is longer than the padding and simply overflows it, which is GNU's
    own `%-15s\\t%s` and not a special case.

    Args:
        session (SessionState): the session holding the shell options.
        plus (bool): render the `set +o` re-readable spelling.
    """
    lines = []
    for name, default in SET_OPTION_DEFAULTS.items():
        on = session.shell_options.get(name, default)
        if plus:
            lines.append(f"set {'-' if on else '+'}o {name}")
        else:
            lines.append(f"{name:<15}\t{'on' if on else 'off'}")
    return encode_text("\n".join(lines) + "\n")


async def set_builtin(call: BuiltinCall) -> Result:
    """The ``set`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_set(
        list(call.argv.args), call.context.session, call_stack=call.call_stack
    )

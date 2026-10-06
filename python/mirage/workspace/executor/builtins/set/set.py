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
from mirage.utils.quote import single_quote
from mirage.workspace.executor.builtins.constants import SET_QUOTED_CHARS
from mirage.workspace.executor.builtins.declare.declare import (
    bash_declare_quote,
    is_control,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import set_positional_params, visible_env
from mirage.workspace.types import ExecutionNode


async def handle_set(
    args: list[str],
    session: SessionState,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        lines = [
            f"{k}={_listed_value(v)}"
            for k, v in sorted(visible_env(session).items())
        ]
        out = encode_text("\n".join(lines) + "\n")
        return out, IOResult(), ExecutionNode(command="set", exit_code=0)
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
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
                    f"bash: set: {option}: invalid option name\n"
                )
                return (
                    None,
                    IOResult(exit_code=2, stderr=err),
                    ExecutionNode(command="set", exit_code=2, stderr=err),
                )
            session.shell_options[option] = enable
        # A letter naming no option is ignored rather than refused: bash
        # has options mirage does not implement (`-a`, `-B`, `-H`), and
        # `set` is where a script turns those on without wanting to fail.
        # A nested shell answers the same leftovers differently, which is
        # why the grammar hands them back instead of deciding here.
        i += word.consumed
    return None, IOResult(), ExecutionNode(command="set", exit_code=0)


def _listed_value(value: str) -> str:
    """A value as bash's bare ``set`` prints it.

    ``$'...'`` when it holds a control character, the form ``declare
    -p`` writes; single quotes when the shell would read a character in
    it specially; bare otherwise. GNU prints ``IFS=$' \\t\\n'``,
    ``x='a b'`` and ``y=a,b``.

    Args:
        value (str): the variable's value.
    """
    if any(is_control(ch) for ch in value):
        return bash_declare_quote(value)
    tilde = any(
        ch == "~" and (i == 0 or value[i - 1] in "=:")
        for i, ch in enumerate(value)
    )
    if (
        tilde
        or value.startswith("#")
        or any(ch in SET_QUOTED_CHARS for ch in value)
    ):
        return single_quote(value)
    return value


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

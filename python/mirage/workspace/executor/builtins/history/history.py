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

from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.core.history.render import render_history_listing
from mirage.io.types import IOResult
from mirage.shell.bytes import encode_text
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.session import SessionState
from mirage.workspace.types import ExecutionNode

# bash 5.2.21's own string, letters in ITS order (`history -anrw`, not
# the accepted-set order the flag table is written in).
_USAGE = (
    "history: usage: history [-c] [-d offset] [n] or "
    "history -anrw [filename] or history -ps arg [arg...]\n"
)
_OPTION_CHARS = "cdanrwsp"


def _result(
    stdout: bytes | None, exit_code: int = 0, stderr: bytes | None = None
) -> Result:
    """The builtin's output, status and execution-tree node.

    Args:
        stdout (bytes | None): what the builtin prints.
        exit_code (int): its status.
        stderr (bytes | None): what it says on stderr.
    """
    return (
        stdout,
        IOResult(exit_code=exit_code, stderr=stderr),
        ExecutionNode(
            command="history", exit_code=exit_code, stderr=stderr or b""
        ),
    )


def _out_of_range(value: str) -> Result:
    err = f"bash: history: {value}: history position out of range\n"
    return _result(None, 1, encode_text(err))


def _parse_args(
    args: list[str],
) -> tuple[dict[str, FlagValue], list[str], str | None]:
    """Parse history builtin args the way bash getopt does.

    Args:
        args (list[str]): Raw tokens after the command name.

    Returns:
        tuple[dict[str, JsonValue], list[str], str | None]: Flags dict,
        operand texts, and an error message (None when parsing
        succeeded). Any dash-leading token is option-parsed, digits
        included (`history -1` is an invalid option in bash); `--` or
        the first operand ends option parsing, so `history -s rm -rf`
        stores "rm -rf" as text. `-d` takes the rest of its token as
        the offset when attached (`-d3`, and `-dc` deletes entry "c"),
        otherwise the next token.
    """
    flags: dict[str, FlagValue] = {}
    texts: list[str] = []
    options_done = False
    i = 0
    while i < len(args):
        token = args[i]
        if options_done or token == "-" or not token.startswith("-"):
            texts.append(token)
            options_done = True
        elif token == "--":
            options_done = True
        else:
            j = 1
            while j < len(token):
                ch = token[j]
                if ch not in _OPTION_CHARS:
                    return {}, [], f"bash: history: -{ch}: invalid option\n"
                flags[ch] = True
                if ch == "d":
                    rest = token[j + 1 :]
                    if rest:
                        flags["d"] = rest
                    elif i + 1 < len(args):
                        i += 1
                        flags["d"] = args[i]
                    else:
                        return (
                            {},
                            [],
                            "bash: history: -d: option requires an argument\n",
                        )
                    break
                j += 1
        i += 1
    return flags, texts, None


async def handle_history(
    registry: MountRegistry,
    args: list[str],
    session: SessionState,
) -> Result:
    """GNU's history builtin over the workspace's recorder.

    GNU lookup order: builtins resolve before mount commands, so a
    mount-local command named "history" can never shadow this one.
    -a/-r/-w/-n are accepted no-ops: bash uses them to sync the
    in-memory list with the histfile, but here both are the same
    store and always in sync. -p prints its args verbatim (mirage's
    shell has no `!` history expansion, so every word is its own
    expansion); unlike bash, the `history -p` invocation itself is
    still recorded, because the recorder is also the audit log.
    When -s and -p are combined, -s wins and nothing is printed
    (bash-verified for both -ps and -sp).

    Args:
        registry (MountRegistry): The workspace's mount registry, which
            carries its recorder.
        args (list[str]): Raw builtin args (flags and counts).
        session (SessionState): Calling session.
    """
    flags, texts, error = _parse_args(args)
    if error is not None:
        return _result(None, 2, encode_text(error + _USAGE))
    if not flags and len(texts) > 1:
        # bash abandons everything still to run, as `exit 1 2` does;
        # `-p` and `-s` take any number of words.
        raise ExitSignal(1, stderr=b"bash: history: too many arguments\n")
    observer = registry.observer
    if observer is None:
        return _result(
            None, 1, b"bash: history: not enabled for this workspace\n"
        )
    fl = FlagView(flags, spec=SPECS["history"])
    c = fl.as_bool("c")
    d = fl.as_str("d")
    s = fl.as_bool("s")
    p = fl.as_bool("p")
    sid = session.session_id
    if c:
        await observer.log_clear(session=sid)
    if d is not None:
        try:
            offset = int(d)
        except ValueError:
            return _out_of_range(d)
        visible = await observer.session_command_events(sid)
        idx = offset - 1 if offset > 0 else len(visible) + offset
        if not 0 <= idx < len(visible):
            return _out_of_range(d)
        await observer.log_delete(session=sid, offset=offset)
    if s and texts:
        await observer.log_command_text(
            " ".join(texts), session=sid, cwd=session.cwd
        )
    if p and not s:
        return _result(encode_text("\n".join(texts) + "\n" if texts else ""))
    if (
        c
        or d is not None
        or s
        or fl.as_bool("a")
        or fl.as_bool("r")
        or fl.as_bool("w")
        or fl.as_bool("n")
    ):
        return _result(None)
    count = None
    if texts:
        try:
            count = int(texts[0])
        except ValueError:
            err = f"bash: history: {texts[0]}: numeric argument required\n"
            return _result(None, 1, encode_text(err))
    events = await observer.session_command_events(sid)
    return _result(encode_text(render_history_listing(events, n=count)))


async def history_builtin(call: BuiltinCall) -> Result:
    """The ``history`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_history(
        call.registry, list(call.argv.args), call.context.session
    )

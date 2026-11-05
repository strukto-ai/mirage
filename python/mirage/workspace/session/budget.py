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

from collections.abc import Awaitable, Iterable
from contextvars import ContextVar
from typing import TypeVar

from mirage.shell.bytes import encode_text
from mirage.shell.errors import ExitSignal
from mirage.shell.variable import ShellValue
from mirage.utils.sanitize import byte_length
from mirage.workspace.session.constants import ENV_EXHAUSTED_STATUS
from mirage.workspace.session.session import SessionState

T = TypeVar("T")

# The running workspace's max_env, None outside a line or for no cap.
_limits: ContextVar[int | None] = ContextVar("mirage_env_limit", default=None)


async def run_with_env_limit(limit: int | None, call: Awaitable[T]) -> T:
    """``call`` awaited under a workspace's max_env, which every write to
    a session's shell state is checked against. Mirrors TypeScript's
    ``runWithEnvLimit``.

    Args:
        limit (int | None): the workspace's max_env in bytes, None for no
            cap.
        call (Awaitable[T]): the line.
    """
    token = _limits.set(limit)
    try:
        return await call
    finally:
        _limits.reset(token)


def _env_limit() -> int | None:
    """The running workspace's max_env, None for no cap."""
    return _limits.get()


def entry_bytes(name: str, value: ShellValue | None) -> int:
    """The bytes one name and its value hold: a variable, a function and
    its body, or an alias and its text.

    Args:
        name (str): the name.
        value (ShellValue | None): the value, None for none.
    """
    if value is None:
        held = 0
    elif isinstance(value, str):
        held = byte_length(value)
    elif isinstance(value, dict):
        held = sum(byte_length(k) + byte_length(v) for k, v in value.items())
    else:
        held = sum(byte_length(v) for v in value if v is not None)
    return byte_length(name) + held


def args_bytes(args: Iterable[str]) -> int:
    """The bytes a list of positional parameters holds.

    Args:
        args (Iterable[str]): the parameters.
    """
    return sum(byte_length(arg) for arg in args)


def env_bytes(session: SessionState) -> int:
    """The bytes a session's shell state holds: its variables, functions,
    aliases and positional parameters, names and values.

    Args:
        session (SessionState): the session.
    """
    return (
        sum(entry_bytes(n, var.value) for n, var in session.vars.items())
        + sum(entry_bytes(n, body) for n, body in session.functions.items())
        + sum(entry_bytes(n, text) for n, text in session.aliases.items())
        + args_bytes(session.positional_args)
    )


def check_env(session: SessionState, before: int, after: int) -> None:
    """Refuse a write that grows a session's shell state past max_env.

    Bash fails as it does when it cannot allocate, a fatal error, and the
    message says the bound is a setting, so an agent does not take it for
    a broken shell. A write that does not grow passes unchecked.

    Args:
        session (SessionState): the session written.
        before (int): the bytes the entry held before the write.
        after (int): the bytes it holds after.

    Raises:
        ExitSignal: the write would pass max_env.
    """
    limit = _env_limit()
    if limit is None or after <= before:
        return
    if env_bytes(session) - before + after > limit:
        raise ExitSignal(
            ENV_EXHAUSTED_STATUS,
            stderr=encode_text(
                f"bash: xmalloc: cannot allocate {after} bytes (past "
                f"max_env of {limit} bytes, a mirage workspace setting)\n"
            ),
        )

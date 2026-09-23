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

import shlex
from collections.abc import Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.workspace.executor.builtins.script.bash import handle_bash
from mirage.workspace.executor.builtins.script.script import (read_script_text,
                                                              script_error)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def _env_split_string(words: list[str]) -> list[str]:
    """Consume env's ``-S``/``--split-string`` option on a shebang line.

    GNU env documents ``-S`` as the facility for passing an interpreter
    plus options through a shebang (the kernel hands env everything
    after it as one argument, and ``-S`` re-splits it), so the option
    is spelling, not a word: ``-S bash -x``, ``-Sbash -x`` and
    ``--split-string=bash -x`` all name bash. The line is already
    whitespace-split here, so consuming the option is all that is left.

    Args:
        words (list[str]): the words after env on a shebang line.
    """
    if not words:
        return words
    head = words[0]
    if head in ("-S", "--split-string"):
        return words[1:]
    if head.startswith("--split-string="):
        head = head[len("--split-string="):]
    elif head.startswith("-S"):
        head = head[2:]
    else:
        return words
    return [head, *words[1:]] if head else words[1:]


def shebang_words(script: str) -> list[str]:
    """The interpreter words a script's first line names, env resolved.

    Args:
        script (str): the script text.
    """
    first = script.split("\n", 1)[0]
    if not first.startswith("#!"):
        return []
    words = first[2:].strip().split()
    if words and words[0].rsplit("/", 1)[-1] == "env":
        words = _env_split_string(words[1:])
    if words:
        words[0] = words[0].rsplit("/", 1)[-1]
    return words


async def handle_exec_path(
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    path: str,
    args: list[str],
    session: SessionState,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a slash-carrying head word as a program, bash's loader rule.

    bash hands a word containing a slash straight to the loader: no
    builtin, function, or install can claim it, and the file either
    runs or the shell reports why not. Two deliberate divergences from
    bash, both consequences of the VFS: there is no exec bit to check
    (``chmod`` is stored, not enforced; mount mode does real access
    control), so an existing file runs without ``+x``; and the shell
    prefix bash puts on the diagnostic is dropped, matching every other
    mirage diagnostic.

    A shebang naming sh or bash (directly or via env) runs through the
    nested-shell machinery, as does a script with none. Any other
    interpreter word is re-dispatched as a command line, so
    ``#!/usr/bin/env python3`` reaches the python3 command wherever the
    workspace routes it, and an interpreter nobody registers answers
    with its own "command not found".

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        execute_fn (Callable): runs a program line in this session.
        path (str): the head word, as typed.
        args (list[str]): the words after it, positional for the script.
        session (SessionState): shell session state.
        stdin (ByteSource | None): input stream for the script.
    """
    try:
        script = await read_script_text(dispatch, path, session.cwd)
    except FS_ERRORS as exc:
        strerror = fs_strerror(exc)
        if strerror is None:
            raise
        code = 127 if isinstance(exc, FileNotFoundError) else 126
        return script_error(path, strerror, code)
    words = shebang_words(script)
    interp = words[0] if words else "sh"
    if interp in ("sh", "bash"):
        return await handle_bash(dispatch, execute_fn,
                                 [*words[1:], path, *args], session, stdin,
                                 interp)
    line = shlex.join([*words, path, *args])
    io = await execute_fn(line, session_id=session.session_id, stdin=stdin)
    return io.stdout, io, ExecutionNode(command=f"{path} " +
                                        " ".join(args) if args else path,
                                        exit_code=io.exit_code)

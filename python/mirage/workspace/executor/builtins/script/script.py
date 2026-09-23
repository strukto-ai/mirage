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
from mirage.io.stream import materialize
from mirage.runtime.types import DispatchFn
from mirage.types import FileType
from mirage.utils.errors import FS_ERRORS, eisdir, fs_strerror
from mirage.utils.path import resolve_path
from mirage.workspace.executor.builtins.links import resolve_path_stat
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def script_error(
        prefix: str,
        message: str,
        code: int,
        command: str | None = None) -> tuple[None, IOResult, ExecutionNode]:
    """A diagnostic from a shell that never got as far as running.

    ``prefix`` and ``command`` come apart because bash reports itself by
    ``argv[0]``, which for a script operand is the operand: the recorded
    command still has to be the builtin that ran, not a file path.

    Args:
        prefix (str): what the line reports itself as, before the colon.
        message (str): the rest of the line, without the newline.
        code (int): the exit status.
        command (str | None): what to record the failure under, when
            that is not the prefix.
    """
    err = f"{prefix}: {message}\n".encode()
    return None, IOResult(exit_code=code,
                          stderr=err), ExecutionNode(command=command or prefix,
                                                     exit_code=code,
                                                     stderr=err)


async def read_script_text(dispatch: DispatchFn, path: str, cwd: str) -> str:
    """Read a script file through the op dispatcher.

    Every way of running a script off a mount comes through here, so a
    backend quirk is answered once rather than per caller. The one
    answered today is a directory, which only a real filesystem reports
    as EISDIR on read: a keyed backend has no directory object to open
    and answers ENOENT, ssh's raw error carries no errno, and WebDAV
    serves the collection's HTML listing as bytes, which a loader that
    read first would then run as a script. So the stat probe runs
    before the read, and asks both channels a backend can answer on,
    since on a prefix store a directory is the set of keys under it
    rather than an object. A stat miss alone proves nothing (absence
    takes two channels), so only a positive directory answer is acted
    on and the read still owns "no such file".

    The caller owns the diagnostic: `source` and a nested shell word
    the same failure differently and exit differently on it.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        path (str): the script operand, as typed.
        cwd (str): working directory a relative operand resolves against.
    """
    scope = _to_scope(resolve_path(path, cwd))
    stat = await resolve_path_stat(dispatch, scope)
    if stat is not None and stat.type == FileType.DIRECTORY:
        raise eisdir(path)
    data, _ = await dispatch("read", scope)
    if isinstance(data, bytes):
        return data.decode(errors="replace")
    if data is None:
        return ""
    return (await materialize(data)).decode(errors="replace")


async def read_script_file(
    dispatch: DispatchFn,
    name: str,
    path: str,
    session: SessionState,
) -> tuple[str, None] | tuple[None, tuple[None, IOResult, ExecutionNode]]:
    """Read a script file operand, or the failure bash reports for it.

    GNU splits the diagnostics by how far startup got, and both halves
    fall out of the errno rather than being listed case by case. A file
    the shell cannot open at all is blamed on the shell, and only a
    missing one is exit 127 (``bash: run.sh: No such file or directory``);
    anything it found but could not run is 126 (``Permission denied``,
    ``Not a directory``). A directory is the exception, because it opens
    fine and fails on the first read, by which point ``$0`` is already the
    operand, so bash prints it twice (``/tmp: /tmp: Is a directory``, exit
    126). Reproduced rather than tidied up: it is what an agent copying a
    message into a search box will find.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        name (str): the head word, used as the diagnostic prefix.
        path (str): the script operand, as typed.
        session (SessionState): shell session state, for the working directory.
    """
    try:
        return await read_script_text(dispatch, path, session.cwd), None
    except FS_ERRORS as exc:
        strerror = fs_strerror(exc)
        if isinstance(exc, IsADirectoryError):
            return None, script_error(path,
                                      f"{path}: {strerror}",
                                      126,
                                      command=name)
        code = 127 if isinstance(exc, FileNotFoundError) else 126
        return None, script_error(name, f"{path}: {strerror}", code)

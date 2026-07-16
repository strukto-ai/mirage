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

from mirage.accessor.history import HistoryAccessor
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.history.render import render_history_listing
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _out_of_range(value: str) -> IOResult:
    err = f"history: {value}: history position out of range\n".encode()
    return IOResult(exit_code=1, stderr=err)


@command("history", resource="history", spec=SPECS["history"])
async def history_cmd(
    accessor: HistoryAccessor,
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    c: bool = False,
    d: str | None = None,
    s: bool = False,
    p: bool = False,
    a: bool = False,
    r: bool = False,
    w: bool = False,
    n: bool = False,
    session_id: str | None = None,
    cwd: PathSpec | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    """GNU history builtin over the recorder.

    -a/-r/-w/-n are accepted no-ops: bash uses them to sync the
    in-memory list with the histfile, but here both are the same
    store and always in sync. -p prints its args verbatim (mirage's
    shell has no `!` history expansion, so every word is its own
    expansion); unlike bash, the `history -p` invocation itself is
    still recorded, because the recorder is also the audit log.
    When -s and -p are combined, -s wins and nothing is printed
    (bash-verified for both -ps and -sp).
    """
    observer = accessor.observer
    if session_id is None:
        raise ValueError("history requires the caller's session id")
    session = session_id
    if c:
        await observer.log_clear(session=session)
    if d is not None:
        try:
            offset = int(d)
        except ValueError:
            return None, _out_of_range(d)
        visible = await observer.session_command_events(session)
        idx = offset - 1 if offset > 0 else len(visible) + offset
        if not 0 <= idx < len(visible):
            return None, _out_of_range(d)
        await observer.log_delete(session=session, offset=offset)
    if s and texts:
        await observer.log_command_text(
            " ".join(texts),
            session=session,
            cwd=cwd.virtual if cwd is not None else None)
    if p and not s:
        out = "\n".join(texts) + "\n" if texts else ""
        return out.encode(), IOResult()
    if c or d is not None or s or a or r or w or n:
        return None, IOResult()
    if len(texts) > 1:
        err = b"history: too many arguments\n"
        return None, IOResult(exit_code=1, stderr=err)
    count = None
    if texts:
        try:
            count = int(texts[0])
        except ValueError:
            err = f"history: {texts[0]}: numeric argument required\n".encode()
            return None, IOResult(exit_code=1, stderr=err)
    events = await observer.session_command_events(session)
    output = render_history_listing(events, n=count)
    return output.encode(), IOResult()

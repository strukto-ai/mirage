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

from collections.abc import Awaitable, Callable
from typing import Any

from mirage.context import reset_current_session, set_current_session
from mirage.nfs.delegate import MirageNFS
from mirage.workspace.session.session import Session

BOUND_METHODS: tuple[str, ...] = (
    "lookup",
    "getattr",
    "read",
    "write",
    "create",
    "create_exclusive",
    "mkdir",
    "remove",
    "rename",
    "setattr",
    "set_size",
    "symlink",
    "readlink",
    "readdir",
    "flush",
    "flush_all",
    "flush_idle",
)

BoundCall = Callable[..., Awaitable[Any]]


class SessionBoundNFS:
    """A delegate whose every call runs under one session's grants.

    The wrap is at the boundary the server calls, not at each op inside
    the adapter. That is the difference between a narrowing and a hole:
    an adapter that binds sixteen of seventeen op call sites still
    serves the seventeenth with the workspace's full reach, and nothing
    about the missing one looks wrong at the call site. Wrapping the
    entry points instead means the set is one list, and
    ``tests/nfs/test_session.py`` fails if the adapter grows a method
    the list does not name.

    The context is set *inside* the coroutine so it lands on the task
    that executes the op, the way ``MountCore`` binds a session-scoped
    FUSE mount and the way ``execute`` brackets a shell command.

    Args:
        inner (MirageNFS): the adapter to scope.
        session (Session): the session whose mount grants apply.
    """

    # Declared rather than defined: the bodies are installed in
    # __init__ from BOUND_METHODS, and without these a caller reading
    # `delegate.flush_all` has no type to read. The meta-test pins the
    # two lists against each other, so a method can neither be bound
    # without being declared nor declared without being bound.
    lookup: BoundCall
    getattr: BoundCall
    read: BoundCall
    write: BoundCall
    create: BoundCall
    create_exclusive: BoundCall
    mkdir: BoundCall
    remove: BoundCall
    rename: BoundCall
    setattr: BoundCall
    set_size: BoundCall
    symlink: BoundCall
    readlink: BoundCall
    readdir: BoundCall
    flush: BoundCall
    flush_all: BoundCall
    flush_idle: BoundCall

    def __init__(self, inner: MirageNFS, session: Session) -> None:
        self._inner = inner
        self._session = session
        for name in BOUND_METHODS:
            setattr(self, name, self._bind(getattr(inner, name)))

    def root_dir(self) -> int:
        """The root's file id. Reads no op, so it needs no binding."""
        return self._inner.root_dir()

    def _bind(
        self,
        method: Callable[...,
                         Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        """Wrap one delegate method in the session context.

        Args:
            method (Callable): the adapter method to wrap.

        Returns:
            Callable: the same call, run under the session.
        """

        async def bound(*args: Any, **kwargs: Any) -> Any:
            token = set_current_session(self._session)
            try:
                return await method(*args, **kwargs)
            finally:
                reset_current_session(token)

        return bound


def scoped(inner: MirageNFS, session: Session | None) -> "NFSDelegate":
    """The delegate to serve, scoped when a session was given.

    Args:
        inner (MirageNFS): the adapter to serve.
        session (Session | None): the session to scope to, or None for
            an unscoped mount.

    Returns:
        NFSDelegate: what the server should call.
    """
    return inner if session is None else SessionBoundNFS(inner, session)


# What a server calls: the adapter itself, or the adapter behind one
# session's grants. Both answer the trait and both flush on teardown.
NFSDelegate = MirageNFS | SessionBoundNFS

from typing import Any

from mirage.workspace.frame import ExecutionFrame
from mirage.workspace.frame import persistent_session as persistent_session
from mirage.workspace.session.session import SessionState

_FIELDS = {
    "_diagnostics": "diagnostics",
    "_cmdsub_seq": "cmdsub_seq",
    "_cmdsub_status": "cmdsub_status",
}


class EvaluationSession(SessionState):
    """An explicit view forwarding durable writes to its calling shell."""

    def __init__(self, state: SessionState, frame: ExecutionFrame) -> None:
        self.__dict__["_state"] = state
        self.__dict__["_frame"] = frame

    def __getattribute__(self, name: str) -> Any:
        if name in {"__dict__", "_state", "_frame", "fork", "__class__"}:
            return super().__getattribute__(name)
        frame_field = _FIELDS.get(name)
        if frame_field is not None:
            return getattr(self._frame, frame_field)
        return getattr(self._state, name)

    def __setattr__(self, name: str, value: Any) -> None:
        frame_field = _FIELDS.get(name)
        if frame_field is not None:
            setattr(self._frame, frame_field, value)
        else:
            setattr(self._state, name, value)

    def fork(self, **overrides: Any) -> SessionState:
        return execution_session(
            self._state.fork(**overrides), self._frame.fork()
        )


def execution_session(
    session: SessionState, frame: ExecutionFrame | None = None
) -> SessionState:
    if isinstance(session, EvaluationSession):
        if frame is None:
            return session
        session = session._state
    return EvaluationSession(session, frame or ExecutionFrame())


def child_session(parent: SessionState) -> SessionState:
    child = execution_session(parent.fork())
    if isinstance(child, EvaluationSession):
        child._frame.parent = parent
    child._parse_seq = parent._parse_seq
    child._parse_current = parent._parse_current
    child._alias_marks = dict(parent._alias_marks)
    child._alias_stack = list(parent._alias_stack)
    child._local_vars = (
        None if parent._local_vars is None else dict(parent._local_vars)
    )
    child._local_frames = [dict(frame) for frame in parent._local_frames]
    child._local_random = list(parent._local_random)
    return child

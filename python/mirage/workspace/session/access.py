from mirage.context.session_context import DEFAULT_UMASK
from mirage.context.types import IOContext
from mirage.observe.context import Recorder
from mirage.policy.policies import Policies
from mirage.types import DEFAULT_VISIBILITY, EntryGate
from mirage.workspace.session.session import SessionState


def io_context(
    session: SessionState | None,
    admission: EntryGate | None = None,
    policies: Policies | None = None,
    recorder: Recorder | None = None,
) -> IOContext:
    """Capture a caller's access facts before starting asynchronous I/O.

    Args:
        session (SessionState | None): the shell, absent for a direct mount call.
        admission (EntryGate | None): this command's admitted path rules.
        policies (Policies | None): the workspace's coded policies.
        recorder (Recorder | None): the invocation's observer recording.
    """
    return IOContext(
        session.session_id if session is not None else "",
        session.visibility if session is not None else DEFAULT_VISIBILITY,
        session.mount_modes if session is not None else None,
        session.umask if session is not None else DEFAULT_UMASK,
        bool(session.shopts.get("dotglob")) if session is not None else False,
        admission,
        recorder=recorder,
        policies=policies,
    )

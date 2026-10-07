from mirage.context.types import IOContext
from mirage.observe.context import Recorder
from mirage.policy.policies import Policies
from mirage.types import EntryGate
from mirage.workspace.session.session import SessionState


def io_context(
    session: SessionState,
    admission: EntryGate | None = None,
    policies: Policies | None = None,
    recorder: Recorder | None = None,
) -> IOContext:
    """Capture a caller's access facts before starting asynchronous I/O.

    Args:
        session (SessionState): the shell performing the operation.
        admission (EntryGate | None): this command's admitted path rules.
        policies (Policies | None): the workspace's coded policies.
    """
    return IOContext(
        session.session_id,
        session.visibility,
        session.mount_modes,
        session.umask,
        bool(session.shopts.get("dotglob")),
        admission,
        recorder=recorder,
        policies=policies,
    )

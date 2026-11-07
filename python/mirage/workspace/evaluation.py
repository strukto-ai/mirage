from dataclasses import dataclass, field

from mirage.rs.session import ShellVars
from mirage.workspace.frame import ExecutionFrame
from mirage.workspace.session.session import SessionState


@dataclass(frozen=True, slots=True, eq=False)
class EvaluationContext:
    """One evaluator's state, separate from the session stored by its manager.

    Two contexts are the same evaluation only if they are one object, as in
    TypeScript.
    """

    session: SessionState
    frame: ExecutionFrame = field(default_factory=ExecutionFrame)
    parent: "EvaluationContext | None" = None

    def fork(self) -> "EvaluationContext":
        """An evaluation on a fork of this session: a job or a stage.

        Args:
            None
        """
        return EvaluationContext(self.session.fork(), self.frame.fork(), self)


def child_context(
    context: EvaluationContext, records: ShellVars | None = None
) -> EvaluationContext:
    """A child shell's evaluation: the session's subshell and a new frame.

    Args:
        context (EvaluationContext): the parent shell's evaluation.
        records (ShellVars | None): the child's variables when a running
            expansion made them; None copies the session's.
    """
    return EvaluationContext(
        context.session.subshell(records), context.frame.fork(), context
    )

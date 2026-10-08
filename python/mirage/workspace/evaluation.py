from dataclasses import dataclass, field

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


def child_context(context: EvaluationContext) -> EvaluationContext:
    """A child shell's evaluation: the session's subshell and a new frame.

    Args:
        context (EvaluationContext): the parent shell's evaluation.
    """
    return EvaluationContext(
        context.session.subshell(), context.frame.fork(), context
    )

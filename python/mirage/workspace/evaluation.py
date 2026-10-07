from contextvars import Token
from dataclasses import dataclass, field
from typing import Any

from mirage.context.session_context import (
    bound_evaluation,
    reset_current_session,
    set_current_session,
)
from mirage.workspace.frame import ExecutionFrame
from mirage.workspace.session.manager import SessionManager
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


def set_current_evaluation(
    context: EvaluationContext, owner: SessionManager | None = None
) -> Token[Any]:
    """Bind an evaluation with its session, as one binding.

    Args:
        context (EvaluationContext): the evaluator entering this task.
        owner (SessionManager | None): the workspace owner; inherited if omitted.
    """
    return set_current_session(context.session, owner, evaluation=context)


def reset_current_evaluation(token: Token[Any]) -> None:
    """Restore the binding ``set_current_evaluation`` replaced.

    Args:
        token (Token[Any]): what ``set_current_evaluation`` returned.
    """
    reset_current_session(token)


def get_current_evaluation() -> EvaluationContext | None:
    return bound_evaluation()


def child_context(context: EvaluationContext) -> EvaluationContext:
    """A child shell's evaluation: the session's subshell and a new frame.

    Args:
        context (EvaluationContext): the parent shell's evaluation.
    """
    return EvaluationContext(
        context.session.subshell(), context.frame.fork(), context
    )

from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any

from mirage.context.session_context import (
    reset_current_session,
    set_current_session,
)
from mirage.types import EntryGate
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
    admission: EntryGate | None = None

    def fork(self) -> "EvaluationContext":
        """An evaluation on a fork of this session: a job or a stage.

        Args:
            None
        """
        return EvaluationContext(self.session.fork(), self.frame.fork(), self)


_current: ContextVar[EvaluationContext | None] = ContextVar(
    "mirage_evaluation", default=None
)


def set_current_evaluation(
    context: EvaluationContext, owner: SessionManager | None = None
) -> tuple[Token[Any], Token[EvaluationContext | None]]:
    """Bind evaluation and session scopes together.

    Args:
        context (EvaluationContext): the evaluator entering this task.
        owner (SessionManager | None): the workspace owner; inherited if omitted.
    """
    ancestors = []
    parent = context.parent
    while parent is not None:
        ancestors.append(parent.session)
        parent = parent.parent
    session_token = set_current_session(
        context.session, owner, ancestors=tuple(ancestors)
    )
    return session_token, _current.set(context)


def reset_current_evaluation(
    tokens: tuple[Token[Any], Token[EvaluationContext | None]],
) -> None:
    """Restore the evaluation and session scopes ``set_current_evaluation``
    replaced.

    Args:
        tokens (tuple[Token[Any], Token[EvaluationContext | None]]): what
            ``set_current_evaluation`` returned.
    """
    session_token, evaluation_token = tokens
    _current.reset(evaluation_token)
    reset_current_session(session_token)


def get_current_evaluation() -> EvaluationContext | None:
    return _current.get()


def child_context(context: EvaluationContext) -> EvaluationContext:
    """A child shell's evaluation: the session's subshell and a new frame.

    Args:
        context (EvaluationContext): the parent shell's evaluation.
    """
    return EvaluationContext(
        context.session.subshell(), context.frame.fork(), context
    )

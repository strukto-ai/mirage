from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any

from mirage.context.session_context import (
    reset_current_session,
    set_current_session,
)
from mirage.shell.constants import RANDOM, RANDOM_UNSET
from mirage.shell.variable import ShellVar, copy_var
from mirage.workspace.frame import ExecutionFrame
from mirage.workspace.session.manager import SessionManager
from mirage.workspace.session.session import SessionState


@dataclass(frozen=True, slots=True)
class EvaluationContext:
    """One evaluator's state, separate from the session stored by its manager."""

    session: SessionState
    frame: ExecutionFrame = field(default_factory=ExecutionFrame)
    parent: "EvaluationContext | None" = None

    def fork(self, **overrides: Any) -> "EvaluationContext":
        return EvaluationContext(
            self.session.fork(**overrides), self.frame.fork(), self
        )


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
    session_token, evaluation_token = tokens
    _current.reset(evaluation_token)
    reset_current_session(session_token)


def get_current_evaluation() -> EvaluationContext | None:
    return _current.get()


def child_context(context: EvaluationContext) -> EvaluationContext:
    result = context.fork()
    parent, child = context.session, result.session
    child._parse_seq = parent._parse_seq
    child._parse_current = parent._parse_current
    child._alias_marks = dict(parent._alias_marks)
    child._alias_stack = list(parent._alias_stack)
    child._local_vars = (
        None if parent._local_vars is None else copy_locals(parent._local_vars)
    )
    child._local_frames = [
        child._local_vars
        if frame is parent._local_vars and child._local_vars is not None
        else copy_locals(frame)
        for frame in parent._local_frames
    ]
    child._local_random = list(parent._local_random)
    # The child reseeds on its first draw instead of replaying the parent's seed.
    if child._random_seed != RANDOM_UNSET:
        var = parent.vars.get(RANDOM)
        child._random_seed = (
            var.value
            if var is not None and isinstance(var.value, str)
            else None
        )
    return result


def copy_locals(
    frame: dict[str, ShellVar | None],
) -> dict[str, ShellVar | None]:
    """Copy saved locals into child-owned frames.

    Temporary call environments become ordinary saved scopes in the child.

    Args:
        frame (dict[str, ShellVar | None]): the parent's saved variables.
    """
    return {
        name: None if var is None else copy_var(var)
        for name, var in frame.items()
    }

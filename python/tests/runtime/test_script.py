import asyncio

import pytest

from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.script import CTX_GLOBAL, eval_with_ctx, script_engine
from mirage.runtime.types import EvalResult, EvalValue, ScriptSource


class Recorder(EvaluatorMixin):
    """Records the globals a script would have been shown."""

    def __init__(
        self,
        value: EvalValue = None,
        delay: float = 0.0,
        error: Exception | None = None,
    ) -> None:
        self.value = value
        self.delay = delay
        self.error = error
        self.inputs: dict[str, EvalValue] = {}

    async def eval(
        self,
        code: str,
        *,
        inputs: dict[str, EvalValue] | None = None,
        session: str | None = None,
    ) -> EvalResult:
        self.inputs = dict(inputs or {})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return EvalResult(value=self.value)


@pytest.mark.asyncio
async def test_the_payload_arrives_as_one_global_named_ctx():
    # The convention every config script speaks. Spreading the payload's
    # keys instead put `profile` in scope on one host and nothing on the
    # other, which no test using a fake evaluator could see.
    engine = Recorder("ok")
    await eval_with_ctx("...", {"profile": "release"}, engine, 1.0)
    assert engine.inputs == {"ctx": {"profile": "release"}}
    assert CTX_GLOBAL == "ctx"


@pytest.mark.asyncio
async def test_it_answers_with_the_scripts_last_expression():
    assert await eval_with_ctx("...", {}, Recorder({"a": 1}), 1.0) == {"a": 1}


@pytest.mark.asyncio
async def test_a_timeout_reaches_the_caller_unworded():
    # Each caller refuses in its own voice and its own error type, so
    # this raises the bare asyncio error rather than either layer's.
    with pytest.raises(asyncio.TimeoutError):
        await eval_with_ctx("...", {}, Recorder("ok", delay=0.2), 0.01)


@pytest.mark.asyncio
async def test_an_eval_failure_reaches_the_caller_unworded():
    with pytest.raises(EvalError):
        await eval_with_ctx("...", {}, Recorder(error=EvalError("boom")), 1.0)


def test_script_engine_builds_the_named_runtime():
    engine = script_engine(ScriptSource("..."), "monty")
    assert engine.name == "monty"
    assert isinstance(engine, EvaluatorMixin)


# The wrong language is answered from the table before building, so a
# config naming the wrong engine reads as that, not as the engine's
# install hint.
@pytest.mark.parametrize(
    ("runtime", "refusal"),
    [
        ("local", "cannot evaluate one"),
        ("sandlock", "cannot evaluate one"),
        ("wasi", "cannot evaluate one"),
        ("nope", "unknown runtime"),
        ("quickjs", "python, but names runtime"),
    ],
)
def test_script_engine_refuses_a_runtime_it_cannot_use(runtime, refusal):
    with pytest.raises(ValueError, match=refusal):
        script_engine(ScriptSource("..."), runtime)

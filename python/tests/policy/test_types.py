import pytest
from pydantic import ValidationError

from mirage.policy.types import Answer


def test_an_answer_is_its_kind_and_its_own_fields():
    assert Answer.model_validate({"kind": "deny", "reason": "no"}) == Answer(
        kind="deny", reason="no"
    )
    assert Answer.model_validate({"kind": "ask"}).reason is None
    assert (
        Answer.model_validate({"kind": "route", "machine": "docker"}).machine
        == "docker"
    )
    assert Answer.model_validate(
        {"kind": "route", "machine": "docker", "reason": "x"}
    ) == Answer(kind="route", machine="docker", reason="x")


@pytest.mark.parametrize(
    "data",
    [
        {"kind": "allow"},
        {"kind": "route"},
        {"kind": "deny", "machine": "docker"},
        {"kind": "route", "runtime": "docker"},
        {"kind": "ask", "policy": "Mine"},
        {"deny": "x"},
    ],
)
def test_any_other_shape_is_refused(data):
    with pytest.raises(ValidationError):
        Answer.model_validate(data)

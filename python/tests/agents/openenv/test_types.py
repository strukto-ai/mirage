import pytest

pytest.importorskip("openenv")

from pydantic import ValidationError

from mirage.agents.openenv.types import (
    MirageAction,
    MirageObservation,
    Refusal,
)


def test_an_action_is_a_shell_line_by_default():
    action = MirageAction(arguments={"command": "ls /"})

    assert action.tool == "shell"
    assert action.arguments == {"command": "ls /"}


def test_arguments_are_checked_against_the_tools_schema():
    with pytest.raises(ValidationError, match="'path' is a required"):
        MirageAction(tool="read", arguments={"command": "ls"})
    with pytest.raises(ValidationError, match="'command' is a required"):
        MirageAction.model_validate({"tool": "shell", "arguments": {}})


def test_an_unknown_tool_or_field_is_refused():
    with pytest.raises(ValidationError):
        MirageAction.model_validate({"tool": "rm", "arguments": {}})
    with pytest.raises(ValidationError):
        MirageAction.model_validate(
            {"arguments": {"command": "ls"}, "cwd": "/"}
        )


def test_an_observation_round_trips_through_json():
    observation = MirageObservation(
        tool="shell",
        stderr="rm: Permission denied\n",
        exit_code=1,
        refusal=Refusal(kind="deny", reason="rm is not allowed"),
    )

    again = MirageObservation.model_validate_json(
        observation.model_dump_json()
    )

    assert again == observation

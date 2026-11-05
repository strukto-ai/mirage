import pytest
from pydantic import ValidationError

from mirage.process.config import MAX_PROCESSES, ProcessPermissions, nearer


def block(doc: object) -> ProcessPermissions:
    return ProcessPermissions.model_validate(doc)


def test_an_unstated_block_caps_at_max_processes():
    assert ProcessPermissions() == ProcessPermissions(
        list="session", kill="session", max=MAX_PROCESSES
    )
    assert block({"max": None}).max is None


def test_layered_takes_each_field_from_the_nearest_block_that_states_it():
    workspace = block({"list": "workspace", "kill": "workspace", "max": 4})
    assert ProcessPermissions.layered((block({"max": 9}), workspace)) == (
        block({"list": "workspace", "kill": "workspace", "max": 9})
    )
    assert ProcessPermissions.layered((None, workspace)) == workspace
    assert ProcessPermissions.layered(
        (block({"max": None}), workspace)
    ).max is (None)
    assert ProcessPermissions.layered((None, None)) == ProcessPermissions()


def test_layered_keeps_an_inherited_kill_within_the_list_above_it():
    layered = ProcessPermissions.layered(
        (block({"list": "session"}), block("workspace"))
    )
    assert (layered.list, layered.kill) == ("session", "session")


def test_restrict_narrows_only_the_fields_the_inline_block_states():
    own = block({"list": "workspace", "kill": "workspace", "max": 9})
    assert own.restrict(block({"max": 2})) == block(
        {"list": "workspace", "kill": "workspace", "max": 2}
    )
    assert own.restrict(block({"list": "session"})) == block({"max": 9})
    assert block({"max": None}).restrict(block({"max": 5})).max == 5


def test_one_block_still_refuses_a_kill_past_its_own_list():
    with pytest.raises(ValidationError):
        block({"list": "session", "kill": "workspace"})


def test_nearer_is_the_narrower_scope():
    assert nearer("workspace", "session") == "session"
    assert nearer("workspace", "workspace") == "workspace"

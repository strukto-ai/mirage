import pytest
from pydantic import SecretStr, ValidationError

from mirage.vfs.mem0.config import Mem0Config


def test_scope_filter_user():
    cfg = Mem0Config(api_key=SecretStr("k"), user_id="alex")
    assert cfg.scope_filter == {"user_id": "alex"}
    assert cfg.scope_kind == "user"


def test_scope_filter_agent():
    cfg = Mem0Config(api_key=SecretStr("k"), agent_id="routine_agent")
    assert cfg.scope_filter == {"agent_id": "routine_agent"}
    assert cfg.scope_kind == "agent"


def test_requires_exactly_one_entity_none_set():
    with pytest.raises(ValidationError):
        Mem0Config(api_key=SecretStr("k"))


def test_requires_exactly_one_entity_two_set():
    with pytest.raises(ValidationError):
        Mem0Config(api_key=SecretStr("k"), user_id="a", agent_id="b")


def test_defaults():
    cfg = Mem0Config(api_key=SecretStr("k"), run_id="r")
    assert cfg.host == "https://api.mem0.ai"
    assert cfg.default_page_size == 100
    assert cfg.default_search_limit == 10
    assert cfg.scope_filter == {"run_id": "r"}

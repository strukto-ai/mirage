import pytest
from pydantic import ValidationError

from mirage.core.wandb.pathing import safe_name
from mirage.vfs.registry import build_vfs
from mirage.vfs.wandb import WandbConfig


@pytest.mark.parametrize("config", [{
    "entities": []
}, {
    "entities": ["a/b"]
}, {
    "entities": ["a"],
    "page_size": 0
}, {
    "entities": ["a"],
    "max_pages": 0
}, {
    "entities": ["a"],
    "typo": True
}])
def test_invalid_config(config: dict) -> None:
    with pytest.raises(ValidationError):
        WandbConfig(**config)


@pytest.mark.parametrize("name", [
    "", ".", "..", "\x00", "a\x00b", "a/b", "a\\b", "lab", ".lab", "a..b",
    "...", "café"
])
def test_entities_match_filesystem_names(name: str) -> None:
    if safe_name(name):
        assert WandbConfig(entities=[name]).entities == [name]
    else:
        with pytest.raises(ValidationError):
            WandbConfig(entities=[name])


def test_registry_redacts_key_and_has_no_mutations() -> None:
    vfs = build_vfs("wandb", {"entities": ["lab"], "api_key": "private-key"})
    assert vfs.name == "wandb"
    assert "private-key" not in str(vfs.get_state())
    assert not vfs.SIZES_ALWAYS_KNOWN

import pytest
from pydantic import ValidationError

from mirage import IOConfig


def test_defaults_and_frozen_buffer_limit():
    assert IOConfig().buffer_bytes == 65536
    config = IOConfig(buffer_bytes=262144)
    assert config.buffer_bytes == 262144
    with pytest.raises(ValidationError):
        config.buffer_bytes = 65536


@pytest.mark.parametrize(
    "value", [None, True, "65536", 65536.5, 0, 16383, 2**53]
)
def test_invalid_buffer_limits_are_rejected(value):
    with pytest.raises(ValidationError):
        IOConfig(buffer_bytes=value)


def test_unknown_knobs_are_rejected():
    with pytest.raises(ValidationError):
        IOConfig.model_validate({"chunk_bytes": 16384})

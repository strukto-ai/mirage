import pytest
from pydantic import ValidationError

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.api.client import stall_timeout
from mirage.vfs.databricks_volume import DatabricksVolumeConfig


def config(**kwargs) -> DatabricksVolumeConfig:
    return DatabricksVolumeConfig(
        catalog="main", schema="default", volume="agent_files", **kwargs
    )


def test_pool_is_lazy_and_uses_configured_timeout():
    accessor = DatabricksVolumeAccessor(
        config(host="https://example.com/", token="secret", timeout=17)
    )
    assert accessor.config.host == "https://example.com"
    assert accessor.pool._session is None
    assert accessor.pool._timeout == stall_timeout(17)


@pytest.mark.parametrize(
    "host",
    [
        "",
        "example.com",
        "file:///tmp/x",
        "https://u:p@example.com",
        "https://example.com/api",
        "https://example.com?",
        "https://example.com#",
        "https://example.com/?a=b",
        "https://example.com/#fragment",
        "https://example.com:invalid",
        "https://example.com\n",
        "https://example.com\\extra",
    ],
)
def test_rejects_non_origin_host(host):
    with pytest.raises(ValidationError):
        config(host=host, token="secret")


@pytest.mark.parametrize("token", ["", "  ", "secret\n", "secret\r"])
def test_rejects_unsafe_static_token_without_exposing_it(token):
    with pytest.raises(ValidationError) as error:
        config(host="https://example.com", token=token)
    assert "input_value" not in str(error.value)
    assert "secret" not in str(error.value)


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"host": "https://example.com"},
        {"token": "secret"},
        {
            "host": "https://example.com",
            "token": "secret",
            "profile": "DEFAULT",
        },
        {"host": "https://example.com", "token": "secret", "timeout": 0},
    ],
)
def test_requires_explicit_credentials_and_positive_timeout(kwargs):
    with pytest.raises(ValidationError):
        config(**kwargs)


@pytest.mark.parametrize(
    "host, normalized",
    [
        ("HTTPS://EXAMPLE.COM:443/", "https://example.com"),
        ("http://example.com:80", "http://example.com"),
        ("http://[::1]:8000/", "http://[::1]:8000"),
    ],
)
def test_normalizes_origin(host, normalized):
    assert config(host=host, token="secret").host == normalized

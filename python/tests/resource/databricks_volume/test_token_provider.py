import pytest

from mirage.core.databricks_volume.client import resolve_token
from mirage.resource.databricks_volume.token_provider import (
    StaticTokenProvider, TokenProvider)


class AsyncTokenProvider:

    def __init__(self, token: str) -> None:
        self.token = token

    async def get_token(self) -> str:
        return self.token


def test_static_provider_returns_the_token():
    assert StaticTokenProvider("dapi-123").get_token() == "dapi-123"


def test_the_protocol_accepts_a_sync_and_an_async_implementation():
    assert isinstance(StaticTokenProvider("x"), TokenProvider)
    assert isinstance(AsyncTokenProvider("x"), TokenProvider)


@pytest.mark.asyncio
async def test_resolve_token_awaits_an_async_provider():
    assert await resolve_token(AsyncTokenProvider("tok-async")) == "tok-async"


@pytest.mark.asyncio
async def test_resolve_token_returns_a_sync_providers_token():
    assert await resolve_token(StaticTokenProvider("tok")) == "tok"


@pytest.mark.asyncio
async def test_resolve_token_refuses_an_empty_token():
    with pytest.raises(ValueError, match="empty token"):
        await resolve_token(StaticTokenProvider(""))

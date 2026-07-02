import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.stream import range_read, read_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_CONTENT = ("https://graph.microsoft.com/v1.0/me/drive"
            "/root:/Docs/a.txt:/content")


@pytest.mark.asyncio
async def test_read_stream_yields_full_content():
    with aioresponses() as m:
        m.get(_CONTENT, body=b"abcdef")
        chunks = []
        async for chunk in read_stream(_accessor(),
                                       PathSpec.from_str_path("/Docs/a.txt")):
            chunks.append(chunk)
    assert b"".join(chunks) == b"abcdef"


@pytest.mark.asyncio
async def test_read_stream_missing_raises_file_not_found():
    with aioresponses() as m:
        m.get(_CONTENT,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        with pytest.raises(FileNotFoundError) as exc:
            async for _ in read_stream(
                    _accessor(),
                    PathSpec.from_str_path("/od/Docs/a.txt",
                                           mount_key("/od/Docs/a.txt",
                                                     "/od"))):
                pass
    assert str(exc.value) == "/od/Docs/a.txt"


@pytest.mark.asyncio
async def test_read_stream_refreshes_callable_token_on_401():
    calls = {"n": 0}

    def provider():
        calls["n"] += 1
        return "fresh" if calls["n"] > 1 else "stale"

    accessor = OneDriveAccessor(OneDriveConfig(access_token=provider))
    with aioresponses() as m:
        m.get(_CONTENT, status=401, payload={"error": {"code": "expired"}})
        m.get(_CONTENT, body=b"abcdef")
        chunks = [
            c async for c in read_stream(accessor,
                                         PathSpec.from_str_path("/Docs/a.txt"))
        ]
    assert b"".join(chunks) == b"abcdef"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_range_read_returns_requested_bytes():
    captured = {}

    def _cb(url, **kwargs):
        from aioresponses import CallbackResult
        captured["range"] = kwargs["headers"].get("Range")
        return CallbackResult(body=b"cde")

    with aioresponses() as m:
        m.get(_CONTENT, callback=_cb)
        data = await range_read(_accessor(),
                                PathSpec.from_str_path("/Docs/a.txt"), 2, 5)
    assert data == b"cde"
    assert captured["range"] == "bytes=2-4"

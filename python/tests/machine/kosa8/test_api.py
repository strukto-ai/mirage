# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========


import base64
import json

import httpx
import pytest

from mirage.machine.kosa8.api import (
    ExecFrame,
    Kosa8Api,
    Kosa8ApiError,
    Kosa8StreamCut,
)


def _line(**frame) -> bytes:
    return json.dumps(frame).encode() + b"\n"


def _data(stream: str, data: bytes) -> bytes:
    return _line(stream=stream, data=base64.b64encode(data).decode())


def _api(handler, key: str | None = "k8c_live_test", url=None) -> Kosa8Api:
    return Kosa8Api(key, url, transport=httpx.MockTransport(handler))


def test_the_key_falls_back_to_the_environment(monkeypatch):
    monkeypatch.setenv("KOSA8_API_KEY", "k8c_live_env")
    seen = []

    def handler(request):
        seen.append(request.headers["authorization"])
        return httpx.Response(200, json={"sandbox": {"id": "sbx_1"}})

    api = _api(handler, key=None)
    assert api._client.headers["authorization"] == "Bearer k8c_live_env"
    assert api._client.headers["user-agent"] == "mirage-kosa8"


def test_no_key_anywhere_says_how_to_set_one(monkeypatch):
    monkeypatch.delenv("KOSA8_API_KEY", raising=False)
    with pytest.raises(ValueError, match="set KOSA8_API_KEY"):
        _api(lambda r: httpx.Response(200), key=None)


@pytest.mark.parametrize(
    "url,env,base",
    [
        (None, None, "https://api.kosa8.com"),
        (None, "https://eu.example.test/", "https://eu.example.test"),
        (
            "https://own.example.test",
            "https://eu.example.test",
            "https://own.example.test",
        ),
    ],
)
def test_the_address_is_the_configs_then_the_environments(
    monkeypatch, url, env, base
):
    if env is None:
        monkeypatch.delenv("KOSA8_CLOUD_URL", raising=False)
    else:
        monkeypatch.setenv("KOSA8_CLOUD_URL", env)
    api = _api(lambda r: httpx.Response(200), url=url)
    assert str(api._client.base_url).rstrip("/") == base


@pytest.mark.asyncio
async def test_calls_reach_their_routes():
    seen = []

    def handler(request):
        seen.append(
            (
                request.method,
                request.url.path,
                request.url.query.decode(),
                request.content,
            )
        )
        if request.url.path == "/v1/sandboxes" or request.method == "GET":
            return httpx.Response(
                200, json={"sandbox": {"id": "sbx_1", "state": "running"}}
            )
        return httpx.Response(200, json={})

    api = _api(handler)
    assert (await api.create({"template": "base"}))["id"] == "sbx_1"
    assert (await api.get("sbx_1"))["state"] == "running"
    await api.sleep("sbx_1")
    await api.set_egress("sbx_1", {"internet": False})
    await api.remove("sbx_1", "/root/.mirage/in-1")
    await api.delete("sbx_1")
    assert seen == [
        ("POST", "/v1/sandboxes", "", b'{"template":"base"}'),
        ("GET", "/v1/sandboxes/sbx_1", "", b""),
        ("POST", "/v1/sandboxes/sbx_1/sleep", "", b""),
        ("PUT", "/v1/sandboxes/sbx_1/egress", "", b'{"internet":false}'),
        (
            "DELETE",
            "/v1/sandboxes/sbx_1/files",
            "path=%2Froot%2F.mirage%2Fin-1",
            b"",
        ),
        ("DELETE", "/v1/sandboxes/sbx_1", "", b""),
    ]
    await api.close()


@pytest.mark.asyncio
async def test_a_refusal_carries_kosa8s_code_and_message():
    api = _api(
        lambda r: httpx.Response(
            404, json={"error": "not_found", "message": "no sandbox sbx_1"}
        )
    )
    with pytest.raises(Kosa8ApiError, match="no sandbox sbx_1") as caught:
        await api.get("sbx_1")
    assert (caught.value.status, caught.value.code) == (404, "not_found")


@pytest.mark.asyncio
async def test_removing_a_file_already_gone_is_no_error():
    api = _api(lambda r: httpx.Response(404, json={"error": "not_found"}))
    await api.remove("sbx_1", "/tmp/x")


@pytest.mark.asyncio
async def test_an_upload_streams_its_bytes():
    got = {}

    async def handler(request):
        got["path"] = request.url.params["path"]
        got["body"] = await request.aread()
        got["type"] = request.headers["content-type"]
        return httpx.Response(200, json={"file": {}})

    async def parts():
        yield b"\x00\xff"
        yield b"ab"

    await _api(handler).upload("sbx_1", "/root/.mirage/in-1", parts())
    assert got == {
        "path": "/root/.mirage/in-1",
        "body": b"\x00\xffab",
        "type": "application/octet-stream",
    }


@pytest.mark.asyncio
async def test_an_exec_yields_its_frames_byte_for_byte():
    body = {}

    def handler(request):
        body.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=_data("stdout", b"a\x00\xff")
            + _line(heartbeat=True)
            + b"\n"
            + _data("stderr", b"e\n")
            + _line(done=True, exit=3),
        )

    frames = [
        f
        async for f in _api(handler).exec("sbx_1", ["sh", "-c", "x"], ["A=1"])
    ]
    assert body == {"cmd": ["sh", "-c", "x"], "stream": True, "env": ["A=1"]}
    assert frames == [
        ExecFrame("stdout", b"a\x00\xff"),
        ExecFrame("stderr", b"e\n"),
        ExecFrame(exit_code=3),
    ]


@pytest.mark.asyncio
async def test_an_exec_without_env_sends_none():
    body = {}

    def handler(request):
        body.update(json.loads(request.content))
        return httpx.Response(200, content=_line(done=True, exit=0))

    [_ async for _ in _api(handler).exec("sbx_1", ["true"], [])]
    assert "env" not in body


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content,match",
    [
        (_data("stdout", b"x"), "ended before the command exited"),
        (_line(done=True, error="the host stopped it"), "the host stopped it"),
        (b"not json\n", "cannot read"),
        (_line(stream="stdout", data="!!"), "cannot read"),
    ],
)
async def test_a_stream_cut_short_says_so(content, match):
    api = _api(lambda r: httpx.Response(200, content=content))
    with pytest.raises(Kosa8StreamCut, match=match):
        [_ async for _ in api.exec("sbx_1", ["true"], [])]


@pytest.mark.asyncio
async def test_a_refused_exec_raises_before_any_frame():
    api = _api(
        lambda r: httpx.Response(
            409,
            json={"error": "not_running", "message": "the sandbox is deleted"},
        )
    )
    with pytest.raises(Kosa8ApiError, match="the sandbox is deleted"):
        [_ async for _ in api.exec("sbx_1", ["true"], [])]

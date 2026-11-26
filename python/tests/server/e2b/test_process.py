import asyncio
import base64
import json

import pytest

from mirage.io.pipe import CAPACITY
from tests.server.routers.e2b_test_support import (
    KEY,
    PROCESS,
    TOKEN,
    sandbox_headers,
    server,
    start_body,
)

PREFIX = "/process.Process/"


@pytest.mark.asyncio
async def test_live_process_controls(tmp_path):
    async with server(tmp_path, auth_config=TOKEN) as (app, client):

        async def sandbox():
            created = await client.post(
                "/v2/sandboxes", headers={"x-api-key": "server-key"}, json={}
            )
            assert created.status_code == 201
            lease = created.json()
            return {
                "e2b-sandbox-id": lease["sandboxID"],
                "e2b-sandbox-port": "49983",
                "x-access-token": lease["envdAccessToken"],
            }

        headers, other = await sandbox(), await sandbox()

        async def control(method, payload, *, addressed=headers):
            return await client.post(
                PREFIX + method, headers=addressed, json=payload
            )

        async def run(line, on_start=None, *, timeout=None, disconnect=False):
            start = json.dumps(
                {
                    "process": {
                        "cmd": "/bin/bash",
                        "args": ["-l", "-c", line],
                    },
                    "stdin": True,
                }
            ).encode()
            sent = False
            disconnected = asyncio.Event()
            frames = []

            async def receive():
                nonlocal sent
                if not sent:
                    sent = True
                    return {
                        "type": "http.request",
                        "body": b"\0" + len(start).to_bytes(4, "big") + start,
                    }
                await disconnected.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                if message["type"] == "http.response.start":
                    assert message["status"] == 200
                    return
                frame = json.loads(message["body"][5:])
                frames.append(frame)
                event = frame.get("event", {})
                if "start" in event:
                    if on_start is not None:
                        await on_start(event["start"]["pid"])
                    if disconnect:
                        disconnected.set()

            stream_headers = {
                **headers,
                "host": "test",
                "content-type": "application/connect+json",
            }
            if timeout is not None:
                stream_headers["connect-timeout-ms"] = str(timeout)
            async with asyncio.timeout(3):
                await app.state.e2b_app(
                    {
                        "type": "http",
                        "method": "POST",
                        "scheme": "http",
                        "path": PREFIX + "Start",
                        "query_string": b"",
                        "headers": [
                            (key.encode(), value.encode())
                            for key, value in stream_headers.items()
                        ],
                        "client": ("127.0.0.1", 10001),
                        "server": ("test", 80),
                    },
                    receive,
                    send,
                )
            return frames

        async def write(pid):
            listed = await control("List", {})
            (info,) = listed.json()["processes"]
            assert info["pid"] == pid
            assert info["config"]["args"] == ["-l", "-c", "cat"]
            selector = {"process": {"pid": pid}}
            missing = await control(
                "SendSignal",
                {**selector, "signal": "SIGNAL_SIGKILL"},
                addressed=other,
            )
            assert missing.status_code == 404
            wrong_signal = await control(
                "SendSignal", {**selector, "signal": 15}
            )
            assert wrong_signal.json()["code"] == "unimplemented"
            excess = base64.b64encode(b"x" * (CAPACITY + 1)).decode()
            too_large = await control(
                "SendInput",
                {
                    **selector,
                    "input": {"stdin": excess},
                },
            )
            assert too_large.json()["code"] == "resource_exhausted"
            assert (
                await control(
                    "SendInput",
                    {
                        **selector,
                        "input": {"stdin": "AP8K"},
                    },
                )
            ).is_success
            assert (await control("CloseStdin", selector)).is_success

        frames = await run("cat", write)
        assert frames[1] == {"event": {"data": {"stdout": "AP8K"}}}
        assert frames[-2]["event"]["end"]["exitCode"] == 0
        assert (await control("List", {})).json() == {"processes": []}

        async def kill(pid):
            result = await control(
                "SendSignal", {"process": {"pid": pid}, "signal": 9}
            )
            assert result.is_success

        frames = await run("cat", kill)
        assert frames[-2]["event"]["end"]["exitCode"] == 137
        assert (await control("List", {})).json() == {"processes": []}

        frames = await run("cat", timeout=50)
        assert frames[-1]["error"]["code"] == "deadline_exceeded"
        assert (await control("List", {})).json() == {"processes": []}

        await run("cat", disconnect=True)
        assert (await control("List", {})).json() == {"processes": []}

        async def revoke(_pid):
            result = await client.delete(
                f"/sandboxes/{headers['e2b-sandbox-id']}",
                headers={"x-api-key": "server-key"},
            )
            assert result.status_code == 204

        frames = await run("cat", revoke)
        assert frames[-1]["error"]["code"] == "canceled"
        assert (await control("List", {})).status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("retirement", ["delete", "expire"])
async def test_retiring_a_lease_releases_a_stalled_command_response(
    tmp_path, retirement
):
    async with server(tmp_path, auth_config=TOKEN) as (app, client):
        headers = await sandbox_headers(client)
        path = f"/sandboxes/{headers['e2b-sandbox-id']}"
        stalled = asyncio.Event()
        resume = asyncio.Event()
        messages = iter(
            [{"type": "http.request", "body": start_body("sleep 30")}]
        )

        async def receive():
            message = next(messages, None)
            if message is not None:
                return message
            await resume.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                assert message["status"] == 200
            else:
                stalled.set()
                await resume.wait()

        scope = {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "path": PROCESS,
            "query_string": b"",
            "headers": [
                (key.encode(), value.encode())
                for key, value in {**headers, "host": "test"}.items()
            ],
            "client": ("127.0.0.1", 10001),
            "server": ("test", 80),
        }
        async with asyncio.timeout(3), asyncio.TaskGroup() as tasks:
            tasks.create_task(app.state.e2b_app(scope, receive, send))
            await stalled.wait()
            if retirement == "delete":
                retired = await client.delete(path, headers=KEY)
            else:
                retired = await client.post(
                    f"{path}/timeout", headers=KEY, json={"timeout": 0}
                )
            assert retired.status_code == 204, retired.text

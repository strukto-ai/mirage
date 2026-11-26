import base64
import json
import time
from contextlib import asynccontextmanager
from unittest.mock import patch

import jwt
from httpx import ASGITransport, AsyncClient

from mirage.server import app as app_module
from mirage.server.app import build_app
from mirage.server.auth import AuthConfig, AuthMode

KEY = {"X-API-Key": "server-key"}
TOKEN = AuthConfig(mode=AuthMode.TOKEN, bearer_token=KEY["X-API-Key"])
CREATE = "/v2/sandboxes"
PROCESS = "/process.Process/Start"
SECRET = "e2b-test-key-with-at-least-32-bytes"
NATIVE = "http://native"


@asynccontextmanager
async def server(tmp_path, *, resource_store=None, e2b_port=8766, **kwargs):
    app = build_app(
        state_root=tmp_path / "daemon",
        resource_store=resource_store,
        e2b_port=e2b_port,
        allowed_hosts=["native", "test"],
        **kwargs,
    )
    sandbox = app.state.e2b_app
    with patch.object(app_module, "_start_e2b", return_value=None):
        async with (
            app.router.lifespan_context(app),
            AsyncClient(
                transport=ASGITransport(app=sandbox or app),
                mounts={NATIVE: ASGITransport(app=app)},
                base_url="http://test",
            ) as client,
        ):
            yield app, client


def account_key(account):
    return jwt.encode(
        {"sub": account, "exp": int(time.time()) + 60},
        SECRET,
        algorithm="HS256",
    )


async def sandbox_headers(client, **options):
    created = await client.post(CREATE, headers=KEY, json=options)
    assert created.status_code == 201, created.text
    return data_headers(created.json())


def data_headers(body):
    return {
        "e2b-sandbox-id": body["sandboxID"],
        "e2b-sandbox-port": "49983",
        "x-access-token": body["envdAccessToken"],
        "content-type": "application/connect+json",
        "authorization": "Basic dXNlcjo=",
    }


def start_body(command, **options):
    payload = json.dumps(
        {
            "process": {
                "cmd": "/bin/bash",
                "args": ["-l", "-c", command],
                **options,
            }
        }
    ).encode()
    return b"\0" + len(payload).to_bytes(4, "big") + payload


def envelopes(body):
    frames = []
    while body:
        size = int.from_bytes(body[1:5], "big")
        frames.append((body[0], json.loads(body[5 : 5 + size])))
        body = body[5 + size :]
    return frames


def output_of(response, stream):
    return b"".join(
        base64.b64decode(frame["event"]["data"][stream])
        for flags, frame in envelopes(response.content)
        if flags == 0 and stream in frame["event"].get("data", {})
    )

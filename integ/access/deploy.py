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
"""Start and stop each deployment of the Mirage server, per host.

``dev`` is what a developer gets: the CLI's first ``workspace create``
starts the daemon on this machine, in local auth mode with a token file.
``token`` and ``jwt`` are the server as a service runs it, ``serve.py``
or ``serve.ts`` with every setting from the environment: one fixed token,
or the mock issuer's JWTs. SSH is on in all three, with three keys: a
plain one, one bound to the ``guarded`` profile, and one never
authorized.
"""

import json
import logging
import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import boto3
import httpx
from issuer import ACCOUNT, AUTHORIZED_PARTY, CLIENT_ID, Issuer
from moto.server import ThreadedMotoServer

ROOT = Path(__file__).resolve().parents[2]
INTEG = ROOT / "integ"
HOSTS = ("python", "typescript")
DEPLOYMENTS = ("dev", "token", "jwt")
TOKEN = "access-integ-token"
SEED = "seed"
RAM = '{"mounts": {"/": {"vfs": "ram", "mode": "write"}}}\n'
STORE_DEPLOYMENTS = ("token", "jwt")
STORE_ENV = "ACCESS_SNAPSHOT_STORE"


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def mirage_cli(host: str, *args: str) -> list[str]:
    """The ``mirage`` command line of one host.

    Args:
        host (str): ``python`` or ``typescript``.
        *args (str): the command's words.

    Returns:
        list[str]: the argv.
    """
    if host == "python":
        return [str(Path(sys.executable).parent / "mirage"), *args]
    return [
        "node",
        str(ROOT / "typescript/packages/cli/dist/bin/mirage.js"),
        *args,
    ]


def clean_env() -> dict[str, str]:
    """This process's environment without any Mirage setting."""
    return {k: v for k, v in os.environ.items() if not k.startswith("MIRAGE_")}


def _key_line(public: str, options: list[str]) -> str:
    return (",".join(options) + " " if options else "") + public


def ssh_keys(root: Path, account: str | None = None) -> None:
    for name in ("id_plain", "id_guarded", "id_unknown"):
        subprocess.run(
            [
                "ssh-keygen",
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-f",
                str(root / name),
            ],
            check=True,
        )
    owner = [] if account is None else [f'mirage-account="{account}"']
    lines = [
        _key_line((root / "id_plain.pub").read_text(), owner),
        _key_line(
            (root / "id_guarded.pub").read_text(),
            [*owner, 'mirage-profile="guarded"'],
        ),
    ]
    (root / "authorized_keys").write_text("".join(lines))


@dataclass
class Deployment:
    """One running server and how to reach it.

    Args:
        name (str): ``dev``, ``token`` or ``jwt``.
        host (str): ``python`` or ``typescript``.
        root (Path): its private directory.
        port (int): the HTTP port.
        ssh_port (int): the SSH port.
        issuer (Issuer): the mock issuer, for ``jwt``.
    """

    name: str
    host: str
    root: Path
    port: int
    ssh_port: int
    issuer: Issuer
    store: "SnapshotStore"
    process: subprocess.Popen[bytes] | None = field(default=None, repr=False)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def home(self) -> Path:
        return self.root / "home"

    def bearer(self) -> str:
        """A token this deployment accepts, minted now for ``jwt``."""
        if self.name == "jwt":
            return self.issuer.token()
        if self.name == "token":
            return TOKEN
        return (self.home / "auth_token").read_text().strip()

    def server_env(self) -> dict[str, str]:
        """The settings the server reads, as a deployment sets them."""
        env = {
            **clean_env(),
            "MIRAGE_HOME": str(self.home),
            "MIRAGE_DAEMON_PORT": str(self.port),
            "MIRAGE_IDLE_GRACE_SECONDS": "600",
            "MIRAGE_SSH_PORT": str(self.ssh_port),
            "MIRAGE_SSH_HOST_KEY_FILE": str(self.root / "host_key"),
            "MIRAGE_SSH_AUTHORIZED_KEYS": str(self.root / "authorized_keys"),
        }
        if self.name in STORE_DEPLOYMENTS:
            env[STORE_ENV] = json.dumps(self.store.config(self.host))
        if self.name == "token":
            env |= {"MIRAGE_AUTH_MODE": "token", "MIRAGE_AUTH_TOKEN": TOKEN}
        if self.name == "jwt":
            env |= {
                "MIRAGE_AUTH_MODE": "jwt",
                "MIRAGE_JWT_ALG": "RS256",
                "MIRAGE_JWT_JWKS_URL": self.issuer.jwks_url,
                "MIRAGE_JWT_ISSUER": self.issuer.url,
                "MIRAGE_JWT_AUDIENCE": CLIENT_ID,
                "MIRAGE_JWT_AUTHORIZED_PARTIES": AUTHORIZED_PARTY,
                "MIRAGE_LOGIN_CLIENT_ID": CLIENT_ID,
            }
        return env

    def cli_env(self, token: str | None = None) -> dict[str, str]:
        """The environment a CLI reaching this deployment runs in.

        On ``dev`` the CLI finds the token file itself; elsewhere it is
        handed a token, a fresh one unless ``token`` names another.

        Args:
            token (str | None): the token to send instead.

        Returns:
            dict[str, str]: the environment.
        """
        env = {
            **self.server_env(),
            "MIRAGE_DAEMON_URL": self.url,
        }
        for key in ("MIRAGE_AUTH_TOKEN", "MIRAGE_AUTH_MODE"):
            env.pop(key, None)
        if token is not None:
            env["MIRAGE_TOKEN"] = token
        elif self.name != "dev":
            env["MIRAGE_TOKEN"] = self.bearer()
        return env

    def ssh_key(self, name: str = "plain") -> Path:
        return self.root / f"id_{name}"

    def ready(self) -> bool:
        try:
            health = httpx.get(f"{self.url}/v1/health", timeout=1)
            with socket.create_connection(
                ("127.0.0.1", self.ssh_port), timeout=1
            ):
                return health.status_code == 200
        except (httpx.TransportError, OSError):
            return False

    def wait_ready(self, log: Path, timeout: float = 60) -> None:
        deadline = time.monotonic() + timeout
        while not self.ready():
            exited = (
                self.process is not None and self.process.poll() is not None
            )
            if exited or time.monotonic() > deadline:
                text = log.read_text() if log.exists() else ""
                raise RuntimeError(
                    f"{self.host} {self.name} server did not start:\n{text}"
                )
            time.sleep(0.05)


def _start(d: Deployment) -> None:
    d.home.mkdir(parents=True, exist_ok=True)
    ssh_keys(d.root, ACCOUNT if d.name == "jwt" else None)
    if d.name == "dev":
        config = d.root / "seed.yaml"
        config.write_text(RAM)
        created = subprocess.run(
            mirage_cli(
                d.host, "workspace", "create", str(config), "--id", SEED
            ),
            env=d.cli_env(),
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if created.returncode != 0:
            raise RuntimeError(
                f"{d.host} dev: workspace create failed: {created.stderr}"
            )
        d.wait_ready(d.home / "daemon.log")
        return
    log = d.root / "server.log"
    command = (
        [sys.executable, str(INTEG / "access" / "serve.py"), str(d.port)]
        if d.host == "python"
        else ["node", "--import", "tsx", "access/serve.ts", str(d.port)]
    )
    with log.open("w") as out:
        d.process = subprocess.Popen(
            command,
            cwd=INTEG,
            env=d.server_env(),
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    d.wait_ready(log)
    httpx.post(
        f"{d.url}/v1/workspaces",
        json={
            "id": SEED,
            "config": {"mounts": {"/": {"vfs": "ram", "mode": "write"}}},
        },
        headers={"Authorization": f"Bearer {d.bearer()}"},
        timeout=30,
    ).raise_for_status()


def _stop(d: Deployment) -> None:
    if d.process is None:
        subprocess.run(
            mirage_cli(d.host, "daemon", "stop"),
            env=d.cli_env(),
            cwd=ROOT,
            capture_output=True,
            timeout=60,
        )
        return
    d.process.terminate()
    try:
        d.process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        d.process.kill()
        d.process.wait()


@dataclass
class SnapshotStore:
    """The S3-like snapshot store, a moto server, in each host's spelling.

    Args:
        endpoint (str): the moto server's URL.
        bucket (str): the bucket snapshots go in.
    """

    endpoint: str
    bucket: str = "snaps"

    def config(self, host: str) -> dict[str, object]:
        """The store's config as ``S3Config`` spells it on ``host``.

        Args:
            host (str): ``python`` or ``typescript``.

        Returns:
            dict[str, object]: the config fields.
        """
        if host == "python":
            return {
                "bucket": self.bucket,
                "region": "us-east-1",
                "endpoint_url": self.endpoint,
                "aws_access_key_id": "testing",
                "aws_secret_access_key": "testing",
                "path_style": True,
                "key_prefix": f"access/{host}/",
            }
        return {
            "bucket": self.bucket,
            "region": "us-east-1",
            "endpoint": self.endpoint,
            "accessKeyId": "testing",
            "secretAccessKey": "testing",
            "forcePathStyle": True,
            "keyPrefix": f"access/{host}/",
        }


@contextmanager
def snapshot_store() -> Iterator[SnapshotStore]:
    """Run the moto server the snapshot store suites write to.

    Yields:
        SnapshotStore: the store, its bucket made.
    """
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    store = SnapshotStore(f"http://{host}:{port}")
    boto3.client(
        "s3",
        endpoint_url=store.endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name="us-east-1",
    ).create_bucket(Bucket=store.bucket)
    try:
        yield store
    finally:
        server.stop()


@contextmanager
def deployed(
    name: str, host: str, root: Path, issuer: Issuer, store: SnapshotStore
) -> Iterator[Deployment]:
    """Run one deployment for the length of the block.

    Args:
        name (str): ``dev``, ``token`` or ``jwt``.
        host (str): ``python`` or ``typescript``.
        root (Path): a private directory.
        issuer (Issuer): the mock issuer.
        store (SnapshotStore): the snapshot store ``token`` and ``jwt``
            are given; ``dev``, started by the CLI, has none.

    Yields:
        Deployment: the running server.
    """
    root.mkdir(parents=True, exist_ok=True)
    d = Deployment(name, host, root, free_port(), free_port(), issuer, store)
    try:
        _start(d)
        yield d
    finally:
        _stop(d)

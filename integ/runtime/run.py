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

import sys
from pathlib import Path

_RUNTIME_DIR = str(Path(__file__).parent)
_INTEG_DIR = str(Path(__file__).parent.parent)
sys.path[:] = [p for p in sys.path if p not in (_RUNTIME_DIR, _INTEG_DIR, "")]

import asyncio  # noqa: E402
import copy  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import shlex  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import uuid  # noqa: E402
from typing import Any  # noqa: E402

from mirage import (  # noqa: E402
    EXTERNAL_COMMANDS,
    MountMode,
    ProcessExecution,
    ProcessExecutorMixin,
    Workspace,
)
from mirage.cache.index import NULL_INDEX, IndexCacheStore  # noqa: E402
from mirage.commands.cli.types import CLISpec  # noqa: E402
from mirage.errors import classify  # noqa: E402
from mirage.policy import Policy  # noqa: E402
from mirage.policy.types import (  # noqa: E402
    CommandContext,
    Deny,
    ExecuteResultContext,
    Route,
    VfsContext,
    VfsResultContext,
)
from mirage.runtime.base import Runtime  # noqa: E402
from mirage.runtime.mixin import LineExecutorMixin  # noqa: E402
from mirage.runtime.routing import RouteContext, ScriptSource  # noqa: E402
from mirage.runtime.table import build_runtime, register_runtime  # noqa: E402
from mirage.runtime.types import RunResult  # noqa: E402
from mirage.types import FileStat, Limit, PathSpec  # noqa: E402
from mirage.vfs.base import BaseVFS  # noqa: E402
from mirage.vfs.ram import RAMVFS  # noqa: E402

HOST = "python"
SUITE_DIR = Path(__file__).parent
DB = "mirage_integ_runtime"
BUCKET = "mirage-integ-runtime"
# What a case's `backends` entry needs on this host before it can run.
BACKEND_REQUIRES: dict[str, list[str]] = {
    "ram": [],
    "disk": [],
    "ssh": ["env:MIRAGE_INTEG_SSH_HOST"],
    "redis": ["env:REDIS_URL"],
    "s3": ["s3"],
}
# The guest language of every runtime a case's `runtimes` may name, and
# the line head a step's program runs under in it. A sandbox has none: it
# runs whole lines, so a case's plain commands are its program.
RUNTIME_LANGUAGE: dict[str, str | None] = {
    "monty": "python",
    "wasi": "python",
    "pyodide": "python",
    "quickjs": "js",
    "local": "python",
    "sandlock": "python",
    "docker": None,
    "ssh": None,
    "e2b": None,
    "smolvm": None,
    "apple_container": None,
}
PROGRAM_HEAD: dict[str, str] = {"python": "python3 -c", "js": "node -e"}
# The expect keys that read the workspace's op ledger.
LEDGER_CHECKS = frozenset({"ops_contain", "ops_absent", "ops_count"})
# What a `runtimes` entry needs on this host before it can run. A runtime
# missing here does not exist on this host (pyodide is typescript's), so
# its variant is not listed at all.
RUNTIME_REQUIRES: dict[str, list[str]] = {
    "monty": [],
    "wasi": ["env:MIRAGE_WASI_HOME"],
    "quickjs": ["env:MIRAGE_QUICKJS_HOME"],
    "local": [],
    "sandlock": ["env:MIRAGE_INTEG_SANDLOCK"],
    "docker": ["env:MIRAGE_INTEG_DOCKER_CONTAINER"],
    "ssh": ["env:MIRAGE_INTEG_SSH_HOST"],
    "e2b": ["env:MIRAGE_INTEG_E2B_SANDBOX"],
    "smolvm": ["env:MIRAGE_INTEG_SMOLVM_MACHINE"],
    "apple_container": ["env:MIRAGE_INTEG_APPLE_CONTAINER"],
}
# The world entry a runtime is built from, before a case's own `entry`
# narrows its captures or adds config. A sandbox is reached through
# config the job provides; a name missing here is built by name alone.
RUNTIME_ENTRY: dict[str, dict[str, Any]] = {
    "sandlock": {"captures": ["python3", "node", "@external"]},
    "docker": {
        "captures": ["*"],
        "config": {"container": "${MIRAGE_INTEG_DOCKER_CONTAINER}"},
    },
    "ssh": {
        "captures": ["*"],
        "config": {
            "host": "${MIRAGE_INTEG_SSH_HOST}",
            "port": 2222,
            "username": "${MIRAGE_INTEG_SSH_USERNAME}",
            "identity_file": "${MIRAGE_INTEG_SSH_KEY}",
        },
    },
    "e2b": {
        "captures": ["*"],
        "config": {"sandbox_id": "${MIRAGE_INTEG_E2B_SANDBOX}"},
    },
    "smolvm": {
        "captures": ["*"],
        "config": {"machine": "${MIRAGE_INTEG_SMOLVM_MACHINE}"},
    },
    "apple_container": {
        "captures": ["*"],
        "config": {"container": "${MIRAGE_INTEG_APPLE_CONTAINER}"},
    },
}
# Runtimes that need a host the hosted runners do not give every job
# (a live sandbox, a hypervisor, Landlock): an unmet requirement skips
# their variants even under INTEG_RUNTIME_STRICT.
OPTIONAL_RUNTIMES = {"sandlock", "e2b", "smolvm", "apple_container"}

_moto_server: Any = None
_s3_endpoint: str | None = None
_mongo_seeded = False


class EchoBox(Runtime, LineExecutorMixin):
    """A test-only whole-line runtime: echoes the raw line back."""

    name = "echobox"
    captures = ("nvidia-smi",)

    async def run_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        return RunResult(
            stdout=f"box:{line}\n".encode(), stderr=None, exit_code=0
        )


# Registered the way a host registers its own runtime, so a case names
# it by string like a builtin, `build_runtime` resolves it, and the
# unknown-name refusal lists it. The registry suite pins that door.
register_runtime(EchoBox.name, EchoBox)


class ProcessBox(Runtime, ProcessExecutorMixin):
    """A host-authored argv runtime using the public capability import."""

    name = "processbox"
    captures = (EXTERNAL_COMMANDS,)

    async def run_process(self, request: ProcessExecution) -> RunResult:
        return RunResult(
            stdout=(
                json.dumps(request.argv, separators=(",", ":")) + "\n"
            ).encode(),
            stderr=None,
            exit_code=0,
        )


RUNTIME_KINDS: dict[str, type[Runtime]] = {
    EchoBox.name: EchoBox,
    ProcessBox.name: ProcessBox,
}


# Each test policy decides synchronously in `decide`; the hook the engine
# calls is stamped on per case, as `async def` (the default) or a plain
# `def` (`"sync": true`), so one case runs under both shapes on both
# hosts. The seam has to await whatever a hook returns: a plain `def`
# used to raise inside python's fail-closed arm, and every command read
# `policy X failed` (TypeScript has always accepted a value or a
# promise). Neither base defines its hook, so only a shaped instance acts.
class DenyFlag(Policy):
    """Test-only pre_command policy: refuse a command carrying a flag."""

    HOOK = "pre_command"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._command = spec["command"]
        self._flag = spec["flag"]
        self._reason = spec["reason"]

    def decide(self, ctx: CommandContext) -> Deny | None:
        if ctx.command == self._command and self._flag in ctx.argv:
            return Deny(self._reason)
        return None


class PlaceLine(Policy):
    """Test-only pre_execute policy: place a line holding a word on a
    runtime, or refuse it when the entry names a ``deny`` reason."""

    HOOK = "pre_execute"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._contains = spec["contains"]
        self._runtime = spec.get("runtime", "")
        self._deny = spec.get("deny")

    def decide(self, ctx: RouteContext) -> Deny | Route | None:
        if self._contains not in ctx.line:
            return None
        if self._deny is not None:
            return Deny(self._deny)
        return Route(self._runtime)


class LockWrites(Policy):
    """Test-only pre_vfs policy: refuse write ops under a prefix."""

    HOOK = "pre_vfs"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._prefix = spec["prefix"]

    def decide(self, ctx: VfsContext) -> Deny | None:
        if ctx.write and ctx.path.virtual.startswith(self._prefix):
            return Deny("locked")
        return None


class SealReads(Policy):
    """Test-only pre_vfs policy: refuse read ops on a path suffix."""

    HOOK = "pre_vfs"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._suffix = spec["suffix"]

    def decide(self, ctx: VfsContext) -> Deny | None:
        if not ctx.write and ctx.path.virtual.endswith(self._suffix):
            return Deny("sealed")
        return None


class RedactReads(Policy):
    """Test-only post_vfs policy: refuse read results holding a marker."""

    HOOK = "post_vfs"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._marker = spec["marker"].encode()

    def decide(self, ctx: VfsResultContext) -> Deny | None:
        data = (
            ctx.result if isinstance(ctx.result, (bytes, bytearray)) else None
        )
        if ctx.op == "read" and data is not None and self._marker in data:
            return Deny("redacted")
        return None


class OpReadCap(Policy):
    """Test-only post_vfs policy: cap read bytes on a path suffix."""

    HOOK = "post_vfs"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._suffix = spec["suffix"]
        self._max_bytes = spec["max_bytes"]

    def decide(self, ctx: VfsResultContext) -> Limit | None:
        if ctx.op == "read" and ctx.path.virtual.endswith(self._suffix):
            return Limit(max_bytes=self._max_bytes)
        return None


class LineCap(Policy):
    """Test-only post_execute policy: bound every line's output."""

    HOOK = "post_execute"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._limit = Limit(
            **{k: v for k, v in spec.items() if k not in ("name", "sync")}
        )

    def decide(self, ctx: ExecuteResultContext) -> Limit | None:
        return self._limit


class Boom(Policy):
    """Test-only post_execute policy that throws: must fail closed."""

    HOOK = "post_execute"

    def __init__(self, spec: dict[str, Any]) -> None:
        pass

    def decide(self, ctx: ExecuteResultContext) -> Limit | None:
        raise RuntimeError("boom")


POLICY_KINDS = {
    "deny_flag": DenyFlag,
    "place_line": PlaceLine,
    "lock_writes": LockWrites,
    "seal_reads": SealReads,
    "redact_reads": RedactReads,
    "op_read_cap": OpReadCap,
    "line_cap": LineCap,
    "boom": Boom,
}


def _sync_hook(self: Policy, ctx: Any) -> Any:
    return self.decide(ctx)


async def _async_hook(self: Policy, ctx: Any) -> Any:
    return self.decide(ctx)


def _build_policy(spec: dict[str, Any]) -> Policy:
    """One world policies entry, dispatched on its ``name``.

    Args:
        spec (dict[str, Any]): the entry; ``name`` picks the test policy
            class, ``sync`` picks a plain ``def`` hook over the default
            ``async def``, the remaining keys are its config.
    """
    base = POLICY_KINDS[spec["name"]]
    hook = _sync_hook if spec.get("sync", False) else _async_hook
    shaped = type(base.__name__, (base,), {base.HOOK: hook})
    return shaped(spec)


def _register_runtimes(entries: dict[str, str]) -> None:
    """The world's host-side runtime registrations, ``name -> kind``.

    Runs before the world's runtimes are built, so a refused
    registration (a builtin's name) surfaces as the case's build error.

    Args:
        entries (dict[str, str]): the name to register under, and the
            test runtime class it names (``echobox``).
    """
    for name, kind in entries.items():
        register_runtime(name, RUNTIME_KINDS[kind])


def _expand(value: Any) -> Any:
    """Expand ``${ENV}`` placeholders in config values.

    Args:
        value (Any): a config scalar, list, or dict from a case file.
    """
    if isinstance(value, str):
        return re.sub(
            r"\$\{([A-Z0-9_]+)\}",
            lambda m: os.environ.get(m.group(1), ""),
            value,
        )
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand(v) for v in value]
    return value


def _requirement_met(req: str) -> bool:
    """Whether one suite requirement holds on this host.

    Args:
        req (str): ``env:NAME`` (environment variable set) or ``s3``
            (this host can serve an S3 endpoint; python always can,
            via an in-process moto server).
    """
    if req.startswith("env:"):
        return bool(os.environ.get(req[4:]))
    if req == "s3":
        return True
    raise ValueError(f"unknown requirement: {req!r}")


def _s3_config(key_prefix: str | None = None) -> Any:
    from mirage.vfs.s3 import S3Config

    endpoint = _ensure_s3()
    return S3Config(
        bucket=BUCKET,
        key_prefix=key_prefix,
        region="us-east-1",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        path_style=True,
    )


def _s3_client() -> Any:
    import boto3

    endpoint = _ensure_s3()
    return boto3.client(
        "s3",
        region_name="us-east-1",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )


def _ensure_s3() -> str:
    """Start the in-process moto server once and seed the bucket."""
    global _moto_server, _s3_endpoint
    if _s3_endpoint is not None:
        return _s3_endpoint
    from moto.server import ThreadedMotoServer

    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    _moto_server = ThreadedMotoServer(
        ip_address="127.0.0.1", port=0, verbose=False
    )
    _moto_server.start()
    host, port = _moto_server.get_host_and_port()
    _s3_endpoint = f"http://{host}:{port}"
    import boto3

    client = boto3.client(
        "s3",
        region_name="us-east-1",
        endpoint_url=_s3_endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )
    client.create_bucket(Bucket=BUCKET)
    client.put_object(
        Bucket=BUCKET, Key="greeting.txt", Body=b"hello from s3\n"
    )
    return _s3_endpoint


async def _ensure_mongo() -> None:
    global _mongo_seeded
    if _mongo_seeded:
        return
    from pymongo import AsyncMongoClient

    client = AsyncMongoClient(os.environ["MONGODB_URI"])
    try:
        await client.drop_database(DB)
        db = client[DB]
        await db["books"].insert_many(
            [{"_id": 1, "title": "alpha"}, {"_id": 2, "title": "beta"}]
        )
        await db["authors"].insert_many([{"_id": 1, "name": "ada"}])
    finally:
        await client.close()
    _mongo_seeded = True


class FailingRAMVFS(RAMVFS):
    """A RAM mount whose named records fail their stat and read.

    The shape of one broken record behind a REST collection: the
    listing names it, and every question about it errors with whatever
    the upstream said, which is no filesystem error at all. Its commands
    ask the same functions, so ``ls`` and ``find`` meet the record where
    a remote mount's commands do, and with no find of its own, as such a
    mount has none, ``find`` walks.

    Args:
        failing (list[str]): names, spelled as a mount's ``files``
            spells them, whose stat and read fail.
    """

    find = BaseVFS.find

    def __init__(self, failing: list[str]) -> None:
        super().__init__()
        self._failing = frozenset(failing)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        self._refuse(path)
        return await super().stat(path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        self._refuse(path)
        return await super().read(path, index, offset, size)

    def _refuse(self, path: PathSpec) -> None:
        if path.vfs_path.strip("/") in self._failing:
            raise RuntimeError("upstream 502 Bad Gateway")


async def _build_vfs(spec: dict[str, Any], run_id: str) -> Any:
    kind = spec["vfs"]
    if kind == "ram":
        vfs = FailingRAMVFS(spec["failing"]) if "failing" in spec else RAMVFS()
        if "generated_files" in spec:
            vfs.load_state(
                {
                    "files": {
                        f"/file-{i}.txt": b"unused"
                        for i in range(spec["generated_files"])
                    },
                }
            )
        return vfs
    if kind == "disk":
        from mirage.vfs.disk import DiskVFS

        return DiskVFS(
            tempfile.mkdtemp(prefix=f"mirage-integ-runtime-{run_id}-")
        )
    if kind == "ssh":
        from mirage.vfs.ssh import SSHVFS, SSHConfig

        # The ssh runtime's box: a fresh directory per mount, made before
        # the mount is, since a root that does not exist serves nothing.
        vfs = SSHVFS(
            SSHConfig(
                host=os.environ["MIRAGE_INTEG_SSH_HOST"],
                port=2222,
                username=os.environ.get("MIRAGE_INTEG_SSH_USERNAME"),
                identity_file=os.environ.get("MIRAGE_INTEG_SSH_KEY"),
                root=f"/tmp/mirage-integ-runtime-{run_id}",
            )
        )
        sftp = await vfs.accessor.sftp()
        await sftp.mkdir(vfs.config.root)
        return vfs
    if kind == "redis":
        from mirage.vfs.redis import RedisVFS

        return RedisVFS(
            url=os.environ["REDIS_URL"],
            key_prefix=f"mirage-integ-runtime-{run_id}/",
        )
    if kind == "s3":
        from mirage.vfs.s3 import S3VFS

        scoped = spec.get("scoped", False)
        return S3VFS(
            _s3_config(f"mirage-integ-runtime-{run_id}/" if scoped else None)
        )
    if kind == "mongodb":
        from mirage.vfs.mongodb import MongoDBConfig, MongoDBVFS

        await _ensure_mongo()
        return MongoDBVFS(
            config=MongoDBConfig(uri=os.environ["MONGODB_URI"], databases=[DB])
        )
    raise ValueError(f"unknown VFS kind: {kind!r}")


def _build_entry(entry: Any) -> Any:
    """One world runtimes entry: a name string or the uniform mapping.

    Args:
        entry (Any): ``"monty"`` or ``{"name", "captures", "config",
            "script"}``; a ``script`` is embedded source, the same
            contract as a yaml entry.
    """
    if isinstance(entry, str):
        return entry
    options: dict[str, Any] = {}
    if "captures" in entry:
        options["captures"] = tuple(entry["captures"])
    if "config" in entry:
        options["config"] = _expand(entry["config"])
    if "script" in entry:
        options["script"] = ScriptSource(entry["script"])
    return build_runtime(entry["name"], **options)


def _install_clis(ws: Workspace, clis: dict[str, Any]) -> None:
    """Install the world's script CLIs, the yaml ``clis:`` shape inline.

    Each entry embeds its program instead of naming a file, the same
    way a runtime entry embeds a policy script here; cli.sh writes them
    back out to files to drive the yaml path.

    Args:
        ws (Workspace): the workspace being built.
        clis (dict[str, Any]): head word -> {script, language, runtime,
            config}.
    """
    for name, entry in clis.items():
        spec = CLISpec(
            name=name,
            script=ScriptSource(
                entry["script"], language=entry.get("language", "python")
            ),
            runtime=entry.get("runtime"),
        )
        ws.register_cli(name, spec, entry.get("config"))


async def _build_workspace(world: dict[str, Any], run_id: str) -> Workspace:
    _register_runtimes(world.get("register_runtimes", {}))
    mounts: dict[str, Any] = {}
    seeds: list[tuple[str, str, bytes]] = []
    mount_specs = world.get("mounts", {"/ram": {"vfs": "ram"}})
    for index, (prefix, spec) in enumerate(mount_specs.items()):
        vfs = await _build_vfs(spec, f"{run_id}-{index}")
        guards = {
            cmd: Limit(**kwargs)
            for cmd, kwargs in spec.get("limits", {}).items()
        }
        mode = MountMode(spec.get("mode", "exec"))
        mounts[prefix] = (
            (vfs, mode, guards) if guards or "mode" in spec else vfs
        )
        for name, content in spec.get("files", {}).items():
            seeds.append((prefix, name, content.encode()))
    kwargs: dict[str, Any] = {}
    if "session_id" in world:
        kwargs["session_id"] = world["session_id"]
    if "runtimes" in world:
        kwargs["runtimes"] = [_build_entry(e) for e in world["runtimes"]]
    if "route_policy" in world:
        kwargs["route_policy"] = ScriptSource(world["route_policy"])
    if "policies" in world:
        kwargs["policies"] = [_build_policy(s) for s in world["policies"]]
    if "command_limits" in world:
        kwargs["command_limits"] = {
            name: Limit(**limit)
            for name, limit in world["command_limits"].items()
        }
    if "profiles" in world:
        kwargs["profiles"] = world["profiles"]
    if "profile" in world:
        kwargs["profile"] = world["profile"]
    ws = Workspace(mounts, mode=MountMode.EXEC, **kwargs)
    if "clis" in world:
        _install_clis(ws, world["clis"])
    made_dirs: set[str] = set()
    for prefix, name, data in seeds:
        # A nested seed needs its directory first: write refuses a
        # missing parent (GNU dest-parent semantics), and the op-level
        # mkdir creates the whole chain.
        parent = f"{prefix}/{name.rpartition('/')[0]}"
        if "/" in name and parent not in made_dirs:
            await ws.dispatch("mkdir", PathSpec.from_str_path(parent))
            made_dirs.add(parent)
        await ws.dispatch(
            "write", PathSpec.from_str_path(f"{prefix}/{name}"), data=data
        )
    return ws


def _check_ops(expect: dict[str, Any], seen: list[str]) -> list[str]:
    """Ledger expectations for one step, against the ops it added.

    Args:
        expect (dict[str, Any]): the step's expect block; ``ops_contain``
            and ``ops_absent`` hold an op name or ``"<op> <path>"``, and
            ``ops_count`` maps one of those to how many records match it.
        seen (list[str]): the records the step appended, one
            ``"<op> <path>"`` string per record, in arrival order.
    """
    recorded = set(seen) | {entry.partition(" ")[0] for entry in seen}
    problems = []
    for entry in expect.get("ops_contain", []):
        if entry not in recorded:
            problems.append(f"ledger missing {entry!r}: got {seen!r}")
    for entry in expect.get("ops_absent", []):
        if entry in recorded:
            problems.append(f"ledger must not hold {entry!r}: got {seen!r}")
    for entry, want in expect.get("ops_count", {}).items():
        got = sum(1 for s in seen if entry in (s, s.partition(" ")[0]))
        if got != want:
            problems.append(
                f"ledger holds {entry!r} {got} times, not {want}: got {seen!r}"
            )
    return problems


async def _run_facade(
    ws: Workspace, expect: dict[str, Any], spec: dict[str, Any]
) -> list[str]:
    """One facade step: call a typed Files convenience and check its value.

    Args:
        ws (Workspace): the workspace under test.
        expect (dict[str, Any]): ``value`` (JSON-comparable result) or
            ``throws_contains``.
        spec (dict[str, Any]): ``method`` (the python facade spelling,
            e.g. ``is_dir``), ``path``, ``data`` for a write, ``offset``
            for ``pwrite`` and ``length`` for ``truncate``.
    """
    method = getattr(ws.vfs, spec["method"])
    args: list[Any] = [spec["path"]]
    if "data" in spec:
        args.append(spec["data"].encode())
    if "offset" in spec:
        args.append(spec["offset"])
    if "length" in spec:
        args.append(spec["length"])
    if "errno" in expect:
        # The cross-language error assertion. `throws_contains` reads the
        # message, which the two languages word differently for the same
        # condition (python's OSError renders the strerror, the TypeScript
        # FsError carries only the path), so an errno case must name the
        # condition instead.
        try:
            await method(*args)
            name = "NONE"
        except Exception as exc:
            condition = classify(exc)
            name = (
                condition.name if condition is not None else type(exc).__name__
            )
        if name != expect["errno"]:
            return [f"facade errno {name}, expected {expect['errno']}"]
        return []
    if "throws_contains" in expect:
        try:
            await method(*args)
        except Exception as exc:
            if expect["throws_contains"] in str(exc):
                return []
            return [
                f"facade raised {exc!r}, expected "
                f"{expect['throws_contains']!r} in the message"
            ]
        return ["facade: expected an error, none raised"]
    value = await method(*args)
    if "value" in expect and value != expect["value"]:
        return [f"facade value {value!r}, expected {expect['value']!r}"]
    return []


def _check(
    case_id: str,
    label: str,
    expect: dict[str, Any],
    exit_code: int,
    stdout: str,
    stderr: str,
) -> list[str]:
    problems = []
    if "exit" in expect and exit_code != expect["exit"]:
        problems.append(
            f"exit: expected {expect['exit']}, got {exit_code} "
            f"(stderr {stderr[-300:]!r})"
        )
    if "stdout" in expect and stdout != expect["stdout"]:
        problems.append(
            f"stdout: expected {expect['stdout']!r}, got {stdout!r}"
        )
    if "stdout_contains" in expect and expect["stdout_contains"] not in stdout:
        problems.append(
            f"stdout missing {expect['stdout_contains']!r}: got {stdout!r}"
        )
    if "stderr" in expect and stderr != expect["stderr"]:
        problems.append(
            f"stderr: expected {expect['stderr']!r}, got {stderr!r}"
        )
    if "stderr_contains" in expect and expect["stderr_contains"] not in stderr:
        problems.append(
            f"stderr missing {expect['stderr_contains']!r}: got {stderr!r}"
        )
    return [f"{case_id} {label}: {p}" for p in problems]


async def _run_parallel(
    ws: Workspace, case_id: str, index: int, branches: list[dict[str, Any]]
) -> list[str]:
    """Run each branch on a session of its own, all at once.

    The branches start together, so their ops reach the mounts
    interleaved as two agents' would, and each is checked against its
    own ``expect``. A branch cannot check the ledger: the workspace
    keeps one, and every branch's ops land in it.

    Args:
        ws (Workspace): the workspace under test.
        case_id (str): the case, for failure lines.
        index (int): the step's place in the case.
        branches (list[dict[str, Any]]): the steps to run together.
    """
    ledger = [
        f"{case_id} step[{index}].parallel[{k}]: a branch cannot check "
        "the ledger, which holds every branch's ops"
        for k, branch in enumerate(branches)
        if set(branch.get("expect", {})) & LEDGER_CHECKS
    ]
    if ledger:
        return ledger
    runs = []
    for k, branch in enumerate(branches):
        session_id = f"parallel-{index}-{k}"
        ws.create_session(session_id)
        label = f"step[{index}].parallel[{k}]"
        runs.append(_run_step(ws, case_id, label, branch, session_id))
    results = await asyncio.gather(*runs)
    return [problem for problems in results for problem in problems]


async def _run_step(
    ws: Workspace,
    case_id: str,
    label: str,
    step: dict[str, Any],
    session_id: str | None = None,
) -> list[str]:
    expect = step.get("expect", {})
    # The ledger slice this step adds: ws.vfs.records is the one
    # workspace-wide account, so the step's own ops are the tail.
    ledger_before = len(ws.vfs.records)
    if "facade" in step:
        problems = await _run_facade(ws, expect, step["facade"])
        seen = [f"{r.op} {r.path}" for r in ws.vfs.records[ledger_before:]]
        problems.extend(_check_ops(expect, seen))
        return [f"{case_id} {label}: {p}" for p in problems]
    if "s3_put" in step:
        put = step["s3_put"]
        _s3_client().put_object(
            Bucket=BUCKET, Key=put["key"], Body=put["body"].encode()
        )
        return []
    if "add_runtime" in step:
        ws.add_runtime(step["add_runtime"])
        return []
    if "rename" in step:
        spec = step["rename"]
        try:
            await ws.dispatch(
                "rename",
                PathSpec.from_str_path(spec["src"]),
                dst=PathSpec.from_str_path(spec["dst"]),
            )
            errno_name = "NONE"
        except Exception as exc:
            condition = classify(exc)
            errno_name = (
                condition.name if condition is not None else type(exc).__name__
            )
        if errno_name != expect.get("errno", "NONE"):
            return [
                f"{case_id} {label}: rename errno {errno_name}, "
                f"expected {expect.get('errno')}"
            ]
        return []
    if "read_op" in step:
        # Reads through the op door (the surface FUSE and programmatic
        # access share), where pre_vfs/post_vfs policies fire.
        content = ""
        try:
            result, _ = await ws.dispatch(
                "read", PathSpec.from_str_path(step["read_op"])
            )
            errno_name = "NONE"
            content = bytes(result).decode()
        except PermissionError:
            errno_name = "EACCES"
        problems = []
        if errno_name != expect.get("errno", "NONE"):
            problems.append(
                f"read_op errno {errno_name}, "
                f"expected {expect.get('errno', 'NONE')}"
            )
        if "content" in expect and content != expect["content"]:
            problems.append(
                f"read_op content {content!r}, expected {expect['content']!r}"
            )
        return [f"{case_id} {label}: {p}" for p in problems]
    command = step["command"]
    if "script" in step:
        source = (
            SUITE_DIR.parent / "fixtures" / "runtime" / step["script"]
        ).read_text()
        command += " " + shlex.quote(source)
    kwargs: dict[str, Any] = {}
    if session_id is not None:
        kwargs["session_id"] = session_id
    if "runtime" in step:
        kwargs["runtime"] = step["runtime"]
    if "stdin" in step:
        kwargs["stdin"] = step["stdin"].encode()
    if "throws_contains" in expect:
        try:
            await ws.shell(command, **kwargs)
        except Exception as exc:
            if expect["throws_contains"] in str(exc):
                return []
            return [
                f"{case_id} {label}: raised {exc!r}, expected "
                f"{expect['throws_contains']!r} in the message"
            ]
        return [f"{case_id} {label}: expected an error, none raised"]
    result = await ws.shell(command, **kwargs)
    stdout = await result.stdout_str()
    stderr = await result.stderr_str()
    problems = _check(case_id, label, expect, result.exit_code, stdout, stderr)
    seen = [f"{r.op} {r.path}" for r in ws.vfs.records[ledger_before:]]
    problems.extend(
        f"{case_id} {label}: {p}" for p in _check_ops(expect, seen)
    )
    return problems


def _overlay(step: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    """The step with its ``expect_on`` entries for ``keys`` laid over
    ``expect`` in order, a parallel step's branches each the same way.

    Args:
        step (dict[str, Any]): the step as the variant holds it.
        keys (list[str]): the ``expect_on`` keys that apply, weakest
            first.
    """
    on = step.get("expect_on", {})
    expect = dict(step.get("expect", {}))
    for key in keys:
        expect.update(on.get(key, {}))
    overlaid = {**step, "expect": expect}
    if "parallel" in step:
        overlaid["parallel"] = [_overlay(b, keys) for b in step["parallel"]]
    return overlaid


def _step_for(
    step: dict[str, Any], language: str | None
) -> tuple[dict[str, Any] | None, bool]:
    """One step as a runtime of ``language`` runs it, and whether it
    holds a guest program; None when nothing in it runs there.

    A ``program`` (inline source) or ``script`` (a fixture path) maps a
    guest language to what that language runs, under ``python3 -c`` or
    ``node -e``, and a ``command`` map gives the whole line per
    language. An ``expect`` keyed by language, as ``program`` is, gives
    each language its own answer. A parallel step keeps the branches
    that run there.

    Args:
        step (dict[str, Any]): the step as the suite spells it.
        language (str | None): the runtime's guest language; None for a
            sandbox, which runs the plain lines.
    """
    if "parallel" in step:
        mapped = [_step_for(branch, language) for branch in step["parallel"]]
        branches = [branch for branch, _ in mapped if branch is not None]
        if not branches:
            return None, False
        return {**step, "parallel": branches}, any(g for _, g in mapped)
    key = next(
        (
            k
            for k in ("program", "script", "command")
            if isinstance(step.get(k), dict)
        ),
        None,
    )
    if key is None:
        return step, False
    by_language = step[key]
    if language is None or language not in by_language:
        return None, False
    head = PROGRAM_HEAD[language]
    source = by_language[language]
    step = {k: v for k, v in step.items() if k != "program"}
    if key == "program":
        step["command"] = f"{head} {shlex.quote(source)}"
    elif key == "script":
        step.update(command=head, script=source)
    else:
        step["command"] = source
    expect = step.get("expect", {})
    if expect.keys() & PROGRAM_HEAD.keys():
        step["expect"] = expect.get(language, {})
    return step, True


def _for_runtime(case: dict[str, Any], runtime: str) -> dict[str, Any] | None:
    """The case as one runtime runs it, or None when nothing runs there.

    Each step runs as ``_step_for`` maps it to the runtime's language;
    a step with nothing in that language is left out, and a case left
    with no program is not the runtime's (a sandbox runs the plain
    lines). A step's ``expect_on`` keyed by the runtime, then by
    ``runtime@host``, is what it answers differently, and the case's
    ``filesystem`` entry for it is the capabilities it declares. The
    world runs the runtime from its ``RUNTIME_ENTRY``, with the case's
    ``entry`` captures and config laid over it.

    Args:
        case (dict[str, Any]): the case as the suite spells it.
        runtime (str): one name from the case's ``runtimes``.
    """
    language = RUNTIME_LANGUAGE[runtime]
    steps: list[dict[str, Any]] = []
    programs = 0
    for listed in case["steps"]:
        step, guest = _step_for(listed, language)
        if step is None:
            continue
        programs += guest
        steps.append(_overlay(step, [runtime, f"{runtime}@{HOST}"]))
    if programs == 0 and language is not None:
        return None
    world = copy.deepcopy(case.get("world", {}))
    world["runtimes"] = [_entry(runtime, case.get("entry", {})), "workspace"]
    variant = {
        **case,
        "id": f"{case['id']}@{runtime}",
        "runtime": runtime,
        "world": world,
        "steps": steps,
        "requires": case.get("requires", []) + RUNTIME_REQUIRES[runtime],
        "optional": runtime in OPTIONAL_RUNTIMES,
    }
    if runtime in case.get("filesystem", {}):
        variant["filesystem"] = {runtime: case["filesystem"][runtime]}
    else:
        variant.pop("filesystem", None)
    return variant


def _entry(runtime: str, override: dict[str, Any]) -> Any:
    """The world entry for one runtime of a case's matrix.

    Args:
        runtime (str): the runtime's name.
        override (dict[str, Any]): the case's ``entry``: ``captures``
            replace the runtime's, ``config`` keys join its config.
    """
    base = RUNTIME_ENTRY.get(runtime, {})
    if not base and not override:
        return runtime
    entry = {"name": runtime, **base, **override}
    if "config" in base or "config" in override:
        entry["config"] = {
            **base.get("config", {}),
            **override.get("config", {}),
        }
    return entry


def _variants(case: dict[str, Any]) -> list[dict[str, Any]]:
    """The case once per runtime and backend it names.

    A case lists ``runtimes`` to pin that one behavior holds whatever
    guest runs it (see ``_for_runtime``), and ``backends`` to pin that it
    holds whatever serves the mount: each backend variant replaces every
    ``ram`` mount with that backend (an S3 one under a key prefix of its
    own, so variants never see each other's objects). Each variant takes
    its runtime's and backend's requirements. A step's ``expect_on``
    keyed by the backend, then by ``runtime@backend``, holds what that
    variant answers differently, merged over its ``expect`` for it only.

    Args:
        case (dict[str, Any]): the case as the suite spells it.
    """
    if "runtimes" in case:
        unknown = [r for r in case["runtimes"] if r not in RUNTIME_LANGUAGE]
        if unknown:
            raise ValueError(f"{case['id']}: unknown runtimes {unknown}")
        only = {
            r for r in os.environ.get("INTEG_RUNTIMES", "").split(",") if r
        }
        variants = []
        for runtime in case["runtimes"]:
            if runtime not in RUNTIME_REQUIRES or (
                only and runtime not in only
            ):
                continue
            variant = _for_runtime(case, runtime)
            if variant is not None:
                variants.extend(_backend_variants(variant))
        return variants
    return _backend_variants(case)


def _backend_variants(case: dict[str, Any]) -> list[dict[str, Any]]:
    backends = case.get("backends")
    if backends is None:
        return [case]
    variants = []
    for backend in backends:
        world = copy.deepcopy(case.get("world", {}))
        for spec in world.get("mounts", {}).values():
            if spec.get("vfs") == "ram":
                spec["vfs"] = backend
                spec["scoped"] = True
        variants.append(
            {
                **case,
                "id": f"{case['id']}@{backend}",
                "backend": backend,
                "world": world,
                "requires": case.get("requires", [])
                + BACKEND_REQUIRES[backend],
            }
        )
    return variants


async def _remove_roots(ws: Workspace) -> None:
    """Remove the directory each disk and ssh backend mount was given.

    Args:
        ws (Workspace): the case's workspace, still open, since an ssh
            root goes over the mount's own connection.
    """
    for entry in ws.mounts():
        vfs = entry.vfs
        if vfs.name == "disk":
            await asyncio.to_thread(shutil.rmtree, vfs.root)
        elif vfs.name == "ssh":
            sftp = await vfs.accessor.sftp()
            await sftp.rmtree(vfs.config.root)


async def _run_case(suite: str, case: dict[str, Any]) -> list[str]:
    case_id = f"{suite}/{case['id']}"
    world = case.get("world", {})
    run_id = uuid.uuid4().hex[:8]
    if "build_error" in case:
        try:
            ws = await _build_workspace(world, run_id)
        except Exception as exc:
            if case["build_error"]["contains"] in str(exc):
                return []
            return [
                f"{case_id}: build raised {exc!r}, expected "
                f"{case['build_error']['contains']!r} in the message"
            ]
        await ws.close()
        return [f"{case_id}: expected the world build to fail"]
    ws = await _build_workspace(world, run_id)
    problems: list[str] = []
    try:
        runtimes = {runtime.name: runtime for runtime in ws.runtimes()}
        for name, operations in case.get("filesystem", {}).items():
            supported = runtimes[name].capabilities.filesystem
            for operation, expected in operations.items():
                if (operation in supported) != expected:
                    problems.append(
                        f"{case_id}: {name} filesystem {operation}: "
                        f"expected {expected}, got {operation in supported}"
                    )
        backend = case.get("backend")
        keys = [] if backend is None else [backend]
        if backend is not None and "runtime" in case:
            keys.append(f"{case['runtime']}@{backend}")
        for index, step in enumerate(case["steps"]):
            step = _overlay(step, keys)
            if "parallel" in step:
                problems.extend(
                    await _run_parallel(ws, case_id, index, step["parallel"])
                )
            else:
                label = f"step[{index}]"
                problems.extend(await _run_step(ws, case_id, label, step))
    finally:
        try:
            await _remove_roots(ws)
        finally:
            await ws.close()
    return problems


async def main() -> int:
    only = set(sys.argv[1:])
    strict = os.environ.get("INTEG_RUNTIME_STRICT") == "1"
    passed = failed = skipped = 0
    failures: list[str] = []
    for path in sorted(SUITE_DIR.rglob("*.json")):
        suite = json.loads(path.read_text())
        name = path.relative_to(SUITE_DIR).with_suffix("").as_posix()
        if only and not any(
            name == o or name.startswith(f"{o}/") for o in only
        ):
            continue
        requires = suite.get("requires", {})
        if isinstance(requires, list):
            host_requires = requires
        else:
            host_requires = requires.get(HOST, [])
        unmet = [r for r in host_requires if not _requirement_met(r)]
        if unmet:
            if strict and not suite.get("optional", False):
                failures.append(
                    f"{name}: unmet requirements {unmet} "
                    "(INTEG_RUNTIME_STRICT=1)"
                )
                failed += 1
            else:
                print(f"skip {name} (unmet: {', '.join(unmet)})")
                skipped += 1
            continue
        for listed in suite["cases"]:
            if HOST not in listed.get("hosts", ["python", "typescript"]):
                continue
            for case in _variants(listed):
                unmet = [
                    r
                    for r in case.get("requires", [])
                    if not _requirement_met(r)
                ]
                if unmet:
                    if strict and not case.get("optional", False):
                        failures.append(
                            f"{name}/{case['id']}: unmet requirements {unmet} "
                            "(INTEG_RUNTIME_STRICT=1)"
                        )
                        failed += 1
                    else:
                        print(
                            f"skip {name}/{case['id']} (unmet: {', '.join(unmet)})"
                        )
                    continue
                problems = await _run_case(name, case)
                if problems:
                    failed += 1
                    failures.extend(problems)
                    print(f"FAIL {name}/{case['id']}")
                else:
                    passed += 1
                    print(f"ok {name}/{case['id']}")
    if _moto_server is not None:
        _moto_server.stop()
    print(f"\n{passed} passed, {failed} failed, {skipped} suites skipped")
    for line in failures:
        print(f"  {line}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

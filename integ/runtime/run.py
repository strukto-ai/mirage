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

_INTEG_DIR = str(Path(__file__).parent.parent)
sys.path[:] = [p for p in sys.path if p not in (_INTEG_DIR, "")]

import asyncio  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import uuid  # noqa: E402
from typing import Any  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.commands.cli.types import CLISpec  # noqa: E402
from mirage.errors import classify  # noqa: E402
from mirage.policy import Policy  # noqa: E402
from mirage.policy.types import CommandContext  # noqa: E402
from mirage.policy.types import Deny  # noqa: E402
from mirage.policy.types import ExecuteResultContext  # noqa: E402
from mirage.policy.types import OpsContext  # noqa: E402
from mirage.policy.types import OpsResultContext  # noqa: E402
from mirage.runtime.base import Runtime  # noqa: E402
from mirage.runtime.mixin import LineExecutorMixin  # noqa: E402
from mirage.runtime.routing import ScriptSource  # noqa: E402
from mirage.runtime.table import build_runtime  # noqa: E402
from mirage.runtime.table import register_runtime  # noqa: E402
from mirage.runtime.types import RunResult  # noqa: E402
from mirage.types import Limit, PathSpec  # noqa: E402

HOST = "python"
SUITE_DIR = Path(__file__).parent
DB = "mirage_integ_runtime"
BUCKET = "mirage-integ-runtime"

_moto_server: Any = None
_s3_endpoint: str | None = None
_mongo_seeded = False


class EchoBox(Runtime, LineExecutorMixin):
    """A test-only whole-line runtime: echoes the raw line back."""

    name = "echobox"
    captures = ("nvidia-smi", )

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        return RunResult(stdout=f"box:{line}\n".encode(),
                         stderr=None,
                         exit_code=0)


# Registered the way a host registers its own runtime, so a case names
# it by string like a builtin, `build_runtime` resolves it, and the
# unknown-name refusal lists it. The registry suite pins that door.
register_runtime(EchoBox.name, EchoBox)

RUNTIME_KINDS: dict[str, type[Runtime]] = {EchoBox.name: EchoBox}


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


class LockWrites(Policy):
    """Test-only pre_ops policy: refuse write ops under a prefix."""

    HOOK = "pre_ops"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._prefix = spec["prefix"]

    def decide(self, ctx: OpsContext) -> Deny | None:
        if ctx.write and ctx.path.virtual.startswith(self._prefix):
            return Deny("locked")
        return None


class SealReads(Policy):
    """Test-only pre_ops policy: refuse read ops on a path suffix."""

    HOOK = "pre_ops"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._suffix = spec["suffix"]

    def decide(self, ctx: OpsContext) -> Deny | None:
        if not ctx.write and ctx.path.virtual.endswith(self._suffix):
            return Deny("sealed")
        return None


class RedactReads(Policy):
    """Test-only post_ops policy: refuse read results holding a marker."""

    HOOK = "post_ops"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._marker = spec["marker"].encode()

    def decide(self, ctx: OpsResultContext) -> Deny | None:
        data = ctx.result if isinstance(ctx.result,
                                        (bytes, bytearray)) else None
        if ctx.op == "read" and data is not None and self._marker in data:
            return Deny("redacted")
        return None


class OpReadCap(Policy):
    """Test-only post_ops policy: cap read bytes on a path suffix."""

    HOOK = "post_ops"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._suffix = spec["suffix"]
        self._max_bytes = spec["max_bytes"]

    def decide(self, ctx: OpsResultContext) -> Limit | None:
        if ctx.op == "read" and ctx.path.virtual.endswith(self._suffix):
            return Limit(max_bytes=self._max_bytes)
        return None


class LineCap(Policy):
    """Test-only post_execute policy: bound every line's output."""

    HOOK = "post_execute"

    def __init__(self, spec: dict[str, Any]) -> None:
        self._limit = Limit(**{
            k: v
            for k, v in spec.items() if k not in ("name", "sync")
        })

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
    shaped = type(base.__name__, (base, ), {base.HOOK: hook})
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
        return re.sub(r"\$\{([A-Z0-9_]+)\}",
                      lambda m: os.environ.get(m.group(1), ""), value)
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


def _s3_config() -> Any:
    from mirage.resource.s3 import S3Config
    endpoint = _ensure_s3()
    return S3Config(bucket=BUCKET,
                    region="us-east-1",
                    endpoint_url=endpoint,
                    aws_access_key_id="testing",
                    aws_secret_access_key="testing",
                    path_style=True)


def _s3_client() -> Any:
    import boto3
    endpoint = _ensure_s3()
    return boto3.client("s3",
                        region_name="us-east-1",
                        endpoint_url=endpoint,
                        aws_access_key_id="testing",
                        aws_secret_access_key="testing")


def _ensure_s3() -> str:
    """Start the in-process moto server once and seed the bucket."""
    global _moto_server, _s3_endpoint
    if _s3_endpoint is not None:
        return _s3_endpoint
    from moto.server import ThreadedMotoServer
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    _moto_server = ThreadedMotoServer(ip_address="127.0.0.1",
                                      port=0,
                                      verbose=False)
    _moto_server.start()
    host, port = _moto_server.get_host_and_port()
    _s3_endpoint = f"http://{host}:{port}"
    import boto3
    client = boto3.client("s3",
                          region_name="us-east-1",
                          endpoint_url=_s3_endpoint,
                          aws_access_key_id="testing",
                          aws_secret_access_key="testing")
    client.create_bucket(Bucket=BUCKET)
    client.put_object(Bucket=BUCKET,
                      Key="greeting.txt",
                      Body=b"hello from s3\n")
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
        await db["books"].insert_many([{
            "_id": 1,
            "title": "alpha"
        }, {
            "_id": 2,
            "title": "beta"
        }])
        await db["authors"].insert_many([{"_id": 1, "name": "ada"}])
    finally:
        await client.close()
    _mongo_seeded = True


async def _build_resource(spec: dict[str, Any], run_id: str) -> Any:
    kind = spec["resource"]
    if kind == "ram":
        from mirage.resource.ram import RAMResource
        return RAMResource()
    if kind == "redis":
        from mirage.resource.redis import RedisResource
        return RedisResource(url=os.environ["REDIS_URL"],
                             key_prefix=f"mirage-integ-runtime-{run_id}/")
    if kind == "s3":
        from mirage.resource.s3 import S3Resource
        return S3Resource(_s3_config())
    if kind == "mongodb":
        from mirage.resource.mongodb import MongoDBConfig, MongoDBResource
        await _ensure_mongo()
        return MongoDBResource(config=MongoDBConfig(
            uri=os.environ["MONGODB_URI"], databases=[DB]))
    raise ValueError(f"unknown resource kind: {kind!r}")


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
        spec = CLISpec(name=name,
                       script=ScriptSource(entry["script"],
                                           language=entry.get(
                                               "language", "python")),
                       runtime=entry.get("runtime"))
        ws.register_cli(name, spec, entry.get("config"))


async def _build_workspace(world: dict[str, Any], run_id: str) -> Workspace:
    _register_runtimes(world.get("register_runtimes", {}))
    mounts: dict[str, Any] = {}
    seeds: list[tuple[str, str, bytes]] = []
    mount_specs = world.get("mounts", {"/ram": {"resource": "ram"}})
    for prefix, spec in mount_specs.items():
        resource = await _build_resource(spec, run_id)
        guards = {
            cmd: Limit(**kwargs)
            for cmd, kwargs in spec.get("limits", {}).items()
        }
        mounts[prefix] = (resource, MountMode.EXEC,
                          guards) if guards else resource
        for name, content in spec.get("files", {}).items():
            seeds.append((prefix, name, content.encode()))
    kwargs: dict[str, Any] = {}
    if "runtimes" in world:
        kwargs["runtimes"] = [_build_entry(e) for e in world["runtimes"]]
    if "route_policy" in world:
        kwargs["route_policy"] = ScriptSource(world["route_policy"])
    if "policies" in world:
        kwargs["policies"] = [_build_policy(s) for s in world["policies"]]
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
        await ws.dispatch("write",
                          PathSpec.from_str_path(f"{prefix}/{name}"),
                          data=data)
    return ws


def _check_ops(expect: dict[str, Any], seen: list[str]) -> list[str]:
    """Ledger expectations for one step, against the ops it added.

    Args:
        expect (dict[str, Any]): the step's expect block; ``ops_contain``
            and ``ops_absent`` hold ``"<op> <path>"`` strings.
        seen (list[str]): the records the step appended, one
            ``"<op> <path>"`` string per record, in arrival order.
    """
    problems = []
    for entry in expect.get("ops_contain", []):
        if entry not in seen:
            problems.append(f"ledger missing {entry!r}: got {seen!r}")
    for entry in expect.get("ops_absent", []):
        if entry in seen:
            problems.append(f"ledger must not hold {entry!r}: got {seen!r}")
    return problems


async def _run_facade(ws: Workspace, expect: dict[str, Any],
                      spec: dict[str, Any]) -> list[str]:
    """One facade step: call a typed Ops convenience and check its value.

    Args:
        ws (Workspace): the workspace under test.
        expect (dict[str, Any]): ``value`` (JSON-comparable result) or
            ``throws_contains``.
        spec (dict[str, Any]): ``method`` (the python facade spelling,
            e.g. ``is_dir``), ``path``, and ``data`` for ``append``.
    """
    method = getattr(ws.fs, spec["method"])
    args: list[Any] = [spec["path"]]
    if "data" in spec:
        args.append(spec["data"].encode())
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
            name = (condition.name
                    if condition is not None else type(exc).__name__)
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


def _check(case_id: str, label: str, expect: dict[str, Any], exit_code: int,
           stdout: str, stderr: str) -> list[str]:
    problems = []
    if "exit" in expect and exit_code != expect["exit"]:
        problems.append(f"exit: expected {expect['exit']}, got {exit_code}")
    if "stdout" in expect and stdout != expect["stdout"]:
        problems.append(f"stdout: expected {expect['stdout']!r}, "
                        f"got {stdout!r}")
    if "stdout_contains" in expect and expect["stdout_contains"] not in stdout:
        problems.append(f"stdout missing {expect['stdout_contains']!r}: "
                        f"got {stdout!r}")
    if "stderr" in expect and stderr != expect["stderr"]:
        problems.append(f"stderr: expected {expect['stderr']!r}, "
                        f"got {stderr!r}")
    if "stderr_contains" in expect and expect["stderr_contains"] not in stderr:
        problems.append(f"stderr missing {expect['stderr_contains']!r}: "
                        f"got {stderr!r}")
    return [f"{case_id} {label}: {p}" for p in problems]


async def _run_step(ws: Workspace, case_id: str, index: int,
                    step: dict[str, Any]) -> list[str]:
    expect = step.get("expect", {})
    label = f"step[{index}]"
    # The ledger slice this step adds: ws.fs.records is the one
    # workspace-wide account, so the step's own ops are the tail.
    ledger_before = len(ws.fs.records)
    if "facade" in step:
        problems = await _run_facade(ws, expect, step["facade"])
        seen = [f"{r.op} {r.path}" for r in ws.fs.records[ledger_before:]]
        problems.extend(_check_ops(expect, seen))
        return [f"{case_id} {label}: {p}" for p in problems]
    if "s3_put" in step:
        put = step["s3_put"]
        _s3_client().put_object(Bucket=BUCKET,
                                Key=put["key"],
                                Body=put["body"].encode())
        return []
    if "add_runtime" in step:
        ws.add_runtime(step["add_runtime"])
        return []
    if "rename" in step:
        spec = step["rename"]
        try:
            await ws.dispatch("rename",
                              PathSpec.from_str_path(spec["src"]),
                              dst=PathSpec.from_str_path(spec["dst"]))
            errno_name = "NONE"
        except FileNotFoundError:
            errno_name = "ENOENT"
        if errno_name != expect.get("errno", "NONE"):
            return [
                f"{case_id} {label}: rename errno {errno_name}, "
                f"expected {expect.get('errno')}"
            ]
        return []
    if "read_op" in step:
        # Reads through the op door (the surface FUSE and programmatic
        # access share), where pre_ops/post_ops policies fire.
        content = ""
        try:
            result, _ = await ws.dispatch(
                "read", PathSpec.from_str_path(step["read_op"]))
            errno_name = "NONE"
            content = bytes(result).decode()
        except PermissionError:
            errno_name = "EACCES"
        problems = []
        if errno_name != expect.get("errno", "NONE"):
            problems.append(f"read_op errno {errno_name}, "
                            f"expected {expect.get('errno', 'NONE')}")
        if "content" in expect and content != expect["content"]:
            problems.append(f"read_op content {content!r}, "
                            f"expected {expect['content']!r}")
        return [f"{case_id} {label}: {p}" for p in problems]
    command = step["command"]
    kwargs: dict[str, Any] = {}
    if "runtime" in step:
        kwargs["runtime"] = step["runtime"]
    if "stdin" in step:
        kwargs["stdin"] = step["stdin"].encode()
    if "throws_contains" in expect:
        try:
            await ws.execute(command, **kwargs)
        except Exception as exc:
            if expect["throws_contains"] in str(exc):
                return []
            return [
                f"{case_id} {label}: raised {exc!r}, expected "
                f"{expect['throws_contains']!r} in the message"
            ]
        return [f"{case_id} {label}: expected an error, none raised"]
    result = await ws.execute(command, **kwargs)
    stdout = await result.stdout_str()
    stderr = await result.stderr_str()
    problems = _check(case_id, label, expect, result.exit_code, stdout, stderr)
    seen = [f"{r.op} {r.path}" for r in ws.fs.records[ledger_before:]]
    problems.extend(f"{case_id} {label}: {p}"
                    for p in _check_ops(expect, seen))
    return problems


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
        for index, step in enumerate(case["steps"]):
            problems.extend(await _run_step(ws, case_id, index, step))
    finally:
        await ws.close()
    return problems


async def main() -> int:
    only = set(sys.argv[1:])
    strict = os.environ.get("INTEG_RUNTIME_STRICT") == "1"
    passed = failed = skipped = 0
    failures: list[str] = []
    for path in sorted(SUITE_DIR.glob("*.json")):
        suite = json.loads(path.read_text())
        name = suite["suite"]
        if only and name not in only:
            continue
        requires = suite.get("requires", {})
        if isinstance(requires, list):
            host_requires = requires
        else:
            host_requires = requires.get(HOST, [])
        unmet = [r for r in host_requires if not _requirement_met(r)]
        if unmet:
            if strict and not suite.get("optional", False):
                failures.append(f"{name}: unmet requirements {unmet} "
                                "(INTEG_RUNTIME_STRICT=1)")
                failed += 1
            else:
                print(f"skip {name} (unmet: {', '.join(unmet)})")
                skipped += 1
            continue
        for case in suite["cases"]:
            if HOST not in case.get("hosts", ["python", "typescript"]):
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

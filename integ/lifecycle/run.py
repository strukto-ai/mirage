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
"""Host-side workspace lifecycle cases shared with both TypeScript wrappers.

The JSON supplies workspace settings, ordered API actions and expected
results. Filesystem facade checks exercise the dispatcher even when a
shell command can answer directly through a backend's command handler.
"""

import asyncio
import errno
import json
import sys
from contextlib import aclosing
from pathlib import Path
from typing import Any

from mirage import ShellExecution
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.cli.types import CLI, CLIHandler, CLIInvocation
from mirage.commands.spec.types import CommandSpec
from mirage.config import load_config
from mirage.context import reset_current_session, set_current_session
from mirage.errors import classify
from mirage.io.cooperative import chunks
from mirage.io.types import IOResult
from mirage.policy import Policy, PolicyDenied
from mirage.policy.match import Outcome
from mirage.policy.types import (
    Ask,
    CommandContext,
    CommandExplanation,
    Deny,
    Route,
    Scope,
    SessionContext,
    ShellExplanation,
    ShellNode,
    VfsContext,
    VfsExplanation,
)
from mirage.process.types import SpawnRequest
from mirage.runtime.routing import RouteContext
from mirage.runtime.types import ScriptSource
from mirage.server import io_serde
from mirage.server.vfs_calls import VFS_CALL_BY_NAME
from mirage.shell.console import Channel, JobConsole
from mirage.types import MountMode, PathSpec
from mirage.utils.abort import MirageAbortError
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs, register_vfs
from mirage.workspace import Session, Workspace
from mirage.workspace.snapshot import apply_state_dict, to_state_dict

SUITE = Path(__file__).with_name("cases.json")


class CachedRAMVFS(RAMVFS):
    """A local fixture exercising the same read cache as remote mounts."""

    caches_reads = True

    def __init__(self, files: dict[str, str] | None = None) -> None:
        super().__init__()
        self.load_state(
            {
                "files": {
                    path: data.encode() for path, data in (files or {}).items()
                }
            }
        )


register_vfs("cached-ram", CachedRAMVFS)


class TrackedStreamVFS(CachedRAMVFS):
    """A chunked source whose pull and close counts are shared corpus assertions."""

    def __init__(
        self,
        files: dict[str, str] | None = None,
        chunk_size: int = 16384,
        fail_after: int | None = None,
        stall_after: int | None = None,
        repeat: int = 1,
    ) -> None:
        super().__init__(
            {path: data * repeat for path, data in (files or {}).items()}
        )
        self.chunk_size = chunk_size
        self.fail_after = fail_after
        self.stall_after = stall_after
        self.pulls = 0
        self.closed = 0

    async def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ):
        data = await super().read(path, index)
        try:
            for offset in range(0, len(data), self.chunk_size):
                self.pulls += 1
                if (
                    self.stall_after is not None
                    and offset // self.chunk_size >= self.stall_after
                ):
                    await asyncio.Event().wait()
                if (
                    self.fail_after is not None
                    and offset // self.chunk_size >= self.fail_after
                ):
                    raise OSError("stream tail fetched")
                yield data[offset : offset + self.chunk_size]
        finally:
            self.closed += 1


register_vfs("tracked-stream", TrackedStreamVFS)


class TrackedStreamCLI:
    """A registered CLI exercising stdin, deferred status, and producer closure."""

    def __init__(
        self, exit_code: int = 0, stderr: str = "", writer: bool = False
    ) -> None:
        self.exit_code = exit_code
        self.writer = writer
        self.stderr = stderr.encode()
        self.pulls = 0
        self.closed = 0

    async def invoke(self, inv: CLIInvocation):
        if self.writer:
            assert inv.stdio is not None
            try:
                async for chunk in inv.stdio.stdin:
                    self.pulls += 1
                    await inv.stdio.stdout.write(chunk)
                await inv.stdio.stderr.write(self.stderr)
                return IOResult(exit_code=self.exit_code)
            finally:
                self.closed += 1
        result = IOResult(stderr=self.stderr)
        return self.output(inv, result), result

    async def output(self, inv: CLIInvocation, result: IOResult):
        try:
            async with aclosing(chunks(inv.stdin or b"")) as source:
                async for chunk in source:
                    self.pulls += 1
                    yield chunk
            result.exit_code = self.exit_code
        finally:
            self.closed += 1


class RulePolicy(Policy):
    """A host policy whose command and op refusals are supplied by JSON."""

    def __init__(self, rule: dict[str, Any]) -> None:
        self.rule = rule

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        if ctx.command in self.rule.get("commands", []):
            return Deny(self.rule["reason"])
        return None

    async def pre_vfs(self, ctx: VfsContext) -> Deny | None:
        if ctx.path.virtual in self.rule.get("paths", []):
            return Deny(self.rule["reason"])
        return None

    async def pre_session(self, ctx: SessionContext) -> Deny | None:
        if ctx.key in self.rule.get("vars", []):
            return Deny(self.rule["reason"])
        return None

    async def pre_execute(self, ctx: RouteContext) -> Deny | Route | None:
        if any(word in ctx.line for word in self.rule.get("lines", [])):
            return Deny(self.rule["reason"])
        for word, runtime in self.rule.get("routes", {}).items():
            if word in ctx.line:
                return Route(runtime)
        return None


def answered(answers: tuple[Deny | Ask | Route, ...]) -> list[dict[str, Any]]:
    """Each policy answer as a case pins it: its kind, who gave it, and
    its reason or the runtime it names."""
    return [
        {
            "kind": a.kind,
            "policy": a.policy,
            **(
                {"runtime": a.runtime}
                if isinstance(a, Route)
                else {"reason": a.reason}
            ),
        }
        for a in answers
    ]


def explained(expl: ShellExplanation | VfsExplanation) -> dict[str, Any]:
    """An explanation as a case pins it: a VFS call's verdict, or a
    line's with its commands in the order the line reads them."""
    verdict = {
        "outcome": expl.outcome.value,
        "reason": expl.reason,
        "answers": answered(expl.answers),
        "refusal": expl.refusal.kind if expl.refusal is not None else None,
    }
    if isinstance(expl, VfsExplanation):
        return {"call": expl.call, **verdict, "error": expl.error}
    return {
        **verdict,
        "exit_code": expl.exit_code,
        "stderr": expl.stderr,
        "commands": [
            {
                "command": c.command,
                "outcome": c.outcome.value,
                "answers": answered(c.answers),
                "runtime": c.runtime,
            }
            for c in commands_of(expl.node)
        ],
    }


def commands_of(
    node: ShellNode | CommandExplanation,
) -> list[CommandExplanation]:
    """Every command under a node of a line's tree, in source order."""
    mine = [node] if isinstance(node, CommandExplanation) else []
    return mine + [c for child in node.children for c in commands_of(child)]


class SlowSink(JobConsole):
    """A caller streaming a line that takes a while over each chunk.

    Args:
        delay (float): seconds per chunk.
    """

    def __init__(self, delay: float) -> None:
        super().__init__()
        self.delay = delay

    async def emit(self, channel: Channel, data: bytes) -> None:
        await asyncio.sleep(self.delay)
        await super().emit(channel, data)


def profile_document(raw: dict[str, Any]) -> dict[str, Any]:
    """Embed a JSON policy program as the ordinary config loader does."""
    doc = dict(raw)
    if doc.get("policy") is not None:
        policy = dict(doc["policy"])
        policy["script"] = ScriptSource(**policy["script"])
        doc["policy"] = policy
    return doc


async def action(
    ws: Workspace,
    step: dict[str, Any],
    policies: dict[str, RulePolicy],
    held: dict[str, Any],
) -> Any:
    """Run one host API action; no shell command mutates the mount table.

    Args:
        ws (Workspace): the scenario's workspace.
        step (dict[str, Any]): the action document.
        policies (dict[str, RulePolicy]): the coded policies registered
            so far, by id.
        held (dict[str, Any]): what earlier steps put aside for later
            ones; ``snapshot`` stores the state dict ``checkout`` applies.
    """
    op = step["op"]
    if op == "register_stream_cli":
        cli = TrackedStreamCLI(
            step.get("exit_code", 0),
            step.get("stderr", ""),
            step.get("writer", False),
        )
        held.setdefault("stream_clis", {})[step["name"]] = cli
        ws.register_cli(
            step["name"],
            CLI(
                spec=CommandSpec(name=step["name"]),
                handlers={"": CLIHandler(fn=cli.invoke)},
            ),
        )
        return None
    if op == "stream_cli_stats":
        cli = held["stream_clis"][step["name"]]
        return {"pulls": cli.pulls, "closed": cli.closed}
    if op == "stream_stats":
        vfs = ws.mount(step["path"]).vfs
        assert isinstance(vfs, TrackedStreamVFS)
        return {"pulls": vfs.pulls, "closed": vfs.closed}
    if op == "cached":
        value = await ws.cache.get(step["path"])
        return value.decode() if value is not None else None
    if op in {"read", "write", "readdir", "stat"} and "session" in step:
        token = set_current_session(ws.get_session(step["session"]))
        try:
            return await action(
                ws,
                {k: v for k, v in step.items() if k != "session"},
                policies,
                held,
            )
        finally:
            reset_current_session(token)
    if op == "mount":
        vfs = build_vfs(step["vfs"], step.get("config", {}))
        try:
            return ws.add_mount(
                step["path"], vfs, MountMode(step.get("mode", "read"))
            ).prefix
        except Exception:
            await vfs.close()
            raise
    if op == "unmount":
        await ws.unmount(step["path"])
    elif op == "set_mode":
        ws.set_mount_mode(step["path"], MountMode(step["mode"]))
    elif op == "session":
        ws.create_session(
            step["id"], profile=profile_document(step.get("profile", {}))
        )
    elif op == "close_session":
        await ws.close_session(step["id"])
    elif op == "set_profile":
        raw = step["profile"]
        profile = profile_document(raw) if isinstance(raw, dict) else raw
        await ws.set_session_profile(
            step.get("session", ws.default_session_id), profile
        )
    elif op == "register_cli":
        ws.register_cli(
            step["name"],
            CLI(
                spec=CommandSpec(name=step["name"]),
                script=ScriptSource(**step["script"]),
                runtime=step.get("runtime"),
            ),
            step.get("config"),
        )
    elif op == "unregister_cli":
        ws.unregister_cli(step["name"])
    elif op == "clis":
        return sorted(ws.clis())
    elif op == "add_runtime":
        return ws.add_runtime(step["name"]).name
    elif op == "remove_runtime":
        await ws.remove_runtime(step["name"])
    elif op == "runtimes":
        return [entry.name for entry in ws.runtimes()]
    elif op == "register_policy":
        if step["id"] in policies:
            raise ValueError("policy already registered")
        policy = RulePolicy(step)
        ws.policies.add(policy)
        policies[step["id"]] = policy
    elif op == "unregister_policy":
        policy = policies.pop(step["id"], None)
        return ws.policies.remove(policy) if policy is not None else False
    elif op == "write":
        await ws.vfs.write(step["path"], step["data"].encode())
    elif op == "read":
        return (await ws.vfs.read(step["path"])).decode()
    elif op == "readdir":
        return sorted(await ws.vfs.readdir(step["path"]))
    elif op == "stat":
        row = await ws.vfs.stat(step["path"])
        return {"type": row.type.value, "size": row.size}
    elif op == "drain_processes":
        await ws.processes.drain()
    elif op == "spawn":
        child = ws.spawn(
            SpawnRequest(tuple(step["argv"])), step.get("session")
        )
        child.stdin.close()
        return child.pid
    elif op == "stream_exec":
        session = Session(ws, step.get("session"))
        execution: ShellExecution = await session.shell(
            step["command"], stream=True
        )
        completion = asyncio.create_task(execution.wait())
        events = []
        first_before_done = False
        value = {}
        try:
            async for event in execution.events:
                if not events:
                    first_before_done = not completion.done()
                events.append(
                    {"stream": event.stream, "data": list(event.data)}
                )
                if "consume_delay_ms" in step:
                    await asyncio.sleep(step["consume_delay_ms"] / 1000)
                if step.get("stop") == "cancel":
                    execution.cancel()
                    break
                if step.get("stop") == "close":
                    await execution.aclose()
                    break
            try:
                result = await completion
                value = {
                    "exit_code": result.exit_code,
                    "stdout": await result.stdout_str(),
                    "stderr": await result.stderr_str(),
                    "refusal": result.refusal.reason
                    if result.refusal
                    else None,
                }
            except MirageAbortError:
                value = {"aborted": True}
        finally:
            await execution.aclose()
            await asyncio.gather(completion, return_exceptions=True)
        return {
            "has_id": bool(execution.id),
            "events": events,
            "bounded": all(len(event["data"]) <= 16384 for event in events),
            "stdout_bytes": sum(
                len(event["data"])
                for event in events
                if event["stream"] == "stdout"
            ),
            "stderr_bytes": sum(
                len(event["data"])
                for event in events
                if event["stream"] == "stderr"
            ),
            "first_before_done": first_before_done,
            **value,
        }
    elif op == "exec":
        cancel = asyncio.Event() if "cancel_after_ms" in step else None
        sink = (
            SlowSink(step["sink_delay_ms"] / 1000)
            if "sink_delay_ms" in step
            else None
        )
        timer = (
            asyncio.get_running_loop().call_later(
                step["cancel_after_ms"] / 1000, cancel.set
            )
            if cancel is not None
            else None
        )
        try:
            result = await ws.shell(
                step["command"],
                session_id=step.get("session"),
                cancel=cancel,
                env=step.get("env"),
                cwd=step.get("cwd"),
                sink=sink,
            )
        except MirageAbortError:
            return {"aborted": True}
        finally:
            if timer is not None:
                timer.cancel()
        value = {
            "exit_code": result.exit_code,
            "stdout": await result.stdout_str(),
            "stderr": await result.stderr_str(),
            "refusal": result.refusal.reason if result.refusal else None,
        }
        if sink is not None:
            value["streamed"] = (await sink.snapshot(Channel.STDOUT)).decode()
        return value
    elif op == "concurrent":
        return list(
            await asyncio.gather(
                *(action(ws, sub, policies, held) for sub in step["steps"])
            )
        )
    elif op == "snapshot":
        held["state"] = await to_state_dict(ws)
    elif op == "checkout":
        # A checkout onto the running workspace: the restored state wins,
        # and every restored variable clears the session gate first.
        await apply_state_dict(ws, held["state"])
    elif op == "mounts":
        return sorted(m.prefix for m in ws.mounts())
    elif op == "tools":
        return list(Session(ws, step.get("session")).tools.names())
    elif op == "tool":
        tools = Session(ws, step.get("session")).tools
        result = await tools.call(step["tool"], step["arguments"])
        return {"text": result.text, "is_error": result.is_error}
    elif op == "asks":
        return [
            {"command": r.command, "paths": list(r.paths), "reason": r.reason}
            for r in ws.decisions.pending(step.get("session", ""))
        ]
    elif op == "answer":
        for record in ws.decisions.pending():
            await ws.decisions.answer(
                record.id,
                Outcome(step.get("outcome", "allow")),
                Scope(step.get("scope", "once")),
            )
    elif op == "explain":
        explain = Session(ws, step.get("session")).explain
        return explained(await explain.shell(step["command"]))
    elif op == "vfs":
        session = Session(ws, step.get("session"))
        call = VFS_CALL_BY_NAME[step["call"]]
        args = io_serde.checked(call, step.get("args", {}))
        if step.get("explain"):
            vfs = session.explain.vfs
            return explained(await getattr(vfs, call.name)(**args))
        return await io_serde.answered(session, call, args, False)
    elif op == "close":
        await ws.close()
    else:
        raise ValueError(f"unknown lifecycle action: {op}")
    return None


async def run(case: dict[str, Any]) -> int:
    """Stop a failed scenario at its first mismatch and always close it."""
    ws = Workspace(**load_config(case["settings"]).to_workspace_kwargs())
    policies: dict[str, RulePolicy] = {}
    held: dict[str, Any] = {}
    try:
        for index, step in enumerate(case["steps"]):
            try:
                actual = {"value": await action(ws, step, policies, held)}
            except Exception as exc:
                actual = {"error": str(exc)}
                condition = classify(exc)
                if isinstance(exc, OSError) and exc.errno is not None:
                    actual["errno"] = errno.errorcode.get(exc.errno)
                elif condition is not None:
                    actual["errno"] = condition.name
                if isinstance(exc, PolicyDenied) and exc.refusal is not None:
                    actual["reason"] = exc.refusal.reason
            expected = step.get("expect", {"value": None})
            if not matches(actual, expected):
                raise AssertionError(
                    f"step {index + 1} ({step['op']}): "
                    f"expected {expected!r}, got {actual!r}"
                )
        return len(case["steps"])
    finally:
        await ws.close()


def matches(actual: Any, expected: Any) -> bool:
    """Objects select fields; error and *_contains assertions select text."""
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(matches(got, want) for got, want in zip(actual, expected))
        )
    if not isinstance(expected, dict):
        return actual == expected
    if not isinstance(actual, dict):
        return False
    for key, want in expected.items():
        field = key.removesuffix("_contains")
        if field not in actual:
            return False
        got = actual[field]
        if key == "error" or key.endswith("_contains"):
            if not isinstance(got, str) or want not in got:
                return False
        elif not matches(got, want):
            return False
    return True


async def main() -> int:
    suite = json.loads(
        (Path(sys.argv[1]) if len(sys.argv) > 1 else SUITE).read_text()
    )
    passed = 0
    steps = 0
    failures = 0
    for case in suite["cases"]:
        try:
            steps += await run(case)
        except Exception as exc:
            failures += 1
            print(f"FAIL python/{case['id']}: {exc}")
        else:
            passed += 1
            print(f"ok python/{case['id']}")
    print(f"{passed} cases / {steps} steps passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

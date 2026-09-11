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
from pathlib import Path
from typing import Any

from mirage.commands.cli.types import CLISpec
from mirage.config import load_config
from mirage.context import reset_current_session, set_current_session
from mirage.errors import classify
from mirage.policy import Policy
from mirage.policy.types import CommandContext, Deny, OpsContext
from mirage.resource.ram import RAMResource
from mirage.resource.registry import build_resource, register_resource
from mirage.runtime.types import ScriptSource
from mirage.types import MountMode
from mirage.workspace import Workspace

SUITE = Path(__file__).with_name("cases.json")


class CachedRAMResource(RAMResource):
    """A local fixture exercising the same read cache as remote resources."""

    caches_reads = True

    def __init__(self, files: dict[str, str] | None = None) -> None:
        super().__init__()
        self.load_state({
            "files": {
                path: data.encode()
                for path, data in (files or {}).items()
            }
        })


register_resource("cached-ram", CachedRAMResource)


class RulePolicy(Policy):
    """A host policy whose command and op refusals are supplied by JSON."""

    def __init__(self, rule: dict[str, Any]) -> None:
        self.rule = rule

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        if ctx.command in self.rule.get("commands", []):
            return Deny(self.rule["reason"])
        return None

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        if ctx.path.virtual in self.rule.get("paths", []):
            return Deny(self.rule["reason"])
        return None


def profile_document(raw: dict[str, Any]) -> dict[str, Any]:
    """Embed a JSON policy program as the ordinary config loader does."""
    doc = dict(raw)
    if doc.get("policy") is not None:
        policy = dict(doc["policy"])
        policy["script"] = ScriptSource(**policy["script"])
        doc["policy"] = policy
    return doc


async def action(ws: Workspace, step: dict[str, Any],
                 policies: dict[str, RulePolicy]) -> Any:
    """Run one host API action; no shell command mutates the mount table."""
    op = step["op"]
    if op == "cached":
        value = await ws.cache.get(step["path"])
        return value.decode() if value is not None else None
    if op in {"read", "write", "readdir", "stat"} and "session" in step:
        token = set_current_session(ws.get_session(step["session"]))
        try:
            return await action(ws, {
                k: v
                for k, v in step.items() if k != "session"
            }, policies)
        finally:
            reset_current_session(token)
    if op == "mount":
        resource = build_resource(step["resource"], step.get("config", {}))
        try:
            return ws.add_mount(step["path"], resource,
                                MountMode(step.get("mode", "read"))).prefix
        except Exception:
            await resource.close()
            raise
    if op == "unmount":
        await ws.unmount(step["path"])
    elif op == "set_mode":
        ws.set_mount_mode(step["path"], MountMode(step["mode"]))
    elif op == "session":
        ws.create_session(step["id"],
                          profile=profile_document(step.get("profile", {})))
    elif op == "set_profile":
        raw = step["profile"]
        profile = profile_document(raw) if isinstance(raw, dict) else raw
        await ws.set_session_profile(
            step.get("session", ws.default_session_id), profile)
    elif op == "register_cli":
        ws.register_cli(
            step["name"],
            CLISpec(name=step["name"],
                    script=ScriptSource(**step["script"]),
                    runtime=step.get("runtime")), step.get("config"))
    elif op == "unregister_cli":
        ws.unregister_cli(step["name"])
    elif op == "clis":
        return sorted(ws.clis())
    elif op == "add_runtime":
        return ws.add_runtime(step["name"]).name
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
        await ws.fs.write(step["path"], step["data"].encode())
    elif op == "read":
        return (await ws.fs.read(step["path"])).decode()
    elif op == "readdir":
        return sorted(await ws.fs.readdir(step["path"]))
    elif op == "stat":
        row = await ws.fs.stat(step["path"])
        return {"type": row.type.value, "size": row.size}
    elif op == "exec":
        result = await ws.execute(step["command"],
                                  session_id=step.get("session"))
        return {
            "exit_code": result.exit_code,
            "stdout": await result.stdout_str(),
            "stderr": await result.stderr_str(),
            "refusal": result.refusal.reason if result.refusal else None,
        }
    elif op == "mounts":
        return sorted(m.prefix for m in ws.mounts())
    elif op == "close":
        await ws.close()
    else:
        raise ValueError(f"unknown lifecycle action: {op}")
    return None


async def run(case: dict[str, Any]) -> int:
    """Stop a failed scenario at its first mismatch and always close it."""
    ws = Workspace(**load_config(case["settings"]).to_workspace_kwargs())
    policies: dict[str, RulePolicy] = {}
    try:
        for index, step in enumerate(case["steps"]):
            try:
                actual = {"value": await action(ws, step, policies)}
            except Exception as exc:
                actual = {"error": str(exc)}
                condition = classify(exc)
                if isinstance(exc, OSError) and exc.errno is not None:
                    actual["errno"] = errno.errorcode.get(exc.errno)
                elif condition is not None:
                    actual["errno"] = condition.name
            expected = step.get("expect", {"value": None})
            if not matches(actual, expected):
                raise AssertionError(f"step {index + 1} ({step['op']}): "
                                     f"expected {expected!r}, got {actual!r}")
        return len(case["steps"])
    finally:
        await ws.close()


def matches(actual: Any, expected: Any) -> bool:
    """Objects select fields; error and *_contains assertions select text."""
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
    suite = json.loads(SUITE.read_text())
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

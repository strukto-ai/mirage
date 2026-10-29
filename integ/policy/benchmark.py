import asyncio
import json
import platform
import resource
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.policy.base import Policy
from mirage.policy.policies import Policies
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    Deny,
    SessionContext,
    VfsContext,
)
from mirage.rs.policy import admission_matcher, units
from mirage.vfs.ram import RAMVFS


class Counter(Policy):
    def __init__(self) -> None:
        self.calls = 0
        self.vfs_calls = 0
        self.session_calls = 0

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        self.calls += 1
        return Deny("benchmark refusal") if ctx.command == "rm" else None

    async def pre_vfs(self, ctx: VfsContext) -> None:
        self.vfs_calls += 1

    async def pre_session(self, ctx: SessionContext) -> None:
        self.session_calls += 1


async def run() -> dict:
    results = []

    async def measure(
        name: str, iterations: int, operation: Callable[[], Awaitable[None]]
    ) -> None:
        first = time.perf_counter()
        await operation()
        first_ms = (time.perf_counter() - first) * 1000
        started = time.perf_counter()
        for _ in range(iterations):
            await operation()
        results.append(
            {
                "name": name,
                "iterations": iterations,
                "first_ms": first_ms,
                "ms": (time.perf_counter() - started) * 1000,
                "errors": 0,
            }
        )

    for size in (4, 256):
        rules = AdmissionRules(
            deny=tuple(
                CommandRule(reason=f"rule {i}", commands=(f"blocked{i}",))
                for i in range(size - 1)
            )
            + (
                CommandRule(
                    reason="protected path",
                    commands=("cat",),
                    paths=("/private/*",),
                ),
            )
        )
        matcher = admission_matcher(rules)
        assert matcher.ask("has_rules") is True

        async def cache() -> None:
            assert admission_matcher(rules) is matcher

        async def equivalent() -> None:
            assert (
                admission_matcher(
                    replace(
                        rules, deny=tuple(replace(rule) for rule in rules.deny)
                    )
                )
                is matcher
            )

        await measure(f"cache_same_{size}", 500, cache)
        await measure(f"cache_equal_{size}", 500, equivalent)
        changed = replace(rules, deny=())
        assert admission_matcher(changed).ask("has_rules") is False
        assert admission_matcher(rules).ask("has_rules") is True
        for count in (1, 256):
            paths = [
                {
                    "virtual_path": units(f"/data/f{i}"),
                    "display_path": units(f"/data/f{i}"),
                }
                for i in range(count)
            ]
            facts = {
                "tokens": [units("cat")],
                "tool": False,
                "cwd": units("/"),
                "paths": paths,
                "operands": paths,
                "walks": False,
                "subtree": False,
                "moves": False,
                "move_target": None,
            }

            denied_path = {
                "virtual_path": units("/private/secret"),
                "display_path": units("/private/secret"),
            }
            denied_paths = [*paths[:-1], denied_path]
            denied_facts = {
                **facts,
                "paths": denied_paths,
                "operands": denied_paths,
            }

            async def request() -> None:
                result = matcher.ask("decide", facts=facts)
                assert (
                    result["outcome"] == "allow"
                    and result["asks"] == []
                    and result["rule"] is None
                )
                denied = matcher.ask("decide", facts=denied_facts)
                assert denied["outcome"] == "deny"
                assert denied["asks"] == []
                assert denied["rule"] == size - 1
                assert denied["matched_path"] == units("/private/secret")

            await measure(f"match_rules_{size}_paths_{count}", 50, request)

    context = CommandContext(command="echo", argv=(), paths=(), cwd="/")
    for count in (0, 4, 64):
        callbacks = [Counter() for _ in range(count)]
        policies = Policies(callbacks)

        async def gate() -> None:
            before = sum(p.calls for p in callbacks)
            assert await policies.pre_command(context) is None
            assert sum(p.calls for p in callbacks) - before == count

        await measure(f"composition_{count}", 100, gate)

    callback = Counter()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[callback],
        profiles={"bench": {"commands": {"deny": ["blocked"]}}},
    )
    ws.create_session("bench", profile="bench")
    try:
        seed = await ws.shell("printf 'alpha\\nbeta\\n' > /data/report")
        assert seed.exit_code == 0
        cases = [
            ("cat /data/report", b"alpha\nbeta\n", b"", 0),
            ("ls /data", b"report\n", b"", 0),
            ("export BENCH=value", b"", b"", 0),
            ("rm /data/report", b"", b"rm: Permission denied\n", 126),
        ]
        for index, (command, stdout, stderr, code) in enumerate(cases):

            async def shell() -> None:
                before = callback.calls
                vfs_before = callback.vfs_calls
                session_before = callback.session_calls
                result = await ws.shell(command, session_id="bench")
                assert (
                    result.exit_code,
                    result.stdout or b"",
                    result.stderr or b"",
                ) == (code, stdout, stderr), (
                    command,
                    result.exit_code,
                    result.stdout,
                    result.stderr,
                )
                if index != 2:
                    assert callback.calls > before
                if index == 0:
                    assert callback.vfs_calls > vfs_before
                if index == 2:
                    assert callback.session_calls > session_before

            await measure(f"shell_{index}", 20, shell)
    finally:
        await ws.close()
    return {
        "host": "python",
        "runtime": platform.python_version(),
        "source": str(Path(__file__).resolve()),
        "max_rss_platform_units": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss,
        "memory_note": (
            "ru_maxrss includes native memory; bytes on macOS, KiB on Linux. "
            "No process memory cap imposed."
        ),
        "samples": results,
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run())))

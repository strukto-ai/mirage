import asyncio
import time

from mirage import MountMode, Workspace
from mirage.process.types import SpawnRequest
from mirage.vfs.ram import RAMVFS

LOG = (
    "09:00 INFO  boot\n"
    "09:01 ERROR disk full on /var\n"
    "09:02 INFO  retry\n"
    "09:03 ERROR disk full on /var\n"
    "09:04 WARN  slow response\n"
    "09:05 ERROR timeout talking to db\n"
)

PROFILES = {
    "agent": {},
    "operator": {"processes": "workspace"},
    "auditor": {"processes": {"list": "workspace"}},
    "sandboxed": {"processes": {"max": 3}},
}


async def sh(ws: Workspace, line: str, session_id: str | None = None) -> str:
    who = f"[{session_id}] " if session_id else ""
    io = await ws.shell(line, session_id=session_id)
    out = await io.stdout_str()
    err = (io.stderr or b"").decode()
    print(f"{who}$ {line}")
    for text in (out, err):
        if text:
            print("  " + text.rstrip("\n").replace("\n", "\n  "))
    return out


async def background_work(ws: Workspace) -> None:
    print("=== 1. background work an agent can manage by PID ===")
    await sh(ws, "sleep 30 & slow=$!; echo slow=$slow")
    await sh(
        ws,
        "{ sleep 0.3; grep -c ERROR /data/app.log; } > /data/errors.txt &"
        " scan=$!; echo scan=$scan",
    )
    await sh(ws, "jobs -l")
    await sh(ws, "ps")
    await sh(ws, 'kill "$slow"; echo "kill exit=$?"')
    await sh(ws, 'wait "$scan"; echo "scan exit=$?"; cat /data/errors.txt')
    await sh(ws, "ps | cat")


async def drive_from_host(ws: Workspace) -> None:
    print("\n=== 2. drive a mirage command from the host like Popen ===")
    child = ws.spawn(SpawnRequest(argv=("grep", "-n", "ERROR")))
    started = time.monotonic()

    async def feed() -> None:
        for line in LOG.splitlines(keepends=True):
            print(
                f"  +{(time.monotonic() - started) * 1000:4.0f}ms stdin  "
                f"{line.rstrip()}"
            )
            await child.stdin.write(line.encode())
            await asyncio.sleep(0.1)
        child.stdin.close()

    writer = asyncio.create_task(feed())
    async for chunk in child.stdout:
        print(
            f"  +{(time.monotonic() - started) * 1000:4.0f}ms stdout "
            f"{chunk.decode().rstrip()}"
        )
    await writer
    info = await child.wait()
    print(f"  grep pid={child.pid} exit={info.exit_code}")

    tally = ws.spawn(
        SpawnRequest(argv=("sh", "-c", "cut -d' ' -f2 | sort | uniq -c"))
    )
    result = await tally.communicate(LOG.encode())
    print("  sh -c 'cut | sort | uniq -c' ->")
    print("  " + result.stdout.decode().rstrip("\n").replace("\n", "\n  "))

    literal = ws.spawn(SpawnRequest(argv=("echo", "$(rm -rf /data)")))
    result = await literal.communicate()
    print(
        "  argv is literal, no shell expansion:",
        result.stdout.decode().rstrip("\n"),
    )

    stuck = ws.spawn(SpawnRequest(argv=("sleep", "30")))
    started = time.monotonic()
    stuck.terminate()
    info = await stuck.wait()
    print(
        f"  terminate sleep 30 -> exit={info.exit_code} "
        f"after {(time.monotonic() - started) * 1000:.0f}ms"
    )


async def scoped_by_profile(ws: Workspace) -> None:
    print("\n=== 3. agents cannot see or kill each other's work ===")
    ws.create_session("agent-a", profile="agent")
    ws.create_session("agent-b", profile="agent")
    ws.create_session("audit", profile="auditor")
    ws.create_session("ops", profile="operator")
    pid = (await sh(ws, "sleep 30 & echo $!", "agent-a")).strip()
    await sh(ws, "ps", "agent-b")
    await sh(ws, f"kill {pid}", "agent-b")
    await sh(ws, "ps", "audit")
    await sh(ws, f"kill {pid}", "audit")
    await sh(ws, f'kill {pid}; echo "kill exit=$?"', "ops")


async def capped_by_profile(ws: Workspace) -> None:
    print("\n=== 4. a process cap stops a runaway loop ===")
    ws.create_session("sandbox", profile="sandboxed")
    await sh(ws, "n=0; while true; do sleep 30 & n=$((n+1)); done", "sandbox")
    await sh(ws, 'echo "status=$? started=$n"; jobs', "sandbox")
    await sh(ws, "kill %1; kill %2", "sandbox")
    await ws.processes.drain()
    await sh(ws, "echo a | tr a b", "sandbox")


async def nothing_outlives_close(ws: Workspace) -> None:
    print("\n=== 5. closing the workspace stops everything it started ===")
    await sh(ws, "sleep 60 &", "agent-a")
    await sh(ws, "sleep 60 | sleep 60 &", "agent-b")
    ws.spawn(SpawnRequest(argv=("sleep", "60")))
    live = [p.info for p in ws.processes.live()]
    print(
        f"  live before close: {len(live)} -> "
        + ", ".join(f"{i.pid}:{i.command}" for i in live)
    )
    started = time.monotonic()
    await ws.close()
    print(
        f"  live after close:  {len(ws.processes.live())} "
        f"(close took {(time.monotonic() - started) * 1000:.0f}ms)"
    )


async def main() -> None:
    vfs = RAMVFS()
    ws = Workspace(
        {"/data": vfs},
        mode=MountMode.WRITE,
        profiles=PROFILES,
        profile="agent",
    )
    await ws.shell(f"printf '%s' '{LOG}' > /data/app.log")
    await background_work(ws)
    await drive_from_host(ws)
    await scoped_by_profile(ws)
    await capped_by_profile(ws)
    await nothing_outlives_close(ws)


if __name__ == "__main__":
    asyncio.run(main())

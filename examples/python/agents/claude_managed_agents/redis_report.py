"""Total a CSV with Claude Managed Agents, working in a Mirage workspace.

A self-hosted environment's worker answers the agent's bash, read,
write, edit, glob and grep calls in a RAM and Redis workspace. The
agent totals /workspace/orders.csv per customer and saves the table
to /redis/report.md, which stays in Redis after the run.

Usage:
    docker run -d -p 6379:6379 redis
    uv add 'mirage-ai[claude-managed-agents,redis]'
    python examples/python/agents/claude_managed_agents/redis_report.py

.env.development holds ANTHROPIC_API_KEY, ANTHROPIC_ENVIRONMENT_ID (a
self-hosted environment) and ANTHROPIC_ENVIRONMENT_KEY (its key from
the Claude Console).
"""

import asyncio
import contextlib
import os

from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.agents.claude_managed_agents import mirage_tools
from mirage.vfs.ram import RAMVFS
from mirage.vfs.redis import RedisVFS

load_dotenv(".env.development")

ORDERS = (
    "customer,item,amount\n"
    "acme,widget,120\n"
    "globex,gadget,75\n"
    "acme,gizmo,30\n"
    "initech,widget,60\n"
    "globex,widget,45\n"
)

TASK = (
    "Total the amount per customer in /workspace/orders.csv and save the "
    "totals as a markdown table, largest first, to /redis/report.md."
)


async def main() -> None:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    ws = Workspace(
        {"/workspace": RAMVFS(), "/redis": RedisVFS(url=redis_url)},
        mode=MountMode.WRITE,
    )
    await ws.vfs.write("/workspace/orders.csv", ORDERS.encode())

    environment_id = os.environ["ANTHROPIC_ENVIRONMENT_ID"]
    client = AsyncAnthropic()
    agent = await client.beta.agents.create(
        name="Mirage orders report",
        model="claude-opus-5-5",
        tools=[
            {
                "type": "agent_toolset_20260401",
                "default_config": {
                    "enabled": True,
                    "permission_policy": {"type": "always_allow"},
                },
                "configs": [
                    {"name": "web_fetch", "enabled": False},
                    {"name": "web_search", "enabled": False},
                ],
            }
        ],
    )
    session = await client.beta.sessions.create(
        agent={"type": "agent", "id": agent.id, "version": agent.version},
        environment_id=environment_id,
    )
    worker = client.beta.environments.work.worker(
        environment_id=environment_id,
        environment_key=os.environ["ANTHROPIC_ENVIRONMENT_KEY"],
        tools=mirage_tools(ws),
    )
    serving = asyncio.create_task(worker.run())
    try:
        stream = await client.beta.sessions.events.stream(session.id)
        await client.beta.sessions.events.send(
            session.id,
            events=[
                {
                    "type": "user.message",
                    "content": [{"type": "text", "text": TASK}],
                }
            ],
        )
        async for event in stream:
            if event.type == "agent.tool_use":
                print(f"  -> {event.name} {event.input}")
            elif event.type == "agent.message":
                for block in event.content:
                    if block.type == "text":
                        print(block.text)
            elif event.type == "session.status_idle":
                if event.stop_reason.type != "requires_action":
                    break
            elif event.type == "session.status_terminated":
                break
    finally:
        serving.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await serving
        await client.beta.agents.archive(agent.id)

    print("\n=== /redis/report.md (from Redis, through Mirage) ===")
    print((await ws.vfs.read("/redis/report.md")).decode())


if __name__ == "__main__":
    asyncio.run(main())

"""Total a CSV with OpenAI's Agents API, working in a Mirage workspace.

The agent runs on OpenAI's servers in a self-hosted environment: its
shell commands, file reads and patches reach workspace `demo` through
`codex exec-server forward` and `mirage codex-exec`, both started
here. The agent totals /workspace/orders.csv per customer and saves
the table to /redis/report.md, which stays in Redis after the run.

Usage:
    docker run -d -p 6379:6379 redis
    uv tool install 'mirage-ai[ssh,redis]'
    npm install -g @openai/codex@alpha
    mirage workspace create workspace.yaml --id demo
    python examples/python/agents/openai_agents_api/redis_report.py

workspace.yaml mounts RAM at /workspace and Redis at /redis, as the
OpenAI Agents API page shows. .env.development holds OPENAI_API_KEY
and OPENAI_EXECUTOR_API_KEY (an environment key from the Agents tab).
"""

import os
import subprocess
import uuid

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(".env.development")

WORKSPACE = "demo"
LISTEN = "127.0.0.1:8790"
CODEX = os.environ.get("CODEX", "codex")

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


def mirage_shell(line: str, stdin: str = "") -> str:
    done = subprocess.run(
        ["mirage", "shell", "-w", WORKSPACE, "-c", line],
        input=stdin,
        capture_output=True,
        text=True,
        check=True,
    )
    return done.stdout


def main() -> None:
    mirage_shell("cat > /workspace/orders.csv", ORDERS)
    relay = subprocess.Popen(
        ["mirage", "codex-exec", WORKSPACE, "--listen", LISTEN],
        stderr=subprocess.PIPE,
        text=True,
    )
    forward = None
    try:
        assert relay.stderr is not None
        print(relay.stderr.readline().strip())

        client = OpenAI()
        session = client.beta.agents.sessions.create(
            agent={"model": "gpt-6-luna"},
            environment={
                "type": "self_hosted",
                "workspace_directory": "/workspace",
            },
        )
        environment = session.environment
        if environment is None or environment.type != "self_hosted":
            raise RuntimeError("the session has no self-hosted environment")
        forward = subprocess.Popen(
            [
                CODEX,
                "exec-server",
                "forward",
                "--connect",
                f"ws://{LISTEN}",
                "--remote",
                environment.remote_url,
                "--environment-id",
                environment.id,
            ],
            env={
                **os.environ,
                "CODEX_API_KEY": os.environ["OPENAI_EXECUTOR_API_KEY"],
            },
        )

        with client.beta.agents.sessions.events.stream(session.id) as stream:
            client.beta.agents.sessions.events.create(
                session.id,
                events=[
                    {
                        "type": "agent.session.input.message",
                        "input": [
                            {
                                "role": "user",
                                "content": [
                                    {"type": "input_text", "text": TASK}
                                ],
                            }
                        ],
                    }
                ],
                idempotency_key=str(uuid.uuid4()),
            )
            for event in stream:
                if event.type == "agent.session.turn.output_text.delta":
                    print(event.delta, end="", flush=True)
                elif event.type in (
                    "agent.session.turn.completed",
                    "agent.session.turn.failed",
                    "agent.session.turn.cancelled",
                ):
                    print(f"\n[{event.type}]")
                    break
    finally:
        for child in (forward, relay):
            if child is not None:
                child.terminate()
                child.wait()

    print("\n=== /redis/report.md (from Redis, through Mirage) ===")
    print(mirage_shell("cat /redis/report.md"))


if __name__ == "__main__":
    main()

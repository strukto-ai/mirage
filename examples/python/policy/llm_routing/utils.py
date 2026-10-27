import os

from config import RuntimeChoice
from dotenv import load_dotenv
from openai import AsyncOpenAI
from typesafe_sdk import AsyncTypeSafeClient, Choice

load_dotenv(".env.development")

CHOICES: dict[str, dict[str, str]] = {}


async def parse_runtime(
    model: str, task: str, runtimes: dict[str, str], line: str
) -> dict[str, str]:
    """Ask the model where a line runs: Jev for a jev model, else OpenAI.

    Each line is asked once, so its preview and its run agree.

    Args:
        model (str): the model to ask.
        task (str): what to pick.
        runtimes (dict[str, str]): each runtime and what it can run.
        line (str): the shell line.
    """
    if line not in CHOICES:
        ask = ask_jev if model.startswith("jev") else ask_openai
        CHOICES[line] = await ask(model, task, runtimes, line)
    return CHOICES[line]


async def ask_openai(
    model: str, task: str, runtimes: dict[str, str], line: str
) -> dict[str, str]:
    """Ask an OpenAI model for a RuntimeChoice, its reason in its words.

    Args:
        model (str): the model to ask.
        task (str): what to pick.
        runtimes (dict[str, str]): each runtime and what it can run.
        line (str): the shell line.
    """
    prompt = f"{task} Say why in one sentence.\n" + "\n".join(
        f"{name}: {about}" for name, about in runtimes.items()
    )
    done = await AsyncOpenAI(timeout=10).responses.parse(
        model=model, instructions=prompt, input=line, text_format=RuntimeChoice
    )
    return done.output_parsed.model_dump()


async def ask_jev(
    model: str, task: str, runtimes: dict[str, str], line: str
) -> dict[str, str]:
    """Ask a Jev model to choose, its reason the confidence it reports.

    Args:
        model (str): the model to ask.
        task (str): what to pick.
        runtimes (dict[str, str]): each runtime and what it can run.
        line (str): the shell line.
    """
    async with AsyncTypeSafeClient(
        api_key=os.environ["JEV_API_KEY"], timeout=10
    ) as client:
        done = await client.system_one(
            line,
            {"runtime": Choice(instructions=task, criteria=runtimes)},
            model=model,
        )
    answer = done.choices["runtime"]
    return {
        "runtime": answer.choice,
        "reason": f"confidence {answer.confidence:.2f}",
    }

from config import RuntimeChoice
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv(".env.development")

CLIENT = AsyncOpenAI(timeout=10)
CHOICES: dict[str, dict[str, str]] = {}


async def parse_runtime(model: str, prompt: str, line: str) -> dict[str, str]:
    """Ask the model where a line runs, parsed as a RuntimeChoice.

    Each line is asked once, so its preview and its run agree.

    Args:
        model (str): the model to ask.
        prompt (str): the instructions, with the runtimes to pick from.
        line (str): the shell line.
    """
    if line not in CHOICES:
        done = await CLIENT.responses.parse(
            model=model,
            instructions=prompt,
            input=line,
            text_format=RuntimeChoice,
        )
        CHOICES[line] = done.output_parsed.model_dump()
    return CHOICES[line]

from config import RuntimeChoice
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv(".env.development")

CLIENT = AsyncOpenAI(timeout=10)


async def parse_runtime(model: str, prompt: str, line: str) -> dict[str, str]:
    """Ask the model where a line runs, parsed as a RuntimeChoice.

    Args:
        model (str): the model to ask.
        prompt (str): the instructions, with the runtimes to pick from.
        line (str): the shell line.
    """
    done = await CLIENT.responses.parse(
        model=model, instructions=prompt, input=line, text_format=RuntimeChoice
    )
    return done.output_parsed.model_dump()

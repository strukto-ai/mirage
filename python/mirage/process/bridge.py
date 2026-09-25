from mirage.process.types import ProcessView, SpawnRequest
from mirage.types import PathSpec


class GuestProcesses:

    def __init__(self, view: ProcessView | None) -> None:
        self.view = view

    async def run(self,
                  argv: list[str],
                  input: str = "",
                  cwd: str | None = None) -> dict[str, str | int]:
        if self.view is None or self.view.spawn is None:
            raise PermissionError("runtime has no process spawn door")
        if not isinstance(argv, list) or not argv or not all(
                isinstance(arg, str) for arg in argv):
            raise ValueError("argv must be a nonempty list of strings")
        child = self.view.spawn(
            SpawnRequest(
                tuple(argv),
                PathSpec.from_str_path(cwd) if cwd is not None else None))
        result = await child.communicate(input.encode())
        return {
            "stdout": result.stdout.decode(errors="replace"),
            "stderr": result.stderr.decode(errors="replace"),
            "returncode": result.exit_code
        }

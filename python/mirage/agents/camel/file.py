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

import shlex
import tempfile
from pathlib import Path

from camel.toolkits import FileToolkit

from mirage.agents.camel._async import AsyncRunner
from mirage.agents.io_text import io_to_str
from mirage.workspace.workspace import Workspace


class MirageFileToolkit(FileToolkit):

    def __init__(
        self,
        workspace: Workspace,
        working_directory: str = "/",
        timeout: float | None = None,
        default_encoding: str = "utf-8",
        backup_enabled: bool = False,
    ) -> None:
        self._ws = workspace
        self._runner = AsyncRunner()
        self._mirage_root = working_directory
        self._tmpdir = tempfile.TemporaryDirectory(prefix="mirage-camel-")
        super().__init__(
            working_directory=self._tmpdir.name,
            timeout=timeout,
            default_encoding=default_encoding,
            backup_enabled=backup_enabled,
        )

    def close(self) -> None:
        self._runner.close()
        self._tmpdir.cleanup()

    def _to_mirage_path(self, file_path: str) -> str:
        path_str = file_path
        if not path_str.startswith("/"):
            base = self._mirage_root.rstrip("/") or ""
            path_str = f"{base}/{path_str}"
        return path_str

    def _read_mirage_bytes(self, mirage_path: str) -> bytes:
        quoted = shlex.quote(mirage_path)
        io = self._runner.run(self._ws.execute(f"cat {quoted}"))
        if io.exit_code != 0:
            stderr = io.stderr if isinstance(io.stderr, bytes) else b""
            raise FileNotFoundError(stderr.decode("utf-8", errors="replace"))
        return io.stdout if isinstance(io.stdout, bytes) else b""

    def _write_mirage_bytes(self, mirage_path: str, data: bytes) -> None:
        parent = str(Path(mirage_path).parent)
        if parent and parent != "/":
            mkdir_io = self._runner.run(
                self._ws.execute(f"mkdir -p {shlex.quote(parent)}"))
            if mkdir_io.exit_code != 0:
                stderr = mkdir_io.stderr if isinstance(mkdir_io.stderr,
                                                       bytes) else b""
                raise OSError(stderr.decode("utf-8", errors="replace"))
        quoted = shlex.quote(mirage_path)
        io = self._runner.run(self._ws.execute(f"cat > {quoted}", stdin=data))
        if io.exit_code != 0:
            stderr = io.stderr if isinstance(io.stderr, bytes) else b""
            raise OSError(stderr.decode("utf-8", errors="replace"))

    def write_to_file(
        self,
        title: str,
        content: str | list[list[str]],
        filename: str,
        encoding: str | None = None,
        use_latex: bool = False,
    ) -> str:
        """Write content to filename over Mirage Workspace.

        Args:
            title (str): Document title (used by some format writers).
            content: Content payload.
            filename (str): Logical Mirage path.
            encoding (str | None): Override default encoding.
            use_latex (bool): Forwarded to PDF writer.

        Returns:
            str: Success or error message.
        """
        mirage_path = self._to_mirage_path(filename)
        local_name = Path(filename).name or "out"
        local_path = Path(self._tmpdir.name) / local_name
        super_msg = super().write_to_file(
            title=title,
            content=content,
            filename=str(local_path),
            encoding=encoding,
            use_latex=use_latex,
        )
        if super_msg.startswith("Error"):
            return super_msg
        produced = self._find_produced_file(local_path)
        if produced is None:
            return f"Error: format writer produced no file for {local_path}"
        target = self._adjust_extension(mirage_path, produced)
        try:
            self._write_mirage_bytes(target, produced.read_bytes())
        except OSError as exc:
            return f"Error writing {target}: {exc}"
        return f"Content successfully written to file: {target}"

    def read_file(self, file_paths: str | list[str]) -> str | dict[str, str]:
        """Read files from Mirage and return Markdown-rendered text.

        Args:
            file_paths (str | list[str]): Single path or list of paths.

        Returns:
            str | dict[str, str]: Same shape as camel read_file.
        """
        if isinstance(file_paths, str):
            return self._read_one(file_paths)
        out: dict[str, str] = {}
        for fp in file_paths:
            out[fp] = self._read_one(fp)
        return out

    def _read_one(self, file_path: str) -> str:
        mirage_path = self._to_mirage_path(file_path)
        try:
            data = self._read_mirage_bytes(mirage_path)
        except FileNotFoundError as exc:
            return f"Failed to read file: {mirage_path} ({exc})"
        suffix = Path(mirage_path).suffix or ".txt"
        local = Path(
            self._tmpdir.name) / f"read_{abs(hash(mirage_path))}{suffix}"
        local.write_bytes(data)
        return super().read_file(file_paths=str(local))

    def _find_produced_file(self, expected: Path) -> Path | None:
        if expected.exists():
            return expected
        for ext in (".md", ".pdf", ".docx", ".csv", ".json", ".html", ".txt"):
            candidate = expected.with_suffix(ext)
            if candidate.exists():
                return candidate
        parent = expected.parent
        if parent.exists():
            for child in parent.iterdir():
                if child.stem == expected.stem and child.is_file():
                    return child
        return None

    def _adjust_extension(self, mirage_path: str, produced: Path) -> str:
        target = Path(mirage_path)
        if target.suffix:
            return mirage_path
        return str(target.with_suffix(produced.suffix))

    def edit_file(self, file_path: str, old_content: str,
                  new_content: str) -> str:
        """Replace old_content with new_content in a Mirage file.

        Args:
            file_path (str): Logical Mirage path.
            old_content (str): Exact text to find.
            new_content (str): Replacement text.

        Returns:
            str: Success or error message.
        """
        mirage_path = self._to_mirage_path(file_path)
        try:
            data = self._read_mirage_bytes(mirage_path).decode(
                self.default_encoding)
        except FileNotFoundError:
            return f"Error: File {mirage_path} does not exist"
        if old_content not in data:
            return f"Error: old_content not found in {mirage_path}"
        new_data = data.replace(old_content, new_content)
        self._write_mirage_bytes(mirage_path,
                                 new_data.encode(self.default_encoding))
        return f"Successfully edited file: {mirage_path}"

    def search_files(self, file_name: str, path: str | None = None) -> str:
        """Locate files by name pattern via Mirage's find.

        Args:
            file_name (str): Glob pattern passed to find -name.
            path (str | None): Search root; defaults to working_directory.

        Returns:
            str: Newline-separated list of matching paths.
        """
        root = self._to_mirage_path(path or self._mirage_root)
        cmd = f"find {shlex.quote(root)} -name {shlex.quote(file_name)}"
        io = self._runner.run(self._ws.execute(cmd))
        return io_to_str(io)

    def glob_files(self, pattern: str, path: str | None = None) -> str:
        """Glob via Mirage's find -name.

        Args:
            pattern (str): Glob pattern.
            path (str | None): Search root.

        Returns:
            str: Newline-separated list of matches.
        """
        return self.search_files(file_name=pattern, path=path)

    def grep_files(
        self,
        pattern: str,
        path: str | None = None,
        file_pattern: str | None = None,
    ) -> str:
        """Regex search via Mirage's grep -rn.

        Args:
            pattern (str): Regex.
            path (str | None): Search root.
            file_pattern (str | None): --include glob.

        Returns:
            str: Concatenated grep output.
        """
        root = self._to_mirage_path(path or self._mirage_root)
        parts = ["grep", "-rn", shlex.quote(pattern)]
        if file_pattern:
            parts.insert(2, f"--include={shlex.quote(file_pattern)}")
        parts.append(shlex.quote(root))
        io = self._runner.run(self._ws.execute(" ".join(parts)))
        return io_to_str(io)

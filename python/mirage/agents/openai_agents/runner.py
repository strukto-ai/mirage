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

import base64
from typing import Any, cast

from agents import Runner, TResponseInputItem
from openai import AsyncOpenAI

from mirage.types import FileType
from mirage.workspace.workspace import Workspace

_VISION_TYPES = {
    FileType.IMAGE_PNG,
    FileType.IMAGE_JPEG,
    FileType.IMAGE_GIF,
}

_MIMETYPE_FOR = {
    FileType.IMAGE_PNG: "image/png",
    FileType.IMAGE_JPEG: "image/jpeg",
    FileType.IMAGE_GIF: "image/gif",
    FileType.PDF: "application/pdf",
}


class MirageRunner:
    """Run OpenAI agents with mirage-resolved multimodal attachments.

    Args:
        workspace (Workspace): The workspace to resolve paths against.
        client (AsyncOpenAI | None): OpenAI async client, used for PDF
            uploads via the Files API. Required if any attachment is
            a PDF; constructed with default settings if not given.
    """

    def __init__(
        self,
        workspace: Workspace,
        client: AsyncOpenAI | None = None,
    ) -> None:
        self._ws = workspace
        self._client = client

    async def _block_for_path(self, path: str) -> dict[str, Any]:
        st = await self._ws.ops.stat(path)
        data = await self._ws.ops.read(path)
        if st.type in _VISION_TYPES:
            mime = _MIMETYPE_FOR[st.type]
            b64 = base64.b64encode(data).decode("ascii")
            return {
                "type": "input_image",
                "image_url": f"data:{mime};base64,{b64}",
            }
        if st.type == FileType.PDF:
            if self._client is None:
                self._client = AsyncOpenAI()
            filename = path.rsplit("/", 1)[-1]
            uploaded = await self._client.files.create(
                file=(filename, data),
                purpose="user_data",
            )
            return {"type": "input_file", "file_id": uploaded.id}
        return {
            "type": "input_text",
            "text": data.decode("utf-8", errors="replace"),
        }

    async def build_blocks(
        self,
        prompt: str,
        paths: list[str],
    ) -> list[dict[str, Any]]:
        """Build the user-message content blocks for a prompt + paths.

        Args:
            prompt (str): User-facing instruction text.
            paths (list[str]): Mirage paths to attach (any resource).

        Returns:
            list[dict]: Content blocks ready to embed in a user message.
        """
        blocks: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
        for path in paths:
            blocks.append(await self._block_for_path(path))
        return blocks

    async def run_with_attachments(
        self,
        agent,
        prompt: str,
        paths: list[str],
    ):
        """Run the agent with mirage paths as multimodal attachments.

        Args:
            agent: The OpenAI Agents SDK Agent instance.
            prompt (str): User-facing instruction text.
            paths (list[str]): Mirage paths to attach.

        Returns:
            The result from `agents.Runner.run`.
        """
        blocks = await self.build_blocks(prompt, paths)
        message = cast(TResponseInputItem, {"role": "user", "content": blocks})
        return await Runner.run(agent, [message])

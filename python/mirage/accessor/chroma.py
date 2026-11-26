from typing import Any

import chromadb
from chromadb.config import Settings

from mirage.accessor.base import Accessor
from mirage.vfs.chroma.config import ChromaConfig
from mirage.vfs.secrets import reveal_secret


class ChromaAccessor(Accessor):
    def __init__(self, config: ChromaConfig) -> None:
        self.config = config
        self._client: Any | None = None
        self._collection: Any | None = None

    async def get_client(self) -> Any:
        """The client for this mount, opened on first use.

        Its settings are built without chromadb's own sources, so the
        mount's config is all it reads: a ``CHROMA_*`` variable or a
        ``.env`` in the working directory changes nothing.
        """
        if self._client is None:
            key = reveal_secret(self.config.api_key)
            self._client = await chromadb.AsyncHttpClient(
                host=self.config.host,
                port=self.config.port,
                ssl=self.config.ssl,
                headers={"x-chroma-token": key} if key else None,
                settings=Settings.model_construct(),
            )
        return self._client

    async def get_collection(self) -> Any:
        if self._collection is None:
            client = await self.get_client()
            self._collection = await client.get_collection(
                self.config.collection_name
            )
        return self._collection

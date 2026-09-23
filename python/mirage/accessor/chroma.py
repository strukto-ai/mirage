from typing import Any

import chromadb

from mirage.accessor.base import Accessor
from mirage.vfs.chroma.config import ChromaConfig


class ChromaAccessor(Accessor):

    def __init__(self, config: ChromaConfig) -> None:
        self.config = config
        self._client: Any | None = None
        self._collection: Any | None = None

    async def get_client(self) -> Any:
        if self._client is None:
            self._client = await chromadb.AsyncHttpClient(
                host=self.config.host,
                port=self.config.port,
                ssl=self.config.ssl)
        return self._client

    async def get_collection(self) -> Any:
        if self._collection is None:
            client = await self.get_client()
            self._collection = await client.get_collection(
                self.config.collection_name)
        return self._collection

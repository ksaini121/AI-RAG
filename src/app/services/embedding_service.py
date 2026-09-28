from langchain_openai import OpenAIEmbeddings

from app.core.config import config


class EmbeddingService:
    """
    Embeds a single query string for retrieval. Not for batch document
    embedding at ingestion time — that's app/temporal/activities.py's
    embed_chunks, which runs inside a Temporal activity, not a request.
    """

    def __init__(self) -> None:
        self._embeddings = OpenAIEmbeddings(
            openai_api_key=config.openai_api_key,
            model=config.openai_embedding_model,
            dimensions=config.openai_embedding_dimensions,
        )

    def embed_query(self, text: str) -> list[float]:
        return self._embeddings.embed_query(text)


# Module-level singleton, lazily built: OpenAIEmbeddings() just constructs a
# client object (no network handshake, unlike app/temporal/client.py's
# Client.connect()), so a simple lazy accessor is enough — no lifespan wiring
# needed. Avoids rebuilding an HTTP connection pool on every request, since
# RetrievalService is constructed fresh per request via the get_<x>_service
# factory pattern.
_embedding_service: EmbeddingService | None = None


def get_embedding_service() -> EmbeddingService:
    global _embedding_service
    if _embedding_service is None:
        _embedding_service = EmbeddingService()
    return _embedding_service

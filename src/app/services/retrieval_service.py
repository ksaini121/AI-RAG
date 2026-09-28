import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import config
from app.db.models import Document, DocumentChunk
from app.services.embedding_service import get_embedding_service


@dataclass
class RetrievedChunk:
    content: str
    distance: float
    document_id: uuid.UUID
    chunk_index: int


class RetrievalService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self._embeddings = get_embedding_service()

    def search(self, user_id: uuid.UUID, query: str, k: int | None = None) -> list[RetrievedChunk]:
        # Read live, not as a default-arg value: a default is evaluated once
        # at function-definition (import) time, which would silently freeze
        # whatever config.retrieval_top_k was at that moment.
        k = k if k is not None else config.retrieval_top_k

        query_vector = self._embeddings.embed_query(query)

        distance = DocumentChunk.embedding.cosine_distance(query_vector).label("distance")
        stmt = (
            select(DocumentChunk, distance)
            .join(Document, Document.id == DocumentChunk.document_id)
            .where(
                DocumentChunk.user_id == user_id,  # tenancy boundary — never optional
                # Excludes chunks still mid-ingestion: chunk_and_store writes
                # placeholder zero-vector embeddings before embed_chunks runs,
                # and those would otherwise tie at the same cosine distance
                # and pollute results with no error surfaced.
                Document.status == "ready",
            )
            .order_by(distance)
            .limit(k)
        )
        rows = self.db.execute(stmt).all()
        return [
            RetrievedChunk(
                content=chunk.content,
                distance=dist,
                document_id=chunk.document_id,
                chunk_index=chunk.chunk_index,
            )
            for chunk, dist in rows
        ]

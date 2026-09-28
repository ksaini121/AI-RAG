"""RetrievalService tests.

All of these commit real rows and query the HNSW-indexed embedding column,
so they require the Postgres container to be running (`make db-up`) and the
schema migrated (`make migrate`). Embedding vectors are hand-written, not
real OpenAI output — RetrievalService.search still calls EmbeddingService to
embed the *query string*, so that one call is monkeypatched per test to
avoid needing an OPENAI_API_KEY or network access for what is otherwise a
pure query-logic test.
"""

import uuid

from app.db.models import Document, DocumentChunk
from app.services.retrieval_service import RetrievalService

EMBEDDING_DIM = 1536


def _make_document(db_session, user_id: uuid.UUID, status: str = "ready") -> Document:
    document = Document(
        id=uuid.uuid4(),
        user_id=user_id,
        filename="test.txt",
        content_type="text/plain",
        size_bytes=0,
        storage_path="unused",
        sha256="0" * 64,
        status=status,
    )
    db_session.add(document)
    db_session.commit()
    db_session.refresh(document)
    return document


def _make_chunk(
    db_session, document: Document, user_id: uuid.UUID, index: int, content: str, vector: list
) -> DocumentChunk:
    chunk = DocumentChunk(
        id=uuid.uuid4(),
        document_id=document.id,
        user_id=user_id,
        chunk_index=index,
        content=content,
        token_count=0,
        embedding=vector,
    )
    db_session.add(chunk)
    db_session.commit()
    return chunk


def test_search_orders_by_distance(db_session, test_user):
    document = _make_document(db_session, test_user.id)

    # Hand-written vectors: "near" is closer to the query vector than "far"
    # by construction, not by asking OpenAI to judge similarity. Not unit
    # vectors — cosine distance only cares about direction, not magnitude.
    query_vector = [1.0] + [0.0] * (EMBEDDING_DIM - 1)
    near_vector = [0.9] + [0.1] * (EMBEDDING_DIM - 1)
    far_vector = [0.0] * (EMBEDDING_DIM - 1) + [1.0]

    _make_chunk(db_session, document, test_user.id, 0, "near", near_vector)
    _make_chunk(db_session, document, test_user.id, 1, "far", far_vector)

    service = RetrievalService(db_session)
    service._embeddings.embed_query = lambda text: query_vector

    results = service.search(test_user.id, "anything", k=2)
    assert [r.content for r in results] == ["near", "far"]


def test_search_never_returns_another_users_chunks(db_session, test_user, other_user):
    my_document = _make_document(db_session, test_user.id)
    their_document = _make_document(db_session, other_user.id)

    query_vector = [1.0] + [0.0] * (EMBEDDING_DIM - 1)
    my_vector = [0.5] + [0.5] * (EMBEDDING_DIM - 1)
    # Deliberately the *closer* match to the query than my_vector: a test
    # where the other user's data is a worse match would pass even with a
    # missing tenancy filter. This construction is the one that actually
    # catches that bug.
    their_vector = [0.99] + [0.01] * (EMBEDDING_DIM - 1)

    _make_chunk(db_session, my_document, test_user.id, 0, "mine", my_vector)
    _make_chunk(db_session, their_document, other_user.id, 0, "theirs", their_vector)

    service = RetrievalService(db_session)
    service._embeddings.embed_query = lambda text: query_vector

    results = service.search(test_user.id, "anything", k=5)
    assert [r.content for r in results] == ["mine"]


def test_search_excludes_documents_not_ready(db_session, test_user):
    ready_document = _make_document(db_session, test_user.id, status="ready")
    embedding_document = _make_document(db_session, test_user.id, status="embedding")

    query_vector = [1.0] + [0.0] * (EMBEDDING_DIM - 1)
    ready_vector = [0.5] + [0.5] * (EMBEDDING_DIM - 1)
    # A placeholder zero-vector, exactly what chunk_and_store writes before
    # embed_chunks overwrites it — this is the chunk the status join must
    # exclude, since chunk_and_store commits it while the parent document is
    # still "chunking"/"embedding", not "ready".
    placeholder_vector = [0.0] * EMBEDDING_DIM

    _make_chunk(db_session, ready_document, test_user.id, 0, "ready chunk", ready_vector)
    _make_chunk(
        db_session, embedding_document, test_user.id, 0, "placeholder chunk", placeholder_vector
    )

    service = RetrievalService(db_session)
    service._embeddings.embed_query = lambda text: query_vector

    results = service.search(test_user.id, "anything", k=5)
    assert [r.content for r in results] == ["ready chunk"]


def test_search_respects_k(db_session, test_user):
    document = _make_document(db_session, test_user.id)
    query_vector = [1.0] + [0.0] * (EMBEDDING_DIM - 1)

    for i in range(5):
        vector = [1.0 - i * 0.1] + [0.0] * (EMBEDDING_DIM - 1)
        _make_chunk(db_session, document, test_user.id, i, f"chunk-{i}", vector)

    service = RetrievalService(db_session)
    service._embeddings.embed_query = lambda text: query_vector

    results = service.search(test_user.id, "anything", k=2)
    assert len(results) == 2

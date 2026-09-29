from langchain_core.tools import tool
from langgraph.prebuilt import ToolRuntime

from app.agent.context import AgentContext
from app.agent.state import AgentState
from app.core.config import config
from app.services.document_service import DocumentService
from app.services.retrieval_service import RetrievalService


@tool
def search_documents(query: str, runtime: ToolRuntime[AgentContext, AgentState]) -> str:
    """Search the user's uploaded documents for passages relevant to a query."""
    # Sync def on purpose: ToolNode runs sync tools in a thread, so blocking
    # SQLAlchemy is safe here and RetrievalService works completely unchanged.
    ctx = runtime.context
    hits = RetrievalService(ctx.db).search(ctx.user_id, query, config.retrieval_top_k)
    if not hits:
        return "No relevant documents found."
    return "\n\n".join(f"[distance={h.distance:.3f}] {h.content}" for h in hits)


@tool
def list_my_documents(runtime: ToolRuntime[AgentContext, AgentState]) -> str:
    """List the current user's uploaded documents and their ingestion status."""
    ctx = runtime.context
    documents = DocumentService(ctx.db).get_all_documents(ctx.user_id)
    if not documents:
        return "No documents found."

    return "\n\n".join(
        f"{doc.filename} ({doc.status}, {doc.chunk_count} chunks)" for doc in documents
    )


TOOLS = [search_documents, list_my_documents]

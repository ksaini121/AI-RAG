import uuid
from dataclasses import dataclass

from sqlalchemy.orm import Session


@dataclass
class AgentContext:
    """Run-scoped context, passed to .astream(context=...) and read by tools
    via ToolRuntime.context. Holds the live request Session: the FastAPI
    dependency owns its lifecycle, so the agent must never close it."""

    user_id: uuid.UUID
    db: Session

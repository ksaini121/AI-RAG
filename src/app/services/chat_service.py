import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ChatThread

TITLE_MAX_CHARS = 60


class ChatService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create_thread(self, user_id: uuid.UUID, title: str | None) -> ChatThread:
        thread = ChatThread(id=uuid.uuid4(), user_id=user_id, title=title)
        self.db.add(thread)
        self.db.commit()
        self.db.refresh(thread)
        return thread

    def list_threads(self, user_id: uuid.UUID) -> list[ChatThread]:
        stmt = (
            select(ChatThread)
            .where(ChatThread.user_id == user_id)
            .order_by(ChatThread.last_message_at.desc().nulls_last(), ChatThread.created_at.desc())
        )
        return list(self.db.scalars(stmt))

    def get_for_user(self, thread_id: uuid.UUID, user_id: uuid.UUID) -> ChatThread | None:
        # The ownership gate: the checkpointer knows nothing about users, so
        # every route must pass through here before touching the graph.
        stmt = select(ChatThread).where(ChatThread.id == thread_id, ChatThread.user_id == user_id)
        return self.db.scalars(stmt).first()

    def touch(self, thread: ChatThread, first_message: str) -> None:
        thread.last_message_at = datetime.now(UTC)
        if not thread.title:
            thread.title = first_message[:TITLE_MAX_CHARS]
        self.db.commit()

    def delete_for_user(self, thread_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        thread = self.get_for_user(thread_id, user_id)
        if thread is None:
            return False
        self.db.delete(thread)
        self.db.commit()
        return True

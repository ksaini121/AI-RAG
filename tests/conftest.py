"""Shared fixtures for tests that need a real DB session.

`db_session` opens its own connection (not via FastAPI's `get_db`, which is
request-scoped) and rolls back at the end of each test, so rows written by
one test never leak into the next. Requires Postgres running (`make db-up`)
and the schema migrated (`make migrate`).
"""

import uuid

import pytest

from app.db.models import User
from app.db.session import SessionLocal


@pytest.fixture
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def test_user(db_session):
    user = User(
        id=uuid.uuid4(),
        name="Test User",
        email=f"retrieval-test-{uuid.uuid4()}@example.com",
        # Not a real hash: these tests never log in through the API, only
        # ORM-insert rows directly, so password never needs to validate.
        password="unused",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def other_user(db_session):
    user = User(
        id=uuid.uuid4(),
        name="Other User",
        email=f"retrieval-test-other-{uuid.uuid4()}@example.com",
        password="unused",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user

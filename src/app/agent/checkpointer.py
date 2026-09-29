from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from app.core.config import config

# Typed as AsyncConnectionPool[AsyncConnection[DictRow]], matching exactly
# what langgraph-checkpoint-postgres's AsyncPostgresSaver expects (its own
# Conn type alias): the row_factory=dict_row passed in kwargs below is what
# makes this true at runtime, but without connection_class here mypy can't
# see it and the pool defaults to a plain-tuple row type.
_pool: AsyncConnectionPool[AsyncConnection[DictRow]] | None = None


def build_pool() -> AsyncConnectionPool[AsyncConnection[DictRow]]:
    global _pool
    _pool = AsyncConnectionPool(
        conninfo=config.checkpointer_dsn,
        connection_class=AsyncConnection[DictRow],
        max_size=10,
        open=False,
        # Both REQUIRED by langgraph-checkpoint-postgres: dict_row because
        # the saver indexes rows by column name; autocommit because it
        # manages its own transaction boundaries. prepare_threshold=0
        # keeps PgBouncer-compat if you ever put one in front of Postgres.
        kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": 0},
    )
    return _pool

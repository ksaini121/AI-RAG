"""One-shot script: create the LangGraph checkpointer tables.

These tables are library-owned (see CHECKPOINTER_TABLES in alembic/env.py),
so they are created by AsyncPostgresSaver.setup(), not by Alembic.
Run with `make checkpointer-setup`.
"""

import asyncio

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.checkpointer import build_pool


async def main() -> None:
    pool = build_pool()
    await pool.open()
    try:
        await AsyncPostgresSaver(pool).setup()
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())

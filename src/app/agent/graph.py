from langchain_openai import ChatOpenAI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from app.agent.checkpointer import build_pool
from app.agent.context import AgentContext
from app.agent.state import AgentState
from app.agent.tools import TOOLS
from app.core.config import config

SYSTEM_PROMPT = """You are a helpful assistant with access to the user's uploaded documents.
Use search_documents to find relevant passages before answering questions that might relate
to their documents."""

_graph = None


async def agent_node(state: AgentState) -> dict:
    # async: only awaits the OpenAI call itself. Everything the tools do
    # is sync SQLAlchemy, safely off the event loop via ToolNode's own
    # thread handling — this node never touches the DB directly.
    model = ChatOpenAI(model=config.openai_chat_model).bind_tools(TOOLS)
    response = await model.ainvoke([("system", SYSTEM_PROMPT), *state["messages"]])
    return {"messages": [response]}


def build_graph(checkpointer: AsyncPostgresSaver) -> object:
    builder = StateGraph(AgentState, context_schema=AgentContext)
    builder.add_node("agent", agent_node)
    builder.add_node("tools", ToolNode(TOOLS))

    builder.add_edge(START, "agent")
    builder.add_conditional_edges("agent", tools_condition, {"tools": "tools", END: END})
    builder.add_edge("tools", "agent")
    return builder.compile(checkpointer=checkpointer)


async def connect_graph() -> None:
    global _graph
    pool = build_pool()
    await pool.open()
    checkpointer = AsyncPostgresSaver(pool)
    _graph = build_graph(checkpointer)


def get_graph():
    if _graph is None:
        raise RuntimeError("Agent graph not built. Did the lifespan run?")
    return _graph

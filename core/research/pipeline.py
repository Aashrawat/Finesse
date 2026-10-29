"""Supervisor: search -> read -> write -> critique, passing results through a shared state dict."""

from typing import Callable, Optional

from core.research.agents import build_reader_agent, build_search_agent, critic_chain, writer_chain
from core.research.tools import require_tavily_key

STEPS = ("Search agent", "Reader agent", "Writer", "Critic")


def run_research_pipeline(topic: str, on_step: Optional[Callable[[int], None]] = None) -> dict:
    """Run the four-step pipeline. `on_step(n)` is called as step n (1-4) starts."""
    require_tavily_key()  # fail fast with a clear message
    notify = on_step or (lambda _n: None)
    state: dict = {}

    # Step 1 - search agent
    notify(1)
    search_result = build_search_agent().invoke({
        "messages": [("user", f"Search the web for information on {topic}")]
    })
    state["search_results"] = search_result["messages"][-1].content

    # Step 2 - reader agent
    notify(2)
    reader_result = build_reader_agent().invoke({
        "messages": [("user",
            f"Based on the following search results about '{topic}', "
            f"pick the most relevant URL and scrape it for deeper content.\n\n"
            f"Search Results:\n{state['search_results'][:2000]}"
        )]
    })
    state["scraped_content"] = reader_result["messages"][-1].content

    # Step 3 - writer chain
    notify(3)
    research_combined = (
        f"SEARCH RESULTS : \n {state['search_results']} \n\n"
        f"DETAILED SCRAPED CONTENT : \n {state['scraped_content']}"
    )
    state["report"] = writer_chain().invoke({"topic": topic, "research": research_combined})

    # Step 4 - critic chain
    notify(4)
    state["feedback"] = critic_chain().invoke({"report": state["report"]})

    return state


if __name__ == "__main__":
    topic = input("\nEnter a research topic: ")
    result = run_research_pipeline(topic, on_step=lambda n: print(f"step {n} - {STEPS[n - 1]} working ..."))
    print("\nFinal report\n", result["report"])
    print("\nCritic report\n", result["feedback"])

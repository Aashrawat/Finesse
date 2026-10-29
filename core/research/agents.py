"""The four research roles: search agent, reader agent, writer chain, critic chain."""

import os
from functools import lru_cache

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

from core.research.tools import scrape_url, search_web

load_dotenv()


@lru_cache(maxsize=1)
def get_llm() -> ChatOpenAI:
    return ChatOpenAI(model="gpt-4o-mini", temperature=0, api_key=os.getenv("OPENAI_API_KEY"))


# 1st agent: search the web
def build_search_agent():
    return create_agent(model=get_llm(), tools=[search_web])


# 2nd agent: read (scrape) the best result
def build_reader_agent():
    return create_agent(model=get_llm(), tools=[scrape_url])


# Writer chain
writer_prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful assistant that writes a concise summary of the given text."),
    ("human", """Write a detailed research report on the topic below. Topic {topic}
    Research Gathered: {research}
    Structure the report in the following sections:
    Introduction: Provide a brief overview of the topic.
    Key Findings: Summarize the main points and insights.
    Conclusion: Summarize the main points and insights.
    Sources: List the sources used to gather the information.
    Be detailed, concise, and well-structured."""),
])

# Critic chain
critic_prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful assistant that critiques the given text and provides feedback on the quality of the writing."),
    ("human", """Critique the following text and provide feedback on the quality of the writing. Report: {report}
    Respond in this exact format:
    Score: X/10
    Strength:
    - ...
    - ...

    Areas to improve:
    - ...
    - ...

    One line verdict:
    - ..."""),
])


def writer_chain():
    return writer_prompt | get_llm() | StrOutputParser()


def critic_chain():
    return critic_prompt | get_llm() | StrOutputParser()

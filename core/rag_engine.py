import os
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnablePassthrough, RunnableLambda
from dotenv import load_dotenv
from core.vector_store import build_vector_store, load_vector_store, get_retriever, COLLECTION_NAME

load_dotenv()

SYSTEM_PROMPT = """You are an expert meeting assistant. Answer the user's question
based ONLY on the meeting transcript context provided below.

If the answer is not found in the context, say:
"I could not find this information in the meeting transcript."

Always be concise and precise. If quoting someone, mention it clearly.
When the context contains timestamps like [02:15] or [1:02:15], cite the relevant ones
inline in exactly that bracketed format.

Context from meeting transcript:
{context}"""


def get_llm():
    return ChatOpenAI(
        model="gpt-4o-mini",
        api_key=os.getenv("OPENAI_API_KEY"),
        temperature=0.3,
    )


def format_docs(docs):
    return "\n\n".join([doc.page_content for doc in docs])


def _make_chain(retriever):
    prompt = ChatPromptTemplate.from_messages([
        ("system", SYSTEM_PROMPT),
        ("human", "{question}"),
    ])

    # full LCEL RAG pipeline
    return (
        {
            "context": retriever | RunnableLambda(format_docs),
            "question": RunnablePassthrough(),
        }
        | prompt
        | get_llm()
        | StrOutputParser()
    )


def build_rag_chain(transcript: str, collection_name: str = COLLECTION_NAME):
    vector_store = build_vector_store(transcript, collection_name)
    return _make_chain(get_retriever(vector_store, k=4))


def load_rag_chain(collection_name: str = COLLECTION_NAME):
    vector_store = load_vector_store(collection_name)
    return _make_chain(get_retriever(vector_store, k=4))


def ask_question(rag_chain, question: str) -> str:
    print(f"Question : {question}")
    answer = rag_chain.invoke(question)
    print(f"answer :{answer}")
    return answer

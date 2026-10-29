from functools import lru_cache
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document

CHROMA_DIR = "vector_db"
COLLECTION_NAME = "meeting_transcript"
EMBEDDING_MODEL = "all-MiniLM-L6-v2"


@lru_cache(maxsize=1)  # load the embedding model once per process
def get_embeddings():
    return HuggingFaceEmbeddings(
        model_name=EMBEDDING_MODEL,
        model_kwargs={"device": "cpu"},
    )


def _open_collection(collection_name: str) -> Chroma:
    return Chroma(
        collection_name=collection_name,
        embedding_function=get_embeddings(),
        persist_directory=CHROMA_DIR,
    )


def build_vector_store(transcript: str, collection_name: str = COLLECTION_NAME) -> Chroma:
    print("Building vector Store")

    splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
    chunks = splitter.split_text(transcript)

    docs = [
        Document(page_content=chunk, metadata={"chunk_index": i})
        for i, chunk in enumerate(chunks)
    ]

    # Drop any previous data in this collection so answers only come from this transcript
    _open_collection(collection_name).delete_collection()

    return Chroma.from_documents(
        documents=docs,
        embedding=get_embeddings(),
        collection_name=collection_name,
        persist_directory=CHROMA_DIR,
    )


def load_vector_store(collection_name: str = COLLECTION_NAME) -> Chroma:
    return _open_collection(collection_name)


def delete_vector_store(collection_name: str) -> None:
    _open_collection(collection_name).delete_collection()


def get_retriever(vector_store: Chroma, k: int = 4):
    return vector_store.as_retriever(
        search_type="similarity",
        search_kwargs={"k": k},
    )

from dotenv import load_dotenv
load_dotenv()  # load OPENAI_API_KEY / WHISPER_MODEL before importing the core modules

from utils.audio_processor import process_input
from utils.exporter import export_pdf, export_txt
from core.transcriber import transcribe_all
from core.summarizer import summarize, generate_title
from core.extractor import extract_action_items, extract_key_decisions, extract_questions
from core.rag_engine import build_rag_chain, ask_question


def analyze(source: str) -> dict:
    """Run the full pipeline: audio -> transcript (auto-translated) -> summary/extraction."""
    chunks = process_input(source)
    transcript = transcribe_all(chunks, translate=None)  # None = auto-detect, translate if not English

    print("Generating summary and extracting items...")
    return {
        "title": generate_title(transcript),
        "summary": summarize(transcript),
        "action_items": extract_action_items(transcript),
        "decisions": extract_key_decisions(transcript),
        "questions": extract_questions(transcript),
        "transcript": transcript,
    }


def print_results(results: dict) -> None:
    print(f"\n=== {results['title']} ===")
    print(f"\nSUMMARY:\n{results['summary']}")
    print(f"\nACTION ITEMS:\n{results['action_items']}")
    print(f"\nKEY DECISIONS:\n{results['decisions']}")
    print(f"\nOPEN QUESTIONS:\n{results['questions']}")


def export_menu(results: dict) -> None:
    choice = input("\nExport results? [p]df / [t]xt / [b]oth / [n]o: ").strip().lower()
    if choice in ("p", "b"):
        print("Saved PDF:", export_pdf(results))
    if choice in ("t", "b"):
        print("Saved TXT:", export_txt(results))


def chat_loop(transcript: str) -> None:
    print("\nBuilding chat index...")
    chain = build_rag_chain(transcript)
    print("Chat with your meeting. Type 'exit' to quit.")
    while True:
        question = input("\nYou: ").strip()
        if question.lower() in ("exit", "quit", "q"):
            break
        if question:
            ask_question(chain, question)


def main() -> None:
    source = input("YouTube URL or audio/video file path: ").strip().strip('"')
    if not source:
        print("No input given.")
        return

    results = analyze(source)
    print_results(results)
    export_menu(results)
    chat_loop(results["transcript"])


if __name__ == "__main__":
    main()

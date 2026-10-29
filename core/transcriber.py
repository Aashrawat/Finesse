import whisper
import os
from dotenv import load_dotenv

load_dotenv()

WHISPER_MODEL = os.getenv("WHISPER_MODEL","small")

_model = None

def load_model():
    global _model

    if _model is None: 
        print(f"Loading Whisper model: {WHISPER_MODEL} ...")
        _model = whisper.load_model(WHISPER_MODEL) 
        print("Whisper model loaded successfully.")
    return _model 

def detect_language(audio_path: str) -> str:
    """Detect the spoken language (ISO code, e.g. 'en', 'hi', 'es') from the first 30s of audio."""
    model = load_model()
    audio = whisper.pad_or_trim(whisper.load_audio(audio_path))
    mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(model.device)
    _, probs = model.detect_language(mel)
    return max(probs, key=probs.get)

def transcribe_chunk_full(chunk_path: str, translate : bool = False) -> dict:
    """Full Whisper result, including 'segments' with start/end times in seconds."""
    model = load_model()

    task = "translate" if translate else "transcribe"

    return model.transcribe(chunk_path, task=task)

def transcribe_chunk(chunk_path: str, translate : bool = False) -> str:
    return transcribe_chunk_full(chunk_path, translate=translate)["text"]

def transcribe_all(chunks: list, translate : bool | None = False) -> str:
    """translate=True/False forces the task; translate=None auto-detects the language
    and translates to English only when the audio is not English."""
    if translate is None:
        language = detect_language(chunks[0])
        translate = language != "en"
        print(f"Detected language: {language} -> {'translating to English' if translate else 'no translation needed'}")

    full_transcript = ""
    for i, chunk in enumerate(chunks):
        print(f"Transcribing chunk {i+1} ...")
        text = transcribe_chunk(chunk, translate=translate)

        full_transcript += text + "\n"
    print(f"Transcription complete.")
    return full_transcript
import sys
import json
import base64
import io
import time
import os

# Suppress HF symlink warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

def log_debug(msg):
    sys.stderr.write(f"[whisper_worker] {msg}\n")
    sys.stderr.flush()

def main():
    model_size = sys.argv[1] if len(sys.argv) > 1 else "tiny"
    log_debug(f"Loading faster-whisper model '{model_size}' on CPU (int8, 4 threads)...")
    
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1)
        log_debug(f"faster-whisper model '{model_size}' ready!")
        print(json.dumps({"status": "ready", "model": model_size}), flush=True)
    except Exception as e:
        log_debug(f"Failed to load faster-whisper: {e}")
        print(json.dumps({"status": "error", "error": str(e)}), flush=True)
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            action = req.get("action", "transcribe")

            if action == "ping":
                print(json.dumps({"id": req_id, "success": True, "pong": True, "model": model_size}), flush=True)
                continue

            if action == "set_model":
                new_model = req.get("model", "tiny")
                log_debug(f"Switching faster-whisper model from '{model_size}' to '{new_model}'...")
                model = WhisperModel(new_model, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1)
                model_size = new_model
                log_debug(f"Switched model to '{model_size}'!")
                print(json.dumps({"id": req_id, "success": True, "model": model_size}), flush=True)
                continue

            if action == "transcribe":
                audio_b64 = req.get("audioBase64")
                if not audio_b64:
                    print(json.dumps({"id": req_id, "success": False, "error": "No audio data"}), flush=True)
                    continue

                audio_bytes = base64.b64decode(audio_b64)
                audio_stream = io.BytesIO(audio_bytes)
                
                initial_prompt = req.get("initialPrompt") or None
                language = req.get("language") or None

                t0 = time.time()
                transcribe_kwargs = {
                    "beam_size": 1,
                    "best_of": 1,
                    "vad_filter": True,
                    "vad_parameters": dict(min_silence_duration_ms=300)
                }
                if initial_prompt:
                    transcribe_kwargs["initial_prompt"] = initial_prompt
                if language and language != "auto":
                    transcribe_kwargs["language"] = language

                segments, info = model.transcribe(audio_stream, **transcribe_kwargs)
                
                texts = []
                for seg in segments:
                    t = seg.text.strip()
                    if t:
                        texts.append(t)

                full_text = " ".join(texts).strip()
                elapsed = time.time() - t0

                print(json.dumps({
                    "id": req_id,
                    "success": True,
                    "text": full_text,
                    "language": info.language if info else "unknown",
                    "language_probability": info.language_probability if info else 1.0,
                    "durationSec": elapsed
                }), flush=True)
        except Exception as err:
            log_debug(f"Error handling request: {err}")
            print(json.dumps({
                "id": req.get("id") if "req" in locals() else None,
                "success": False,
                "error": str(err)
            }), flush=True)

if __name__ == "__main__":
    main()

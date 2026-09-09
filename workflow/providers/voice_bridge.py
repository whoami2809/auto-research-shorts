"""Isolated protocol bridge. Never discovers or reads .env; env comes from parent.

Dependencies retain the original SDK pins. JSON stdin: text, then GO after READY.
Only the fixed, parent-created temporary audio path is accepted on argv.
"""
import json
import math
import os
import re
import sys

MAX_TEXT = 12000
MAX_AUDIO = 20 * 1024 * 1024


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def read_line():
    line = sys.stdin.buffer.readline(100000)
    if len(line) >= 100000 or not line.endswith(b"\n"):
        raise ValueError()
    return json.loads(line)


def settings():
    from elevenlabs import VoiceSettings
    values = {}
    for name in ("API_KEY", "VOICE_ID", "MODEL_ID"):
        value = os.environ.get("ELEVENLABS_" + name, "").strip()
        if not value or len(value) > 512:
            raise ValueError()
        if name != "API_KEY" and not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", value):
            raise ValueError()
        values[name] = value
    params = {}
    for name, low, high in (("SPEED", .7, 1.2), ("STABILITY", 0, 1), ("SIMILARITY_BOOST", 0, 1), ("STYLE", 0, 1)):
        number = float(os.environ["ELEVENLABS_" + name])
        if not math.isfinite(number) or not low <= number <= high:
            raise ValueError()
        params[name.lower()] = number
    boost = os.environ["ELEVENLABS_USE_SPEAKER_BOOST"].lower()
    if boost not in ("true", "false", "1", "0"):
        raise ValueError()
    params["use_speaker_boost"] = boost in ("true", "1")
    return values, VoiceSettings(**params)


def main():
    try:
        import httpx
        from elevenlabs.client import ElevenLabs
        values, params = settings()
        payload = read_line()
        if not isinstance(payload, dict) or set(payload) != {"text"}:
            raise ValueError()
        text = payload["text"]
        if not isinstance(text, str) or not text.strip() or len(text.encode("utf-16-le")) // 2 > MAX_TEXT:
            raise ValueError()
        if values["API_KEY"] in text:
            raise ValueError()
        if len(sys.argv) != 2:
            raise ValueError()
        # Proxy env and redirects cannot select alternative network destinations.
        transport = httpx.Client(timeout=120.0, follow_redirects=False, trust_env=False)
        client = ElevenLabs(api_key=values["API_KEY"], base_url="https://api.elevenlabs.io", timeout=120.0, httpx_client=transport)
    except Exception:
        emit({"error": "CONFIG_MISSING"})
        return 1
    emit({"ready": True})
    try:
        if read_line() != {"go": True}:
            return 1
        audio = client.text_to_speech.convert(
            voice_id=values["VOICE_ID"], model_id=values["MODEL_ID"], text=text,
            voice_settings=params, output_format="mp3_44100_128",
            request_options={"max_retries": 0},
        )
        size = 0
        with open(sys.argv[1], "xb") as handle:
            for chunk in audio:
                size += len(chunk)
                if size > MAX_AUDIO:
                    raise ValueError()
                handle.write(chunk)
        if size < 3:
            raise ValueError()
        emit({"done": True})
        return 0
    except Exception as error:
        status = getattr(error, "status_code", None)
        code = "EXTERNAL_REJECTED" if isinstance(status, int) and 400 <= status < 500 and status != 408 else "EXTERNAL_OUTCOME_UNKNOWN"
        emit({"error": code})
        return 1
    finally:
        transport.close()


if __name__ == "__main__":
    raise SystemExit(main())

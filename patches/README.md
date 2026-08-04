# Runtime patches for third-party transcription images

Mesynx bind-mounts one patched file into the WhisperX container. This
directory holds that change as a **unified diff**, not as a copy of the
upstream file — the upstream sources belong to their own projects under their
own licences, and this repo has no business redistributing them.

The materialised `.py` files are gitignored. Generate them locally with:

```bash
./patches/apply.sh
```

That pulls the pristine file out of the published image, applies the diff, and
writes the result next to this README, ready for the bind-mount in
`docker-compose.yml`.

---

## `whisperx-audio.py.patch` — **required**

| | |
| --- | --- |
| Upstream | [`ghcr.io/etalab-ia/whisperx-openai-api`](https://github.com/etalab-ia/whisperx-openai-api) |
| Target | `/app/endpoints/audio.py` |
| Size | 6 lines changed |

Mesynx signals that it wants diarization by appending `-diarize` to the model
name (`src/lib/transcription/format.ts`, `getResponseFormat`). The stock server
rejects any model name that isn't exactly `settings.transcribe_model`, so it
returns **404** for `large-v3-turbo-diarize`. The documented convention never
worked against this image.

The patch loosens one comparison to accept the suffix:

```python
if model.removesuffix("-diarize") != settings.transcribe_model:
    raise ModelNotFoundException()
```

**Without this patch, diarized transcription returns 404.**

---

## `stt.py.patch` — **historical, no longer applied**

| | |
| --- | --- |
| Upstream | [`fedirz/faster-whisper-server`](https://github.com/fedirz/faster-whisper-server) |
| Target | `faster_whisper_server/routers/stt.py` |
| Size | 12 lines changed |

Kept for the record. That service was removed from `docker-compose.yml` once
WhisperX superseded it. Retained because it documents the fix for a
long-standing transcription bug, and anyone still running the legacy
`faster-whisper-server` needs it.

It changes two things:

1. **`vad_filter` defaults to `True`.** Quiet wearable audio (a clip-on
   recorder averages around −30 dB with long silences) reaches the decoder as
   silence, and Whisper hallucinates filler on silence.
2. **`condition_on_previous_text` is accepted as a form field.** Mesynx was
   already sending `condition_on_previous_text: false` — the correct anti-loop
   setting — but the stock server silently drops unknown form fields, so
   faster-whisper's default `True` applied. One bad 30-second window then fed
   itself as context and never recovered.

Measured on the same hour-long recording, before and after:

| | Before | After |
| --- | --- | --- |
| Words | 2,668 | **7,756** |
| Duplicate segments | 1,333 (**99.9%**) | 34 (5.2%) |
| Distinct vocabulary | ~3 | **1,200** |

Before the fix the transcript was the phrase `"Thank you."` repeated 1,334
times.

# Standalone transcription server (WhisperX)

Run transcription on a **different machine** from the app — a GPU box on your
LAN or tailnet. It exposes the OpenAI-compatible `/v1/audio/transcriptions`
endpoint that Mesynx AI uses, plus forced alignment and speaker diarization.

> The main [`docker-compose.yml`](../docker-compose.yml) already runs this
> service alongside the app. You only need this directory if you want
> transcription on separate hardware.

> **Why a dedicated service.** Chat-only local servers like Ollama and Open
> WebUI do not implement the audio endpoint — they return `405 Method Not
> Allowed` on `/v1/audio/transcriptions`. WhisperX does.

## Requirements

**A GPU is required.** There is no CPU image for WhisperX. You need an NVIDIA
card, current drivers, and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

The diarization models are gated, so you also need a Hugging Face token:

1. Accept the licence at
   [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Generate a **read**-scope token at
   [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
3. Put it in a `.env` next to this file as `HF_TOKEN=hf_...`.

Without a valid token the image fails on a gated-repo `401`. The entrypoint
guard catches that and idles with a clear message rather than restarting
forever — but it will not transcribe.

## Quick start

```bash
# From the repo root, once — materialises the model-alias patch:
./patches/apply.sh

cd whisper-server
docker compose up -d

# /health needs no auth; /v1/models requires the bearer key.
curl http://localhost:8398/health
```

First boot downloads the Whisper and pyannote models (1–2 GB), so give it a few
minutes. They persist in the `whisperx_cache` volume.

### Why the patch

Mesynx AI requests diarization by appending `-diarize` to the model name, but
the stock image rejects any model name that is not exactly `TRANSCRIBE_MODEL` —
so the convention returns **404** without it. `apply.sh` pulls the pristine file
from the published image and applies a six-line diff. See
[`../patches/README.md`](../patches/README.md).

## Connect it to Mesynx AI

1. **Settings → AI Providers → Add Provider**
2. **Provider:** `Custom (OpenAI-compatible)`
3. **Nickname:** e.g. `Home GPU · WhisperX`
4. **Base URL:** `http://<this-host>:8398/v1` (a Tailscale IP works well)
5. **API key:** whatever you set as `WHISPERX_API_KEY`
6. **Test Connection**, then choose **`large-v3-turbo-diarize`**, tick **Use for
   transcription**, and save.

Configure providers through the UI rather than writing to the database
directly — API keys are encrypted with a path that rejects plaintext, so a row
inserted by hand fails with `Could not decrypt the API key` on every request.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HF_TOKEN` | — | **Required.** Read scope, after accepting the pyannote licence. |
| `WHISPERX_API_KEY` | `sk-placeholder` | Must match the key entered in Settings. |
| `WHISPERX_MODEL` | `large-v3-turbo` | Base transcription model. |
| `WHISPERX_BATCH_SIZE` | `4` | See sizing below. |
| `WHISPERX_ALIGN_LANGUAGES` | `["en"]` | Alignment models preloaded at boot. Others load on demand for the first request in that language. |

### Sizing `BATCH_SIZE`

The single biggest driver of GPU memory.

| VRAM | `WHISPERX_BATCH_SIZE` |
| ---- | --------------------- |
| 8 GB | `4` |
| 12 GB | `8` |
| 16 GB+ | `16` |

Too high shows up as `CUDA failed with error out of memory` in **this
container's** logs, while the app reports only a bare `500` with nothing in its
own log — the failure is upstream of it. When a transcription 500s with no
app-side log, check `docker logs mesynx-whisperx` and `nvidia-smi` first.

Uptime matters too: a long-lived CUDA process on a nearly-full card fragments
its allocator and creeps upward — one container went from 2.6 GB to 6.5 GB over
about 17 hours before failing mid-transcription.
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` is set by default to counter
that, and a restart reclaims the rest.

### Sharing the box with an LLM

Pin them to different cards. An unpinned reservation lets a resident LLM and
WhisperX fight over the same GPU, which produces CUDA-OOM failures on exactly
the transcribe-then-summarise path the app runs on every recording. This
compose pins device `0`; point your LLM elsewhere.

---

> **LLMs are not transcription models.** Gemma, Llama and GPT are *text*
> models — they cannot transcribe audio and will not answer
> `/v1/audio/transcriptions`. Use a Whisper-family model here, and configure an
> LLM separately as the **summary / enhancement** provider.

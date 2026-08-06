#!/usr/bin/env sh
# Materialise the patched files that docker-compose.yml bind-mounts.
#
# The upstream sources are not vendored into this repo (see README.md); this
# pulls the pristine file out of the published image and applies our diff.
# Safe to re-run — it always starts from the image's copy, never from a
# previously patched file.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMAGE=${WHISPERX_IMAGE:-ghcr.io/etalab-ia/whisperx-openai-api:latest}

command -v docker >/dev/null 2>&1 || { echo "error: docker not found" >&2; exit 1; }
command -v patch  >/dev/null 2>&1 || { echo "error: 'patch' not found (apt install patch)" >&2; exit 1; }

echo "Pulling pristine endpoints/audio.py from $IMAGE ..."
docker run --rm --entrypoint cat "$IMAGE" /app/endpoints/audio.py > "$DIR/whisperx-audio.py.tmp"

if ! [ -s "$DIR/whisperx-audio.py.tmp" ]; then
    echo "error: extracted file is empty — is the image tag correct?" >&2
    rm -f "$DIR/whisperx-audio.py.tmp"
    exit 1
fi

echo "Applying whisperx-audio.py.patch ..."
if ! patch -p1 --forward "$DIR/whisperx-audio.py.tmp" < "$DIR/whisperx-audio.py.patch"; then
    echo "" >&2
    echo "error: patch did not apply. The upstream file has probably changed." >&2
    echo "Pin a known-good tag via WHISPERX_IMAGE, or refresh the patch." >&2
    rm -f "$DIR/whisperx-audio.py.tmp" "$DIR/whisperx-audio.py.tmp.orig"
    exit 1
fi

mv "$DIR/whisperx-audio.py.tmp" "$DIR/whisperx-audio.py"
rm -f "$DIR/whisperx-audio.py.tmp.orig"

echo "OK -> patches/whisperx-audio.py"
echo "Now run: docker compose up -d whisperx"

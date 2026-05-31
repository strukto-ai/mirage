# Local audio (offline transcription)

[local_audio.py](local_audio.py) runs shell-style commands over local audio
files (`.wav`, `.mp3`, `.ogg`): `stat` reads metadata only, while `cat` /
`head` / `grep` transcribe with an offline Whisper model.

## Dependencies

The audio stack is optional and not installed by default. It is not part of
the core package, so `import mirage` works fine without it, only this example
needs it. Install the three deps with `uv add`:

```bash
uv add av tinytag "sherpa-onnx>=1.13"
```

Note the `sherpa-onnx>=1.13` floor: on macOS (arm64) some older wheels ship
without their bundled `libonnxruntime` dylib and crash on import. 1.13+ pulls
`sherpa-onnx-core`, which carries the native library.

## Model

The example expects a Whisper model at `models/sherpa-onnx-whisper-base/`
(repo root, gitignored). Download the `sherpa-onnx-whisper-base` model from
the sherpa-onnx (k2-fsa) pre-trained model collection and extract it there so
the directory contains `base-encoder.onnx`, `base-decoder.onnx`, and
`base-tokens.txt`.

## Run

From the repo root, using the project venv so `.env.development` and the
`models/` path resolve:

```bash
./python/.venv/bin/python examples/python/other/local_audio.py
```

The `/s3` variant ([../s3/local_audio_s3.py](../s3/local_audio_s3.py)) needs
the same deps and model plus S3 credentials in `.env.development`.

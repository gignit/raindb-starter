# Yoda voice samples (RainDB starter)

Generated with **Amazon Polly** (AWS-native TTS, `us-east-1`) -- same in-env AWS
environment as Bedrock, so this voice path does NOT leave our environment.

All samples speak the same Yoda-style greeting that references a (fake) recent note:

> "Hmmm. Welcome to RainDB, you are. A note about the quarterly roadmap, recently you
>  wrote. Strong with the Force, your data is. Help you build, I will."

## Files

| File | Engine | Voice | Treatment |
|---|---|---|---|
| `plain-Matthew.mp3` | neural | Matthew (US M) | baseline, no SSML -- normal narrator |
| `yoda-neural-Matthew.mp3` | neural | Matthew | rate 80% (slower). Neural rejects pitch. |
| `yoda-neural-Brian.mp3` | neural | Brian (GB M) | rate 80% |
| `yoda-neural-Stephen.mp3` | neural | Stephen (US M) | rate 80% |
| `yoda-deep-Matthew.mp3` | standard | Matthew | rate slow + **pitch -20%** (deeper, more Yoda) |
| `yoda-deep-Brian.mp3` | standard | Brian | rate slow + pitch -20% |
| `yoda-deep-Russell.mp3` | standard | Russell (AU M) | rate slow + pitch -20% |

## What this proves for the handoffs

- A **Yoda voice can be produced entirely in-env** (Polly), no third-party TTS account.
- The **neural engine ignores `prosody pitch`** (quirk) -- use the **standard** engine when
  you want pitch shaping, or do pitch post-processing. The `yoda-deep-*` files use standard.
- For a *real* Yoda timbre (not just pitch-shifted narration) you'd use **Bedrock Amazon
  Nova Sonic** (bidirectional speech, in-env) with a custom voice/persona, or a voice-clone
  provider via the pod egress. Polly is the zero-dependency baseline that ships today.

## Quirks captured (for the seed / provider impl)

- Polly neural: SSML `<prosody pitch>` -> error. Use `rate` only on neural; use `standard`
  engine for pitch.
- Polly is a separate AWS API (`aws polly synthesize-speech`), NOT Bedrock Converse.
- Bedrock Nova Sonic = `InvokeModelWithBidirectionalStream` (real-time), us-east-1/us-west-2.
- Mistral Voxtral (STT) = `InvokeModel`, needs `us.` inference-profile prefix.

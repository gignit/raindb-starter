#!/usr/bin/env python3
"""
fanout.py -- fan a single prompt out to EVERY model that advertises a given
capability, concurrently, and print each response as it returns.

Why this exists
---------------
RainDB's Foundation catalog (fdn-internal/* on Bedrock, fdn/* external) exposes
many models per capability. When you want to see "which chat models are actually
working right now, and how do they answer?" -- or audition image/audio/video
models -- you do not want to call them one at a time. This script:

  1. asks the tenant's /v1/models for every model with the requested capability,
  2. sends them all the SAME prompt with a concurrency cap (default 20),
  3. streams results to the terminal AS THEY COMPLETE (fastest first), and
  4. writes any binary artifact (image/audio/video) to samples/<capability>/.

It talks to the OpenAI-compatible /v1 surface of your bolt's tenant, so it works
against whatever models that tenant has -- no AWS creds needed, the platform
routes (and bills) per model.

Endpoint + key resolution (in order)
-------------------------------------
  --endpoint / --api-key flags
  RAINDB_ENDPOINT / RAINDB_API_KEY env
  --profile <name> (reads ~/.config/raindb-cli/{config,credentials})
  RAINDB_PROFILE env, else the repo's stored git profile, else first core.rtest.* profile

Usage
-----
  scripts/fanout.py chat            -p "Explain immutable data in one sentence."
  scripts/fanout.py reasoning       -p "If a train leaves..."  --max-tokens 4000
  scripts/fanout.py image-generation -p "a serene starfield over a desert"
  scripts/fanout.py audio-generation -p "Welcome to RainDB."   --voice Brian
  scripts/fanout.py embedding       -p "vectorize me"
  scripts/fanout.py chat --profile core.rtest.chess-pod --concurrency 20

  scripts/fanout.py --list          # show capabilities present in the catalog

Capabilities are whatever /v1/models advertises (chat, reasoning, vision,
function-calling, structured-output, embedding, image-generation,
audio-generation, audio-transcription, video-input, pdfs, documents, ...).

Doubles as a model-conformance harness: because it calls every model live, the
ERRORs it surfaces are real per-provider request-shape findings, NOT script bugs
and NOT billing (a normal chat call succeeds even when some models 400). Known
quirks this has already exposed on rtest (see raindb AI_INTERFACE_GAPS_HANDOFF):

  - OpenAI gpt-5 / o-series  : reject `max_tokens` (use max_completion_tokens).
  - Anthropic-direct Opus 4.x: reject `temperature`/`top_p` (RainDB injects them;
                               RequestOverrides not applied on the direct path).
  - OpenAI image models      : reject `response_format` on /images/generations.
  - nano-banana (Gemini img) : does image-gen via chat `modalities`, 404 on /images.
  - Bedrock Stability large  : 403 (model access not enabled on the AWS account).
  - Reasoning models         : empty content if the token budget is too small.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import configparser
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLES_ROOT = REPO_ROOT / "samples"
CLI_CONFIG = Path.home() / ".config" / "raindb-cli" / "config"
CLI_CREDS = Path.home() / ".config" / "raindb-cli" / "credentials"

# ---- terminal color (auto-off when not a tty) ------------------------------
_TTY = sys.stdout.isatty()
def c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _TTY else s
def bold(s): return c("1", s)
def green(s): return c("32", s)
def red(s): return c("31", s)
def yellow(s): return c("33", s)
def cyan(s): return c("36", s)
def dim(s): return c("2", s)

_print_lock = threading.Lock()
def emit(*parts: str) -> None:
    with _print_lock:
        print(*parts, flush=True)


# ---- profile / endpoint resolution -----------------------------------------
def _read_ini(path: Path) -> configparser.ConfigParser:
    cp = configparser.ConfigParser()
    if path.exists():
        # raindb-cli files are INI-ish: [profile] then key = value
        cp.read(path)
    return cp


def _stored_git_profile() -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "config", "--local", "--get", "raindb.profile"],
            capture_output=True, text=True, timeout=5,
        )
        v = out.stdout.strip()
        return v or None
    except Exception:
        return None


def _first_rtest_profile(cfg: configparser.ConfigParser) -> str | None:
    for sect in cfg.sections():
        if sect.startswith("core.rtest."):
            return sect
    for sect in cfg.sections():
        if sect != "settings":
            return sect
    return None


def resolve_auth(args) -> tuple[str, str, str]:
    """Return (endpoint_base, api_key, label). endpoint_base has no trailing /v1."""
    endpoint = args.endpoint or os.environ.get("RAINDB_ENDPOINT")
    api_key = args.api_key or os.environ.get("RAINDB_API_KEY")
    if endpoint and api_key:
        return endpoint.rstrip("/").removesuffix("/graphql"), api_key, "flags/env"

    cfg = _read_ini(CLI_CONFIG)
    creds = _read_ini(CLI_CREDS)
    profile = (
        args.profile
        or os.environ.get("RAINDB_PROFILE")
        or _stored_git_profile()
        or _first_rtest_profile(cfg)
    )
    if not profile:
        sys.exit(red("No profile found. Pass --profile or --endpoint/--api-key, "
                     "or set RAINDB_ENDPOINT/RAINDB_API_KEY."))
    if profile not in cfg:
        sys.exit(red(f"Profile [{profile}] not in {CLI_CONFIG}. "
                     f"Available: {', '.join(s for s in cfg.sections() if s!='settings')}"))

    ep = endpoint or cfg[profile].get("endpoint", "")
    ep = ep.rstrip("/").removesuffix("/graphql")
    key = api_key or (creds[profile].get("api_key", "") if profile in creds else "")
    if not ep or not key:
        sys.exit(red(f"Profile [{profile}] missing endpoint or api_key."))
    if profile.endswith(".prod") or ".prod." in profile:
        sys.exit(red(f"Refusing to run against a production profile ({profile}). rtest only."))
    return ep, key, profile


# ---- HTTP ------------------------------------------------------------------
def http_json(method: str, url: str, key: str, body: dict | None, timeout: int):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def list_models(base: str, key: str) -> list[dict]:
    d = http_json("GET", f"{base}/v1/models", key, None, 30)
    return d.get("data", [])


# ---- per-capability request builders + response/artifact handling ----------
ARTIFACT_CAPS = {"image-generation", "audio-generation", "video-generation"}

def fallback_prompt(capability: str) -> str:
    """A GENERIC, capability-name-driven prompt used only if auto-gen can't reach a
    model. No per-model/per-capability hardcoding -- it is derived from the cap name
    so it works for capabilities that did not exist when this script was written."""
    if capability in ("image-generation", "video-generation"):
        return "A subtle starfield over a desert horizon at dusk, cinematic, calm."
    if capability == "audio-generation":
        return "Welcome to RainDB. Immutable, your data is."
    if capability == "embedding":
        return "RainDB stores immutable droplets indexed by UUIDv7."
    # generic text-capability probe, parameterized by the capability name
    return (f"Demonstrate the '{capability}' capability with a brief, concrete example. "
            f"Keep it to a few sentences.")


def autogen_prompt(base: str, key: str, capability: str, gen_model: str, timeout: int) -> str:
    """Ask a chat model to produce a good test prompt for the given capability."""
    instruction = (
        f"You are helping test an AI model that has the capability '{capability}'. "
        f"Write ONE concise, vivid prompt (a single line, no preamble, no quotes) that "
        f"is a good, fair test of that specific capability. For image/audio/video "
        f"capabilities, describe the artifact to produce. Output only the prompt text."
    )
    body = {
        "model": gen_model,
        "messages": [{"role": "user", "content": instruction}],
        "max_completion_tokens": 200,
        "max_tokens": 200,
    }
    try:
        d = http_json("POST", f"{base}/v1/chat/completions", key, body, timeout)
        txt = (d["choices"][0]["message"].get("content") or "").strip()
        txt = txt.strip().strip('"').strip()
        return txt or fallback_prompt(capability)
    except Exception:
        return fallback_prompt(capability)


def pick_gen_model(cap_index: dict) -> str | None:
    """Pick a chat model to author auto-gen prompts -- chosen DYNAMICALLY from the
    live catalog, never a hardcoded id. Heuristic: among models advertising 'chat',
    prefer the cheapest (by advertised prompt price), then the shortest id (usually
    the smallest/fastest tier). Falls back to whatever chat model exists."""
    chat = cap_index.get("chat") or []
    if not chat:
        return None

    def price(m: dict) -> float:
        try:
            return float((m.get("pricing") or {}).get("prompt", "inf"))
        except (TypeError, ValueError):
            return float("inf")

    ranked = sorted(chat, key=lambda m: (price(m), len(m.get("id", "")), m.get("id", "")))
    return ranked[0]["id"]


def build_request(capability: str, model_id: str, prompt: str, args) -> tuple[str, dict]:
    """Return (path, body) for the /v1 call appropriate to the capability."""
    if capability == "embedding":
        return "/v1/embeddings", {"model": model_id, "input": prompt}
    if capability == "image-generation":
        return "/v1/images/generations", {"model": model_id, "prompt": prompt, "n": 1}
    if capability == "audio-generation":
        body = {"model": model_id, "input": prompt}
        if args.voice:
            body["voice"] = args.voice
        return "/v1/audio/speech", body
    # default: chat-style (chat, reasoning, vision, function-calling, etc.)
    # gpt-5 / o-series reject max_tokens -> send BOTH the modern + legacy field;
    # the server/passthrough picks the one the model accepts.
    body = {
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
        "max_completion_tokens": args.max_tokens,
        "max_tokens": args.max_tokens,
    }
    if capability == "reasoning":
        body["reasoning"] = {}
    return "/v1/chat/completions", body


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def save_artifact(capability: str, model_id: str, resp: dict) -> str | None:
    """Persist any binary artifact to samples/<capability>/. Return saved path str."""
    out_dir = SAMPLES_ROOT / capability
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe(model_id)

    # image: OpenAI shape data[].b64_json or data[].url
    if capability == "image-generation":
        items = resp.get("data", [])
        if items and items[0].get("b64_json"):
            p = out_dir / f"{stem}.png"
            p.write_bytes(base64.b64decode(items[0]["b64_json"]))
            return str(p)
        if items and items[0].get("url"):
            p = out_dir / f"{stem}.url.txt"
            p.write_text(items[0]["url"])
            return str(p)

    # audio: either raw bytes (handled in worker) or b64 in json
    if capability == "audio-generation":
        b64 = resp.get("audio") or resp.get("b64_json")
        if b64:
            p = out_dir / f"{stem}.mp3"
            p.write_bytes(base64.b64decode(b64))
            return str(p)
    return None


def summarize_text(capability: str, resp: dict) -> str:
    if capability == "embedding":
        v = resp.get("data", [{}])[0].get("embedding", [])
        return f"<{len(v)}-dim vector> [{', '.join(f'{x:.3f}' for x in v[:4])}, ...]" if v else "<no vector>"
    # chat shape
    try:
        msg = resp["choices"][0]["message"]
        content = msg.get("content")
        if content is None and msg.get("reasoning"):
            content = "(reasoning only) " + msg["reasoning"][:200]
        return (content or "").strip() or "<empty content>"
    except Exception:
        return "<unparseable: " + json.dumps(resp)[:160] + ">"


# ---- worker ----------------------------------------------------------------
def call_model(base: str, key: str, capability: str, model: dict, args, prompt: str) -> dict:
    model_id = model["id"]
    path, body = build_request(capability, model_id, prompt, args)
    url = f"{base}{path}"
    t0 = time.time()
    result = {"model": model_id, "ok": False, "ms": 0, "text": "", "artifact": None, "err": None}
    try:
        # audio/speech may return raw bytes, not JSON -- handle both.
        data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=args.timeout) as r:
            ctype = r.headers.get("Content-Type", "")
            raw = r.read()
        result["ms"] = int((time.time() - t0) * 1000)
        if capability in ("audio-generation",) and not ctype.startswith("application/json"):
            out_dir = SAMPLES_ROOT / capability
            out_dir.mkdir(parents=True, exist_ok=True)
            ext = "mp3" if "mpeg" in ctype or "mp3" in ctype else (ctype.split("/")[-1] or "bin")
            p = out_dir / f"{_safe(model_id)}.{ext}"
            p.write_bytes(raw)
            result["ok"] = True
            result["artifact"] = str(p)
            result["text"] = f"<{len(raw)} bytes {ctype}>"
            return result
        resp = json.loads(raw.decode())
        result["ok"] = True
        result["text"] = summarize_text(capability, resp)
        result["artifact"] = save_artifact(capability, model_id, resp)
    except urllib.error.HTTPError as e:
        result["ms"] = int((time.time() - t0) * 1000)
        try:
            body_err = json.loads(e.read().decode())
            result["err"] = body_err.get("error", {}).get("message") or str(body_err)[:200]
        except Exception:
            result["err"] = f"HTTP {e.code}"
    except Exception as e:
        result["ms"] = int((time.time() - t0) * 1000)
        result["err"] = str(e)[:200]
    return result


# ---- main ------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fan a prompt out to every model with a given capability, concurrently.",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__,
    )
    ap.add_argument("capability", nargs="?", help="e.g. chat, reasoning, image-generation, embedding. "
                    "Omit to run EVERY capability in the catalog.")
    ap.add_argument("-p", "--prompt", default=None,
                    help="Prompt to send. Omit for AUTO-GEN mode: an AI writes a fitting "
                    "test prompt per capability.")
    ap.add_argument("--concurrency", type=int, default=20)
    ap.add_argument("--max-tokens", type=int, default=512)
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--voice", default=None, help="voice id for audio-generation (e.g. Brian)")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--endpoint", default=None)
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--list", action="store_true", help="list capabilities in the catalog and exit")
    ap.add_argument("--json", action="store_true", help="emit a JSON summary at the end")
    args = ap.parse_args()

    base, key, label = resolve_auth(args)
    emit(dim(f"# tenant: {label}  endpoint: {base}"))

    try:
        models = list_models(base, key)
    except Exception as e:
        sys.exit(red(f"Could not list models from {base}/v1/models: {e}"))

    # capability index
    cap_index: dict[str, list[dict]] = {}
    for m in models:
        for cap in m.get("capabilities", []) or []:
            cap_index.setdefault(cap, []).append(m)

    if args.list:
        emit(bold("\nCapabilities in this tenant's catalog:"))
        for cap in sorted(cap_index):
            ids = ", ".join(m["id"] for m in cap_index[cap])
            emit(f"  {green(cap):<28} {len(cap_index[cap]):>2}  {dim(ids)}")
        return

    # Which capabilities to run: the one given, or ALL of them.
    if args.capability:
        if args.capability not in cap_index:
            sys.exit(red(f"No models advertise '{args.capability}'. "
                         f"Available: {', '.join(sorted(cap_index))}"))
        caps_to_run = [args.capability]
    else:
        caps_to_run = sorted(cap_index)
        emit(bold(f"No capability given -> running ALL {len(caps_to_run)}: ")
             + dim(", ".join(caps_to_run)))

    # Auto-gen mode: when no prompt is supplied, an AI authors one per capability.
    gen_model = pick_gen_model(cap_index) if args.prompt is None else None
    if args.prompt is None:
        emit(yellow("AUTO-GEN mode: ") + dim(f"prompts authored by {gen_model or '(none -> defaults)'}"))

    all_results: dict[str, list[dict]] = {}
    all_prompts: dict[str, str] = {}
    for cap in caps_to_run:
        targets = cap_index[cap]
        if args.prompt is not None:
            prompt = args.prompt
        elif gen_model:
            prompt = autogen_prompt(base, key, cap, gen_model, args.timeout)
        else:
            prompt = fallback_prompt(cap)
        all_prompts[cap] = prompt

        render_group_header(cap, targets, prompt, args)
        results = fan_capability(base, key, cap, targets, prompt, args)
        all_results[cap] = results
        render_group_table(cap, results, args)

    render_final_summary(caps_to_run, all_results, all_prompts, args)
    if args.json:
        emit(json.dumps(all_results, indent=2))


# ---- rendering -------------------------------------------------------------
def render_group_header(cap: str, targets: list[dict], prompt: str, args) -> None:
    bar = "=" * 72
    emit(bold(f"\n{bar}"))
    kind = "ARTIFACT" if cap in ARTIFACT_CAPS else ("VECTOR" if cap == "embedding" else "TEXT")
    emit(bold(f"  CAPABILITY: {cap}  ") + dim(f"[{kind}]  {len(targets)} model(s), concurrency {args.concurrency}"))
    emit(bold(bar))
    emit(yellow("  PROMPT:"))
    for line in _wrap(prompt, 66):
        emit("    " + line)
    if cap in ARTIFACT_CAPS:
        emit(cyan(f"  Artifacts for this capability -> {SAMPLES_ROOT / cap}/"))
    emit("")


def render_group_table(cap: str, results: list[dict], args) -> None:
    """A chart of models vs their response (or artifact path / error)."""
    results = sorted(results, key=lambda r: (not r["ok"], r["model"]))
    is_artifact = cap in ARTIFACT_CAPS
    w_model = max([len(r["model"]) for r in results] + [12])
    w_model = min(w_model, 40)
    rcol = "ARTIFACT / OUTPUT" if is_artifact else "RESPONSE"
    emit(dim(f"  {'MODEL':<{w_model}}  {'STATUS':<7} {'ms':>6}  {rcol}"))
    emit(dim(f"  {'-'*w_model}  {'-'*7} {'-'*6}  {'-'*40}"))
    for r in results:
        status = green("OK") if r["ok"] else red("ERR")
        # plain-width status pad (color codes don't count toward width)
        status_pad = "OK " if r["ok"] else "ERR"
        if r["ok"]:
            if r.get("artifact"):
                cell = cyan(r["artifact"])
            else:
                cell = _oneline(r["text"], 80)
        else:
            cell = red(_oneline(r["err"] or "unknown error", 80))
        mname = r["model"] if len(r["model"]) <= w_model else r["model"][: w_model - 1] + "\u2026"
        emit(f"  {bold(mname):<{w_model + 9}}  {status_pad:<7} {r['ms']:>6}  {cell}"
             .replace(status_pad, status, 1) if False else
             f"  {mname:<{w_model}}  {status:<7} {r['ms']:>6}  {cell}")

    # For TEXT groups, also print the FULL responses below the chart (chart = scan,
    # full text = read), so nothing is lost.
    if not is_artifact:
        full = [r for r in results if r["ok"] and r.get("text")]
        if full:
            emit("")
            emit(dim("  Full responses:"))
            for r in full:
                emit("  " + bold(r["model"]) + dim(f"  ({r['ms']}ms)"))
                body = r["text"]
                if len(body) > 1200:
                    body = body[:1200] + dim(" ...[truncated]")
                for line in body.split("\n"):
                    emit("      " + line)
                emit("")


def render_final_summary(caps_to_run, all_results, all_prompts, args) -> None:
    emit(bold("\n" + "#" * 72))
    emit(bold("  SUMMARY"))
    emit(bold("#" * 72))
    grand_arts: list[str] = []
    for cap in caps_to_run:
        rs = all_results.get(cap, [])
        ok = sum(1 for r in rs if r["ok"])
        arts = [r["artifact"] for r in rs if r.get("artifact")]
        grand_arts += arts
        line = f"  {cap:<22} {green(str(ok)+' ok'):>12} / {len(rs):<3}"
        if cap in ARTIFACT_CAPS:
            line += cyan(f"  {len(arts)} artifact(s)")
        emit(line)
    if grand_arts:
        emit("")
        emit(cyan(f"  Generated {len(grand_arts)} artifact(s). Find them here:"))
        # group artifact dirs
        dirs = sorted({str(Path(a).parent) for a in grand_arts})
        for d in dirs:
            n = sum(1 for a in grand_arts if str(Path(a).parent) == d)
            emit(cyan(f"    {d}/  ({n} file(s))"))
        emit(dim("    (open them to view/listen -- e.g. `open " + dirs[0] + "`)"))
    emit("")


def _wrap(s: str, width: int) -> list[str]:
    words, lines, cur = s.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(cur); cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    return lines or [""]


def _oneline(s: str, width: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= width else s[: width - 1] + "\u2026"


def fan_capability(base, key, capability, targets, prompt, args) -> list[dict]:
    """Fan one prompt to all models for a capability; collect results.
    Prints a compact live tick as each returns so long runs show progress."""
    results = []
    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = {ex.submit(call_model, base, key, capability, m, args, prompt): m for m in targets}
        done = 0
        total = len(futs)
        for fut in cf.as_completed(futs):
            r = fut.result()
            results.append(r)
            done += 1
            tick = green("OK ") if r["ok"] else red("ERR")
            emit(dim(f"  [{done}/{total}] ") + tick + " " + r["model"] + dim(f"  {r['ms']}ms"))
    emit("")
    return results


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)

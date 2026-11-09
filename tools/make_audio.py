#!/usr/bin/env python3
"""청해 대본을 음성 파일로 만든다 → public/audio/<id>.m4a + public/audio/index.json
- 엔진: Google Cloud Text-to-Speech (키는 .env 의 GOOGLE_TTS_API_KEY, 앱에는 들어가지 않는다)
- 문장별로 합성해 .audio-cache/ 에 캐시하므로, 대본을 고친 문항만 다시 만든다.
- 문항마다 남녀 목소리를 바꿔 실제 시험처럼 여러 사람이 말하게 한다.
사용: python3 tools/make_audio.py [--voices] [--only kadai-001,...] [--engine say(개발용 시험)]
"""
import array, base64, hashlib, io, json, os, random, re, subprocess, sys, tempfile, urllib.request, wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE, OUT = ROOT / ".audio-cache", ROOT / "public" / "audio"
PARTS = ["kadai", "point", "gaiyo", "hatsuwa", "sokuji"]
SPOKEN = {"gaiyo", "hatsuwa", "sokuji"}
RATE = 24000
# 내레이터는 고정, 대화 인물은 문항마다 풀에서 고른다. --voices 로 실제 목록을 확인해 고칠 수 있다.
VOICES = {
    "N": ["ja-JP-Chirp3-HD-Kore"],
    "F": ["ja-JP-Chirp3-HD-Leda", "ja-JP-Chirp3-HD-Aoede", "ja-JP-Chirp3-HD-Despina"],
    "M": ["ja-JP-Chirp3-HD-Charon", "ja-JP-Chirp3-HD-Orus", "ja-JP-Chirp3-HD-Fenrir"],
}
GAP_TURN, GAP_OPT, GAP_LEAD = 0.55, 1.1, 0.4


def env_key():
    if os.environ.get("GOOGLE_TTS_API_KEY"):
        return os.environ["GOOGLE_TTS_API_KEY"]
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            if line.strip().startswith("GOOGLE_TTS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit(".env 에 GOOGLE_TTS_API_KEY=... 를 넣어 주세요")


def google(text, voice, key):
    body = {"input": {"text": text}, "voice": {"languageCode": "ja-JP", "name": voice},
            "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": RATE}}
    req = urllib.request.Request(f"https://texttospeech.googleapis.com/v1/text:synthesize?key={key}",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            wav = base64.b64decode(json.load(r)["audioContent"])
    except urllib.error.HTTPError as e:
        sys.exit(f"Google TTS 오류 {e.code}: {e.read().decode()[:400]}")
    with wave.open(io.BytesIO(wav)) as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1
        return w.readframes(w.getnframes())


def say(text, voice, key):  # 개발용: 파이프라인 시험에만 쓰고 배포하지 않는다
    with tempfile.TemporaryDirectory() as d:
        a, b = f"{d}/a.aiff", f"{d}/b.wav"
        subprocess.run(["say", "-v", "Kyoko", "-o", a, text], check=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", a, b], check=True)
        with wave.open(b) as w:
            return w.readframes(w.getnframes())


# 짧은 감탄사 뒤 「、」는 합성할 때 쉼 없이 붙어 「あ、待って」가 「あまって」처럼 들린다(실측: 쉼 0.15초 이상 3할 남짓).
# 음성용 글자에서만 「。」로 바꾸면 거의 항상 쉬고(41/42), 그 쉼이 길어 긴 쉼을 줄인다. 화면의 대본 글자는 그대로다.
INTERJ = "あ|ああ|あっ|あれ|あら|え|えっ|ええ|はい|いいえ|いえ|いや|いやあ|うん|ううん|うーん|じゃあ|じゃ|ねえ|へえ|ほら|さあ|まあ|よし|おや|あのう|あの|そう|そうか"
INTERJ_RE = re.compile(rf"(^|[。？！])({INTERJ})、")
PAUSE_TO = 0.32


def tts_text(t):
    return INTERJ_RE.sub(lambda m: m.group(1) + m.group(2) + "。", t)


def shorten_pauses(pcm, thr=500, longer=0.4):
    """「。」로 바꾼 줄은 쉼이 0.6~1초로 길어진다. 소리 사이의 긴 쉼을 모두 PAUSE_TO 초로 줄인다."""
    a = array.array("h", pcm); fr = 240
    voiced = [k for k in range(0, len(a), fr) if max(abs(v) for v in a[k:k + fr]) >= thr]
    if not voiced: return pcm
    out, keep, prev = array.array("h", a[:voiced[0]]), int(RATE * PAUSE_TO), voiced[0]
    for k in voiced[1:]:
        if k - prev > RATE * longer:  # prev 프레임 끝 ~ k 사이가 긴 쉼
            out += a[prev:prev + fr + keep // 2] + a[k - keep // 2:k]
        else:
            out += a[prev:k]
        prev = k
    out += a[prev:]
    return out.tobytes()


def lines_of(q, part):
    out = [{"sp": l["sp"], "t": l["t"]} for l in q["script"]]  # 음성에 쓰는 것만 (후리가나·번역은 제외)
    if part in SPOKEN:
        for i, c in enumerate(q["c"]):
            out.append({"sp": "N", "t": f"{i + 1}ばん。{c}", "opt": True})
    for l in out:
        if tts_text(l["t"]) != l["t"]:
            l["say"] = tts_text(l["t"]); l["v"] = 2  # 바뀐 줄만 표시해, 해당 문항만 다시 만든다
    return out


def main():
    engine = say if "--engine" in sys.argv and sys.argv[sys.argv.index("--engine") + 1] == "say" else google
    key = env_key() if engine is google else None
    if "--voices" in sys.argv:
        with urllib.request.urlopen(f"https://texttospeech.googleapis.com/v1/voices?languageCode=ja-JP&key={key}") as r:
            for v in json.load(r)["voices"]:
                print(v["name"], v["ssmlGender"])
        return
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
    CACHE.mkdir(exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
    index_f = OUT / "index.json"
    index = json.loads(index_f.read_text()) if index_f.exists() else {}
    made = calls = 0
    for part in PARTS:
        for q in json.loads((ROOT / "content" / f"{part}.json").read_text(encoding="utf8")):
            if only and q["id"] not in only:
                continue
            # 원본은 c[0]이 정답이므로, 앱과 같은 순서로 섞어 읽어야 번호가 맞는다
            rng = random.Random("n3:" + q["id"]); order = list(range(len(q["c"]))); rng.shuffle(order)
            q = dict(q, c=[q["c"][k] for k in order])
            pick = random.Random("voice:" + q["id"])
            cast = {sp: pick.choice(pool) for sp, pool in VOICES.items()}
            lines = lines_of(q, part)
            sig = hashlib.sha1(json.dumps([engine.__name__, cast, lines], ensure_ascii=False).encode()).hexdigest()[:10]
            out = OUT / f"{q['id']}.m4a"
            if index.get(q["id"]) == sig and out.exists():
                continue
            pcm = bytearray(b"\0\0" * int(RATE * GAP_LEAD))
            prev = None
            for l in lines:
                voice = cast[l["sp"]]
                text = l.get("say", l["t"])
                h = hashlib.sha1(f"{engine.__name__}|{voice}|{text}".encode()).hexdigest()
                cf = CACHE / f"{h}.pcm"
                if not cf.exists():
                    cf.write_bytes(engine(text, voice, key)); calls += 1
                gap = GAP_OPT if l.get("opt") else GAP_TURN if prev is not None else 0
                body = cf.read_bytes()
                if "say" in l:
                    body = shorten_pauses(body)
                pcm += b"\0\0" * int(RATE * gap) + body
                prev = l["sp"]
            pcm += b"\0\0" * int(RATE * 0.5)
            with tempfile.TemporaryDirectory() as d:
                w = f"{d}/x.wav"
                with wave.open(w, "wb") as f:
                    f.setnchannels(1); f.setsampwidth(2); f.setframerate(RATE); f.writeframes(bytes(pcm))
                subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "48000", w, str(out)], check=True)
            index[q["id"]] = sig; made += 1
            index_f.write_text(json.dumps(index, indent=0, sort_keys=True))
            print(f"{q['id']} ({len(pcm) / 2 / RATE:.0f}초)", flush=True)
    print(f"완료: 새로 만든 파일 {made}개, 합성 요청 {calls}회")


main()

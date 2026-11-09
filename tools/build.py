#!/usr/bin/env python3
"""content/*.json 을 검사하고 public/questions.js 로 묶는다.
- 작성할 때 c[0]이 정답이므로, id를 시드로 보기를 섞어 정답 위치를 고르게 한다.
- 파트별 문항을 모의고사 회차에 나눠 담는다.
사용: python3 tools/build.py [--check]
"""
import json, random, re, sys, html.parser
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARTS = [
    # key, 이름, 일본어, 영역, 지시문, 소리로만 보기 제시, 그룹, 시험 1회분 수량(그룹은 지문 수), 교시
    ("kanji", "한자 읽기", "漢字読み", "문자·어휘", "＿＿＿のことばの読み方として最もよいものを、一つえらびなさい。", 0, 0, 8, 0),
    ("hyoki", "한자 표기", "表記", "문자·어휘", "＿＿＿のことばを漢字で書くとき、最もよいものを、一つえらびなさい。", 0, 0, 6, 0),
    ("bunmyaku", "문맥 규정", "文脈規定", "문자·어휘", "（　　　）に入れるのに最もよいものを、一つえらびなさい。", 0, 0, 11, 0),
    ("iikae", "유의어", "言い換え類義", "문자·어휘", "＿＿＿に意味が最も近いものを、一つえらびなさい。", 0, 0, 5, 0),
    ("yoho", "용법", "用法", "문자·어휘", "つぎのことばの使い方として最もよいものを、一つえらびなさい。", 0, 0, 5, 0),
    ("bunpo1", "문법 형식", "文の文法1", "문법", "（　　　）に入れるのに最もよいものを、一つえらびなさい。", 0, 0, 13, 1),
    ("narabe", "문장 배열", "文の文法2", "문법", "つぎの文の ★ に入る最もよいものを、一つえらびなさい。", 0, 0, 5, 1),
    ("bunsho", "글의 문법", "文章の文法", "문법", "文章全体の内容を考えて、[　]に入る最もよいものを、一つえらびなさい。", 0, 1, 1, 1),
    ("tanbun", "단문 독해", "内容理解（短文）", "독해", "文章を読んで、質問に対する答えとして最もよいものを、一つえらびなさい。", 0, 1, 4, 1),
    ("chubun", "중문 독해", "内容理解（中文）", "독해", "文章を読んで、質問に対する答えとして最もよいものを、一つえらびなさい。", 0, 1, 2, 1),
    ("chobun", "장문 독해", "内容理解（長文）", "독해", "文章を読んで、質問に対する答えとして最もよいものを、一つえらびなさい。", 0, 1, 1, 1),
    ("joho", "정보 검색", "情報検索", "독해", "案内を見て、質問に対する答えとして最もよいものを、一つえらびなさい。", 0, 1, 1, 1),
    ("kadai", "과제 이해", "課題理解", "청해", "話を聞いて、最もよいものを一つえらびなさい。", 0, 0, 6, 2),
    ("point", "포인트 이해", "ポイント理解", "청해", "質問を聞いて、話を聞いて、最もよいものを一つえらびなさい。", 0, 0, 6, 2),
    ("gaiyo", "개요 이해", "概要理解", "청해", "話を聞いて、質問と選択肢を聞き、最もよいものを一つえらびなさい。", 1, 0, 3, 2),
    ("hatsuwa", "발화 표현", "発話表現", "청해", "何と言いますか。最もよいものを一つえらびなさい。", 1, 0, 4, 2),
    ("sokuji", "즉시 응답", "即時応答", "청해", "文を聞いて、その返事を聞き、最もよいものを一つえらびなさい。", 1, 0, 9, 2),
]
OK_TAGS = {"u", "ruby", "rt", "br", "b", "table", "tr", "th", "td"}
errors, warnings = [], []


class TagCheck(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.bad = set(); self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag not in OK_TAGS or attrs:
            self.bad.add(tag)
        if tag != "br":
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1] != tag:
            self.bad.add("/" + tag)
        else:
            self.stack.pop()


def check_html(where, text):
    p = TagCheck(); p.feed(text or ""); p.close()
    if p.bad or p.stack:
        errors.append(f"{where}: 허용되지 않거나 닫히지 않은 태그 {sorted(p.bad)} {p.stack}")

RUBY = re.compile(r"\{([^{}|]+)\|([^{}|]+)\}")
plain_of = lambda s: RUBY.sub(lambda m: m.group(1), s)
strip_tags = lambda s: re.sub(r"<[^>]+>", "", re.sub(r"<rt>.*?</rt>", "", s or ""))
missing_enrich = Counter()


def ruby_html(s):
    out, last = [], 0
    for m in RUBY.finditer(s):
        out.append(html.escape(s[last:m.start()], quote=False))
        out.append(f"<ruby>{html.escape(m.group(1), quote=False)}<rt>{html.escape(m.group(2), quote=False)}</rt></ruby>")
        last = m.end()
    out.append(html.escape(s[last:], quote=False))
    return "".join(out)


def check_ruby(where, s):
    if re.search(r"[{}|]", RUBY.sub("", s)):
        errors.append(f"보강: {where}: 후리가나 괄호 형식 오류 {s[:40]}")
    for m in RUBY.finditer(s):
        if not re.fullmatch(r"[0-9０-９]*[\u4e00-\u9fff々〆ヶ]+", m.group(1)) or not re.fullmatch(r"[ぁ-ゖー]+", m.group(2)):
            errors.append(f"보강: {where}: 후리가나 글자 오류 {{{m.group(1)}|{m.group(2)}}}")
    if re.search(r"[\u4e00-\u9fff々]", RUBY.sub("", s)):
        errors.append(f"보강: {where}: 후리가나 없는 한자 {RUBY.sub('', s)[:40]}")
    if "<" in s:
        errors.append(f"보강: {where}: HTML 태그가 들어 있음")


def check_enrich(q, part):
    i = q["id"]
    keys = ("fr", "fk", "cr", "cm", "cn")
    if not any(k in q for k in keys):
        missing_enrich[part] += 1
        return
    for k in keys:
        if k not in q:
            return errors.append(f"보강: {i}: {k} 없음")
    n = len(q["c"])
    for k in ("cr", "cm", "cn"):
        if not isinstance(q[k], list) or len(q[k]) != n or not all(isinstance(x, str) for x in q[k]):
            return errors.append(f"보강: {i}: {k} 개수가 선지와 다름")
    if not all(x.strip() for x in q["cm"] + q["cn"]):
        errors.append(f"보강: {i}: 빈 뜻/설명")
    check_ruby(i + ".fr", q["fr"])
    if q["fr"] and not q["fk"]:
        errors.append(f"보강: {i}: fk 없음")
    for j, (c, r) in enumerate(zip(q["c"], q["cr"])):
        check_ruby(f"{i}.cr[{j}]", r)
        if plain_of(r) != strip_tags(c):
            errors.append(f"보강: {i}.cr[{j}] 원래 선지와 다름\n   {plain_of(r)}\n   {strip_tags(c)}")
    for j, l in enumerate(q.get("script") or []):
        if "r" not in l or "k" not in l or not l["k"].strip():
            errors.append(f"보강: {i}: 대본 {j}번 줄에 r/k 없음"); continue
        check_ruby(f"{i}.script[{j}]", l["r"])
        if plain_of(l["r"]) != l["t"]:
            errors.append(f"보강: {i}: 대본 {j}번 줄 r이 t와 다름\n   {plain_of(l['r'])}\n   {l['t']}")


def check_q(q, part, spoken, gid=None):
    i = q.get("id", "?")
    n = 3 if part in ("hatsuwa", "sokuji") else 4
    c = q.get("c")
    if not isinstance(c, list) or len(c) != n or not all(isinstance(x, str) and x.strip() for x in c):
        return errors.append(f"{i}: 보기가 {n}개가 아니거나 비어 있음")
    if len(set(c)) != n:
        errors.append(f"{i}: 보기 중복")
    if not q.get("e"):
        errors.append(f"{i}: 해설 없음")
    if re.search(r"(?<![0-9])[1-4]번|첫 번째|두 번째|세 번째|네 번째", q.get("e", "")):
        warnings.append(f"{i}: 해설이 보기 번호를 언급하는 듯함")
    if part not in ("sokuji", "gaiyo") and not q.get("q"):
        errors.append(f"{i}: 문제문 없음")
    check_html(i, q.get("q")); [check_html(i, x) for x in c]
    if part in ("kanji", "hyoki", "iikae") and "<u>" not in q.get("q", ""):
        errors.append(f"{i}: 밑줄 없음")
    if part == "kanji" and not all(re.fullmatch(r"[ぁ-ゖー]+", x) for x in c):
        errors.append(f"{i}: 보기가 히라가나가 아님 {c}")
    if part == "yoho":
        if len(c[0]) < 8:
            errors.append(f"{i}: 용법 보기가 문장이 아님")
    if part == "narabe":
        seq = q.get("seq")
        slots = re.findall(r"＿＿＿|★", q.get("q", ""))
        if q["q"].count("★") != 1 or len(slots) != 4:
            errors.append(f"{i}: 슬롯이 ＿＿＿ 3개 + ★ 1개가 아님")
        elif sorted(seq or []) != [0, 1, 2, 3] or seq[slots.index("★")] != 0:
            errors.append(f"{i}: seq가 잘못됨 {seq}")
        else:
            it = iter(c[k] for k in seq)
            built = re.sub(r"＿＿＿|★", lambda m: next(it), q["q"])
            norm = lambda s: re.sub(r"\s|<[^>]+>", "", s)
            if norm(built) != norm(q.get("answer", "")):
                errors.append(f"{i}: 조각을 맞춘 문장이 answer와 다름\n   {norm(built)}\n   {norm(q.get('answer',''))}")
    if part in ("kadai", "point", "gaiyo", "hatsuwa", "sokuji"):
        s = q.get("script")
        if not s or not all(l.get("sp") in ("M", "F", "N") and l.get("t") for l in s):
            errors.append(f"{i}: 대본 오류")
        elif any(re.search(r"[()（）「」\[\]<>]", l["t"]) for l in s):
            warnings.append(f"{i}: 대본에 음성합성이 읽기 나쁜 기호")


def main():
    all_q, groups, parts_out, seen = [], {}, [], set()
    for key, name, ja, area, ins, spoken, group, per, sec in PARTS:
        parts_out.append(dict(key=key, name=name, ja=ja, area=area, ins=ins, spoken=spoken, group=group))
        f = ROOT / "content" / f"{key}.json"
        if not f.exists():
            warnings.append(f"{key}: 파일 없음")
            continue
        items = json.loads(f.read_text(encoding="utf8"))
        for it in items:
            if group:
                gid = it["id"]
                check_html(gid, it.get("text"))
                groups[gid] = dict(title=it.get("title", ""), text=it["text"], tr=it.get("tr", ""))
                qs = it["questions"]
            else:
                gid, qs = None, [it]
            for q in qs:
                if q.get("id") in seen:
                    errors.append(f"{q.get('id')}: id 중복")
                seen.add(q.get("id"))
                check_q(q, key, spoken, gid)
                if q.get("c"):
                    check_enrich(q, key)
                if "c" not in q or len(q["c"]) < 3:
                    continue
                rng = random.Random("n3:" + q["id"])
                order = list(range(len(q["c"])))
                rng.shuffle(order)
                o = dict(q, part=key, c=[q["c"][k] for k in order], a=order.index(0))
                if "cr" in q and len(q["cr"]) == len(q["c"]):
                    o.update(fr=ruby_html(q["fr"]), cr=[ruby_html(q["cr"][k]) for k in order],
                             cm=[q["cm"][k] for k in order], cn=[q["cn"][k] for k in order])
                if q.get("script"):
                    o["script"] = [dict(l, r=ruby_html(l["r"])) if "r" in l else l for l in q["script"]]
                if q.get("seq"):
                    o["seq"] = [order.index(k) for k in q["seq"]]
                if gid:
                    o["gid"] = gid
                all_q.append(o)

    # 청해 음성 파일이 있으면 경로를 붙인다 (?v= 로 대본이 바뀌면 캐시를 새로 받게 함)
    af = ROOT / "public" / "audio" / "index.json"
    audio = json.loads(af.read_text()) if af.exists() else {}
    for q in all_q:
        if q["id"] in audio and (ROOT / "public" / "audio" / f"{q['id']}.m4a").exists():
            q["au"] = f"audio/{q['id']}.m4a?v={audio[q['id']]}"
    listening = [q for q in all_q if q.get("script")]
    print(f"청해 음성 파일 {sum(1 for q in listening if q.get('au'))}/{len(listening)}")

    # 모의고사 배분: 파트별로 시드 셔플 후 앞에서부터 나눠 담는다
    by_unit = {}
    for q in all_q:
        by_unit.setdefault(q["part"], {}).setdefault(q.get("gid") or q["id"], []).append(q["id"])
    n_exam = min((len(by_unit.get(p[0], {})) // p[7] for p in PARTS), default=0)
    exams = []
    pools = {}
    for p in PARTS:
        u = sorted(by_unit.get(p[0], {}).keys())
        random.Random("exam:" + p[0]).shuffle(u)
        pools[p[0]] = u
    for no in range(n_exam):
        sec = [[], [], []]
        for p in PARTS:
            for u in pools[p[0]][no * p[7]:(no + 1) * p[7]]:
                sec[p[8]].extend(by_unit[p[0]][u])
        exams.append(dict(no=no + 1, sec=sec))

    print("파트별 문항:", dict(Counter(q["part"] for q in all_q)))
    print("합계", len(all_q), "| 지문", len(groups), "| 모의고사", n_exam, "회", [len(sum(e["sec"], [])) for e in exams])
    if missing_enrich:
        print("보강 안 됨:", dict(missing_enrich))
    print("정답 위치 분포:", dict(sorted(Counter(q["a"] for q in all_q).items())))
    for w in warnings[:40]:
        print("주의:", w)
    if errors:
        print(f"\n오류 {len(errors)}건")
        for e in errors[:400]:
            print(" -", e)
        sys.exit(1)
    if "--check" not in sys.argv:
        out = dict(parts=parts_out, q=all_q, g=groups, exams=exams)
        (ROOT / "public" / "questions.js").write_text(
            "window.N3=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf8")
        print("public/questions.js", (ROOT / "public/questions.js").stat().st_size // 1024, "KB")


main()

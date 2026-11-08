// 아이디/비밀번호 계정 관리. 이메일을 받지 않으므로 서버에서 인증 완료 상태로 계정을 만든다.
// POST { action:"signup", username, password }
// POST { action:"delete" }  (Authorization: Bearer <사용자 토큰>)
const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// 앱의 toEmail()과 같은 규칙. 한글 아이디도 쓸 수 있게 16진수로 바꾼다.
const toEmail = (u: string) =>
  "u" + [...new TextEncoder().encode(u)].map((b) => b.toString(16).padStart(2, "0")).join("") + "@users.jlptn3.app";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "허용되지 않는 요청이에요" });
  let body: { action?: string; username?: string; password?: string };
  try { body = await req.json(); } catch { return json(400, { error: "잘못된 요청이에요" }); }

  if (body.action === "signup") {
    const username = String(body.username ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!/^[a-z0-9_가-힣]{2,20}$/.test(username)) return json(400, { error: "아이디는 한글·영문·숫자 2~20자로 만들어 주세요" });
    if (password.length < 8 || password.length > 72) return json(400, { error: "비밀번호는 8자 이상으로 만들어 주세요" });

    const made = await fetch(`${URL_}/auth/v1/admin/users`, {
      method: "POST", headers: admin,
      body: JSON.stringify({ email: toEmail(username), password, email_confirm: true }),
    });
    if (!made.ok) {
      const t = await made.text();
      if (made.status === 422 || /already/i.test(t)) return json(409, { error: "이미 있는 아이디예요" });
      console.error("signup failed", made.status, t);
      return json(502, { error: "가입하지 못했어요. 잠시 뒤 다시 시도해 주세요" });
    }
    const user = await made.json();
    const prof = await fetch(`${URL_}/rest/v1/profiles`, {
      method: "POST", headers: admin, body: JSON.stringify({ user_id: user.id, nickname: username }),
    });
    if (!prof.ok) {
      await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: admin });
      console.error("profile failed", prof.status, await prof.text());
      return json(502, { error: "가입하지 못했어요. 잠시 뒤 다시 시도해 주세요" });
    }
    return json(200, { ok: true });
  }

  if (body.action === "delete") {
    const me = await fetch(`${URL_}/auth/v1/user`, {
      headers: { apikey: SERVICE, Authorization: req.headers.get("Authorization") ?? "" },
    });
    if (!me.ok) return json(401, { error: "다시 로그인해 주세요" });
    const { id } = await me.json();
    const del = await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: admin });
    return del.ok ? json(200, { ok: true }) : json(502, { error: "삭제하지 못했어요" });
  }
  return json(400, { error: "알 수 없는 요청이에요" });
});

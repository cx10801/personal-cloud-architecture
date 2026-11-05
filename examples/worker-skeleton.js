/**
 * 单文件 Worker 骨架
 *
 * 包含：路由分发、Access JWT 二次校验、统一响应封装、CORS。
 * 不依赖任何第三方包。
 */

// ---------- 响应封装 ----------

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });

const text = (s, status = 200) => new Response(s, { status });

// ---------- Access JWT 校验 ----------

let jwksCache = null;
let jwksExpiry = 0;

async function getJwks(env) {
  const now = Date.now();
  if (jwksCache && now < jwksExpiry) return jwksCache;

  const res = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);

  jwksCache = await res.json();
  jwksExpiry = now + 3600_000; // 1 小时
  return jwksCache;
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * 校验边缘注入的 JWT。
 * 返回 payload 或 null（不抛异常，由调用方决定如何处理）。
 */
export async function verifyAccessJwt(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const jwks = await getJwks(env);
    const jwk = jwks.keys?.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

    // aud 必须匹配本应用 —— 不校验会导致令牌可跨应用复用
    if (env.EXPECTED_AUD && payload.aud !== env.EXPECTED_AUD) return null;
    if (payload.exp * 1000 < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

// ---------- 路由 ----------

const routes = {
  "GET /health": async () => json({ ok: true, ts: Date.now() }),

  "GET /api/me": async (req, env) => {
    const user = await verifyAccessJwt(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    return json({ email: user.email, sub: user.sub });
  },

  "GET /api/items": async (req, env) => {
    const user = await verifyAccessJwt(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    // KV 前缀列举，注意 list() 是最终一致的
    const list = await env.STORE.list({ prefix: "item:", limit: 100 });
    return json({ keys: list.keys.map((k) => k.name) });
  },

  "POST /api/items": async (req, env) => {
    const user = await verifyAccessJwt(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => null);
    if (!body?.name) return json({ error: "name required" }, 400);

    const id = crypto.randomUUID();
    await env.STORE.put(`item:${id}`, JSON.stringify({ ...body, id, at: Date.now() }));
    return json({ id }, 201);
  },
};

// ---------- 入口 ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 统一 CORS（按需收紧到具体域名）
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": env.ALLOW_ORIGIN || "*",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
          "access-control-max-age": "86400",
        },
      });
    }

    const key = `${request.method} ${url.pathname}`;
    const handler = routes[key];

    if (!handler) return json({ error: "not found", path: url.pathname }, 404);

    try {
      const res = await handler(request, env, ctx);
      res.headers.set("access-control-allow-origin", env.ALLOW_ORIGIN || "*");
      return res;
    } catch (err) {
      console.error("handler error", key, err?.stack || err);
      return json({ error: "internal error" }, 500);
    }
  },

  // 定时任务：必须幂等
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        // 示例：清理 7 天前的条目
        const cutoff = Date.now() - 7 * 86400_000;
        const list = await env.STORE.list({ prefix: "item:" });
        for (const k of list.keys) {
          const v = await env.STORE.get(k.name, "json");
          if (v && v.at < cutoff) await env.STORE.delete(k.name);
        }
      })(),
    );
  },
};

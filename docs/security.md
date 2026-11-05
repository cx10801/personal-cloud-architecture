# 安全设计

## 1. 威胁模型

先明确防什么、不防什么。单用户自托管服务的攻击面与多租户 SaaS 完全不同。

| 威胁 | 是否防御 | 说明 |
|---|---|---|
| 互联网上的自动化扫描与爆破 | 是 | 无公网入站端口，扫描无从下手 |
| 凭证泄露（密钥被推到公开仓库） | 是 | 提交前扫描 + Secret 注入 |
| 上游服务商侧密钥泄露 | 部分 | 只影响单一上游，可轮换 |
| 设备丢失 | 是 | 会话可远程吊销 |
| 供应链攻击（依赖投毒） | 部分 | 尽量零依赖，Worker 侧无第三方包 |
| 定向 APT | 否 | 不在防御范围 |
| 服务商内部人员访问 | 否 | 数据在边缘明文存储，未做端到端加密 |

---

## 2. 身份架构

### 2.1 为什么不用「每个应用一套登录」

早期每个应用各写一套密码登录。结果是：

- 密码散落在 8 个地方，改一次要改 8 处；
- 会话实现各不相同，有的用 Cookie，有的用 localStorage；
- 没有统一的登出、没有统一的审计。

现在改为**网络层鉴权**：应用不知道密码存在，只信任边缘注入的 JWT。

### 2.2 双通道设计

```
通道 A（日常）：零信任访问控制 → 自建 OIDC IdP
通道 B（应急）：管理后台自带的密码 + TOTP
```

**为什么要两条？** 因为通道 A 依赖服务器上的 IdP，服务器挂了通道 A 就断。如果没有通道 B，故障时进不了后台，只能干等。

这不是冗余，是故障隔离。代价是通道 B 的凭据要单独保管。

### 2.3 JWT 二次校验

边缘通过后会注入 JWT，Worker 侧仍然校验一遍：

```js
async function verifyAccessJwt(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const [h, p, s] = token.split(".");
  const header = JSON.parse(atob(h));

  // 1. 取 JWKS（缓存 1 小时）
  const jwks = await getJwks(env);
  const key = jwks.keys.find(k => k.kid === header.kid);
  if (!key) return null;

  // 2. 验签
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    base64UrlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  // 3. 校验声明
  const payload = JSON.parse(atob(p));
  if (payload.aud !== env.EXPECTED_AUD) return null;   // 关键：aud 必须匹配本应用
  if (payload.exp * 1000 < Date.now()) return null;

  return payload;
}
```

**`aud` 校验是关键。** 不校验的话，为应用 A 签发的 JWT 可以直接拿去访问应用 B——所有应用共享同一个身份提供方，令牌是通用的。这是零信任架构里最容易被忽略的一个洞。

---

## 3. 密钥管理

### 3.1 分级

| 级别 | 例子 | 存储位置 | 轮换周期 |
|---|---|---|---|
| 根 | 云厂商 API Token、SSH 替代通道 | 密码管理器 | 90 天 |
| 上游 | 模型供应商密钥、邮件发送密钥 | Worker Secret | 180 天 |
| 应用 | 会话签名密钥、JWT Secret | Worker Secret | 180 天 |
| 客户端 | 平台签发的 API Key | KV（哈希） | 按需吊销 |

**原则：低级别密钥泄露不能导致高级别密钥泄露。** 所以客户端 Key 无法换算出上游 Key，上游 Key 无法换算出云厂商 Token。

### 3.2 提交前扫描

```bash
#!/usr/bin/env bash
# scan-secrets.sh —— 退出码 0 表示干净
set -euo pipefail

PATTERNS=(
  'ghp_[A-Za-z0-9]{36}'                  # GitHub PAT
  'github_pat_[A-Za-z0-9_]{82}'
  'AKIA[0-9A-Z]{16}'                     # AWS Access Key
  'sk-[A-Za-z0-9]{32,}'                  # 通用 API Key
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'  # JWT
)

found=0
for p in "${PATTERNS[@]}"; do
  if grep -rEn "$p" --include='*.js' --include='*.ts' --include='*.toml' \
       --include='*.yml' --include='*.json' --include='*.md' . 2>/dev/null; then
    found=1
  fi
done

# 额外检查：不该存在的文件名
for f in .env .dev.vars _tokens.json credentials.json; do
  [ -f "$f" ] && ! grep -qx "$f" .gitignore 2>/dev/null && { echo "!! $f 未忽略"; found=1; }
done

exit $found
```

这个脚本的局限要说清楚：**它只能抓格式已知的密钥**。自己拼的密钥、Base64 编码后的密钥都抓不到。所以还要配合人工检查 `git diff --cached`。

### 3.3 一次真实的配置事故

早期 Caddy 里用 `map` 做 Token 白名单：

```caddy
map {token_a}|{token_b} {auth} {
    default "BLOCK"
}
```

问题在于**反引号在 Caddyfile 里是字面量**，`{token_a}` 不会被展开成变量值。结果这个 map 的输入永远是字符串 `"{token_a}|{token_b}"`，而 `{auth}` 永远匹配不到，全部落到 `default "BLOCK"`。

表现是：所有请求 403，包括携带正确 Token 的。排查方向一开始跑偏了（怀疑令牌失效、怀疑上游拒绝），最后靠逐段注释配置才定位。

**教训**：配置语言的字符串语义必须查文档确认，不能凭「看起来像模板」就假设它会展开。

---

## 4. 网络暴露面

### 4.1 服务器

| 项目 | 状态 |
|---|---|
| 公网入站端口 | 无 |
| SSH | 关闭，改用云厂商 Session Manager |
| 出站 | 允许（拉镜像、连上游） |
| 容器端口 | 全部绑 `127.0.0.1` 或 Docker 网桥 |
| 安全组 | 撤销全部 `0.0.0.0/0` 入站规则 |

**Session Manager 替代 SSH 的取舍：**

优点：无私钥管理、操作留痕、不需要开端口。
缺点：依赖云厂商控制面；大文件传输慢；交互式终端偶尔卡顿。

对本项目（低频运维）是净收益。

### 4.2 边缘

| 项目 | 状态 |
|---|---|
| 公开可访问 | AI 网关（需 Key）、图床（需 Token）、短链（公开读） |
| 受保护 | 门户、网盘、每日、邮箱、状态面板 |
| 应删除但曾存在 | 通用 URL 代理（`/proxy?url=`） |

**那条通用代理是最危险的东西。** 它允许任意 URL 转发，等于把 Worker 变成一个开放的 SSRF 跳板——攻击者可以用它访问内网地址、探测云厂商元数据接口。

已删除。教训是：**「顺手加个代理方便调试」这个念头本身就是漏洞。**

---

## 5. 会话管理

| 参数 | 值 | 理由 |
|---|---|---|
| Access 会话时长 | 720 h（30 天） | 单用户场景，频繁重认证的体验代价大于安全收益 |
| 应用内会话 | 12 h | 管理后台权限更高，缩短窗口 |
| 令牌轮换 | 每次刷新 | 降低令牌被截获后的可用窗口 |

30 天的会话是一个明确的取舍：**移动端每次打开都要重新登录是不可接受的**。补偿手段是设备丢失时可从控制台吊销全部会话。

---

## 6. 日志与隐私

| 数据 | 是否记录 |
|---|---|
| 请求路径、状态码、耗时 | 是 |
| 客户端 IP | 是（边缘自动，用于限流） |
| 请求体 | 否（调试模式除外，且 5 分钟过期） |
| 响应体 | 否 |
| API Key 明文 | 否（只记前 8 位用于定位） |
| 文件名 | 是（网盘需要） |
| 文件内容 | 否 |

**这条边界是刻意的：日志系统不应该成为第二个数据库。** 一旦日志里有了用户内容，日志的保留策略、访问控制、备份加密全部要跟着升级——复杂度会失控。

---

## 7. 待改进

1. **无端到端加密**。数据在边缘以明文存储，服务商理论上可见。要做需要客户端加密，代价是所有检索功能失效。
2. **无入侵检测**。没有异常行为告警（比如某 Key 突然用量暴增）。
3. **备份未加密**。服务器备份是明文 tar 包，虽然存在私有桶里。
4. **没有做最小权限的完整落地**。部分脚本仍在用权限较宽的主 Token，理想状态是每个脚本一个专用 Token。

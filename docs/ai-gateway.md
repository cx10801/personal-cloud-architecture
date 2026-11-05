# AI 网关设计

一个自建的、OpenAI 兼容的统一模型入口。目标不是「多接几家模型」，而是**把所有模型调用收敛成一个可计量、可吊销、可切换的出口**。

---

## 1. 为什么要自建

直接用各家 SDK 的问题：

| 问题 | 具体表现 |
|---|---|
| 密钥扩散 | 每个客户端、每台设备各存一份上游 Key，泄露一次全部重配 |
| 无法计量 | 不知道谁用了多少，月底账单是个黑盒 |
| 无法切换 | 上游故障时，要改每个客户端的配置 |
| 无法限流 | 单个脚本写错循环，能把额度一夜打光 |

网关把这四件事收到一处：**客户端只认平台签发的 Key，上游对它不可见。**

---

## 2. 请求生命周期

```
                    ┌─────────────────────────────────┐
客户端 ──Key──▶     │  1  鉴权   2  配额   3  路由    │
                    │  4  注入   5  转发   6  记账    │
                    └─────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
              上游 A（主）                    上游 B（备）
```

### 2.1 鉴权

Key 格式：

```
sk-<tenant>-<random 32 hex>
```

- `tenant` 明文可见，用于快速定位，不含敏感信息；
- 随机段不落库原文，KV 里存的是 `sha256(key)` 的前 16 位作为索引键。

这样即使 KV 泄露，也无法反推出可用 Key。

### 2.2 配额

配额按「租户 + 月份」分片：

```
ai:usage:<tenant>:<YYYY-MM>  →  { requests, prompt_tokens, completion_tokens }
```

检查在请求前，累加在请求后。**累加是异步的**——如果同步写，每个请求会多一次 KV 写延迟（约 30–60 ms），对流式响应是明显负担。

代价是：极端并发下可能小幅超额。个人场景可接受，多租户场景需要换成强一致的计数器。

### 2.3 路由

上游注册表是一个纯数据文件，与业务逻辑分离：

```js
// providers.js —— 只描述「有哪些上游、怎么连」，不含任何逻辑
export default [
  {
    id: "primary",
    baseUrl: "https://<upstream-a>/v1",
    keySecret: "UPSTREAM_A_KEY",   // 指向 Secret 名，不是密钥本身
    models: ["*"],                  // 通配，或显式列出
    weight: 100,
    timeoutMs: 60000,
  },
  {
    id: "fallback",
    baseUrl: "https://<upstream-b>/v1",
    keySecret: "UPSTREAM_B_KEY",
    models: ["*"],
    weight: 0,                      // 0 = 仅作备用，不参与常规分流
    timeoutMs: 45000,
  },
];
```

**关键设计：注册表里存的是「Secret 的名字」，不是密钥本身。** 这样这份文件可以进版本库，不会因为误提交而泄露。

### 2.4 注入与转发

```
客户端请求头：Authorization: Bearer sk-<tenant>-<random>
                    ↓ 剥离
上游请求头：  Authorization: Bearer <真实上游密钥>
```

同时注入上游要求的其他头（版本号、组织 ID 等），并把客户端的 `User-Agent` 改写为固定值——避免上游按 UA 做差异化限流。

### 2.5 失败切换

只在以下情形切换，且**仅在尚未向客户端输出任何字节时**：

- 连接建立失败
- 上游返回 5xx
- 首字节超时

一旦开始流式输出，任何错误都直接透传给客户端。原因：部分输出后重试会导致内容拼接错乱，比直接报错更糟。

```js
// 简化后的判定逻辑
let committed = false;
for (const upstream of candidates) {
  try {
    const res = await fetch(upstream.url, init);
    if (res.status >= 500) continue;        // 未提交，可以换
    committed = true;
    return streamToClient(res);             // 已提交，后续错误不再重试
  } catch (e) {
    if (committed) throw e;
  }
}
```

---

## 3. 流式响应的处理

OpenAI 兼容接口用 SSE（`text/event-stream`）。三个细节：

**第一，不要缓冲。** 用 `TransformStream` 边读边转，否则「流式」变成「等完整再吐」，首字延迟从 500 ms 变成 8 s。

**第二，统计 token 要在流里数。** 上游在最后一个 chunk 里带 `usage` 字段（需要请求时显式要求 `stream_options: {include_usage: true}`）。如果上游不支持，只能按字符数估算，误差约 ±15%。

**第三，客户端断开要能感知。** 用 `request.signal` 监听 abort，及时关闭上游连接，否则上游会继续计费。

```js
const { readable, writable } = new TransformStream();
const writer = writable.getWriter();

(async () => {
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      usage.observe(value);          // 顺路统计
      await writer.write(value);
    }
  } finally {
    writer.close();
    await recordUsage(usage);         // 异步记账
  }
})();

return new Response(readable, {
  headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
});
```

---

## 4. 管理面

管理后台挂在 `/admin`，与业务 API **共用同一个 Worker 但完全独立的鉴权链**：

| 层 | 机制 |
|---|---|
| 第一因子 | 密码（Secret 注入，非配置文件） |
| 第二因子 | TOTP（可选，Base32 Secret） |
| 会话 | 签名 Cookie，密钥来自 `CONFIG_ENC_KEY`，有效期 12 h |
| 来源限制 | 仅允许通过零信任入口访问（边缘策略） |

**为什么不复用零信任的身份？** 因为管理面需要能在「身份提供方挂了」的时候依然可用——否则故障时无法进后台处置。这是刻意的双通道设计。

### 管理面能做什么

- 查看/新增/吊销客户端 Key
- 查看各租户用量与配额
- 切换上游权重、临时禁用某个上游
- 查看最近的失败请求（仅记录状态码与上游 ID，不记录请求内容）

**不做什么**：不提供对话历史查看。网关是管道，不是存储，不留用户内容。

---

## 5. 安全边界

| 威胁 | 缓解 |
|---|---|
| Key 泄露 | 哈希存储 + 可即时吊销 + 按租户隔离配额 |
| 上游密钥泄露 | 只存 Secret，注册表只存名字；日志脱敏 |
| 重放 | 上游密钥不落客户端，客户端 Key 不可用于直连上游 |
| 滥用（循环调用） | 按租户限流 + 日配额上限 |
| 后台爆破 | 密码 + TOTP + 边缘来源限制 |
| 日志泄露内容 | 日志只记元数据（长度、状态码、上游 ID） |

### 一个真实的设计错误

早期版本在日志里记录了完整的请求体，用于「排查问题」。这等于把用户的全部对话内容写进了日志系统。

后来改成：**默认不记录请求体，只在显式开启调试模式时记录前 200 字符，且 5 分钟后自动清除。** 排查需求其实很少需要完整 body——状态码、上游 ID、耗时三个字段能定位 90% 的问题。

---

## 6. 已知不足

1. **用量统计非强一致**，并发高时可能低估 1–3%。
2. **不支持按模型细粒度计费**，只统计 token 总量。要做成本核算需要在上游侧对账。
3. **失败切换是线性的**，不做健康探测。一个上游持续失败时，每个请求都要先撞一次失败再切——延迟会翻倍。改进方向是加熔断器（连续 N 次失败后冷却 M 秒）。
4. **单区域**。Worker 虽然全球分布，但 KV 是最终一致的，跨区域读配额可能读到旧值。

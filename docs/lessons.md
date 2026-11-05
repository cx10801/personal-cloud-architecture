# 踩坑记录

这里记的是**排查过程中真正卡住过的点**，不是教程。每条都注明了症状、根因、验证方式。

---

## 1. 容器里的 `127.0.0.1` 不是宿主机

**症状**：隧道配好了，DNS 也对，但访问子域返回 502。

**排查过程**：

```bash
# 宿主机上直接测，通
curl -sI http://127.0.0.1:8765
# HTTP/1.1 200 OK

# 进容器里测，不通
docker exec cloudflared wget -qO- http://127.0.0.1:8765
# 连接被拒绝
```

**根因**：`cloudflared` 跑在容器内，`127.0.0.1` 指向容器自己的 loopback，不是宿主机的。而目标服务只监听 `127.0.0.1`（出于安全），所以容器也访问不到。

**解法**：加一层 socat 桥接。

```ini
# /etc/systemd/system/agent-bridge.service
[Unit]
Description=Bridge Docker network to loopback service
After=network.target

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:8766,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:8765
Restart=always

[Install]
WantedBy=multi-user.target
```

隧道指向 `172.17.0.1:8766`，桥接转发到 `127.0.0.1:8765`。桥接端口只绑在 Docker 网桥上，公网不可达。

**为什么不用 `network_mode: host`**：那样确实能解决，但等于让容器共享宿主机网络栈，安全边界消失。为一个端口放弃隔离不划算。

---

## 2. Caddyfile 里的反引号是字面量

**症状**：一个反向代理对所有请求返回 403，包括携带正确 Token 的请求。

**根因**：

```caddy
map `{token_a}|{token_b}` {auth} {
    default "BLOCK"
}
```

反引号在 Caddyfile 中是**原始字符串**，`{token_a}` 不展开。这个 map 的输入恒为字符串 `"{token_a}|{token_b}"`，永远匹配不上真实 Token，全部落到 `default "BLOCK"`。

**解法**：改成双引号。

```caddy
map "{token_a}|{token_b}" {auth} {
    default "BLOCK"
}
```

**验证方式**（很关键，因为这种错误不会报错）：

```caddy
# 临时加一行，把 map 的实际输入打出来
respond "input={token_a}|{token_b} matched={auth}"
```

**教训**：配置语言里的字符串语义必须查文档，不能凭「看起来像模板占位符」就假设它会展开。这类错误的特征是**静默失败**——不报错，只是结果永远不对。

---

## 3. 云厂商的 KV 有写入频率上限

**症状**：批量导入书签时，大约每 100 条失败几条，报 429。

**根因**：同一 key 的写入有频率限制（约每秒 1 次），而导入脚本在循环里写同一个「索引」key。

**解法**：把索引拆成多个分片。

```js
// 之前：所有书签写一个索引
await kv.put("bookmark:index", JSON.stringify(all));

// 之后：按 hash 分 16 片
const shard = id.charCodeAt(0) % 16;
await kv.put(`bookmark:index:${shard}`, JSON.stringify(batch));
```

读取时 16 片并发拉取再合并。写入压力分散到 16 个 key，实测不再触发限流。

**附带发现**：KV 的 `list()` 是前缀匹配，不支持条件过滤。所以「按标签筛选」这类功能必须在客户端做，或者预先建好标签索引。这是选型时必须提前想清楚的事——KV 不是数据库。

---

## 4. 流式响应不能缓冲

**症状**：AI 网关接好了，但首字延迟高达 8 秒，感觉像没流式。

**根因**：中间加了一层「先读完整再转发」的逻辑，为了统计 token 数量。

```js
// 错误写法
const text = await res.text();      // 等全部读完
const usage = countTokens(text);
return new Response(text);
```

**解法**：用 `TransformStream` 边读边转发，token 在流里累加。

```js
const { readable, writable } = new TransformStream();
const writer = writable.getWriter();
const reader = res.body.getReader();

(async () => {
  let chars = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chars += value.byteLength;
    await writer.write(value);       // 立即吐给客户端
  }
  writer.close();
  await record({ chars });
})();

return new Response(readable, { headers: { "content-type": "text/event-stream" } });
```

首字延迟从 8 s 降到 ~600 ms（上游本身的首字时间）。

---

## 5. 流式响应里重试会导致内容错乱

**症状**：偶尔出现回复内容重复前半段。

**根因**：失败切换逻辑没有判断「是否已经开始向客户端输出」。上游在输出到一半时断开，代码捕获异常后切到备用上游重新请求，两段内容被拼接到同一个响应流里。

**解法**：引入 `committed` 标志。

```js
let committed = false;
for (const up of candidates) {
  try {
    const res = await fetch(up.url, init);
    if (res.status >= 500 && !committed) continue;
    committed = true;
    return pipeToClient(res);
  } catch (e) {
    if (committed) throw e;   // 已经吐出去了，只能报错
    // 否则换下一个
  }
}
```

**原则**：**失败切换只对幂等操作有效。** 一旦产生副作用（向客户端输出了字节），就不能重试。

---

## 6. Worker 的请求体上限会意外截断上传

**症状**：小文件上传正常，超过一定大小后文件损坏，但接口返回 200。

**根因**：边缘对单次请求体有大小上限，超限时请求在到达 Worker 之前就被处理了，Worker 收到的是不完整数据，而代码没有做完整性校验。

**解法**：分片上传 + 服务端校验。

```js
// 客户端：按 5 MB 切片
for (let i = 0; i < chunks; i++) {
  await fetch(`/upload?part=${i}&total=${chunks}`, { method: "PUT", body: slice });
}
await fetch(`/upload/complete`, { method: "POST", body: JSON.stringify({ id, chunks, size }) });

// 服务端：complete 时校验总字节数
const actual = await sumParts(id, chunks);
if (actual !== size) return new Response("size mismatch", { status: 400 });
```

**关键**：不能相信客户端传来的 size，必须实际累加分片大小比对。早期版本就是因为信任了声明值，导致损坏文件被静默接受。

---

## 7. 免费额度的告警默认不生效

**症状**：配了内存和磁盘告警，但一直是「正常」状态，即使实际已经超标。

**根因**：这两条指标依赖服务器上的采集代理。代理没装时，指标不存在，云厂商的告警进入 `INSUFFICIENT_DATA` 状态，而控制台默认显示为 OK。

**解法**：装采集代理，并且**显式检查告警的 `StateReason`**，不要只看颜色。

```bash
aws cloudwatch describe-alarms \
  --query 'MetricAlarms[].[AlarmName,StateValue,StateReason]' \
  --output table
```

**更普遍的教训**：**「没有告警」不等于「没有问题」，可能只是「没有数据」。** 任何监控体系都要区分这三种状态：正常、异常、无数据。

---

## 8. 一个自定义域和一个路由同时指向不同 Worker

**症状**：某个子域的行为与配置不符，改动不生效。

**根因**：这个子域同时存在两条配置——一条是「Worker 自定义域」（指向旧 Worker），一条是「区域路由」（指向新 Worker）。路由优先级更高，所以实际生效的是新的，但控制台里两条都在，看起来像配置冲突。

**解法**：删除旧的自定义域绑定，只保留一种机制。

**教训**：**同一个资源不要用两套机制管理。** 迁移时要清理旧配置，而不是叠加新配置。

---

## 9. Session Manager 不能替代所有 SSH 场景

**症状**：关掉 22 端口后，日常运维没问题，但传大文件极慢。

**根因**：Session Manager 的数据通道经过控制面转发，带宽受限。

**解法**：大文件走对象存储中转。

```bash
# 本地 → 对象存储 → 服务器拉取
aws s3 cp backup.tar.gz s3://<bucket>/tmp/
# 服务器上
aws s3 cp s3://<bucket>/tmp/backup.tar.gz .
```

**取舍**：为了安全放弃 SSH，代价是传输效率。对低频运维可接受；如果需要频繁传大文件，应该保留一个受限来源 IP 的 SSH 端口。

---

## 10. 通用 URL 代理是最容易埋的雷

早期为了调试方便，加了一个 `/proxy?url=<任意地址>` 的转发端点。它带来三个问题：

1. **SSRF**：可以访问内网地址和云厂商元数据接口（`169.254.169.254`）；
2. **被滥用**：别人可以用它做免费代理，消耗你的额度；
3. **难以审计**：不知道谁转发了什么。

**解法**：删除。需要代理时用白名单。

```js
const ALLOW = new Set(["registry.npmjs.org", "github.com", "objects.githubusercontent.com"]);
const u = new URL(target);
if (!ALLOW.has(u.hostname)) return new Response("forbidden", { status: 403 });
```

**教训**：**「方便调试」是安全设计最常见的借口。** 任何能访问任意地址的功能，默认都应该是拒绝。

---

## 附：排查方法论

这些坑有一个共同点——**症状和根因隔了好几层**。总结几条有用的手法：

1. **二分法隔离**：把配置逐段注释，找出让行为变化的那一段。比读文档快。
2. **打印中间值**：配置语言的求值结果经常和预期不符，直接 `respond` 出来看。
3. **区分「没数据」和「正常」**：监控、日志、指标都有这个陷阱。
4. **看服务端日志，不看客户端报错**：客户端看到的 000/timeout 经常是探针写错，服务端日志才说真话。
5. **改一个变量**：同时改两处，永远不知道是哪处生效了。

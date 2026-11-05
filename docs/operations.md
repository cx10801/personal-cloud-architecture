# 运维手册

## 1. 部署拓扑

```
本地开发机
  ├── wrangler deploy → 边缘 Worker
  └── Session Manager → 服务器 docker compose
```

**没有 CI/CD。** 这是刻意的：部署频率低（周级），流水线本身的维护成本超过收益。取而代之的是一条可重复执行、可审查的脚本。

---

## 2. 边缘侧部署

### 2.1 首次配置

```bash
cp examples/wrangler.toml.example wrangler.toml
# 填 account_id / kv namespace id / r2 bucket 名
```

`wrangler.toml` 里**不出现任何密钥**。所有密钥走 Secret：

```bash
npx wrangler secret put UPSTREAM_KEY
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CONFIG_ENC_KEY    # openssl rand -hex 32
```

Secret 是只写不可读的：写入后连自己也读不回来，只能覆盖。这是特性不是缺陷——它保证密钥不会因为「想看看到底是啥」而被打印到终端历史里。

### 2.2 日常发布

```bash
# 1. 本地验证
npx wrangler dev --local

# 2. 灰度：先发到 staging 子域
npx wrangler deploy --env staging

# 3. 冒烟测试
curl -sI https://staging.<domain>/health

# 4. 生产
npx wrangler deploy
```

### 2.3 回滚

Workers 保留历史版本，回滚是一条命令：

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

**回滚的前提是数据兼容。** 如果新版本改了 KV 的键格式，回滚后旧代码读不到新键——数据迁移必须向后兼容，或者先回滚代码再回滚数据。

---

## 3. 服务器侧部署

### 3.1 容器编排

```yaml
# compose.yml（节选，真实值见 .env）
services:
  tunnel:
    image: cloudflare/cloudflared:latest
    restart: always
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
    network_mode: bridge
    depends_on: [caddy]

  caddy:
    image: caddy:alpine
    restart: always
    ports: ["127.0.0.1:8443:8443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    env_file: [.env]

  idp:
    image: <oidc-provider>:latest
    restart: always
    volumes: ["./idp:/config"]
    # 仅监听回环，通过 caddy 暴露
    expose: ["9091"]

volumes:
  caddy_data:
```

### 3.2 部署流程

```bash
# 本地 → 服务器的差异比对（不直接覆盖）
python deploy-compose.py --diff

# 确认后应用
python deploy-compose.py --apply
```

`--diff` 会渲染出新旧 compose 的差异，并标出会导致容器重建的改动。**重建是有代价的**——短暂的服务中断，以及内存峰值的重新爬升（1 GB 机器上这个很敏感）。

### 3.3 内存预算

这是 1 GB 机器上最重要的运维指标。

| 服务 | 常驻内存 | 峰值 |
|---|---|---|
| 隧道 | 30 MB | 45 MB |
| 反代 | 25 MB | 40 MB |
| 身份提供方 | 120 MB | 180 MB |
| 状态面板 | 40 MB | 60 MB |
| 自动化 Agent | 90 MB | 150 MB |
| 通知服务 | 20 MB | 30 MB |
| 系统 + Docker | 180 MB | 200 MB |
| **合计** | **~505 MB** | **~705 MB** |

剩余约 300 MB，加上 2 GB swap 兜底。**新加服务前必须先看这个表**。

监控 swap 使用率的原因：Linux 在内存压力下会积极 swap，表现出来不是 OOM，而是响应变慢。当 swap 使用超过 70% 时，实际已经处于劣化状态。

---

## 4. 备份策略

| 对象 | 频率 | 方式 | 保留 |
|---|---|---|---|
| KV 配置（书签、短链、AI Key 索引） | 每日 | 全量导出为 JSON → 对象存储 | 30 天 |
| 网盘文件 | 不备份 | 依赖对象存储自身的持久性 | — |
| 服务器数据卷 | 每周 | tar → 对象存储 | 8 周 |
| compose 与配置 | 每次变更 | git 提交 | 永久 |

### 恢复演练

备份没验证过等于没有。每季度做一次恢复演练：

```bash
# 1. 从对象存储拉最新的 KV 导出
# 2. 导入到临时 namespace
# 3. 用临时环境变量指向它，跑一遍读操作
# 4. 比对关键条目数量
```

**真实的坑**：曾经有一次备份脚本因为路径写错，连续三周导出的是空文件（0 字节），而脚本退出码是 0。后来加了「导出后检查条目数，少于阈值就报警」。

---

## 5. 监控

### 5.1 告警项

| 指标 | 阈值 | 含义 |
|---|---|---|
| 实例状态检查 | ≥ 1 | 实例即将不可用 |
| CPU 使用率 | > 80% 持续 5 min | 可能被限流（突发积分耗尽） |
| CPU 积分余额 | < 20 | 突发性能型实例即将降频 |
| 内存使用率 | > 85% | 接近 OOM |
| swap 使用率 | > 70% | 已进入劣化状态 |
| 磁盘使用率 | > 85% | 空间不足 |

**CPU 积分**这一项特别重要：突发性能型实例（如 t 系列）靠积分维持高频，积分耗尽后会强制降频到基准频率，表现为「机器突然变得很慢」，而 CPU 使用率指标看起来并不高。

### 5.2 告警链路

```
云监控指标 → 消息队列 → 函数计算（转换格式） → 群机器人 webhook
```

函数计算里做三件事：格式化消息、加时间戳与实例标识、失败重试（3 次）。

**没做的事**：告警收敛。同一次故障可能触发多条告警（内存高 → swap 高 → 响应慢），目前会分别推送。个人场景下信息量可接受，多实例场景需要加聚合。

---

## 6. 日常检查清单

每周五分钟过一遍：

- [ ] 磁盘使用率 < 85%
- [ ] swap 使用率 < 70%
- [ ] 隧道连接状态正常（控制台看）
- [ ] 上一轮备份文件大小合理（不是 0 字节）
- [ ] 边缘侧错误率无异常尖峰
- [ ] 待过期的凭证（90/180 天轮换）无临期项

---

## 7. 变更管理

三类变更，流程不同：

| 类型 | 例子 | 流程 |
|---|---|---|
| 配置调整 | 改告警阈值、加书签 | 直接改，改完记录 |
| 代码发布 | 改 Worker 逻辑 | 本地验证 → staging → 生产 |
| 架构变更 | 拆 Worker、换数据库 | 写方案 → 对比优劣 → 分批上线 + 回滚预案 |

**架构变更必须有回滚预案。** 具体到「执行哪条命令能回到上一个状态」，而不是「应该可以回滚」。

### 分批上线的实例

把 4,652 行的单体拆成 4 个 Worker 时，没有一次性切换：

1. 先拆出网盘（代码量最大、风险最集中），保留原单体承接其余功能；
2. 观察一周，确认网盘无异常；
3. 再拆每日聚合；
4. 最后拆门户与 AI，切换入口。

每一步都可独立回滚——旧 Worker 保留路由，改一行 DNS 即可切回。全部稳定后才删除旧代码。

# service-center-cli 设计文档

## 1. 概述

一个单一二进制的 Node.js CLI 工具，扮演 API 网关 + 服务发现的角色。包含两个子命令：

- `registry`：启动注册中心。它是一个 HTTP 反向代理网关，同时通过保留路径前缀（默认 `/__registry`）暴露管理 API。
- `server`：启动服务端进程。它向 registry 注册自身路由（可拉起一个下游子进程，例如 `vite`），通过周期性心跳维持注册状态；进程退出时主动 deregister。

最终用户的请求打到 registry，registry 按请求路径的最长前缀匹配路由表，把请求代理到对应 server 的 target。

## 2. 目标与非目标

### 目标

- 单一二进制、两个子命令、零外部存储依赖。
- 路径前缀路由，最长前缀匹配；同一 service 可注册多个前缀。
- HTTP 流量反向代理（WebSocket Upgrade 透传）。
- HTTP 心跳维持在线状态，超时剔除。
- server 子命令可拉起一个下游子进程，并自动分配端口注入。
- 纯内存路由表，registry 重启即清空。
- 极简依赖（commander / http-proxy-middleware / pino）。

### 非目标（v1 显式不做）

- 鉴权（注册/管理 API 完全开放）。
- 路由表持久化与重启恢复。
- 多实例负载均衡（同一 prefix 仅允许一个 service 占用）。
- HTTPS / TLS 终止。
- 限流、熔断、重试、Prometheus 指标暴露。
- 配置文件（所有配置走命令行参数）。
- 多 registry 集群与状态同步。

## 3. 架构

### 3.1 进程模型

```
service-center-cli registry   # 启动注册中心
service-center-cli server     # 启动服务端（可拉起下游子进程）
```

两个角色完全独立、可分别部署。它们之间仅通过 HTTP 通信，没有任何共享内存状态。

### 3.2 单端口与保留前缀

registry 只监听一个 TCP 端口（默认 8080），所有请求由同一个 `node:http` 服务器接收。请求路径若以 `--admin-prefix`（默认 `/__registry`）开头则进入 **Admin Handler**，否则进入 **Proxy Handler**。

服务端注册的 prefix 若与 admin-prefix 冲突（相等或以其为前缀）将被拒绝。

### 3.3 组件视图

```
┌─────────────────────────────── registry 进程 ───────────────────────────────┐
│                                                                              │
│   node:http server (单端口, --port)                                          │
│        │                                                                     │
│        ├─ url 以 /__registry 开头 ─→ AdminHandler                           │
│        │                                  │                                  │
│        │                                  └─→ RouteStore (内存路由表)        │
│        │                                                                     │
│        └─ 其它 url ─→ ProxyHandler                                          │
│                            │                                                 │
│                            ├─ Matcher (最长前缀匹配)                         │
│                            └─ http-proxy-middleware 实例池（按 target 缓存）  │
│                                                                              │
│   后台扫描器（每 --interval 跑一次）→ 剔除超过 --ttl 的 Route               │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────── server 进程 ─────────────────────────────────┐
│                                                                              │
│   1. PortAllocator：从 OS 拿一个可用端口（或使用 --target 中的端口）          │
│   2. ChildRunner：spawn 子进程，{port} 替换 + PORT env + ready 探测           │
│   3. RegistrationClient：POST /register → 周期 /heartbeat → 退出时 /deregister │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 4. CLI 接口

### 4.1 `registry`

```
service-center-cli registry [options]

  --port <n>          代理端口                              默认 8080
  --host <str>        代理监听地址                          默认 0.0.0.0
  --admin-prefix <p>  管理 API 保留前缀                     默认 /__registry
  --ttl <ms>          心跳超时（超过即剔除）                默认 30000
  --interval <ms>     过期扫描间隔                          默认 10000
  --log-level <str>   trace/debug/info/warn/error           默认 info
```

### 4.2 `server`

```
service-center-cli server [options] [-- <cmd> [args...]]

  --registry <url>    必填。registry 的 URL，如 http://127.0.0.1:8080
  --service <name>    必填。服务名，如 user-service
  --prefix <path>     必填。可重复。每个前缀独立校验与心跳
  --target <url>      可选。如 http://10.0.0.5:3000
                      省略时：PortAllocator 自己分配端口，
                      target = http://<本机 hostname>:<port>
  --bind-host <str>   target 的 hostname 来源                默认 os.hostname()
  --heartbeat <ms>    心跳间隔                                默认 10000
  --ready-timeout <ms> 等待子进程绑端口的超时                默认 10000
  --log-level <str>   同 registry                             默认 info
  -- <cmd> [args...]  可选。要拉起的下游服务命令，支持 {port} 占位符
```

子进程环境变量：除了 `{port}` 字面替换外，server 还会向子进程注入 `PORT=<分配端口>` 环境变量。

## 5. Admin API 契约

所有路径挂在 `--admin-prefix`（默认 `/__registry`）下。请求/响应体均为 JSON。

### 5.1 `POST /__registry/register`

注册或刷新路由。**幂等**：同一 `service` 重复调用会覆盖其 `target` 与 `prefixes`；旧 prefix 若不在新列表中则被释放。

**请求体**

```ts
{
  service: string;        // 服务名
  target: string;         // 形如 http://10.0.0.5:3000
  prefixes: string[];     // 必须每个以 "/" 开头
}
```

**响应**

- `200 OK` → `{ ok: true }`
- `400 Bad Request` → `{ error: string, detail?: string }`
  - JSON 非法 / 字段缺失
  - prefix 不以 `/` 开头
  - prefix 与 `--admin-prefix` 冲突
- `409 Conflict` → `{ error: "prefix conflict", detail: { prefix: string, owner: string } }`
  - 某个 prefix 已被别的 service 占用

### 5.2 `POST /__registry/heartbeat`

刷新 TTL。请求体：

```ts
{ service: string; target: string; }
```

**响应**

- `200 OK` → `{ ok: true }`
- `404 Not Found` → `{ error: "unknown service" }`（service 未注册过或已过期）

### 5.3 `POST /__registry/deregister`

主动下线。请求体：

```ts
{ service: string; }
```

**响应**

- `200 OK` → `{ ok: true }`
- `404 Not Found` → `{ error: "unknown service" }`（视作幂等成功也可，但显式 404 便于排查）

### 5.4 `GET /__registry/routes`

调试用，返回当前路由表：

```ts
200 OK → [
  { service: string, target: string, prefixes: string[], lastSeen: number }[]
]
```

## 6. 路由模型

### 6.1 数据结构

```ts
type Route = {
  service: string;
  target: string;
  prefixes: string[];
  lastSeen: number;        // ms 时间戳，register/heartbeat 时刷新
};

// RouteStore 内部维护三张互相一致的索引
routesByService: Map<string, Route>;
targetByPrefix: Map<string, string>;       // prefix -> target
serviceByPrefix: Map<string, string>;      // prefix -> service（冲突检测 & 反查）
```

### 6.2 匹配规则

- **路径前缀匹配 + 路径段边界**：prefix `/api/users` 匹配 `/api/users`、`/api/users/123`、`/api/users/foo/bar`，**不**匹配 `/api/users-foo`。
- **最长前缀胜出**：`/api` 与 `/api/users` 可共存；请求 `/api/users/123` 命中 `/api/users`。
- 命中后从 `targetByPrefix` 拿 target。
- 未命中 → ProxyHandler 直接返回 404，不进代理。

### 6.3 冲突规则

- 同一 `service` 重复 register：覆盖。该 service 原有但不在新列表中的 prefix 被释放。
- 不同 `service` 申请相同 prefix：拒绝，返回 409，detail 写明占用者。
- prefix 与 `--admin-prefix` 冲突：拒绝，返回 400。

### 6.4 TTL 与剔除

registry 后台扫描器每 `--interval` 跑一次：对每条 `Route`，若 `now - lastSeen > ttl`，则连同其所有 prefix 一并删除，输出 warn 日志。

## 7. 生命周期

### 7.1 server 启动流程（B 方案：先 ready 再 register）

```
1. 解析 --target：
   ├─ 有 → port = URL 中端口
   └─ 无 → PortAllocator.listen(0) 拿端口；EADDRINUSE 时重试一次

2. 计算最终 target：
   - 有 --target：用传入值
   - 无：target = `http://${bindHost}:${port}`

3. 若提供 -- <cmd>：
   a. 命令行参数中所有 {port} token 替换为 port
   b. 注入子进程 env: PORT = port
   c. spawn 子进程
   d. ready 探测：在 --ready-timeout 内，每 100ms 尝试 net.connect(port)；
      连上即视为 ready；超时 → 退出码 1

4. POST /__registry/register { service, target, prefixes }
   - 网络错误或 5xx：指数退避重试 3 次（1s/2s/4s）；仍失败 → 若有子进程则 SIGTERM，
     退出码 1
   - 4xx（含 409 冲突）：立即放弃，不重试；若有子进程则 SIGTERM，退出码 1

5. 心跳循环：每 --heartbeat ms → POST /__registry/heartbeat
   - 心跳失败：本周期 warn，不退出
   - 子进程已退出：停止心跳，退出码 = 子进程退出码

6. SIGINT/SIGTERM：
   a. POST /__registry/deregister（best effort，失败仅 warn）
   b. 若有子进程：SIGTERM，等 5s，仍存活则 SIGKILL
   c. 退出码 0
```

### 7.2 registry 启动流程

```
1. 创建 RouteStore（注入 --ttl, --interval）
2. 启动 node:http server（单端口）：
   - on request → 按 url 分发到 AdminHandler 或 ProxyHandler
   - on upgrade → 同样按 url 分发，调用对应 http-proxy-middleware 实例的 upgrade 方法
3. 启动后台扫描器
4. SIGINT/SIGTERM：
   a. server.close()（停止 accept）
   b. 等待 in-flight 请求最多 5s
   c. 关闭扫描器
   d. 退出码 0
```

### 7.3 代理数据流

```
client → registry:8080
  │
  ├─ url 起始于 admin-prefix → AdminHandler
  │
  └─ 其它：
       1. Matcher.longestMatch(prefixes, url) → prefix | null
       2. null → 404 JSON { error: "no route" }
       3. prefix → targetByPrefix.get(prefix) → target
       4. ProxyHandler.getProxy(target)：
            - 命中缓存 → 复用
            - 未命中 → createProxyMiddleware({
                target, changeOrigin: true,
                on: { error: ... }     // 上游错误 → 502
              })
       5. proxy(req, res, next)：
            - next 被调用 → 502（理论不会发生，兜底）
            - on.error → 502 JSON { error: "bad gateway", detail: err.message }
```

WebSocket Upgrade 事件复用同样的 Matcher 查找 + 调用 `proxy.upgrade(req, socket, head)`。

### 7.4 pathRewrite

v1 **不改写**路径。client 访问 `/api/users/123`，server 收到的也是 `/api/users/123`。下游服务需自行处理完整路径。

## 8. 项目布局

```
service-center-cli/
├── package.json
├── tsconfig.json
├── bin/
│   └── cli.js                      # shebang 入口，import ../dist/cli.js
├── src/
│   ├── cli.ts                      # argv 解析 + 子命令分发（commander）
│   ├── commands/
│   │   ├── registry.ts             # `registry` 子命令：装好 proxy + admin handler
│   │   └── server.ts               # `server` 子命令：端口 → 子进程 → 注册 → 心跳
│   ├── registry/
│   │   ├── store.ts                # RouteStore：内存表 + 操作 + TTL 扫描
│   │   ├── matcher.ts              # 最长前缀匹配（纯函数）
│   │   ├── admin-handler.ts        # /__registry/* HTTP handler
│   │   └── proxy-handler.ts        # 客户端流量 handler，按 target 缓存 middleware
│   ├── server/
│   │   ├── port-allocator.ts       # listen(0) → 关闭 → 返回端口
│   │   ├── child-runner.ts         # spawn + {port} 替换 + PORT env + ready 探测
│   │   └── registration-client.ts  # fetch 包装：register/heartbeat/deregister
│   └── shared/
│       ├── types.ts                # RegisterRequest / Route / ErrorResponse
│       ├── argv.ts                 # 通用参数助手
│       ├── http.ts                 # readJsonBody / sendJson
│       └── logging.ts              # pino 实例工厂
└── tests/
    ├── store.test.ts               # 注册 / 心跳刷新 / TTL 剔除 / 冲突检测
    ├── matcher.test.ts             # 最长前缀 / 路径段边界
    ├── port-allocator.test.ts      # 能拿到端口、不重复
    ├── child-runner.test.ts        # {port} 替换、PORT env 注入、ready 超时
    ├── admin-api.test.ts           # 4 个端点 + 错误码
    └── proxy.e2e.test.ts           # 真·registry + 假后端 → 透传验证
```

每个文件单一职责：

- `store.ts` / `matcher.ts`：纯逻辑，零 HTTP 依赖，单测无 mock。
- `admin-handler.ts` / `proxy-handler.ts`：HTTP 适配薄层，依赖 store/matcher。
- `port-allocator.ts` / `child-runner.ts`：系统副作用单元，通过依赖注入（spawn 函数可替换）实现单测。
- `registration-client.ts`：fetch 包装，单测通过注入自定义 fetch 即可。

## 9. 依赖清单

### runtime

- `commander` —— CLI 参数解析
- `http-proxy-middleware`（已安装，v4.2.0，ESM） —— 反向代理
- `pino` —— 结构化日志

### dev

- `typescript`（已安装）
- `tsx` —— 运行 TypeScript 测试与开发期执行
- `@types/node`

### 测试基础设施

测试套件使用 **Node.js 原生 test runner**（`node:test` + `node:assert`），通过 `tsx` 执行 TypeScript。`package.json` scripts：

```json
{
  "scripts": {
    "build": "tsc",
    "test": "tsx --test"
  }
}
```

`tsx --test` 会自动发现 `**/*.test.ts` 文件。

## 10. 错误处理矩阵

### 10.1 Admin API

| 场景                                       | 状态码 | body                                              |
| ------------------------------------------ | ------ | ------------------------------------------------- |
| JSON 非法 / 字段缺失 / prefix 不以 `/` 开头 | 400    | `{ error, detail? }`                              |
| prefix 与 admin-prefix 冲突                | 400    | `{ error: "admin prefix conflict" }`              |
| heartbeat/deregister 的 service 不存在     | 404    | `{ error: "unknown service" }`                    |
| prefix 已被别的 service 占用               | 409    | `{ error: "prefix conflict", detail: { prefix, owner } }` |
| 其它未捕获异常                             | 500    | `{ error: "internal" }`，日志记 stack             |

### 10.2 Proxy 流量

| 场景                  | 状态码 / 行为        | body                                  |
| --------------------- | -------------------- | ------------------------------------- |
| 无 prefix 命中        | 404                  | `{ error: "no route" }`               |
| 上游连接失败          | 502                  | `{ error: "bad gateway", detail }`    |
| 上游超时              | 504                  | `{ error: "gateway timeout" }`        |
| WebSocket Upgrade 失败 | 直接 close socket    | —                                     |

### 10.3 server 进程

| 场景                                       | 行为                                              |
| ------------------------------------------ | ------------------------------------------------- |
| PortAllocator 连续 2 次 EADDRINUSE         | 退出码 1                                          |
| ChildRunner spawn 立即 ENOENT              | 退出码 1，日志 "command not found"                |
| 子进程在 ready-timeout 内退出              | 退出码 = 子进程退出码                             |
| 子进程 ready 超时                          | 退出码 1                                          |
| register 调用失败（registry 不可达或 5xx） | 指数退避重试 3 次（1s/2s/4s），仍失败 → SIGTERM 子进程，退出码 1 |
| register 收到 4xx（如 409 冲突）           | 立即放弃，退出码 1，日志写明 detail               |
| heartbeat 失败                             | 本周期 warn，不退出，下周期继续                   |
| 子进程运行中退出                           | 停止心跳，退出码 = 子进程退出码                   |
| SIGINT/SIGTERM                             | deregister（best effort）→ SIGTERM 子进程 → 5s 后 SIGKILL → 退出码 0 |

## 11. 测试策略

### 11.1 单元测试

- `store.test.ts`：
  - register 插入索引一致
  - 同 service register 覆盖，释放旧 prefix
  - 不同 service 冲突 prefix 抛错
  - heartbeat 刷新 lastSeen
  - deregister 清理三张表
  - sweep：超过 ttl 的整条删除
- `matcher.test.ts`：
  - 精确等值命中
  - 路径段边界（`/api` 不匹配 `/api-users`）
  - 最长前缀胜出
  - 多层嵌套
  - 空表返回 null
- `port-allocator.test.ts`：
  - 返回的端口能被另一个 server 立即 listen
  - 两次调用通常不返回相同端口
- `child-runner.test.ts`（通过依赖注入 mock spawn）：
  - `{port}` 字面替换
  - `PORT` env 注入
  - ready 探测成功路径
  - ready 超时路径

### 11.2 集成测试

- `admin-api.test.ts`：启动真的 registry http server，对 4 个端点逐一验证 200 / 400 / 404 / 409。
- `proxy.e2e.test.ts`：
  1. 起 registry
  2. 起一个假后端 `http.createServer`，绑到 PortAllocator 拿的端口
  3. POST /register 把 `/api/users` 指向假后端
  4. client 打 `/api/users/123` → 断言响应来自假后端
  5. 测 WebSocket Upgrade（小用例即可）
  6. 等 ttl 过期后再打 → 404

### 11.3 手动冒烟

`scripts/demo.sh`：起 registry → server 拉 vite → curl 验证。不进自动化，留作开发者快速验证。

## 12. 设计取舍备注

- **端口分配在 server 端而非 registry 端**：避免 TOCTOU 竞态、避免跨机失效、省一次往返。
- **单端口 + 保留前缀**：客户端流量与管理 API 共用一个端口，简化部署；代价是必须拒绝服务端注册与 admin-prefix 冲突的 prefix。
- **http-proxy-middleware 按 target 缓存实例**：避免每个请求都新建代理实例；target → middleware 的映射在 service deregister 时可不主动清理（缓存小，命中即用）。
- **B 方案（先 ready 再 register）**：避免 registry 短暂地把流量打到未绑端口的 target。

# dsh-restart-button

为 DeepSeek Harness (dsh) 添加一个一键重启按钮，在设置面板的“常规设置”中快速重启整个服务。

## ✨ 功能特性

- 🔄 **一键重启**:在“常规设置”面板点击按钮即可重启整个 DSH 服务
- 🔒 **安全设计**:
  - 仅限同源请求(防止 CSRF)
  - 可用 `allowedOrigins` 显式放行反向代理入口(如 Caddy `28010 → 28000`)
  - 未列入白名单的请求仍拒绝代理转发头
  - 避免重复重启(409 Conflict)
- 🚀 **平滑重启**:
  - 主进程优雅退出,释放端口
  - detach 的辅助进程执行本机生命周期重启(`/var/apps/dsh/cmd/main restart`)
  - 自动检测新进程并刷新页面
- 📊 **状态监控**:显示当前 PID 和上次启动时间

## 📥 安装

从 GitHub 安装(本机 fnOS 部署的标准方式):

```bash
dsh plugin --profile web add github:xiehuc/dsh-restart-button
```

若尚未导出 `node`/`pnpm` 到 `$PATH`,请用仓库内提供的 `.local/bin/dsh` 封装(它自带 node 的 PATH),并确保 web profile 的
`pnpm-workspace.yaml` 的 `allowBuilds` 含本插件名(见下方备注)。

> 备注:从 git 安装时,pnpm 会准备该包并尝试执行其 `prepare`/`publish` 生命周期脚本。本插件的**版本化源码已内置编译好的 `lib/`,
> 无需构建**,因此 `package.json` 不声明任何会触发的 `prepare`/`publish` 脚本,git 安装可干净通过。

## 🚀 使用方法

1. 在 DSH Web UI 中进入 **设置** → **常规设置**
2. 找到 **“重启 DeepSeek Harness 服务”** 按钮
3. 点击按钮即可重启服务
4. 服务重启后会短暂断开,随后自动重连

## ⚙️ 技术细节

### 主机端(Host)

- `lib/index.js`:暴露 `apply(ctx, config)`,注册两个 HTTP 路由:
  - `POST /dsh-restart` —— 触发重启(同源 CSRF 校验 + `allowedOrigins` 白名单)
  - `GET /dsh-restart/status` —— 返回 `{ pid, startedAt }`
- 配置通过 `export const Config`(Standard Schema)声明,由 cordis 在插件启动前校验后传入 `apply`。
- 重启交给 detach、unref 的辅助进程,它等待端口释放后执行 **`/var/apps/dsh/cmd/main restart`**(本机 fnOS 生命周期重启),随后验证端口重新被监听。

### 客户端(Client)

- `lib/client.js`:在 `settings.general.item` 槽位注册 `restart-button` 行。
- 按钮使用宿主内置组件 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button`(`variant="outline"`),不手写样式。
- 交互流程:读当前 PID → `POST /dsh-restart` → 轮询 `/dsh-restart/status` 直到 PID 变化 → `location.reload()`。

### 部署自定义

若重启命令不同,修改 `lib/index.js` 顶部:

```javascript
const RESTART_CMD = '/var/apps/dsh/cmd/main' // 你的重启命令(绝对路径)
const RESTART_ARGS = ['restart']             // 参数
const DEFAULT_PORT = 28000                   // 兜底端口
```

### 反向代理(allow origin)

`POST /dsh-restart` 默认只接受同源请求(`Origin` 的主机 === `Host`),并且会拒绝带
`X-Forwarded-For` / `Forwarded` / `X-Real-IP` 的请求 —— 也就是说**在反向代理后面默认点不动**。
Caddy 的 `reverse_proxy` 默认就会给上游追加这几个头,于是表现为:

```
POST http://192.168.1.7:28010/dsh-restart → 403
restart is limited to same-origin requests
```

把前端入口写进 `allowedOrigins` 即可放行(匹配 scheme + host,裸写 `host:port` 按 http 处理):

```yaml
# cordis.patch.yml
- insert:
    - id: restart-button
      name: dsh-restart-button
      config:
        allowedOrigins:
          - http://192.168.1.7:28010
```

未配置时回退到 `lib/index.js` 的 `DEFAULT_ALLOWED_ORIGINS`(本机默认已含
`http://192.168.1.7:28010`)。只有列出的 origin 会绕过转发头规则,跨站页面伪造的
`Origin` 依然会被拒。

> 走代理时 `Host` 是前端端口(如 Caddy 的 28010),而 28010 是代理自己监听的、永远不会关闭,
> 所以检测“本地端口是否已释放”时这类请求会回退到 `DEFAULT_PORT`,而不是去探代理端口。

## 🛠 本地开发

- `git clone git@github.com:xiehuc/dsh-restart-button.git`
- 改 `lib/`(host)与 `client.js`(client)后直接 commit。
- 若要重新装进 profile:先改 `lib/index.js` 的 `RESTART_CMD/ARGS` 与 profile 的 `pnpm-workspace.yaml`,再
  `dsh plugin --profile web remove dsh-restart-button && dsh plugin --profile web add github:xiehuc/dsh-restart-button`。

## 🔖 相关

- 按钮样式与宿主交互的心得、坑(作用域 bug、自包含配色等)见工作区 `MEMORY.md`。

## 📄 许可证

MIT License

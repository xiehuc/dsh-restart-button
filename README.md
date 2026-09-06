# dsh-restart-button

为 DeepSeek Harness (dsh) 添加一个一键重启按钮，在设置面板中快速重启整个服务。

## ✨ 功能特性

- 🔄 **一键重启**：在设置面板点击按钮即可重启整个 DSH 服务
- 🔒 **安全设计**：
  - 仅限同源请求（防止 CSRF）
  - 禁止代理转发头
  - 避免重复重启（409 Conflict）
- 🚀 **平滑重启**：
  - 主进程优雅退出，释放端口
  - 分离的辅助进程启动新实例
  - 自动检测新进程并刷新页面
- 📊 **状态监控**：显示当前 PID 和上次启动时间

## 📥 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:YOUR_USERNAME/restart-button-pkg
```

### 从 npm 发布版安装

```bash
dsh plugin --profile web add dsh-restart-button@0.1.0
```

## 🚀 使用方法

1. 在 DSH Web UI 中进入 **设置** → **常规设置**
2. 找到 **"重启 DeepSeek Harness 服务"** 按钮
3. 点击按钮即可重启服务
4. 服务重启后会短暂断开，随后自动重连

## ⚙️ 技术细节

### 主机端（Host）

- **端点**：`POST /dsh-restart` - 触发重启
- **状态**：`GET /dsh-restart/status` - 获取当前进程信息
- **安全策略**：
  - 仅接受同源请求（`Origin === Host`）
  - 拒绝所有代理转发头
  - 防止重复重启

### 客户端（Client）

- **位置**：设置面板 → 常规设置 → "重启 DeepSeek Harness 服务"
- **样式**：使用内置 UI 组件，无自定义 CSS

## 🛠️ 部署自定义

如果你需要自定义重启命令，修改 `lib/index.js` 中的：

```javascript
const RESTART_CMD = '/var/apps/dsh/cmd/main'  // 你的重启命令
const RESTART_ARGS = ['restart']               // 你的重启参数
```

## 📄 许可证

MIT License

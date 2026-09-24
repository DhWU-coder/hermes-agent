# Hermes 网页图形聊天页设计

## 目标

在 Dashboard 增加 `/chat-ui`，参考 `codex-gateway` 的三栏视觉关系：左侧会话列表、中间消息流、底部固定输入区。现有 `/chat` TUI 保持可用。新页面允许一个浏览器连接管理多个 Hermes 会话，切换前台会话不关闭后台正在运行的任务。

## 数据与连接

- 复用 Dashboard 的登录态和 `api.buildWsUrl('/api/ws')`，通过 `@hermes/shared` 的 `JsonRpcGatewayClient` 连接现有 `tui_gateway`。
- 使用 `session.create`、`session.activate`、`session.resume`、`prompt.submit`、`session.interrupt`；会话列表及历史记录沿用 Dashboard 已有 REST 接口。
- 运行时状态按 profile 和会话 ID 隔离。WebSocket 事件以 `session_id` 路由至相应会话；切换选中项仅改变视图，不关闭或中断其他会话。
- 连接恢复后重新取得所选会话快照并刷新列表；共享客户端的事件重放处理掉线期间的流式事件。
- 使用当前文件上传接口保存附件，再把文件引用随消息提交；继续使用 Hermes 原有模型、授权和会话数据。

## 页面结构

- 左栏：新对话、会话标题、运行状态和刷新入口。
- 主区：标题、用户与助手消息、流式回复、工具活动和错误；底部输入框、附件、模型信息、发送/停止。
- 页面在窄屏收起会话栏。用户切换 profile 时清理前一 profile 的前端状态，再按新 profile 加载会话。
- 遇到需要用户回答的服务端请求时，在页面显示相应提示，避免后台任务静默卡住。

## 验收

两个会话同时运行时，切到另一个会话并发消息不影响前者；切回后能看到各自的最新内容。刷新或短暂断线后状态可恢复。附件上传、停止、授权提示、历史恢复均可使用。原 `/chat` 终端行为不变。

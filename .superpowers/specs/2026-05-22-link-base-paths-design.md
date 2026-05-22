# Link Base Paths Design

## 目标

- 给 agent 输出里的文件链接增加一组可管理的 session base paths。
- 这组 base paths 只影响链接解析，不影响 `@` 路径搜索、附件、模型或 reasoning-effort。
- 让裸相对路径在当前 `cwd` 之外也能按用户配置的上下文目录跳转。

## 现状

- `ThreadComposer.vue` 已经有路径模糊搜索能力，底层是 `searchComposerFiles(...)`。
- `ThreadConversation.vue` 和 `markdownRenderer.ts` 都有自己的文件链接解析逻辑。
- `useDesktopState.ts` 已经按 thread context 持久化了 model、reasoning-effort、collaboration mode 等状态。

## UI

- 在输入框下方增加一个 `Base paths` 管理区。
- 以 chip 形式展示当前 base paths，每项都支持删除。
- “添加”入口打开搜索面板，复用现有路径模糊搜索体验，但结果只保留目录。
- 选中的目录在保存前统一转成绝对路径并去掉尾部 `/`。
- 列表顺序就是解析优先级顺序。
- 新增路径追加到列表末尾；第一版不做拖拽排序。

## 状态与持久化

- 新增 localStorage key，例如 `codex-web-local.link-base-paths-by-context.v1`。
- 数据结构和 model / reasoning-effort 一样，按 thread context 存储。
- 推荐形状：`Record<string, string[]>`，value 为已归一化的绝对目录路径。
- 加载时丢弃空值、重复值和非绝对路径。
- 线程被清理时同步 prune 对应条目，保持和现有 session 状态一致。

## 链接解析

- 抽出一个共享的文件链接解析 helper，供 `markdownRenderer.ts` 和 `ThreadConversation.vue` 共用。
- 解析规则分三类：
  - 显式绝对路径，保持现有行为
  - 显式相对路径 `./`、`../`、`~/`，保持现有语义
  - 裸相对路径，先尝试用户配置的 base paths，再回退到当前 `cwd`
- 裸相对路径的 base-path 解析采用同步字符串拼接和规范化，不在渲染路径里做额外文件系统探测。
- 这意味着 base paths 的顺序就是用户声明的优先级。
- 第一版不引入新的后端解析 API，避免消息渲染变成异步或产生额外请求。
- 输出链接仍保留原始可读文本，只改变最终 href 指向的绝对路径。

## 组件边界

- `App.vue` 负责把当前 thread context 的 base-path 列表传给 composer 和 conversation。
- `ThreadComposer.vue` 负责增删 base paths 和搜索选择。
- `ThreadConversation.vue` 负责在消息链接里使用 base-path 解析结果。
- `markdownRenderer.ts` 负责 preview / markdown 场景下的同一套解析。

## 错误与回退

- base-path 列表为空时，行为与现在一致。
- 某个 base path 无效时，加载时直接忽略，不阻断页面。
- 如果解析后仍然无法打开，沿用现有 browse/edit 路由回退。
- 只要用户没有添加 base paths，链接解析不会有额外变化。

## 测试

- 持久化读写：新增、删除、刷新后恢复。
- 目录选择：搜索结果只显示目录，选中后保存为绝对路径。
- 解析顺序：裸相对路径优先命中 base paths，再回退 cwd。
- 语义保持：`./`、`../`、`~/` 继续走原有规则。
- 回归：inline code 链接、目录路径链接、`/Codex` 误链都不回退。
- UI 验证：新增/删除 base path 后，浅色和深色主题都要检查外观和可用性。

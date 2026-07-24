---
kind: frontend_style
name: Nexus TUI 终端界面样式系统
category: frontend_style
scope:
    - '**'
source_files:
    - src/tui/theme.ts
    - src/tui/App.tsx
    - src/tui/components/MessageList.tsx
    - src/tui/components/InputBox.tsx
---

Nexus 项目使用基于 Ink（React + Node.js 终端 UI 框架）构建的命令行界面，采用 React 组件化架构和集中式主题管理。

**技术栈与框架**
- 核心框架：Ink v5.2.0（基于 React 18.3.1），用于在终端中渲染交互式 UI
- 样式方案：无 CSS/SCSS，完全通过 Ink 的 `Box`、`Text` 等原生组件属性进行布局与样式控制
- 主题系统：集中式 `theme.ts` 定义颜色、符号、标签等设计令牌

**主题系统设计**
`src/tui/theme.ts` 定义了完整的视觉规范：
- 颜色体系：primary(cyan)、secondary(green)、accent(magenta)、warning(yellow)、error(red)、muted(gray) 等语义化颜色
- 符号系统：用户(◆)、助手(◐)、工具(┌─)、审批(⚠️)、成功(✓)、错误(✗) 等 Unicode 字符
- 动画支持：spinner 数组提供 9 帧加载动画
- 工具标签：read_file(📄)、edit_file(✏️)、bash(⚡)、grep(🔍) 等图标映射

**组件架构模式**
所有 UI 组件遵循统一结构：
- 通过 props 接收数据和回调函数
- 使用 `theme.colors.*` 和 `theme.symbols.*` 访问设计令牌
- 采用 Box 嵌套实现 Flexbox 布局（flexDirection、gap、padding、margin）
- Text 组件配合 color、bold、dimColor 属性控制文本样式

**布局约定**
- 垂直布局为主：`flexDirection="column"` 贯穿整个应用
- 间距统一：使用 gap={1}、padding={1}、marginTop={1} 等标准化间距
- 响应式：依赖终端宽度自动换行，无媒体查询
- 状态栏：底部固定显示状态信息和输入框

**开发约束**
- 禁止直接使用 ANSI 转义序列，必须通过 theme 定义的颜色名称
- 组件必须从 `../theme` 导入主题，保持视觉一致性
- 使用 TypeScript 接口明确组件 props 类型
- 事件处理通过回调函数而非全局状态
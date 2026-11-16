# CHANGELOG

本项目的所有重要变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化（工具 schema 新增=minor，删除/重命名=major，修复=patch）。

## [Unreleased]

## [1.0.1] - 待发布

### Added
- variable_manage 新增 ADD_MODE action（多 mode 变量集合）
- create_shape / create_frame 支持创建时设 cornerRadius
- create_text 支持 width（自动换行）/ textAlignHorizontal / lineHeight / letterSpacing
- node_set_fill 支持 gradient 渐变填充（LINEAR/RADIAL/ANGULAR/DIAMOND）
- batch_execute @opN.id 前序引用 + verbose:false 摘要模式
- 错误中文化词典（8 类常见错误）
- node_info 属性过滤（filter.property + equals/contains）
- broker 工具表主动推送（认证即推 + 桥就绪补推，修复瘦客户端空表竞态）
- 更新可用提示（broker 启动异步探测 GitHub latest）

### Changed
- 按职责五层架构重组，figma-edit-mcp server 端源码并入 src/bridge、src/tools、src/protocol（上游基线 v2.3.3，MIT），7 个运行时补丁源码化，ensureFigmaEditPatched 机制拆除
- 子进程改 --fe-child 路由：broker.mjs 单文件内含三套代码，分发物只剩 index.mjs + broker.mjs
- serverVersion 改 env（FIGMA_MCP_CHANNEL_VERSION）注入，发版 bump 零改动
- 版本单一来源：package.json 一处改，bundle/plugin 三产物注入

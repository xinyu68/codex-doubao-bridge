---
name: doubao-setup
description: "设置或更新 Codex 豆包网页桥接插件，准备稳定的本机运行目录并引导加载 Chrome 扩展、检查连接。适用于首次安装、升级和安装诊断；不发送豆包消息或提交视频生成。"
---

# 豆包桥接插件设置

本 Skill 属于 codex-doubao-bridge 插件。根据本文件的真实绝对路径取两级父目录作为 pluginRoot，不使用工作区或示例目录代替。插件提供 MCP 与视频 Skill；Chrome 扩展需要用户在浏览器中手动加载。

1. 检查 `node --version`，要求 Node.js 20 或更新版本；找不到时先报告依赖问题。插件 MCP 使用 PATH 中的 node，安装 Node 后重新打开 Codex。视频下载验证和尾帧提取需要 ffmpeg / ffprobe，文字问答不需要
2. 执行 `node <pluginRoot>/scripts/plugin-runtime.mjs setup`。这只准备文件和密钥，不启动服务。默认运行目录在 Windows 的 `%LOCALAPPDATA%/codex-doubao-bridge/runtime`；已有插件绑定优先复用，首次设置检测到旧版 standalone Skill 时复用其 bridgeRoot，保持扩展路径、密钥与媒体。首次设置需要自定义运行目录时加 `--bridge-root <绝对路径>`，绑定仍保存在稳定的本机目录
3. 检查返回的 extensionDirectory、reusedExisting 和 updatedFiles。复用旧安装时不移动素材。后端更新时，setup 只会自动结束已核验且没有客户端或操作的托管连接；有活跃客户端时先关闭旧版 Codex 对话，等待连接退出再执行 setup。旧版手工服务需核对该安装的 `.runtime/server.json` 与进程命令行后，只停止该服务；不要批量关闭 Node、浏览器或其他服务
4. 请用户在 Chrome 的 chrome://extensions 开启开发者模式，加载返回的 extensionDirectory；已有同目录扩展时点击重新加载，不再加载第二份。打开 https://www.doubao.com/ 并登录。不能声称插件安装会自动加载 Chrome 扩展或登录账号
5. 当用户要求完成连接验证时，从当前工具列表选择插件提供的 doubao_status。MCP 会自动启动或复用共享连接，不运行 start 脚本，也不要求用户单独启动服务。最多等待40秒供扩展心跳重连，再调用 status；需要详细版本信息时调用 doubao_diagnostics。未完成浏览器步骤时明确报告待办；不要为了测试向豆包发消息或消耗生成次数
6. 插件工具可能有命名空间，不另行 codex mcp add 注册同一 MCP。若工具尚未刷新，重新打开 Codex 对话。若用户已装旧版 MCP / Skill，先验证插件可用，再说明可以移除重复项；未经用户要求不删除旧安装目录或素材

密钥由脚本内部生成并保存在稳定运行目录的 extension/config.js，不读取、打印或复制进插件缓存。不创建计划任务、开机自启、登录 Cookie 导出或视频 API Key。更新时重新运行 setup，复用原密钥和媒体。MCP 在配置就绪后自动管理连接；最后一个客户端退出且本机操作完成30秒后连接退出，豆包云端生成与已保存任务不受影响。账号使用已有免费或付费权益，不默认添加免费额度限制。

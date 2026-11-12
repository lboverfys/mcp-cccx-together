# CC Team MCP

[![Test](https://github.com/lboverfys/mcp-cccx-together/actions/workflows/ci.yml/badge.svg)](https://github.com/lboverfys/mcp-cccx-together/actions/workflows/ci.yml)

让 **Codex 负责任务拆分、协调和验收，Claude Code 负责执行** 的本地多智能体协作 MCP 服务。

Codex 可以一次提交有依赖的任务，服务自动安排并行执行、等待主控验收、传递上游交付，再推进后续工作。主控随时接收进度和问题、追加指令、检查完整结果，并在关闭进程后恢复原会话。工作者复用已有的 Claude Code 模型与登录配置。支持 Windows、macOS 和 Linux，使用标准 MCP stdio 接入。

## 安装

### 前置条件

- **Node.js 22 或更新版本**，包含 npm。
- **Git**，用于从 GitHub 安装；下载 ZIP 使用源码方式时可省略。
- **Claude Code** 已安装，能在终端独立运行并完成一次正常对话。
- **Codex** 已安装；使用其他支持本地 stdio 的 MCP 客户端时，可以手动配置。

Claude Code 的安装和平台要求见[官方安装文档](https://code.claude.com/docs/en/setup)。Windows 下执行命令所需的 Git Bash 等组件按该文档准备。

### 推荐：从 GitHub 安装

在 PowerShell 或 macOS/Linux 终端中执行：

```sh
npm install -g --omit=optional github:lboverfys/mcp-cccx-together
cc-team-mcp doctor
cc-team-mcp setup
```

`setup` 通过 `codex mcp add` 注册名为 `cc_team` 的服务，保存当前 Node 和服务入口的绝对路径。已有同名配置时会提示处理，不自动覆盖。注册完成后，重新打开 Codex 会话，通过 `/mcp` 检查连接。

Windows 的 PowerShell 若限制脚本执行，可使用 `npm.cmd`、`cc-team-mcp.cmd`；macOS/Linux 使用上面的命令即可。本项目自身不需要管理员权限。安装目录、Node 或客户端位置发生变化后，先运行 `doctor`，再按提示更新注册。

`--omit=optional` 跳过 SDK 捆绑的另一份 Claude 原生程序，本项目直接使用已安装的 Claude Code，减少下载与磁盘占用。安装位置由 npm 的全局前缀决定。使用自定义磁盘或已有工具目录时，可以添加 npm 的 `--prefix` 和 `--cache` 参数；将该前缀的命令目录加入终端环境，或直接运行其中的命令。

### 从源码使用

```sh
git clone https://github.com/lboverfys/mcp-cccx-together.git
cd mcp-cccx-together
npm ci --omit=optional
node src/cli.mjs doctor
node src/cli.mjs setup
```

也可以下载仓库 ZIP，解压后在目录内执行后三条命令。保留安装目录供 Codex 启动服务；移动目录后重新注册。

### 其他 MCP 客户端

运行以下命令，根据当前安装路径生成 MCP JSON 配置：

```sh
cc-team-mcp print-config
```

将输出的 `mcpServers.cc_team` 配置加入客户端的本地 MCP 设置。服务通过标准输入输出通信，不需要开放网络端口。Codex 的配置说明见[官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 使用

连接成功后，直接说 **“使用 mct”** 或 **“使用 ctm”** 并描述任务即可。两个别名不区分大小写，都表示让 Codex 通过本 MCP 自动委派 Claude Code（CC）子 agent，Codex 负责协调、验收与收尾。例如：

> 使用 mct 帮我实现登录功能。

> 使用 ctm 检查这个项目的问题，先只读分析。

原来的“使用 cc_team”仍然有效，无需更改 MCP 注册名称。任务明确时直接委派，不再确认是否启用；仅说“使用 mct”或“使用 ctm”时，先沿用当前上下文中的任务，没有明确任务才询问。仅讨论、引用别名或明确要求不使用时，不触发委派。

更新后重新打开 Codex 会话，让客户端加载最新的工具说明。

Codex 会按以下流程协作：

1. `team_open` 创建团队，传入项目约束，并记录返回的 `teamId`。
2. `team_dispatch` 批量提交任务，为工作者指定名字、项目绝对路径、任务、文件范围和依赖。
3. 持续调用 `team_events` 等待进度；工作者提问或申请工具权限时，读取请求并通过 `team_reply` 回答。
4. 根据需要使用 `team_send` 追加指令、`team_interrupt` 中断当前轮次。
5. 通过 `team_result` 读取完整交付，检查实际文件改动与验证结果后，用 `team_review` 传入必填的 `resultId`，记录验收和交接结论。接受和拒绝都必须绑定刚检查的版本；结果在审批期间变化时会拒绝验收，避免放行错误轮次。
6. `team_close` 或 `team_shutdown` 关闭执行进程，保留记录。

工作者使用简短的职责名，例如 `接口开发cc`、`页面布局cc`、`验证cc`。名字在同一团队中唯一，包含 `cc` 后缀最多十个字符；后续操作可以直接使用完整名字。

### 工程质量如何把关

派发时说明任务目标、文件范围和可验证的验收条件。独立工作可以并行；修改同一范围时声明依赖。复杂修改安排独立验证，简单任务不必强行拆成多个工作者。

主控收到结果后，读取完整交付、检查实际差异并运行相关测试，在 `team_review.note` 中记录验收结论。发现问题时向原工作者反馈，修复后重新验收。

权限提问通过 `team_request` 读取全文后再答复。普通问题可用 `text`；多题使用以原问题文本为键的 `answers`，多选值用数组，例如 `{"选择验证平台":["Windows","macOS"]}`。空答案会被拒绝，请求仍保留供纠正。

### 自动调度与交接

例如，一次提交以下任务，`cwd` 替换为项目的绝对路径：

```json
{
  "workers": [
    { "name": "设计cc", "cwd": "<项目绝对路径>", "prompt": "梳理接口契约和验收条件", "scope": ["src"] },
    { "name": "实现cc", "cwd": "<项目绝对路径>", "prompt": "根据已验收设计实现功能", "access": "write", "scope": ["src"], "dependsOn": ["设计cc"] },
    { "name": "验证cc", "cwd": "<项目绝对路径>", "prompt": "独立检查实现与设计的一致性", "scope": ["src"], "dependsOn": ["实现cc"] }
  ]
}
```

- 设计完成后先等待主控验收，通过后才启动实现；实现通过后再启动验证。
- 前置任务的结果摘要和 `team_review.handoff` 随下游任务传入。工作者还可以用内部 `read_dependency` 工具分页读取其已声明依赖的完整交付。
- 前置任务失败或被取消时，下游显示阻塞原因。主控修复、重新验收后，队列继续推进。
- `team_open.maxConcurrent` 控制同时存活的 CC 进程，新团队默认 4。等待中的任务不启动模型；已验收的空闲进程会在排队任务需要容量或工作范围时关闭，保留会话供继续使用。
- 需要修改已验收结果时，向原工作者追加任务或恢复原会话，并在新一轮完成后重新验收。
- 每轮任务绑定具体的前置结果版本，分页读取期间保持一致。上游产生新版后，使用旧版交付的下游会显示 `staleDependencies`；更新并重新验收这条依赖链后，后续任务才继续。

`team_status` 显示依赖、排队原因、后台任务、最近交付和验收记录，`acceptedCurrent` 表示当前整条依赖链的验收是否有效。完整结果单独保存，事件窗口滚动后仍可通过 `team_result` 读取。

`team_review` 返回 `warnings` 时，验收已保存，可通过 `team_status` 查看后续调度状态并处理提示的问题。

### 并行范围与权限

- 默认 `access: "read"`，只提供读取、搜索和问答工具。
- 修改任务使用 `access: "write"`，指定相对于 `cwd` 的 `scope`，例如 `["src/api", "test/api"]`。范围表示路径或目录，不是 glob 表达式。
- 存在写入的重叠范围需要显式依赖来串行执行；没有先后依赖时整批拒绝。独立任务可拆分目录或使用独立工作区，只读任务可以共享范围。
- Windows/macOS 按不区分大小写的方式比较 `scope`。
- `scope` 用于调度冲突检查。工具授权由 Claude Code 的权限机制及主控答复控制；需要操作系统级隔离时，使用独立工作区和宿主提供的沙箱。
- 工作者先读取项目的 `AGENTS.md` / `CLAUDE.md`，遵循主控提供的约束；会话设置禁用继承的 hooks 与技能内联 shell 执行，限制额外 MCP 和再委派工具。内部依赖读取只允许访问已经声明且通过主控验收的前置任务。
- `allowedTools` 可为已授权的工作提供 Claude Code 工具规则。其余待授权工具通过 `team_reply` 显式允许或拒绝。

权限规则的处理顺序见 [Claude Agent SDK 官方说明](https://code.claude.com/docs/en/agent-sdk/permissions)。

### 恢复工作

在新对话中要求 Codex 先调用 `team_list`，按工作者名字和项目目录摘要查找历史团队，再用原 `teamId` 调用 `team_open`。随后按名字使用 `team_resume`，例如：

> 打开之前的团队，让“接口开发cc”继续完善错误处理，保留原来的项目约束。

恢复需要保留 MCP 状态目录和 Claude Code 自身的会话记录。团队约束、并发设置、依赖与验收随状态保存；显式传入新的 `constraints` 更新团队约束，后续派发、恢复或向运行中工作者 `team_send` 时带入新要求。取消后尚未启动的任务也可通过原名字 `team_resume` 重新排队。

`team_close` / `team_shutdown` 保留尚未投递的任务和追加要求。重新打开团队不会自动执行这些消息；显式 `team_resume` 后按原顺序继续，再处理新的恢复指令。已经发送给 CC 但因中断未完成的内容，由主控检查会话和文件状态后决定如何继续。

### 控制模型用量

每个任务可以指定 `maxTurns` 和 `maxBudgetUsd`，交由 Claude Agent SDK 限制轮次和本次运行的预算。例如为一个小型排查任务设置 `maxTurns: 8`。额度耗尽、中断和执行失败分别记录为对应结果，主控据此决定缩小任务或恢复执行。

`costUsd` 和 `modelUsage` 是 SDK 的累计估算值，应读取最新一条，而不是逐结果相加；恢复后的结果可能包含历史用量。恢复新进程会开始新一次预算周期。并发限制、依赖排队和按需读取交付，可以减少无效启动与反复复制上下文。

## 配置

常规安装无需配置文件。服务自动查找 PATH 及 Claude Code 的常见安装位置。需要指定路径时，复制 `team.config.example.json` 并添加相应字段：

| 字段 | 用途 |
| --- | --- |
| `claudeExecutable` | Claude Code 原生可执行文件或受支持的 JavaScript 入口绝对路径 |
| `codexExecutable` | `setup` 和可选通知使用的 Codex 入口；只使用 MCP 轮询时可省略 |
| `stateDir` | 团队、工作者与事件记录目录 |
| `tempDir` | 工作者临时文件根目录 |
| `notificationMode` | `poll`（默认）或 `codex-queue` |

```sh
cc-team-mcp doctor --config /absolute/path/team.config.json
cc-team-mcp setup --config /absolute/path/team.config.json
```

Windows 同样使用绝对路径，例如 `C:/tools/cc-team/team.config.json`。路径中有空格时加引号。

支持环境变量 `CC_TEAM_CONFIG`、`CC_TEAM_CLAUDE_EXECUTABLE`、`CC_TEAM_CODEX_EXECUTABLE`、`CC_TEAM_STATE_DIR`、`CC_TEAM_TEMP_DIR`、`CC_TEAM_NOTIFICATION_MODE`。显式 `--config` 优先于 `CC_TEAM_CONFIG`；各字段环境变量覆盖配置文件。源码目录原有的 `team.config.json` 继续兼容。

`setup` / `print-config` 会保留显式 MCP 环境覆盖，因此自定义状态与临时目录不会在客户端重启后丢失。使用配置文件且依赖 PATH 自动发现客户端时，也会保留发现用的 PATH，便于从图形界面启动；模型密钥不会写入生成的配置。已保存的环境覆盖仍优先于 JSON，调整相同字段时需同时更新对应注册值。

默认状态目录使用平台的用户数据目录，默认临时目录位于系统临时目录下的 `cc-team-mcp`，两者都可单独配置。`doctor` 显示客户端版本、入口路径，并检查状态和临时目录的访问权限。

### 模型配置和环境变量

Claude Code 读取已有的用户、项目与本地设置，模型和鉴权按原配置运行。MCP 不保存额外的模型密钥。`worker.model` 仅在任务明确需要时覆盖模型。

如果模型服务或代理只通过终端环境变量配置，需要让 MCP 客户端转发这些变量。Codex 可在对应 `[mcp_servers.cc_team]` 配置中添加变量名，例如：

```toml
env_vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]
```

按实际使用的提供商补充变量名，例如 AWS 或 Vertex 配置。凭据值保留在环境或 Claude Code 原有设置中。

### 进度通知

默认使用 `team_events` 长轮询，每次最多等待 25 秒。Codex 应持续读取到任务结束，及时回答权限请求和问题。事件返回 `nextCursor`；出现 `gap` 时，同时检查 `team_status` 获取当前状态。

支持 `codex queue --thread ... --message ... --resume` 的客户端可以选择 `notificationMode: "codex-queue"`，并在 `team_open` 中提供主会话完整 UUID。通知仅发送摘要，完整内容通过事件工具读取；投递状态显示在 `team_status.notificationDelivery`。此模式是可选增强，安装和标准工作流使用默认轮询即可。

## 工具参考

| 工具 | 用途 |
| --- | --- |
| `team_list` | 分页查找保存的团队 |
| `team_open` | 创建或恢复团队，设置约束 |
| `team_dispatch` | 批量启动工作者并派发任务 |
| `team_status` | 查询状态、进程 ID 和待答复请求 |
| `team_events` | 按游标读取进度、问题及结果，支持等待和筛选 |
| `team_request` | 分页读取完整的待答复请求 |
| `team_result` | 分页读取完整交付，支持最近一轮或历史结果 ID |
| `team_reply` | 回答问题或允许、拒绝工具操作 |
| `team_send` | 追加指令 |
| `team_interrupt` | 中断当前轮次 |
| `team_resume` | 恢复原工作者会话 |
| `team_review` | 记录主控验收 |
| `team_close` | 批量关闭指定工作者并保留会话 |
| `team_shutdown` | 关闭全部工作者并释放团队锁 |

`result` 事件包含摘要、完整结果 ID，以及 SDK 提供的用量、费用、轮次和耗时。成功交付进入待验收状态，中断和后台继续运行的结果保持各自状态。每位工作者最多有 32 条待处理消息；事件保留最近 2000 条。每份完整交付最多 8 MiB，大型产物应保存为项目文件并返回路径。

`team_result` 和内部 `read_dependency` 返回完整结果 JSON 的 UTF-8 文本片段，使用返回的 `nextOffset` 续读，拼接 `text` 后即可解析。`team_result` 的续页必须携带首页返回的 `resultId`，防止新交付出现后拼接了不同轮次；内部依赖读取已绑定当前轮次的版本。分页按字节读取并保持中文字符完整，避免每一页重复加载整个大结果。

## 排查问题

- **找不到 Claude Code**：先确认 `claude --version` 可运行，再执行 `cc-team-mcp doctor`；必要时指定 `claudeExecutable`。Windows 的任意 `.cmd` 脚本不能直接作为原生入口，标准 npm 安装会自动解析。
- **Codex 没有发现工具**：检查 `codex mcp list` 和 `/mcp`，确认配置指向现有安装目录，然后重新打开会话。
- **模型鉴权或网络错误**：先在同一环境独立运行 Claude Code，再检查客户端的环境变量转发和原有模型设置。
- **工作者停在 `needs_input`**：读取 `team_status` 中的请求，必要时用 `team_request` 获取全文，再调用 `team_reply`。
- **范围冲突**：关闭已完成的工作者，或拆分重叠目录后重试。
- **团队已被其他进程持有**：关闭原团队后重试；异常退出留下的锁可通过下文的 `recover` 命令恢复。
- **关闭失败**：查看错误中记录的进程或后台任务，处理后再次关闭。服务会保留未完成收尾的信息。
- **PowerShell 阻止 npm 脚本**：使用 `npm.cmd` 和 `cc-team-mcp.cmd`，或在已允许脚本的终端执行。

状态文件包含任务内容、进度和工具请求，应放在当前用户可控的目录。停止使用时先关闭团队，再通过 `codex mcp remove cc_team` 移除注册；卸载命令为 `npm uninstall -g cc-team-mcp`，历史状态保留供自行归档。

## 状态维护

通过 `team_status.storage` 查看工作者状态的存储占用。单条工作者记录和状态索引的大小上限各为 8 MiB。

升级前备份状态目录。旧格式会在下次写入时自动迁移，回退旧版本时需恢复备份。

完整交付默认继续保留。需要释放空间时，先关闭对应团队，再预览清理计划；以下示例为每位工作者至少保留最近 3 份结果：

```sh
cc-team-mcp prune --team <团队ID> --keep-results 3
cc-team-mcp prune --team <团队ID> --keep-results 3 --apply
```

命令默认预览，添加 `--apply` 执行清理。清理会保留最近结果和仍被验收或依赖关系引用的版本，清除多余历史结果及孤立状态记录。自定义配置可加 `--config`。

异常退出留下的团队锁可通过以下命令检查和恢复：

```sh
cc-team-mcp recover --team <团队ID>
cc-team-mcp recover --team <团队ID> --apply
```

`recover` 检查相关进程退出后恢复团队锁，并保留原锁备份。命令默认预览，添加 `--apply` 执行恢复。

## 开发与测试

```sh
npm ci --omit=optional
npm run check
npm test
npm pack --dry-run
```

自动化测试使用模拟 Claude 进程，覆盖调度、权限问答、验收交接、状态存储、会话恢复、通知、CLI 和 stdio 生命周期。CI 覆盖 Windows、macOS、Linux 及 Node.js 22、24。

使用已有 Claude Code 配置运行真实模型联调：

```sh
node scripts/smoke-live.mjs
```

真实联调会产生模型费用，验证两名工作者的汇报、问答、多轮和恢复。脚本限时 3 分钟，每个工作进程设置 8 轮和 1 美元的 SDK 估算预算，恢复进程开始新的预算周期；加 `--notify` 可同时验证通知。

测试临时目录可通过进程级 `TEMP`、`TMP`、`TMPDIR` 指定。自动测试结束后清理临时目录，真实联调保留任务状态用于检查。

### 贡献与发布检查

提交问题时提供系统/架构、Node/Claude Code 版本、脱敏后的 `doctor` 输出、最小复现步骤和预期结果。不要上传完整 `.team-state`、模型密钥或未脱敏的任务内容。

代码修改应附能复现问题的测试；协议变更同步工具描述、README 和真实联调脚本。发布前运行三平台 CI、检查包内容，并完成目标平台的真实联调。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方依赖仍遵循各自的许可证。

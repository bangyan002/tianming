# 天命 Node 终端版

终端模式直接在 Node.js 内运行原游戏脚本，只需 Node.js 22 或更新版本。首次安装终端依赖和命令：

```bash
npm run setup:cli
npm run install:cli
```

`setup:cli` 只安装 `scripts/terminal/` 的依赖，不安装桌面版依赖或下载浏览器。`install:cli` 将命令安装到当前用户的命令目录：Linux／macOS 默认 `~/.local/bin`，Windows 默认 `%APPDATA%\npm`。若该目录不在 PATH 中，安装器会显示提示。终端不启动浏览器、Electron、网页服务器或后台常驻服务。

安装后可以在任意目录运行 `tianming interactive`、`tianming list`、`tianming help audience`。命令使用当前仓库代码，需要保留仓库目录，并沿用 `.tianming-terminal/` 中的游戏进度。

自定义安装目录使用 `npm run install:cli -- --bin-dir /你的命令目录`。卸载使用 `npm run uninstall:cli`（自定义目录需带相同 `--bin-dir`）；卸载保留游戏存档。安装器不会覆盖已有的其他命令。

也可以继续从仓库使用 `npm run cli -- <group> <command>`。

## 独立子命令

每条命令执行后退出。游戏修改自动保存到用户主目录下的 `.tianming-terminal/`，下一条命令自动恢复同一局游戏和回合。新开局替换终端自动档；需要保留旧局时先用 `save write` 存入手动槽位。

```bash
tianming list
tianming help audience
tianming audience help
tianming scenario list
tianming game start 1
tianming game status
```

`list` 列出命令组；`list audience`、`help audience`、`audience help` 都列出召见子命令及参数。只输入命令组，例如 `people`，也会显示该组用法。`help` 列出全部操作；查询帮助不启动游戏引擎，不需要先开局。操作入口使用英文，说明、人物名称和游戏内容保留中文。

### 查人员与官位

```bash
tianming people list
tianming people list 王承恩
tianming people show 王承恩
tianming offices list
tianming offices list 王承恩
tianming offices show 1
```

`people show` 显示人物年龄、状态、所在地、势力、能力及现任官位。`offices list` 从当前游戏的官制树读取机构、职位、品秩、任职者和职掌，空位显示“空缺”。人员和官位查询不推进回合。

### 召见并对话

```bash
tianming audience open 王承恩
tianming audience status
tianming audience say "近日朝中有何要事？"
tianming audience history
tianming audience close
```

跨命令恢复同一会话时，保留对话记录、模式及疲劳计数，不重复扣除召见精力。第一次召见、久谈和其他行动仍遵守原游戏的精力及人物状态限制。

私下叙谈使用 `audience open 王承恩 --private`；更换人物或正式／私下模式会结束原会话并发起新的召见。已结束会话的历史可用 `audience history 王承恩` 查看。

### 配置 AI

```bash
tianming config set
tianming config show
tianming config set https://你的服务商地址/v1 你的模型ID
```

按提示输入地址、模型和密钥。密钥输入不回显，保存在终端数据目录的本机设置文件内，也可通过 `TM_API_KEY` 环境变量提供。`TM_API_URL`、`TM_API_MODEL`、`TM_API_KEY` 三项同时设置时，会在启动时应用配置。

人物回复和回合推演使用所配置的服务商，沿用游戏提示词、流式响应、取消及重试规则。

### 诏令、奏疏与回合

```bash
tianming edict add economic "命有司核查各地仓储，具实奏报。"
tianming edict list
tianming memorial list
tianming memorial show 1
tianming memorial reply 1 approve "按奏中所陈办理，事毕复命。"
tianming turn next
tianming history show
```

诏令类别为 `political`（政令）、`military`（军令）、`diplomatic`（外交）、`economic`（经济）、`other`（其他）。省略类别时记入“其他”。

奏疏处理方式为 `approve`（准奏）、`reject`（驳回）、`comment`（批示）。诏令和奏疏批复先保存为待办，`turn next` 才提交并结算。

### 存读档与 JSON 互通

```bash
tianming save list
tianming save write 1 首次问政
tianming save load 1
tianming save export /你的目录/天命存档.json
tianming save import /你的目录/天命存档.json
```

手动档有 1—9 号槽位，0 为当前终端自动档。读档后，后续命令继续操作刚载入的游戏。导出沿用原游戏 JSON 格式，剥离 API 密钥；已有同名文件不会被覆盖。导入和读档保留当前设备的 AI 配置。

终端数据库和设置存放在 `node-database.bin`、`node-settings.json`。数据库写入先完成临时文件写入、同步及原子替换，再报告保存成功。同一个数据目录同时只允许一个终端进程操作。

上一版终端的浏览器 `profile/` 目录保留，Node 模式不直接读取其中的 IndexedDB 文件。已使用上一版的玩家，可从上一版导出游戏 JSON，再用本版 `save import` 导入。桌面版及网页版导出的游戏 JSON 同样可导入。

## JSON 输出与其他参数

```bash
tianming people show 王承恩 --json
tianming offices list --json
tianming game status --data-dir /你的目录/另一局
tianming --check
```

`--json` 输出结构化结果，失败时返回非零退出码。配置的 JSON 模式应提供完整参数或已有配置，密钥用 `TM_API_KEY` 提供。`--check` 只检查 Node 引擎启动与剧本列表。

## 连续交互会话

```bash
tianming interactive
```

进入后直接使用与独立执行相同的英文子命令，无需重复输入 `tianming`：

```text
list
help audience
people list
people show 王承恩
offices list 王承恩
audience open 王承恩
audience say "近日朝中有何要事？"
audience history
audience close
edict add economic "核查仓储，具实奏报。"
edict list
memorial list
turn next
exit
```

在输入命令组或子命令时按 Tab 补全，连续按两次 Tab 查看候选。`list <group>`、`help <group>`、`<group> help` 随时可用。含空格的内容或文件路径可加引号。

对话使用 `audience say`，诏令使用 `edict add`。普通文字被视为未知命令，会提示查看帮助。`exit`、`quit` 或输入结束时保存进度及当前召见，下次启动自动恢复；用 `audience close` 结束召见。

`prompt show`、`prompt choose <number>` 用于当前交互会话的额外弹窗选择，原生确认与输入提示也在终端答复。

终端不构建图形地图和主面板。地图编辑器、工坊等图形工具没有独立子命令。

## 定向验证

```bash
node scripts/terminal/test.cjs
node scripts/terminal/command-test.cjs
node scripts/terminal/storage-test.cjs
node scripts/terminal/install-test.cjs
```

验证使用临时目录和测试 AI 响应。子命令测试清空浏览器搜索路径，并禁止启动任何子进程，覆盖运行时帮助、英文交互命令、人员与官位查询、跨进程召见、流式请求、会话精力、草稿、存读档及 JSON 互通。

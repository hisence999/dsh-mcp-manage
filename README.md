# dsh-mcp-manage

给 **DeepSeek Harness**（DSH）用的 MCP 管理插件：
把一堆 MCP 服务器收进设置面板「**MCP管理**」，一台服务器一行，能看占用、能一键启停，
并且可以按服务器开启**会话级懒启动**——真正省下那些常驻在每次请求里的工具 token。

> 实测：本机 9 台 MCP、54 个工具，全部常驻时约 17,900 tokens；只留两台（15 个工具）约 3,250 tokens。
> 其中 ComfyUI 一家 39 个工具就占 14,700 tokens，而绝大多数对话根本用不到它。

![MCP管理面板](assets/panel.png)

## 它解决什么问题

MCP 工具的 JSON Schema 会跟着每一次请求发给模型。服务器装得越多，常驻成本越高，
而模型多数时候根本不会调用它们。本插件提供三层控制：

| 控制层 | 粒度 | 效果 | 存在哪 |
|---|---|---|---|
| **启用开关** | 每台服务器 / 全局 | 整台装或卸：断开连接、注销工具、移除提示段 | `pluginManager`（profile/.plugin-manager） |
| **懒启动开关** | 每台服务器 / **每会话生效** | 工具照常注册，但默认不进请求，模型调 `mcp_tools` 装载后才可见 | profile 的 `cordis.patch.yml` 本行 `config.lazyServers` |
| **用途说明** | 每台服务器 | 可选，一句话说明这台是干什么的；懒启动时随名字一起交给模型 | 同上，`config.serverNotes` |

## 特色：会话级懒启动

```
面板打开某台的懒启动  →  config.lazyServers: [comfy]
新会话的每次请求      →  system-prompt/assemble 瀑布里按会话过滤
                      →  mcp__comfy__* 全部剔除，只留一个装载器 mcp_tools
装载器描述            →  "Lazy servers: comfy — 本地出图流水线，画图/改图时装载"
模型调 mcp_tools      →  { servers: ["comfy"] }
下一步                →  comfy 的 39 个工具出现，本会话后续请求都可见
```

- **只影响当前会话**：A 会话装了 comfy，B 会话仍然看不到；子代理各自独立。
- **下一步生效**：工具块每次请求重装配，装载后下一轮即可调用（宿主自带 tool-addition 通知）。
- **只列已启用的**：描述和目录里只出现「懒启动 **且** 已启用」的服务器，不会骗模型去装一个空壳。
- **描述实时刷新**：面板上开/关任意一行后，装载器描述立即跟着变，不需要重载插件。
- **可选用途说明**：留空就只给名字；写了就一起注入，模型才知道**什么时候**该装这台。

没有开启任何懒启动时，插件不注册 `mcp_tools`，工具块与你没装本插件时完全一致。

## 安装

要求：DSH 0.4+（用到 `settings.section` 面板槽与 `system-prompt/assemble` 装配瀑布）。

```powershell
# 1. 放进任意目录，然后在你的 profile 里安装
dsh plugin --profile desktop add D:\path\to\dsh-mcp-manage
```

或者手工挂载（开发时用）：

```powershell
# profile 目录下
npm pkg set "dependencies.dsh-mcp-manage=link:D:/path/to/dsh-mcp-manage"
npm pkg set "dsh.profile.bundles[]=dsh-mcp-manage"   # 追加到 bundles 数组
# 建软链/junction 让 Loader 能解析包名
New-Item -ItemType Junction -Path node_modules\dsh-mcp-manage -Target D:\path\to\dsh-mcp-manage
```

然后重启宿主（或触发一次配置重组）。设置 → 侧栏出现「**MCP管理**」（order 18）即成功。

### MCP 配置

MCP 服务器全部写在 `cordis.patch.yml` 的 `- insert:` 列表里，**一台一行**：

```yaml
- insert:
    - id: mcp-manage                 # 插件自己那一行，别删
      name: 'dsh-mcp-manage'

    - id: mcp-exa
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: exa
        transport: streamable-http
        url: https://mcp.exa.ai/mcp
        headers:
          x-api-key: !!js process.env.EXA_API_KEY
```

仓库里只提供脱敏模板 [`cordis.patch.example.yml`](cordis.patch.example.yml)，
把它复制成 `cordis.patch.yml` 再填你自己的 key（或用 `!!js process.env.XXX` 引用环境变量）。
`cordis.patch.yml` 已在 `.gitignore` 里，避免把密钥推到远端。

改完配置不会自动热更：重启宿主，或随便改一下 profile 的 `cordis.patch.yml` 触发重组。

## 使用

面板一台服务器一张卡片：

- 左侧：展开箭头 + 首字母徽标 + 服务名，下面是状态点、`mcp-<名字> · 传输方式`，以及「懒启动」「说明」两个小标签；
- 右侧：`tokens · N 个工具` 与一条占用条（相对占比，过小或无工具时显示 `—`）；
- 最右：**懒启动**、**启用** 两个开关，标题写在开关下方。

点卡片展开：这台服务器的工具清单、懒启动提示，以及「用途说明」编辑框（`保存说明` / `清除` / 字数计数）。

- **tokens** 按工具 schema 序列化后的字符数 ÷ 4 粗估，与宿主 `tokenMeter` 的口径不同，只用来看相对大小。
- **状态点**只表示插件是否加载，不代表 MCP 连接可用；`failOnStartupError: false` 时连接失败不会弹错。
- 点「说明」标签就知道这台写过描述；`保存说明` 写回 profile，`清除` 置空。
- 顶部统计行可点：`全部 / 运行中 / 已停用 / 懒启动` 四档筛选，右侧显示懒启动可省下的 token。

页面对应的 Host 路由（挂在 `/mcp-manage/api`）：

| 路由 | 作用 |
|---|---|
| `GET /state` | 所有服务器 + 汇总（工具数 / tokens / 懒启动可省 / 已写说明数） |
| `POST /toggle` | `{ id, enabled }`，整台启停 |
| `POST /lazy` | `{ server, lazy }`，写回 `config.lazyServers` |
| `POST /note` | `{ server, note }`，写回 `config.serverNotes`（≥600 字报 400，`""` 即清除） |

## 边界

- 懒启动只裁剪**请求里的工具块**（省 token），不阻止模型凭记忆直接调用已注册的工具；
  要硬隔离得另加 `tools.guard`。
- PTC（code-mode）模式下工具块里只有 `run_code`，该机制不生效（默认 native 模式下正常）。
- 用途说明属于「提示」不是「约束」：模型看到说明只是更可能选对服务器，装载决策仍归它自己。
- 写法基于现有插件管理器 / 装配瀑布 API 的组合，非官方文档化用法，DSH 大版本升级后可能需要适配。

## License

[MIT](LICENSE)

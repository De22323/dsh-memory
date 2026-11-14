# dsh-memory

把「AI 的长期记忆」做成**你自己工作区里的一堆纯文本文件**，而不是某家公司的数据库。

一个 DeepSeek Harness 插件：六个记忆工具 + 定时沉降，自带全部脚本，装上就能用。

---

## 它解决什么

AI 助手每次开新会话都从零开始。市面上的记忆方案大多是服务端黑盒 + 向量库——你看不见 AI 记了什么，也没法改、没法删、没法审计。

这个插件的做法：

- **唯一真相是 `memory\记忆\条目.jsonl`**，一行一条，人可以直接读、直接删
- 上面几份都是它的**投影**（`干.md` 索引 / `目录.md` / `枝\*.md` 枝页 / `沉底.md`），生成物，别手改
- **遗忘是排序，不是删除**：每条记忆有盒子（新卡/浅/中/深/沉底），越久没被翻越靠后，但永远搜得到
- **翻卡会回温**：`memory_get` 一次 = 记一次 access，盒子回一档，复习增益让 S 变长
- 检索是中文口语向的（BM25 + 枝命中 + 同义词扩词 + 单字召回），不是只认关键词

## 装法（DSH）

```powershell
# 1. 把这个目录 link 进 profile（不要手改 dsh.profile.bundles）
dsh plugin --profile desktop add link:<本目录>

# 2. 重启 DSH，看设置页插件列表里有没有 dsh-memory
```

首次挂载时会按 `template\` 补齐缺失的文件（**已有的一律不覆盖**）。它会在工作区建出：

```
memory\
  身份.md        天性层：它是谁、怎么说话、底线（你会改的第一份）
  待办.md        待办块（一行一条，只写要做的事）
  近况.md        此刻：他在哪、在干嘛（超过 6 小时就当旧了）
  记忆\
    条目.jsonl   唯一真相（一行一条）
    干.md        索引（生成物，别手改）
```

`template\AGENTS-记忆纪律.md` 是配套的提示词纪律——**粘进你的 AGENTS.md 或系统提示**。插件只给工具和结构，让记忆不烂的是那段纪律。

配置在 `cordis.patch.yml`：

| 字段 | 说明 |
|---|---|
| `workspace` | 工作区根（`memory\` 在它下面；有 `tools\` 就优先用那边的最新脚本） |
| `tickMinutes` | 多少分钟跑一次沉降 + 衰减 + 盒子结算；`0` = 关掉定时 |

## 工具

| 工具 | 干什么 |
|---|---|
| `memory_add` | 写一条（自动取代判定、重建索引、落收据） |
| `memory_search` | 搜（只回「枝 › 标题」+ id） |
| `memory_tree` | 看目录 / 展开某枝的标题 |
| `memory_get` | 取一条全文（顺手回写 access） |
| `memory_feedback` | 打反馈：他否过 → 降权；他确认过 → 加权 |
| `memory_stats` | 体检：叶/枝/盒子分布/过期/被取代 |

## 数据格式

`memory\记忆\条目.jsonl`，一行一个 JSON：

```json
{"id":"h-20261113-001","ts":"2026-11-13T14:51:39.000Z","kind":"fact","imp":3,
 "visibility":"private","content":"一句话","kw":["关键词"],"parent":"b-某枝",
 "box":0,"state":"L1","access":[],"rep":0,"S":12.0,"D":5}
```

`kind`：fact / event / tool / person / meme / mood / date
`box`：0 新卡 / 1 浅 / 2 中 / 3 深 / 4 沉底

## 风险边界

- **只有 host 半边，没有 client.js**。客户端半边声明错（`dsh.client` 没配 `./client`）会让整个页面打不开——这是真实事故。
- 工具注册依赖 `@deepseek-ai/dsh-tools`；解析不到就**降级为不注册工具**，插件本身照常挂载，不炸插件树。
- 装之前先 `undo_snapshot`；装完立刻重启验证，起不来就回 `runtime\fallback`。

## 测试

```powershell
node test/run.mjs     # 脚本层：临时空库跑 add/search/get/tree/stats + 重建投影
node test/apply.mjs   # 插件层：假 ctx 跑 apply()，验证加载/初始化/降级不抛
node test/edge.mjs    # 边界：空库搜索、坏 JSON 行、不存在的 id、重复写、模板不覆盖
```

## 示例（不装 DSH 也能试）

```powershell
node example/demo.mjs
```

在系统临时目录建一个空记忆库，写一条 → 搜出来 → 取正文 → 体检，跑完自动删。见 `example/README.md`。

## 定时维护的安全边界

插件定时跑三件维护，**都不写记忆内容**：

| 动作 | 干什么 | 不干什么 |
|---|---|---|
| `memory-sink --auto` | 把 `状态.md` 里最老的历史节搬进归档 | 不删正文，搬完做守恒校验 |
| `memory-decay --apply` | 把 `state` 字段校正成盒子的投影 | 幂等，全对齐就一个字节都不动 |
| `memory-boxes` | 按时间把条目往深推盒子 | 只升不降，没到线什么都不写 |

每轮 tick 前后对 `条目.jsonl` 算一次 sha256 + 条数；**只要变了就立刻停掉定时维护**，红字进 `runtime/dsh-memory-tick.log`。写记忆内容的只有 `memory_add`，只有模型在会话里主动调用时才会跑。

## License

MIT

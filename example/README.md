# 最小示例

```powershell
node example/demo.mjs
```

它会在系统临时目录里建一个空记忆库，走一遍：

1. `memory_add` 写一条
2. `memory_search` 搜出来（只给标题和 id）
3. `memory_get` 取正文
4. `memory_stats` 体检
5. 列出生成物（`干.md` / `目录.md` / `枝\` —— 这些是人可以读的投影）

**跑完自动删，不碰你自己的记忆。**

想看文件长什么样，把 `demo.mjs` 末尾那行 `rmSync` 注释掉，它会留下临时目录路径让你进去翻。

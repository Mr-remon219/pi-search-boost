# pi-search-boost

**pi（[earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)）的网络搜索增强扩展——把 pi 的 web 搜索升级为多引擎融合、研究级能力：并行多引擎检索、深度研究循环、并行子 agent、focus 定向抓取、缓存与全量审计。**

项目以 Grok Build / Claude Code / Codex 为参照，经过 22 轮实测迭代打磨。行为层由注入系统提示的 `<search_balance>` 主动搜索守则驱动，所有结论都有真实查询 + 审计日志硬证据。

---

## 为什么需要它

编码 agent 的默认 web 搜索通常是单引擎黑盒：无法交叉验证、无成本控制、不可观测，且模型要么少搜（凭过期记忆作答）要么滥搜（琐碎问题也搜）。pi-search-boost 逐一解决：

- **四引擎融合检索** — Bing（免 key）+ Tavily + Exa + Brave 并行，按 URL 去重，按"引擎一致性与域名质量"交叉打分。两个以上独立引擎同时命中 = 高置信；单引擎噪音自动降级。
- **复杂度路由** — 搜索预算与查询复杂度绑定（Keiro / Adaptive-RAG 模式）：`simple` = 1 变体 × 2 引擎（1 credit）、`medium` = 2 × 3、`complex` = 3 × 4 + advanced 抽取（2 credits）。简单查询不再为深度研究买单。
- **focus 定向抓取** — `fetch_page` 的 `focus` 参数只保留与查询相关的段落（Grok find_in_page / Anthropic dynamic filtering 模式）。实测 **省 95% token**（1136 词 → 61 词）。
- **深度研究循环** — 检索 → 抓页 → 抽取 → 覆盖度检查 → 追问 → 收敛；逐来源佐证（关键声明需 ≥2 个独立域名）、时效感知。
- **并行多 agent 研究** — 把问题拆成 2-4 个子任务，各自跑在独立 pi 子进程里（独立上下文、独立搜索预算），结果汇总交叉验证。
- **缓存** — 搜索结果（6h）与页面（24h）落盘；热缓存 ~1ms，跨进程复用。
- **审计与可观测性** — 每次搜索/抓取/研究事件全量落日志（JSONL，5MB 轮转），含 tier、credits 估算、引擎错误、耗时。TUI 内 `/search-audit`、`/search-cache` 命令。
- **主动搜索守则** — agent 启动前注入 `<search_balance>` 规则：何时该搜（事实/版本/时效/对比/陌生领域）、何时不搜（本地代码/纯创作/极稳定概念）、何时停（证据足够/同查询二次=循环/约 3 轮边际收益衰减）、自主兜底（修查询重试、curl 自抓、直接抓 URL、防注入）、**开发中触发**（写代码前搜索不确定的库 API/新依赖版本与替代品/变化过的语法/不认识的报错/技术栈最佳实践）。

---

## 安装

### 一键安装（推荐）

```bash
# Windows
install.bat

# macOS / Linux
chmod +x install.sh && ./install.sh
```

脚本会把扩展复制到 `~/.pi/agent/extensions/search-boost/`，并可选注册你的 API key。

### 手动安装

```bash
mkdir -p ~/.pi/agent/extensions/search-boost/lib
cp index.ts ~/.pi/agent/extensions/search-boost/
cp lib/*.ts ~/.pi/agent/extensions/search-boost/lib/
```

然后**重启 pi**（或 TUI 内 `/reload`）。

### API keys（可选）

不配任何 key 也能用——**免 key 模式**（Bing HTML + Jina Reader）。要满血请配置：

| 变量 | 引擎 | 说明 |
| --- | --- | --- |
| `PI_SEARCH_TAVILY_KEY` | Tavily | agent 设计级搜索 API，质量最好（推荐）。每月 1000 免费 credits |
| `PI_SEARCH_EXA_KEY` | Exa | 语义/神经检索，与关键词引擎互补 |
| `PI_SEARCH_BRAVE_KEY` | Brave | 关键词 + 操作符 |
| `PI_SEARCH_CACHE_TTL` | — | 搜索缓存秒数（默认 `21600`，6h） |
| `PI_SEARCH_PAGE_TTL` | — | 页面缓存秒数（默认 `86400`，24h） |

---

## 工具

| 工具 | 功能 |
| --- | --- |
| `fused_search` | 多引擎搜索：关键词变体 × 引擎并行 → URL 去重 → 跨引擎打分 → 带引擎来源/发布日期/全文内容的排序结果（Tavily advanced / Exa 的 content 可直接消费，跳过抓取） |
| `fetch_page` | Reader 模式抓取：Jina Reader（免 key）→ 本地启发式抽取兜底 → 薄内容自动换 headless-browser 引擎。`focus` 参数只保留相关段落（省 80-95% token） |
| `deep_research` | 多轮循环：覆盖度检查、逐来源佐证、一手来源优先、时效感知。`mode=step` 返回缺口 + 建议追问，由 agent 亲自驱动 |
| `research_parallel` | 2-4 个独立子 agent（pi 子进程）各有搜索预算，并行执行，结果汇总交叉验证 |

### fused_search 参数

| 参数 | 说明 |
| --- | --- |
| `query` | 问题或主题 |
| `queries` | 可选关键词变体（缺省自动派生） |
| `engines` | 引擎子集：`bing`、`tavily`、`exa`、`brave` |
| `max_results` | 融合结果上限（1-20，默认 10） |
| `include_domains` / `exclude_domains` | 客户端硬过滤（引擎忽略 `site:` 操作符） |
| `recency` | `day`/`week`/`month`/`year` — 有日期结果按半衰期指数衰减 |
| `min_score` | 低于融合分阈值的直接丢弃 |
| `depth` | Tavily 深度：`basic`（1 credit）/ `advanced`（2 credits，查询对齐全文抽取） |
| `complexity` | `auto`/`simple`/`medium`/`complex` — 预算档位覆盖 |

查询写法：像 Grok Build 一样堆 3-6 个领域关键词 + 具体术语。`site:example.com` 自动翻译为客户端 include 过滤；`"a" OR "b"` 自动拆成并行变体。

### TUI 命令

- `/search-audit stats|recent|failures|domains|clear` — 审计分析：事件计数、抓取成功率、引擎错误、tier 分布、Tavily credits 估算、失败域名 Top
- `/search-cache stats|clear` — 查看/清空缓存

---

## 架构

```
index.ts        工具注册（fused_search / fetch_page / deep_research /
                research_parallel）、TUI 命令、<search_balance> 守则注入
lib/engines.ts  引擎适配（Bing HTML 含跳转解码与结构变化检测、Tavily、Exa、
                Brave）、查询预处理（site:/OR/引号）、复杂度路由、融合打分、时效衰减
lib/extract.ts  Jina Reader + 本地启发式抽取 + headless-browser 兜底、
                focus 段落过滤（动态过滤）、缓存
lib/research.ts 深度研究循环：轮次、覆盖度、佐证、追问生成
lib/parallel.ts 子 agent 编排：spawn pi 子进程（隔离/并发/超时/故障隔离）
lib/cache.ts    TTL JSON 缓存落盘（损坏自愈）
lib/audit.ts    JSONL 审计日志（5MB 轮转、尾部读取）
lib/util.ts     超时/信号 fetch、HTML 实体解码、URL 归一化、CJK 分词、并发池
```

### 设计来源（刻意借鉴）

- **Jina Reader**（`r.jina.ai/<url>`，免 key markdown 抽取）— [OpenDeepResearcher](https://github.com/mshumer/OpenDeepResearcher) 同款
- **Tavily 为默认搜索 API** — [langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) 的选型
- **搜到自信为止的研究循环** — OpenDeepResearcher 的 iterate-until-confident，改成工具内启发式 + `step` 模式让 LLM 驱动
- **查询分解 + 逐条引用** — [GPT-Researcher](https://docs.gptr.dev/blog/building-gpt-researcher) 的 plan-and-solve
- **复杂度路由** — Keiro / [Adaptive-RAG](https://arxiv.org/abs/2403.14403)
- **动态过滤** — Grok 的 `find_in_page` / Anthropic dynamic filtering 模式
- **防过度搜索停止规则** — WWW'26 实证：约 3 轮后搜索边际收益锐减（over-search 是主要失败模式）

---

## 实测性能

| 指标 | 数值 |
| --- | --- |
| 简单查询（1 变体 × 2 引擎） | ~1.0s |
| 中等查询（2 × 3） | ~3.2s |
| 复杂查询（3 × 4，advanced） | ~3.6s |
| 深度研究单轮 | 9.8s 收敛（2 轮 source_cap） |
| 热缓存命中 | 1-3ms |
| focus 过滤 | 省 95% token（1136 → 61 词） |
| research_parallel（3 子任务） | ~65s 墙钟 |
| 简单查询请求量 vs 平铺搜索 | 少 75% 请求、约一半 credits |

### 验证方法

每一轮迭代都用真实查询 + 审计日志验证（不是纸面声明）：引擎失败逐引擎记录带原因；tier/credits 估算在 `/search-audit stats` 可见；缓存命中跨进程计数。已知故障模式（Bing 挑战页、Jina 限流、DNS 污染环境）都能被检测并优雅降级——守则还教模型在工具失效时用 `curl` 兜底。

---

## 已知限制

- **X/Twitter 数据**：未接入（X API 已收费；guest token 抓取 2025 年起死亡）。实际用 Tavily/Exa 索引替代。
- **模型内建触发**：搜索触发是策略驱动（系统提示），不是 RL 训练进模型。实测与主流 agent 的"模型自决触发"等价（所有主流 agent 都是模型自决，无一使用 server-side 自动触发）。
- **Bing HTML 解析**：依赖 Bing 页面结构；结构变化会被检测并显式报错（绝不静默返回空结果）。
- **无自建索引**：检索经 4 个引擎代理，没有本地全网索引。

---

## 开发历程

22 轮实测迭代：从单引擎 Bing 抓取 → 四引擎融合 + 复杂度路由 → focus 定向读取（省 95% token）→ 深度研究 + 佐证 → 并行子 agent → 主动搜索守则（v3：防过度搜索停止规则；v4：自主兜底规则）→ 最终审计（修复参数暴露与尾部读取 bug）。

## License

MIT

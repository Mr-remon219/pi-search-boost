# pi-search-boost

**面向 [pi](https://github.com/earendil-works/pi-coding-agent) 的搜索增强扩展——把 pi 的网络搜索变成多引擎、研究级的能力：融合多引擎检索、深度研究循环、并行子代理、聚焦过滤抓页、缓存与完整可审计性。**

行为层由注入系统提示词的前摄搜索策略（`<search_balance>` 规则集）驱动。

---

## 你能得到什么

- **融合多引擎搜索** — api 层：Tavily + Brave API + Exa 并行；free 层：keyless Exa MCP（单引擎）。用 `/web_change` 切换
- **跨引擎排序** — 按 URL 去重、按引擎共识与域名质量交叉排序，带每域名软多样性衰减；被 2+ 个独立引擎命中的结果是高置信，单引擎噪音被降权
- **复杂度路由** — 搜索预算绑定查询复杂度：`simple` = 1 变体 × 2 引擎（1 credit）、`medium` = 2 × 3、`complex` = 3 × 4 + advanced 抽取（2 credits）
- **聚焦过滤抓页** — `fetch_page` 的 `focus` 参数只保留与查询相关的段落（实测省 ~95% token）
- **深度研究循环** — 检索 → 抓页 → 抽取 → 覆盖度检查 → 生成追问 → 收敛，带逐来源佐证（关键声明需 ≥2 个独立域名）
- **并行多代理研究** — 把问题拆成 2-4 个子任务，每个作为独立 pi 子进程运行，各自有搜索预算
- **X/Twitter 实时搜索** — `x_search`：托管 x_search 工具（grok 登录 / `XAI_API_KEY`）与融合多引擎（限 x.com）并行、结果去重合并；用户结构化资料走 X 匿名 guest GraphQL；oEmbed 全文增强；无任何凭据也能用（~2s 多引擎降级）
- **缓存** — 搜索结果（6h）与页面（24h）落盘；热缓存命中 ~1ms，跨进程
- **审计与可观测** — 每次搜索/抓页/研究事件都记 JSONL 日志（5MB 轮转），含层级、credits 估算、引擎错误、耗时；TUI 提供 `/search-audit` 与 `/search-cache` 命令
- **前摄搜索策略** — 启动时注入 `<search_balance>` 规则集：何时默认搜索（任何一丝不确定），何时跳过，何时停止（约 3 轮收益递减），自治/兜底规则，以及写代码时的触发规则（对不确定的 API 先搜再写）

---

## 安装——让 pi 来搞定

**前置**：已安装 pi（建议 v0.84 或更新；扩展用到 `pi.registerTool` 与 `before_agent_start` 系统提示词注入）。无需构建、无需打包。

### 方式 A：git 一键安装（推荐）

无需 clone——pi 自动克隆仓库、注册进 `~/.pi/agent/settings.json`、并按 package 规则加载。

```bash
# 1. 先试用（不安装，临时目录跑一次）：
pi -e git:github.com/Mr-remon219/pi-search-boost -p "fused_search 'tokio latest version'"

# 2. 正式安装：
pi install git:github.com/Mr-remon219/pi-search-boost
```

然后重启 pi 或执行 `/reload`。

### 方式 B：clone 后本地安装

```bash
git clone https://github.com/Mr-remon219/pi-search-boost.git
cd pi-search-boost
pi install .
```

### 方式 C：手动复制（兜底——不用 pi 的包机制）

```bash
# Windows
install.bat
# macOS / Linux
chmod +x install.sh && ./install.sh
```

复制到 `~/.pi/agent/extensions/search-boost/`（pi 自动发现该目录下的扩展）。

### 让 pi 帮你完成剩余配置

安装后，把下面这段话粘贴给 pi——agent 会读这份 README 并自己完成：

> 请阅读这份 README 帮我完成配置：确认扩展已加载（search-audit stats）、引导我配置 API keys（或配置我粘贴给你的 key）、并执行验证步骤。


---

## API keys（api 层需要；free 层无需任何 key）

Key 是**环境变量**（扩展不读 `.env` 文件）：
- Windows：`setx PI_SEARCH_TAVILY_KEY "..."` —— 扩展会直接读 `HKCU\Environment`，所以 `setx` 无需重启进程即生效
- macOS / Linux：`export PI_SEARCH_TAVILY_KEY="..."`（或写入 shell profile）
- 或运行 `install.bat` / `install.sh` 交互输入

| 变量 | 引擎 | 说明 |
| --- | --- | --- |
| `PI_SEARCH_TAVILY_KEY` | Tavily | 为 agent 设计的搜索 API，质量最好（推荐）。1000 免费 credits/月 |
| `PI_SEARCH_EXA_KEY` | Exa | 语义/神经检索，与关键词引擎互补 |
| `PI_SEARCH_BRAVE_KEY` | Brave | 关键词 + 操作符 |
| `PI_SEARCH_CACHE_TTL` | — | 搜索缓存秒数（默认 `21600`，6h） |
| `PI_SEARCH_PAGE_TTL` | — | 页面缓存秒数（默认 `86400`，24h） |
| `PI_SEARCH_ALLOW_TUN_FAKEIP` | — | 设为 `0` 关闭 Clash/sing-box TUN fake-ip carve-out（默认开启） |

注册入口：[Tavily](https://tavily.com)（1000 免费 credits/月）· [Exa](https://exa.ai) · [Brave](https://brave.com/search/api/)

---

## 验证

安装后（以及每次搜索后），这两个命令应有响应：

```
/search-audit stats    # 事件计数、引擎错误、层级分布、credits 估算
/search-cache stats    # 缓存命中 / 条目
```

快速冒烟测试（直接跑扩展，无需安装）：

```bash
pi -ne -e git:github.com/Mr-remon219/pi-search-boost -p "fused_search 'tokio latest version'"
```

---

## 更新 / 卸载

```bash
# 移动 pin 的 git ref 并 reconcile 检出：
pi install git:github.com/Mr-remon219/pi-search-boost@main

# 卸载：
pi remove git:github.com/Mr-remon219/pi-search-boost
```

手动安装：重新运行 `install.bat`/`install.sh` 更新；`rm -rf ~/.pi/agent/extensions/search-boost` 卸载。

---

## 工具

| 工具 | 功能 |
| --- | --- |
| `fused_search` | 多引擎搜索：关键词变体 × 引擎并行 → URL 去重 → 跨引擎打分 → 带引擎来源、发布日期与全文（Tavily advanced / Exa）的排序结果，可直接消费 |
| `fetch_page` | Reader 模式抓页：Jina Reader（免 key）→ 本地启发式抽取兜底 → 薄页面走无头浏览器。`focus` 参数只保留相关段落（省 80-95% token） |
| `deep_research` | 多轮循环：覆盖度检查、逐来源佐证、一手来源优先、时效性。`mode=step` 返回缺口与建议查询，供 agent 亲自驱动迭代 |
| `research_parallel` | 2-4 个独立子代理（pi 子进程）各自带搜索预算，并行跑，最后交叉验证汇总 |
| `x_search` | X/Twitter 实时搜索（帖子/用户/线程）。keyword/semantic 双通道并行：托管 x_search 工具（grok 登录 / `XAI_API_KEY`）∥ 融合多引擎（限 x.com），结果去重合并；无凭据也可用（多引擎 + oEmbed 全文增强；用户结构化资料走 guest GraphQL） |

### fused_search 参数

| 参数 | 说明 |
| --- | --- |
| `query` | 问题或主题 |
| `queries` | 可选关键词变体（省略时自动派生） |
| `engines` | 引擎子集覆盖：`tavily`、`exa`、`brave`（api 层）或 `exa-free`（free 层）；默认 = 当前层的引擎 |
| `max_results` | 最大融合结果数（1-20，默认 10） |
| `include_domains` / `exclude_domains` | 客户端硬过滤域名（引擎忽略 `site:` 操作符） |
| `recency` | `day`/`week`/`month`/`year` —— 带日期结果半衰期指数衰减 |
| `min_score` | 丢弃低于融合分数下限的结果 |
| `depth` | Tavily 深度：`basic`（1 credit）/ `advanced`（2 credits，查询对齐全文抽取） |
| `complexity` | `auto`/`simple`/`medium`/`complex` —— 预算层级覆盖 |

查询风格：像 Grok Build 一样堆 3-6 个领域关键词加具体词。`site:example.com` 自动转成客户端 include 过滤；`"a" OR "b"` 自动拆成并行变体。

`fused_search` 是唯一搜索入口（快速查询传 `complexity: "simple"`）；`fetch_page` 负责所有读页。无需任何伴生包。

### TUI 命令

- `/search-audit stats|recent|failures|domains|clear` — 分析审计日志：事件计数、抓取成功率、引擎错误、层级分布、Tavily credits 估算、失败域名
- `/search-cache stats|clear` — 查看或清空缓存
- `/x-login [|-k <XAI_API_KEY>|status]` — 把 xAI 凭据导入 pi 自己的目录供 x_search 使用（无参 = 从你的 grok 登录导入；`-k` = API key；`status` = 查看凭据链）
- `/x-logout` — 删除 pi 本地凭据：官方托管 x_search 路径被禁用，x_search 只用多引擎 / guest-GraphQL / oEmbed 降级链（不影响 grok CLI 自己的登录；`/x-login` 可重新启用官方路径）

### x_search 参数

| 参数 | 说明 |
| --- | --- |
| `type` | `keyword`（X 高级语法：`from:user`、`since:YYYY-MM-DD`、`min_faves:N`）、`semantic`（自然语言）、`user`（结构化资料 + 时间线）、`thread`（按帖子 id / status URL 取完整对话） |
| `query` / `username` / `post_id` | 按 type 分别指定目标 |
| `from_date` / `to_date` | 日期范围（keyword/semantic） |
| `allowed_x_handles` / `excluded_x_handles` | 托管工具级账号过滤（最多 20 个，互斥） |
| `model` / `reasoning_effort` | 驱动模型（默认 `grok-4.6`）与推理强度（默认 `low` — 快且结果一致） |

路由：`keyword`/`semantic` → 托管 x_search（grok 登录 / `XAI_API_KEY`）∥ 融合多引擎（限 x.com）并行、合并去重；**无凭据**时多引擎 + oEmbed 全文增强约 2s 返回。`user` → guest GraphQL（匿名 X 网页 API：粉丝数、简介、认证、带互动的最近帖）→ 多引擎账号链接。`thread` → oEmbed 单条全文。

凭据：`/x-login` 把你的 grok 登录导入 pi 自己的目录（`~/.pi/agent/xsearch-auth.json`）；token 自动刷新（OIDC）。全程零子进程——pi 自己 POST Responses-API 请求。

---

## 架构

```
index.ts        工具注册（fused_search、fetch_page、deep_research、
                research_parallel、x_search）、TUI 命令、<search_balance> 规则集注入
lib/engines.ts  引擎适配（Tavily、Exa、Brave API、exa-free MCP）、查询预处理
                （site:/OR/引号）、复杂度路由、跨引擎融合打分、recency 衰减
lib/xsearch.ts  x_search 主路径：pi 直接 POST Responses API（托管 x_search 工具），
                用 grok 的 OIDC 登录态或 XAI_API_KEY——零子进程；快速凭据预检
lib/xauth.ts    x_search 凭据链：XAI_API_KEY 环境变量 → pi 本地副本
                （xsearch-auth.json，由 /x-login 写入）→ 官方路径必须显式启用；
                OIDC token 自动刷新（尽力同步 grok 文件）；/x-logout 删除副本
lib/xfallback.ts 免凭据降级路由：多引擎（限 x.com）+ oEmbed 全文增强；guest
                GraphQL（匿名 X 网页 API：token 缓存 2h、query id 404 自愈）
                提供结构化用户资料
lib/layer.ts    层级状态（free | api）落盘，/web_change 切换
lib/extract.ts  Jina Reader + 本地启发式抽取 + 无头浏览器兜底、聚焦段落过滤
                （动态过滤）、缓存
lib/research.ts 深度研究循环：轮次、覆盖度检查、佐证、追问生成
lib/parallel.ts 子代理编排：spawn pi 子进程（隔离、并发、超时、故障隔离）
lib/cache.ts    TTL JSON 缓存落盘（损坏自愈）
lib/audit.ts    JSONL 审计日志 5MB 轮转，tail 读取供 /search-audit
lib/util.ts     带超时/信号的 fetch、HTML 解码、URL 归一化、CJK 感知分词、
                有界并发池
```

### 设计来源（刻意借鉴）

- **Jina Reader**（`r.jina.ai/<url>`，免 key markdown 抽取）— 与 [OpenDeepResearcher](https://github.com/mshumer/OpenDeepResearcher) 同思路
- **Tavily 作为默认搜索 API** — [langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) 的选择
- **迭代至确信的研究循环** — OpenDeepResearcher 的设计，改造成工具内启发式 + `step` 模式由 LLM 驱动
- **查询分解 + 逐来源引用** — [GPT-Researcher](https://docs.gptr.dev/blog/building-gpt-researcher) 的 plan-and-solve 模式
- **复杂度路由** — Keiro / [Adaptive-RAG](https://arxiv.org/abs/2403.14403)
- **动态过滤** — Grok 的 `find_in_page` / Anthropic 动态过滤模式
- **前摄搜索停止规则** — WWW'26 证据：约 3 轮后搜索收益急剧衰减（过度搜索是主要失败模式）

---

## 实测数据

| 指标 | 数值 |
| --- | --- |
| 简单查询（1 变体 × 2 引擎） | ~1.0s |
| 中等查询（2 × 3） | ~3.2s |
| 复杂查询（3 × 4，advanced） | ~3.6s |
| 深度研究一轮 | 9.8s 收敛（2 轮，source-cap） |
| 热缓存命中 | 1-3ms |
| 聚焦过滤 | 95% token 节省（1136 → 61 词） |
| research_parallel（3 子任务） | ~65s 墙钟 |
| 简单查询请求量 vs 平铺搜索 | -75% 请求，约一半 credits |

---

## 已知限制

- **X/Twitter 数据**：不包含（X API 收费；guest-token 抓取 2025 年起已死）。用 Tavily/Exa 索引作为实际替代。
- **模型原生触发**：搜索触发靠策略（系统提示词）驱动，不是 RL 训练进模型。
- **Bing HTML 解析**：依赖 Bing 页面结构；结构变化会被检测并响亮失败（绝不静默返回空）。
- **无自建索引**：检索走 4 个引擎代理，没有本地网页索引。
- **free 层是单引擎**：keyless 的 Exa MCP 可能 429；失败会大声报错并提示 `/web_change api`，绝不静默返回空、也绝不回退刮页。

---

## 开发历史

23 轮实测迭代（详见仓库提交历史）：单引擎 Bing 抓取 → 4 引擎融合 + 复杂度路由 → 聚焦过滤抓页（95% token 节省）→ 带佐证的深度研究 → 并行子代理 → 前摄搜索策略（v3：反过度搜索停止规则；v4：自治/兜底规则）→ 审计修复 → **第 23 轮：TUN fake-ip carve-out（Clash TUN 对每个 DNS 查询都回 198.18/15；SSRF 防护现在允许全 fake-ip 主机名解析，但字面私网 IP / 回环 / metadata 仍被拦截；可用 `PI_SEARCH_ALLOW_TUN_FAKEIP=0` 关闭）+ 单策略合并（前摄搜索规则集去重合并为一个带显式工具路由章节的 `<search_balance>`；独立的 web-search-guidance 扩展退役）。**
> Clash/sing-box TUN 用户注意：没有这个修复，`fetch_page` 会对每个真实 URL 报 "resolves to private IP 198.18.0.x"。
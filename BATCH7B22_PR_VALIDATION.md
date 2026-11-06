# Batch 7B-2.2：干净克隆、私有 Registry 恢复、Linux CI 与 PR 准备

项目：`<repo>`
分支：`feature/batch7b-production-deeplink`
基线：`main@c6ebc12`
前置：Batch 7B-2（深链持久化）、Batch 7B-2.1（真实 74 条迁移）

本轮不新增业务功能，只做发布前验证。结论：**`B7B_PR_READY`**

---

## 1. 干净克隆回归结果

克隆方式：`git clone --branch feature/batch7b-production-deeplink <repo> <隔离目录>`。只拿到**已提交内容**，因此天然不含 `node_modules`、`.papers-id/`、`tests/reports/`、`tests/browser/artifacts/`（克隆后实测：`Test-Path .papers-id` → `False`，`Test-Path node_modules` → `False`）。

| 场景 | 命令 | 结果 |
|---|---|---|
| 干净克隆（**无**私有 Registry） | `npm ci` + `python scripts/run_tests.py` | **PASS 26 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 同一克隆恢复私有 Registry 后 | `python scripts/run_tests.py` | **PASS 26 / FAIL 0 / SKIP 0 / BLOCKED 0** |

`npm ci`：40 packages，0 vulnerabilities（两次一致）。

### 1.1 关键套件在两种状态下的表现

| 套件 | 无 Registry（= CI 形态） | 有 Registry（= 授权本机） |
|---|---|---|
| `test21` Registry 生命周期 | **42/42**（全部走合成 Fixture） | **42/42** |
| `test22` 真实一致性 | **8/8 + 1 SKIP**（A 组执行，B 组跳过） | **19/19** |
| `papers-deeplink`（Chromium） | **63/63** | **63/63** |
| 生成器（`scan_papers.py`） | 不依赖 Registry 存在；缺失时按设计中止，不写文件 | 与产物逐字节一致 |

`test22` 在无 Registry 时的实际输出：

```
== B. 私有 Registry 一致性（本机存在才执行）==
SKIP B* Registry 一致性  (本机无 .papers-id/registry.json（按设计不入库）)

共 8 项，PASS 8，FAIL 0，SKIP 1
```

**结论：私有 Registry 缺失不会造成 CI 失败。** A 组（产物自身不变量：74 条唯一不透明 ID、无私人路径）永远执行，所以"公开数据完整性"没有被降级成"本机才有"的检查。

---

## 2. Registry 恢复演练证据

### 2.1 受保护备份

| 项 | 值 |
|---|---|
| 位置 | 仓库外的独立目录（不在任何 git 工作区内） |
| 文件 | `registry.json`（17 899 B） |
| SHA256 | `77fd9a1aca45cf2ca7b79df03903d282366f1c89cfb99b90298ccccfe5c1c66d` |
| 保护 | 只读属性置位；未提交、未上传 |
| 审计脚本 | 同目录 `drill.py`（故障注入）、`genericize.py`（报告脱敏），均不入库 |

### 2.2 恢复到隔离副本

```
copy <备份>/registry.json  <克隆>/.papers-id/registry.json
python scripts/scan_papers.py          # 在克隆里执行
```

| 检查 | 结果 |
|---|---|
| 生成后 `js/papers.js` | **无 Diff**（与生成前逐字节相同） |
| 生成后 `registry.json` | **与备份逐字节相同**（SHA256 一致） |
| 与授权工作区产物对比 | **逐字节相同** |
| 74 个 ID 是否保持原值 | 是（`lm-000001…lm-000074`，`nextId=75`，0 条退役、0 次重号） |
| 无数据变化时重复生成 | 无 Diff（幂等） |

补充：因为 Registry 与产物都逐字节一致，"ID 保持原值"是从**字节级**证否的，不依赖抽样。

### 2.3 故障注入（全部在克隆里执行，不触碰真实学习目录）

| 注入 | 退出码 | `js/papers.js` | `registry.json` | 中止原因 |
|---|---|---|---|---|
| Registry 缺失 | 1 | 未改写 | 未改写 | `[ABORT] 找不到 ID Registry…但已有产物包含 74 …` |
| Registry 损坏（非法 JSON） | 1 | 未改写 | 未改写 | `[ABORT] ID Registry 损坏，已中止（js/papers.js 未被改写）：Registry 不是合法 JSON…` |
| ID 冲突（重复 ID） | 1 | 未改写 | 未改写 | `[ABORT] …ID 冲突：lm-000001 被多条记录占用` |
| 迁移目标被占用 | 1 | 未改写 | 未改写 | `[ABORT] 迁移映射无法应用：迁移目标 … 已被 lm-000002 占用` |

四种故障都是"非 0 退出 + 零写入"，没有静默重建路径。

### 2.4 对真实数据的影响

演练全程只读取学习目录（`os.walk` + `os.stat`），**未创建、未改名、未删除任何真实文件**；备份与克隆都在仓库外，未提交。

---

## 3. 公开 CI 与私有本机测试边界

| 检查 | 在哪跑 | 依赖私有 Registry 吗 |
|---|---|---|
| `test21`（42 项） | CI + 本机 | 否 —— 合成 Fixture 自建 Registry |
| `test22` A 组（8 项） | CI + 本机 | 否 —— 只读 `js/papers.js` |
| `test22` B 组（11 项） | **仅本机** | 是 —— 需要 `id ↔ 相对路径` 映射 |
| `papers-deeplink` S/D/N/F/R/H/V/W 组 | CI + 本机 | 否 —— Fixture 注入 |
| `papers-deeplink` G 组（真实数据） | **CI + 本机** | 否 —— `js/papers.js` 已入库，含 74 个 ID |
| 生成器重跑一致性 | 仅本机 | 是 |

设计取舍：**公开 CI 用合成 Fixture 验证 Registry 生命周期；真实目录身份一致性只在授权本机验证。** 既不把私人 Registry 提交到 GitHub，也不因此让 CI 变成"只测一半"。

另外：B 组缺失时打印 `SKIP` 并计入套件输出的 SKIP 计数，不会静默变绿；`run_tests.py` 的汇总里 `test22` 会显示 `8/8` 而不是 `19/19`，一眼能看出本机少跑了什么。

---

## 4. Chromium 与 SW 测试

全部在真实 Chrome（本机 `157.0.8103.38`）/ CI Chromium 中执行，未跳过任何套件。

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `browser` | 37 | SW 安装 / 离线 / 更新 / 容量 |
| `sw-consistency` | 35 | 版本一致性 / 慢网 / 离线 / HTTP 错误 / SW 重启 |
| `sw-upgrade` | 25 | 旧版安装 → 新版部署 / 安装失败回退 / 多标签 / 混部 |
| `mobile-notes` | 224 | B7A 移动端菜单 / 键盘 / 断点 / 深色 / 无溢出 |
| `course-seo` | 45 | 课程 canonical / og:url / 异步竞态 / 静态 SEO |
| `papers-deeplink` | **63** | 身份稳定 6 + 深链 11 + 重名/特殊字符 7 + 降级 9 + 路由竞争 4 + 视口 3 + 历史/搜索 8 + SW 4 + **真实数据 8** |

发布前验收项对应：

| 验收项 | 证据 |
|---|---|
| 74 条 ID 唯一且完整 | `test22` A1-A6b；`G1/G2`（DOM 74/74，键唯一且全为 `lm-`） |
| 32 篇论文不变 | `test22` A1/A2（序列未变）；`G6`（真实论文深链命中并展开） |
| 旧 `lgx` 链接兼容 | `G4`（真实数据，`marked=lm-000036`）；`test22` A6b（74 个旧键一一映射） |
| 新 `lm` 链接稳定 | `G3`（首/中/尾 3/3）、`S1-S5`、`test21` |
| 重排 / 增删 / 字段变更不误定位 | `S2/S3/S4/S5`、`test21` L4-L11 |
| 刷新、前进、后退 | `D7`、`H2-H5` |
| 焦点、滚动、高亮 | `D2/D3/D4/D9`、`V1-V3`（390×844 与 1280×800） |
| SW 版本升级 | `W1-W4`（慢网升级后新代码生效且深链仍命中）、`sw-upgrade` 25 项 |
| Batch 6 / 7A 无回归 | `test16`（DOMPurify）、`test18`+`split-check`（按需加载）、`test19/20`（发布与搜索）、`mobile-notes`、`course-seo` 全部 PASS |

---

## 5. Linux CI Run ID 与结论

| 项 | 值 |
|---|---|
| Workflow | `tests`（`.github/workflows/tests.yml`） |
| Run ID | **`42175894640`** |
| URL | https://github.com/EricZhao666/blog/actions/runs/42175894640 |
| 事件 / 分支 | `push` / `feature/batch7b-production-deeplink` |
| Head SHA | `f3379e3130c597479f3d33a8e6c8f57446ade7d8` |
| 状态 / 结论 | `completed` / **`success`** |
| 环境 | `ubuntu-latest` · `node-22 / python-3.12` |
| 耗时 | 06:40:08Z → 06:45:07Z（4 分 59 秒） |

步骤级结论（全部 `success`）：

```
Set up job 1s | 检出代码 1s | 安装 Node.js 22 2s | 安装 Python 3.12 0s
安装依赖(npm ci) 1s | 安装 Chromium 19s | 运行时版本 0s
运行测试(python scripts/run_tests.py) 266s | 上传测试报告 1s | 收尾 2s
```

`运行测试` 这一步的结论是成功，而 `run_tests.py` 在任一子套件失败、环境阻塞或断言不通过时都会返回非 0，因此这一步通过即代表 **26 套全部通过**（与本机一致）。

未出现的问题：不需要修改任何测试阈值、没有删除断言、没有跳过浏览器套件；本轮 CI 一次通过，没有做"最小修复"迭代。

关于本文件自身：`BATCH7B22_PR_VALIDATION.md` 是纯 Markdown，不进入任何测试路径；按 `.github/workflows/tests.yml` 的 `on: push` 规则，它的提交会再触发一次相同 workflow。

文档提交的实测结果（用于确认上面的推断）：

| run | head | 内容 | 结论 |
|---|---|---|---|
| `42177435651` | `5362e49` | 仅新增本报告 | **success**（与代码提交一致） |

---

## 6. 实际 Git Diff

相对 `origin/main`（`c6ebc12`）：

```
 .gitignore                            |   5 +
 BATCH7B21_MIGRATION_REPORT.md         | 316 +
 BATCH7B2_REPORT.md                    | 389 +
 BATCH7B22_PR_VALIDATION.md            | 本文件
 css/style.css                         |  51 +
 js/app.js                             | 288 +-
 js/papers.js                          |  74 +          ← 仅 "id" 行
 package.json                          |   2 +-
 scripts/papers_id_registry.py         | 431 +          ← 新增
 scripts/run_tests.py                  |   6 +
 scripts/scan_papers.py                | 226 +-
 sw.js                                 |   2 +-          ← CACHE_VERSION
 tests/browser/helpers/server.js       |  16 +-
 tests/browser/papers-deeplink.spec.js | 728 +          ← 新增
 tests/test21_papers_id_registry.py    | 375 +          ← 新增
 tests/test22_registry_consistency.py  | 171 +          ← 新增
```

提交链（本地 = 远端）：

```
5362e49 文档：新增 B7B2.2 克隆、Registry 恢复与 CI 验收报告（CI run 42177435651 success）
f3379e3 文档：报告中改用具名占位符，修正首次迁移的提交范围
dd20bc7 测试：隐私检测改为通用模式，新增 Registry 一级目录动态校验
3c0e0b9 文档：B7B2.1 报告校正 blob 体积/同名统计并补充部署注意
0a8d10f 文档：B7B2.1 报告补记提交哈希与提交链
4ad19b7 数据：74 条学习资料分配持久 ID 并接入真实一致性验收（B7B2.1）
1ab00bc 文档：BATCH7B2 报告补记提交哈希与证据索引
84f55f0 功能：搜索深链持久 ID 与生产级定位（B7B2）
c6ebc12 （origin/main 基线）
```

**未包含**：`.papers-id/registry.json`、`node_modules/`、`tests/reports/`、`tests/browser/artifacts/`、任何隔离目录/备份。已确认这些路径在整个仓库历史（`git log --all --diff-filter=A`）中从未被提交过。

---

## 7. 安全检查

| 检查 | 结果 |
|---|---|
| 新增行含凭证（`ghp_` / `github_pat_` / `AKIA` / `PRIVATE KEY` / `client_secret` / `password=`） | 0（命中项全部是报告里"扫描模式说明"文本） |
| 新增行含盘符路径 / `/Users/` / `/home/` / `zotero` 库路径 | 0（同上，命中项均为扫描说明文本） |
| 新增行含私人资料根目录名 | **0**（本轮把上一轮检测正则里写死的目录名替换为通用模式 + 动态校验，公开代码不再出现该名字） |
| 报告中的本机绝对路径 | 0 —— 统一改为 `<repo>` / `<benchmark 目录>` / `<baseline 副本>` / `<隔离目录>` 占位符 |
| 无关生成文件 | 0 —— Diff 只含设计内的 15 个文件，`data/**`、`posts`、`feed.xml`、`index.html`、`vendor/**` 未动 |
| 数据丢失 | 0 —— `js/papers.js` 仅 74 行新增；74 条资料三元组集合与迁移前完全一致 |
| Registry / 备份入库 | 否（`.gitignore` 排除 + 历史扫描为空） |

### 已知的**既有**风险（不在本轮修复范围）

`origin/main` 上已有若干脚本把学习资料目录的绝对路径写成默认值（`scripts/scan_papers.py` 的 `LEARN_DIR`、`scan_codefiles.py`、`scan_courses.py` 与 `README.md` 中的示例）。仓库是公开的，这些值是历史提交带进来的，与本轮改动无关。

建议后续单独做一次"数据源路径环境变量化"：把默认值改为 `os.environ.get('BLOG_LEARN_DIR', '')`、缺省时要求显式 `--learn-dir`，并同步 README。因为它会改变所有者"零参数运行"的习惯，不适合塞进一个以 CI/PR 验证为主题的分支。

---

## 8. 回退方案

| 场景 | 操作 |
|---|---|
| 撤销远端分支 | `git push origin --delete feature/batch7b-production-deeplink`（随后本地 `git branch -D`） |
| 本地撤销全部提交 | `git reset --soft c6ebc12`（保留工作区）或 `git checkout main` 后删分支 |
| 回退单个提交 | `git revert --no-edit <sha>`（不要 revert `js/papers.js` 的迁移提交而保留 Registry，见下条） |
| 产物与 Registry 必须同进同退 | 回退 `js/papers.js` 时同步恢复 `.papers-id/registry.json`；不一致时 `test22` B3 会报警 |
| SW 已部署后回退 | `CACHE_VERSION` 需要再递增一次，否则已安装的 SW 继续使用旧缓存 |
| 数据层不可逆点 | 只有 `--force-new-registry` 会重号；旧链接届时永久失效（不串项） |

---

## 9. PR 建议

**标题**

```
feat(papers): 搜索深链持久 ID 与生产级定位（Batch 7B-2 / 7B-2.1 / 7B-2.2）
```

**正文（可直接粘贴）**

```markdown
## 概要
把论文/学习资料的搜索结果变成可持久化的深链，并用持久 ID 取代"数组下标 / 内容指纹"。

## 主要改动
- 新 URL 契约：`#/papers?kind=paper|material&target=…`；旧 `#/papers` 行为不变。
- 学习资料身份：新增 `scripts/papers_id_registry.py`（私有 Registry，`.papers-id/` 不入库），
  身份来源是学习目录内的相对路径；改名/移动优先用文件系统身份确认，确认不了必须显式 `--migrations`。
- 深链行为：进入视口 + 键盘焦点 + 高亮 + 论文自动展开 + 目标缺失提示 + 加载失败原地重试
  + 非法 URL 编码不崩 + 快速切换不串页；修复 `scrollTo(0,0)` 与 `scrollIntoView` 的竞态。
- 搜索状态：后退恢复原搜索上下文，主动导航清空（冻结 S01 仍满足）。
- 数据：74 条学习资料已分配 `lm-000001…074`（`js/papers.js` 仅 74 行新增）。

## 测试
- 新增 `test21`（Registry 生命周期 42 项）、`test22`（真实一致性 19 项 / CI 下 8 项）
- `papers-deeplink` 扩到 63 项（含真实数据 8 项、390×844、慢网 SW 升级）
- 本地与清理后克隆：**26/26 套全绿**；Linux CI run `42175894640` success

## 审查注意
- `.papers-id/registry.json` 是私有身份映射，**按设计不在本 PR 中**；克隆后若需重跑生成器，先按
  `BATCH7B21_MIGRATION_REPORT.md` 第 2.2 节恢复。
- 回退 `js/papers.js` 必须同步处理 Registry（`test22` B3 是哨兵）。
- `CACHE_VERSION` 已递增到 `2026-11-06-1`。
```

---

## 10. 是否达到 PR_READY

| 条件 | 状态 |
|---|---|
| 私有 Registry 不造成 CI 失败 | ✅ 干净克隆 26/26（`test22` 自动降级为 8 项 + SKIP） |
| 独立克隆能完整运行公开测试 | ✅ 克隆内 `npm ci` + 26/26，两态（有/无 Registry）均绿 |
| Registry 备份与恢复可操作 | ✅ 备份 SHA256 记录；恢复后产物与 Registry 逐字节一致 |
| 旧深链与新 ID 均可访问 | ✅ `G4` + `test22` A6b |
| Linux CI 全部通过 | ✅ run `42175894640`，`success`，4m59s |
| 无凭证 / 私人路径 / 无关文件 | ✅ 见第 7 节 |
| 不合并 main、不部署 | ✅ 仅推送特性分支 |

未使用 force push；未修改 `main`；未执行任何部署。

```
B7B_PR_READY
```

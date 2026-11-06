# Batch 7B-2：搜索深链持久化与生产级修复

分支：`feature/batch7b-production-deeplink`（从 `origin/main` = `c6ebc12` 新建）
范围：正式博客 `<repo>`。Benchmark `<benchmark 目录>` **只读**，五份参赛结果、`admin/evaluations/**`、`frozen_v3.json`、`acceptance_v3/**` 全程未写入。

结论：**`B7B2_LOCAL_READY`**（身份迁移无歧义，理由见第 3 节）。

---

## 1. 根因及参考方案分析

### 1.1 五模型验收暴露的四类根因

| 根因 | 证据（B7B01） | 正式博客对应缺陷 |
|---|---|---|
| 没有"目标"概念 | 三个模型的 `#/papers` 深链不带任何目标信息 | 搜索结果全部指向 `#/papers`（`data-href="#/papers"`），点进去只是列表页 |
| 用数组下标当身份 | MiMo / Kimi：重排、前插、删除其他条目后错跳，已复现 | 数据结构本身没有问题，但没有身份字段可用 |
| 用内容指纹当身份 | DeepSeek / MiniMax / Hy4：大小、显示名、分类一变即断链 | `scan_papers.py` 只输出 `name/type/size/sizeFormatted/category/subcategory`，**唯一稳定标识（相对路径）被丢弃** |
| 缺少降级与竞态保护 | MiMo 内联 `onclick` 拼接 ID；Hy4 未自动展开、SW 旧版仍在服务 | 路由无 token 保护的定位回调、无目标缺失提示、无重试 |

### 1.2 本轮新发现（五模型未覆盖）

1. **回顶与定位的滚动竞态**：`router()` 末尾的 `window.scrollTo(0, 0)` 受 CSS `scroll-behavior: smooth` 影响会播放约 300 ms 动画；目标定位用 `scrollIntoView({block:'center'})` 落位后，这段"回顶动画"继续播放，把目标甩出视口（实测 `scrollY` 从 976 被拉回 0）。这是"看起来实现了却没进视口"的隐性原因。
2. **搜索状态的两难**：`searchQuery` 是模块级全局，从不清理 → 冻结 S01"回首页清空"失败；但"一律清空"会让浏览器后退拿不回原搜索上下文。二者必须用历史条目状态区分，不能靠 `popstate`/`hashchange` 的触发顺序。
3. **带查询串的路由会丢元数据**：`updateMetaForRoute` 用整段 hash 查 `STATIC_META`，`/papers?kind=..&target=..` 命中不了，标题/描述被重置为站点默认值。

### 1.3 参考与取舍（未复制任何参赛代码）

- **MiniMax**：URL 状态管理、目标焦点、用"固定属性值比较"而不是拼接选择器定位 DOM —— 采纳思路，改为 `data-paper-key` / `data-material-key` 逐值比较。
- **DeepSeek**：原生 `<a href>` 链接、异常降级、把用例接进 Python 统一入口 —— 采纳思路（本轮的用例同时进 `scripts/run_tests.py`）。
- **未采纳**：数组下标（MiMo/Kimi）与内容指纹（DeepSeek/MiniMax/Hy4）作为身份。二者在 5 类元数据变更下都会错跳或断链。
- **未采纳**：任何完整 `app.js` 覆盖。本轮全部改动都在正式博客现有结构上做增量。

---

## 2. 持久 ID 设计和身份来源

### 2.1 公开契约

```
#/papers?kind=paper&target=<论文目标键>
#/papers?kind=material&target=<资料目标键>
```

- `kind`：`paper` | `material`（缺失时按 target 依次匹配论文、资料，不做猜测性回退）。
- 参数用 `URLSearchParams` 编码，值里不会出现裸 `&`、`#`、`?`，可复制、可刷新、可前进后退。
- 旧 `#/papers`（不带参数）行为完全不变。

### 2.2 身份的来源

| 对象 | 身份来源 | 公开形式 | 与元数据的关系 |
|---|---|---|---|
| 论文 | Zotero `items.itemID`（SQLite 主键，`paper-<itemID>`，沿用既有规则） | `paper-12` | 与标题/作者/分类/大小完全解耦；改标题、改分类、改摘要都不影响 |
| 学习资料 | **持久 ID Registry**，键是资料在学习目录内的相对路径（`ANSYS学习素材/第1课/a.pdf`） | `lm-000123`（不透明序号） | 改大小、改分类规则、改显示字段都不影响；改路径（重命名/移动）由第 2.4 节的确定性机制处理 |

设计要点（对应任务书的 12 条要求）：

1. 唯一、不可变：`lm-\d{6}` 单调分配，`nextId` 只增不减。
2. 不依赖数组下标 / 文件大小 / 显示名 / 分类：ID 由 Registry 给出，渲染与解析都不读这些字段做身份判断。
3. 复用既有可靠身份：论文用 Zotero 主键；资料用相对路径（OS 层原始身份）。
4. 原数据无可靠身份 → 建立 Registry（`scripts/papers_id_registry.py`）。
5. 首次发现分配、后续复用；`nextId` 单调。
6. 元数据变化不产生新 ID（大小 / 分类规则 / 显示字段都不参与身份）。
7. 删除后条目标 `retired`，ID 永久保留，绝不回收（退役 ID 也仍在 `entries` 里占位）。
8. 完全同名资料靠相对路径区分 → 不同 ID（用例 L6 覆盖）。
9. 重命名 / 移动：先用文件系统身份（`st_dev:st_ino`，NTFS 文件索引等）确认"确实是同一份文件"且候选唯一；**确认不了就报错要求 `--migrations`，绝不猜**。
10. 备份（写前自动 `<registry>.bak`）、恢复（`--restore-registry`，备份也要过完整校验）、冲突检测（重复 ID / 重复来源 / 别名冲突 / `nextId` 回退 / 迁移目标被占用）。
11. Registry 损坏、丢失但产物已含 ID、扫描到 0 条、新增量超阈值 → **一律中止**（`js/papers.js` 不被改写），不存在"静默重建"路径。
12. 公开产物只写 `id`；`js/papers.js` 不含任何绝对路径、盘符、用户名（用例 L3d 断言）。

### 2.3 Registry 结构

`<repo>/.papers-id/registry.json`（点目录：Jekyll 构建默认不收录，也没有任何页面引用它）

```json
{
  "version": 1,
  "namespace": "learning-materials",
  "nextId": 75,
  "entries": [
    {
      "id": "lm-000001",
      "source": "ANSYS学习素材/第1课/lesson1.pdf",
      "state": "active",
      "firstSeen": "2026-11-06",
      "aliases": [],
      "fileHint": "3:281474976710999"
    }
  ],
  "migrations": [
    { "from": "机械臂/a.pdf", "to": "风扇/a.pdf", "at": "2026-11-06", "auto": "fileId" }
  ]
}
```

- `aliases`：历史路径，旧路径仍能唯一解析回同一个 ID。
- `fileHint`：`st_dev:st_ino`，只用于"改名/移动后仍能确认是同一份文件"，拿不到就留空（不同文件系统不保证提供）。

### 2.4 解析顺序（JavaScipt 侧，`js/app.js`）

1. `LEARNING_MATERIALS[i].id === target` → 命中（正常路径）。
2. `target` 以 `lgx:` 开头 → 兼容旧数据：`lgx:["名称","分类","子分类"]`，三字段全等才命中，**绝不模糊匹配**。
3. 都不命中 → 显示 `role="status"` 提示 + 完整列表，**不标记任何条目**（不串项）。

`lgx:` 只服务"还没有 Registry ID 的历史产物"。当前仓库里的 `js/papers.js` 属于这种状态（见第 3 节）。

---

## 3. 初次迁移策略

### 3.1 现状核实（客观数据）

对仓库现有 `js/papers.js` 实测：

| 指标 | 值 |
|---|---|
| 论文 | 32（id 形如 `paper-4`，来自 Zotero itemID） |
| 学习资料 | 74 |
| 已带 `lm-` ID 的资料 | **0** |
| 资料字段 | `name,type,size,sizeFormatted,category,subcategory`（无 `id`） |
| `(name, category, subcategory)` 三元组重复数 | **0**（74 条各不相同） |

**因此不存在"重新分配旧 ID"的问题**：历史上从未发布过资料 ID，没有需要迁移的旧 ID 映射。三元组也恰好无碰撞，所以迁移完成前的历史链接（`lgx:`）对现有 74 条资料是**一一对应、无歧义的**。

### 3.2 迁移步骤（一次性，由数据所有者在本机执行）

```bash
cd <repo>
python scripts/scan_papers.py            # 读取本机 Zotero 库 + 学习资料目录
git add js/papers.js                     # 只提交公开产物
git commit -m "数据：学习资料分配持久 ID（B7B2 首次迁移）"
```

> 本节原有 `git add .papers-id/registry.json` 一句，已由 Batch 7B-2.1 修正：Registry 是**私有身份映射**（`id → 本机相对路径`），已在 `.gitignore` 中排除，不随产物提交。备份与恢复方式见 `BATCH7B21_MIGRATION_REPORT.md` 第 2.2 节。

- 首次运行按**相对路径的字典序**分配 `lm-000001…`，顺序确定、可复现（同一份资料树在任何机器上得到同一套 ID）。
- 生成器会打印：新分配 / 恢复 / 退役 / 自动迁移 / 显式迁移，并可用 `--report out.json` 留存。
- 迁移后：新链接使用 `lm-xxxxxxxx`；旧的 `lgx:` 链接继续有效（alias 与三元组回退）。
- 若某天需要改名/移动：`--migrations migrations.json`，内容 `[{"from":"旧相对路径","to":"新相对路径"}]`；`from` 找不到或 `to` 被占用 → 直接中止，不猜。

### 3.3 待人工确认的歧义项

**无**（当前数据集 0 碰撞）。唯一需要所有者确认的是：`learn_dir` 下是否还有"内容不应公开"的目录 —— 那是既有 `EXCLUDE_PATTERNS` 与分类白名单的职责，本轮未改动其语义。

### 3.4 为什么第 2.4 节仍要保留 `lgx:`

迁移需要本机 Zotero 库和私人目录（本轮按任务要求未访问）。在所有者执行 3.2 之前，线上产物没有 `lm-` ID；保留 `lgx:` 让深链**立刻可用**（用例 N2/N3 在"无 ID 数据"上验证了完全同名资料仍能命中正确条目），而不是把资料深链留成"未完成"。

---

## 4. 真实修改文件

| 文件 | 类型 | 内容 |
|---|---|---|
| `js/app.js` | 修改（+288/-） | 深链解析/解析器/定位/高亮/焦点/自动展开/缺失提示；`data-*` 身份属性；搜索结果改原生链接 + 事件委托；搜索状态契约（`history.state`）；数据加载失败原地重试；带查询串路由的元数据 |
| `css/style.css` | 修改（+51） | `.deeplink-target`（描边 + outline + 背景，深色主题）；`.deeplink-notice` |
| `scripts/scan_papers.py` | 修改（+223/-） | 学习资料接入 Registry；文件系统身份提示；迁移/恢复/干跑/报告/保护闸；资料排序加入 ID 作为最终键 |
| `scripts/papers_id_registry.py` | **新增** | Registry 数据模型：校验、读写（原子 + 备份）、显式迁移、对账、冲突与损坏检测 |
| `sw.js` | 修改（1 行） | `CACHE_VERSION` `2026-10-30-1` → `2026-11-06-1`（发布新外壳，避免旧缓存继续服务旧 `app.js`） |
| `tests/test21_papers_id_registry.py` | **新增** | Registry 生命周期（42 项） |
| `tests/browser/papers-deeplink.spec.js` | **新增** | 真实 Chromium 深链验收（55 项，含 390×844 / 1280×800 / 慢网 SW 升级） |
| `tests/browser/helpers/server.js` | 修改（+16） | 新增 `state.overrides`（内存替换 `js/papers.js`），默认关闭，不影响既有 5 套浏览器用例 |
| `scripts/run_tests.py` | 修改（+4） | 接入 `test21`、`papers-deeplink`（23 → 25 套） |
| `package.json` | 修改（1 行） | `test:browser` 追加 `papers-deeplink` |

未改动：`js/papers.js`（真实产物，等 3.2 迁移）、`index.html`、`js/data.js`、`vendor/**`、`data/**`、`notes/**`、任何 Benchmark 文件。

---

## 5. 修复前后证据

同一批用例，同一浏览器（Chrome `157.0.8103.38`），修复前后各跑一次。未修复版本用 `git worktree` 检出 `c6ebc12` 的干净副本，通过 `B7B2_SITE_ROOT` 指向副本执行，**不改动工作区、不改动用例**：

```bash
git worktree add --detach <baseline 副本> c6ebc12
set B7B2_SITE_ROOT=<baseline 副本>
set B7B2_EVIDENCE=papers-deeplink-baseline.json
node tests/browser/papers-deeplink.spec.js     # 修复前
node tests/browser/papers-deeplink.spec.js     # 修复后（不设环境变量）
```

| 轮次 | 结果 | 证据文件（本地，`.gitignore` 内） |
|---|---|---|
| 修复前（`c6ebc12`） | **PASS 17 / FAIL 38**（共 55） | `tests/browser/artifacts/papers-deeplink-baseline.json` |
| 修复后（本分支） | **PASS 55 / FAIL 0**（共 55） | `tests/browser/artifacts/papers-deeplink.json` |

修复前的典型失败（原样摘自 JSON `observed`）：

- `S1 资料搜索结果带 kind/target 参数` → `#/papers`（没有任何目标信息）
- `D1 论文深链精确命中` → `{"keyMatched":0,"total":0}`（`#/papers?...` 落到"页面不存在"分支）
- `D3 论文目标获得键盘焦点` → `{"focused":false}`
- `D5 论文自动展开` → `{"expanded":null}`
- `N2 旧数据（无 ID）重名资料命中 right 而不是 left` → `{"legacyKey":"null","right":null}`
- `F1 目标不存在时有提示` → 无任何提示
- `F8 故障恢复后可重试并正确定位` → `{"keyMatched":0,"hasRetry":0}`
- `H1 搜索结果生成的链接符合公开契约` → `#/papers`
- `H5 主动点首页清空搜索词且无旧结果` → `{"value":"深链论文 Beta","results":1}`（冻结 S01 缺陷）
- `W1/W3 SW 场景深链定位` → `{"marked":null}`

修复后同一批断言的实际观测（节选）：

| 断言 | 观测 |
|---|---|
| D1/D6 命中 + hash 未被改写 | `keyMatched=1`，`#/papers?kind=paper&target=paper-beta` |
| D2 进入视口 | `{"top":557,"bottom":722}`（1280×800） |
| D3 键盘焦点 | `document.activeElement` 即目标卡片 |
| D4 高亮 | `outline: solid / 3px` + 背景 |
| D5 自动展开 | `expanded=true`，摘要高度 22px |
| D9/V1/V2 手机 390×844 | 论文 `{"top":340,"bottom":500}`、资料 `scrollY=976`，均可见且聚焦 |
| V3 长列表深处 | `scrollY>0`，真实滚动后可见 |
| S2 重排 + 前插 + 删除其他条目 | `markedKey=lm-000006`（仍是同一对象） |
| S3 改大小 10→999 B + 改子分类 | `keyMatched=1`（ID 不变） |
| S4 删除目标本身 | `marked=0, notices=1`（失效但不串项） |
| F4 非法百分号编码 `%E0%A4%A` | `pageerror=0`，有提示 |
| F8 数据加载失败 → 重试 | `hasRetry=1`，重试后 `keyMatched=1` |
| H3 后退 | 搜索框恢复"深链论文 Beta"，结果 1 条 |
| H5 主动点首页 | `value=""`, `results=0`, `cards=18` |

Registry 侧修复前证据：未修复版本的 `scan_papers.py` 面对同一份 Fixture 输出

```json
{ "name": "a.pdf", "type": "PDF", "size": 1, "sizeFormatted": "1 B",
  "category": "ANSYS仿真", "subcategory": "第1课" }
```

——没有 `id` 字段；`tests/test21_papers_id_registry.py` 在未修复版本上直接 `ModuleNotFoundError: papers_id_registry`（机制不存在）。修复后 **42/42 PASS**。

---

## 6. Registry 生命周期测试（`tests/test21_papers_id_registry.py`，42 项）

全部使用临时 Fixture（合成 Zotero 库 + 合成学习目录），不访问任何私人数据库或私人目录。

| 场景 | 断言 |
|---|---|
| 原始列表 | L1-L3：4 条资料拿到 `lm-000001…04`，按路径字典序分配，`nextId=5` |
| 数据重排 / 重复生成 | L4：两次生成产物**逐字节相同** |
| 新增排序靠前的资料 | L7：新 ID 追加（`lm-000005`），既有 ID 不变 |
| 删除其他资料 | L8-L10：只退役它自己；退役 ID 不出现在产物中 |
| 资料重新出现 | L11：沿用原 ID，不重新起号 |
| 修改文件大小 | L5：ID 不变，`size` 确实变了 |
| 完全同名资料 | L6：同名但分类/子分类不同 → 不同 ID，互不覆盖 |
| 文件重命名 | L12：文件系统身份可确认 → 沿用原 ID，并记入 `migrations(auto=fileId)` |
| 跨目录移动（分类随之改变） | L13：ID 不变，`category` 变为 `CAD建模` |
| 文件副本（同内容、不同身份） | L14：拿到新 ID，**不复用**原 ID |
| 显式迁移 | L15：`--migrations` 后沿用原 ID，记录 `from/to` |
| 迁移目标被占用 | L16：中止，产品文件未被改写，错误信息含"占用" |
| 迁移来源不存在 | L17：中止（拒绝猜测） |
| Registry 损坏 | L18：非法 JSON → 中止，产物未改写 |
| ID 冲突 | L19：重复 ID → 中止 |
| 来源冲突 | L20：两条记录同一路径 → 中止 |
| `nextId` 回退 | L21：会导致 ID 复用 → 中止 |
| Registry 丢失但产物已含 ID | L22：中止并提示"恢复或显式重建" |
| 备份 / 恢复 | L23-L24：写前落 `.bak`；`--restore-registry` 可恢复并继续 |
| 扫描到 0 条 | L25：中止（避免全量退役） |
| 学习目录不存在 | L26：默认中止 |
| 大批新增 | L27：超阈值中止；`--allow-mass-retire` 可显式放行 |
| 产物可消费性 | L28-L29：字段齐全、ID 唯一 |

---

## 7. Chromium 与 SW 测试（`tests/browser/papers-deeplink.spec.js`，55 项）

真实 Chrome（非 jsdom）+ 本地 HTTP Server，`/blog/` 子路径模拟 GitHub Pages；只放行 loopback 请求。

| 分组 | 覆盖 |
|---|---|
| S1-S6 身份稳定 | 搜索结果带 `kind/target`；重排 + 前插 + 删除其他条目；改大小/子分类；删除目标；论文重排 |
| D1-D11 深链基础 | 论文/资料精确命中、视口、焦点、高亮、自动展开、hash 稳定、刷新 |
| N1-N7 重名与特殊字符 | 带 ID 的重名资料命中 `left`；无 ID 数据命中 `right`；中文 + `& # ? % / + ' " 😀`；XSS 载荷未执行 |
| F1-F9 降级 | 目标不存在、非法编码、非法 `kind`、旧路由兼容、数据加载失败 + 原地重试 |
| R1-R4 路由竞争 | 慢网切走 / 回首页 / 两个深链快速切换：旧结果不覆盖当前页，只有最后一个目标被标记 |
| V1-V3 视口 | 390×844 与 1280×800；长列表深处真实滚动 |
| H1-H8 历史与搜索状态 | 复制链接在新会话复现；后退恢复搜索词；前进回深链；点首页清空；慢网旧搜索回调不覆盖 |
| W1-W4 SW | SW 接管后深链仍精确；**慢网 SW 升级**后新代码（`window.__b7b2Build`）生效且深链仍命中 |

SW 相关实现说明：SW 用例允许 Service Worker；升级用例先在旧版本安装并接管，再替换 `js/app.js` 内容（追加可观测标记）、`CACHE_VERSION` 变化、并给 `app.js`/`index.html` 注入延迟，模拟"慢网发布"。断言同时检查"新代码生效"和"深链定位正确"，覆盖 Hy4 在正式验收里被记录的缺口。

Batch 6/7A 的既有保护未被削弱：`sw-consistency`（35 项，含版本一致性与快照）、`sw-upgrade`（25 项）、`mobile-notes`（224 项，移动端菜单/断点/深色）、`course-seo`（45 项，canonical/og:url/静态 HTML）、`test18`（文章数据按需加载）、`test16`（Markdown DOMPurify）、`test13`/`feed-check`（RSS 完整性）全部保持 PASS，且**没有修改任何断言、阈值或跳过**。

---

## 8. 全量回归

```bash
npm ci                 # 40 packages, 0 vulnerabilities
python scripts/run_tests.py
```

| 项 | 结果 |
|---|---|
| 语法检查（JS/PY 全量） | 全部 OK |
| 测试套件 | **PASS 25 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 既有 23 套 | 全部 PASS（未改断言） |
| 新增 2 套 | `test21` 42/42、`papers-deeplink` 55/55 |
| 报告 | `tests/reports/last-run.md`（本地生成） |

关键套件项数：`audit`（全站巡检）、`browser` 37、`sw-consistency` 35、`sw-upgrade` 25、`mobile-notes` 224、`course-seo` 45、`test19` 36、`test20` 21、`test21` 42、`papers-deeplink` 55。

说明：`tests/browser/artifacts/**`、`tests/reports/**` 属于 `.gitignore` 的本地证据，不入库。

---

## 9. 搜索状态契约（新产品语义）

**冻结的 Benchmark V3 契约未做任何修改。** 以下是正式博客的产品语义，独立于 V3 评分规则，并由此轮用例强制执行。

| # | 触发 | 契约 | 实现 | 用例 |
|---|---|---|---|---|
| 1 | 用户在首页输入关键词 | 首页立即显示结果；关键词记入**当前历史条目**（`history.replaceState`，不改 URL） | `applyGlobalSearch` → `rememberEntryState` | S02 等价 |
| 2 | 点击搜索结果进入深链 | 深链带 `kind/target`；目标进入视口、获得焦点、高亮、论文自动展开 | `papersDeepLink` / `locatePapersTarget` | D1-D11 |
| 3 | 浏览器**后退**回到搜索结果页 | **恢复**该条目的关键词与结果（拿到原搜索上下文） | `readEntrySearch(hash)` | H3 |
| 4 | **前进**回到深链 | 重新定位同一目标 | 同上 + `locatePapersTarget` | H4 |
| 5 | **主动**点首页 / 点导航 / 改地址栏 | 新条目没有记录 → **清空**关键词与结果（等价于冻结 S01 的"回首页必须清空"） | `readEntrySearch` 返回 `null` 时清空 | H5、冻结 S01 |
| 6 | 任何情况下 | 旧的异步搜索结果**不得**覆盖当前页面 | `_routeToken` + `isHomeRoute()` + 关键词三重校验 | H7、冻结 H02、S02 |
| 7 | 数据加载失败 | 显示可重试提示；原地重试后仍定位到原目标 | `[data-retry-data]` + `_dataFailures` | F7-F8 |
| 8 | 目标不存在 / 链接失效 | 明确提示 + 完整列表，**不标记**任何条目（不串项） | `role="status"` 提示 | F1-F3、N01 |

与冻结 S01 的关系：冻结用例通过 `location.hash='#/'` 触发一次**新导航**（第 5 条），因此仍然"清空"；产品新增的"后退恢复"只在历史回溯（第 3 条）时生效。两者不冲突，且没有为了让冻结用例通过而牺牲产品语义。

---

## 10. 剩余风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 迁移尚未在本机执行（无 Zotero 库/私人目录权限） | 线上仍用 `lgx:` 三元组键；三元组若将来出现碰撞会歧义 | 当前 74 条 0 碰撞；执行 3.2 后全部改用 `lm-` ID；冲突场景已被 F1-F3 保护（提示而不是错跳） |
| `.papers-id/registry.json` 需要入库才能跨机器复现 ID | 仓库体积与"相对路径"曝光 | 只含相对路径（无盘符/用户名）；点目录，Jekyll 构建不收录，页面也不引用；如需更严格可 `--registry` 指到仓库外并自行保管 |
| `fileHint` 依赖文件系统提供稳定 inode | exFAT/部分网络盘返回 0 → 改名需 `--migrations` | 拿不到就留空并退回"显式迁移"，绝不猜；用例 L12/L13 在 NTFS 上验证自动迁移 |
| 论文身份是 Zotero `itemID`（库内唯一） | 重建/重新同步库会换号，旧 `paper-<id>` 链接失效 | 失效时显示提示不串项；如需跨库稳定，可在 Registry 增补 `zoteroKey` 映射（未在本轮实施） |
| 深链是 hash 路由，无法被搜索引擎单独收录 | SEO 无收益 | 与既有架构一致；课程页的静态 SEO 走 `notes/*.html`，不受影响 |
| `scrollIntoView({behavior:'instant'})` 在极老浏览器不支持 | 可能抛错 | `try/catch` 回退到 `{block:'center'}`；同时已跳过 `scrollTo(0,0)`，回退时也只是回顶动画，不再把目标甩出视口 |
| 事件委托接管 `[data-href]` | 与既有内联 `onclick` 卡片共存 | 只在 `location.hash !== href` 时跳转，避免重复导航；`a[href]`/`button`/`input` 直接放行 |
| SW 新版本 | 首次访问仍可能命中旧缓存 | `CACHE_VERSION` 已递增；`sw-upgrade`/`sw-consistency` 全部通过 |

---

## 11. Git 提交与回退方法

- 基线：`origin/main` = `c6ebc12`（与 B7B01 统一 commit `c6ebc129…` 同源）
- 分支：`feature/batch7b-production-deeplink`（本地）
- 工作区原有未提交修改：无（`git status` 全程干净开始），未执行 `reset --hard` / `clean` / 覆盖

提交记录（本轮）：

```
84f55f0  功能：搜索深链持久 ID 与生产级定位（B7B2）      # 代码 + 两个新用例 + 本报告
        文档：BATCH7B2 报告补记提交哈希与证据索引        # 仅本报告的后续补充
```

未提交（按设计，等待第 3.2 节的首次迁移）：`.papers-id/registry.json` 与 `js/papers.js`。

回退：

```bash
# 只回退本次改动（保留分支）
git revert --no-edit 84f55f0

# 或整体丢弃分支
git checkout main && git branch -D feature/batch7b-production-deeplink

# 若已执行数据迁移，需要一并回退产物与 Registry（两者必须同进同退）
git checkout 84f55f0^ -- js/papers.js .papers-id/registry.json
```

注意：**回退 `js/papers.js` 必须同时回退 `.papers-id/registry.json`**，否则产物里的 ID 与 Registry 不一致（生成器会因此中止，这是设计上的保护）。

清理本轮创建的临时检出：

```bash
git worktree remove <baseline 副本> --force
```

---

## 12. PR 建议

标题：`feat(papers): 搜索深链持久 ID 与生产级定位（Batch 7B-2）`

描述要点：

1. 新增公开 URL 契约 `#/papers?kind=paper|material&target=…`，旧 `#/papers` 不变。
2. 学习资料身份从"下标/指纹"改为**持久 ID Registry**（`scripts/papers_id_registry.py`），支持备份/恢复/冲突检测/显式迁移，损坏即中止。
3. 深链行为：视口、焦点、高亮、论文自动展开、目标缺失提示、数据失败重试、非法编码不崩、快速切换不串页。
4. 搜索状态：后退恢复上下文，主动导航清空（冻结 S01 仍满足）。
5. 测试：新增 `test21`（42 项）与 `papers-deeplink`（55 项，含 390×844 / 1280×800 / 慢网 SW 升级），23 → 25 套全绿。
6. 需要 reviewers 注意：`CACHE_VERSION` 已递增；`.papers-id/registry.json` 需与 `js/papers.js` 同进同退。

建议 review 顺序：`scripts/papers_id_registry.py` → `scripts/scan_papers.py` 的 2b 段 → `js/app.js` 的"论文 / 学习资料深链"段 → `router()` 的 `/papers` 分支与末尾"回顶/定位"取舍 → 两个新用例。

本轮**未** push、未合并、未部署。

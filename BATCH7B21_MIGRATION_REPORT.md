# Batch 7B-2.1：持久 ID 真实迁移与发布前验收

项目：`<repo>`
分支：`feature/batch7b-production-deeplink`
基线：`1ab00bc`（B7B2 实现 + 25/25 回归）
本轮：**只做迁移与验收**，不新增功能，不改 Benchmark 结果。

结论：**`B7B21_LOCAL_READY`**（迁移无歧义；74 条全部保留；26/26 套回归通过）

---

## 1. 迁移前后数据对照

| 指标 | 迁移前（`backup/papers.js.before`） | 迁移后（`js/papers.js`） |
|---|---|---|
| 仓库内 blob 大小 | 40 949 B | 42 651 B（**+1 702 B = 74 × 23 B**，正好是 74 行 `"id"`） |
| 工作区文件大小 | 42 068 B（`core.autocrlf=true` 把 LF 检出成 CRLF） | 42 651 B（本次按 LF 写入，git 归一化后无差异） |
| 工作区 SHA256 | `5e5fd4ff6a288258ff74b3bf9db879f5963adbde92cf48c68ea4570949540fb4` | `582ac21468d85f08a001bc0f95cb61cf7c47fe7ab661305e8d1e544d57a5cae1` |
| 论文 | 32（`paper-<itemID>`） | 32（序列完全未变） |
| 学习资料 | 74 | 74 |
| 资料字段 | `name,type,size,sizeFormatted,category,subcategory` | 同上 + **`id`** |
| 带 `id` 的资料 | 0 | 74 |
| `(名称,分类,子分类)` 三元组 | 74 组，0 重复 | 74 组，0 重复（完全一致） |
| 同名文件 | 63 个不同名称 / 9 组同名（涉及 20 条，单名最多 3 条） | 完全相同（未合并、未覆盖） |
| Git Diff | — | **74 行新增，0 行删除**（只有 `"id"` 那一行，无行尾噪声） |

> 行尾说明：本仓库 `core.autocrlf=true`，旧工作区副本是 CRLF、仓库内的 blob 是 LF。重新生成时按 LF 写入，git 归一化后差异仍然只有 74 行 —— 没有整文件重写，也没有行尾翻转。工作区字节数 "-1 119 +1 702 = +583" 只反映这个本地检出差异，不代表仓库内容缩水。

分类分布（前后一致）：`ANSYS仿真` 54、`机械臂CAD模型` 15、`CAD建模` 5。
子分类分布（前后一致）：`ANSYS仿真` 下 26 个课次（含 `第二十七课(1)`）、`CAD建模/SolidWorks` 5、`机械臂CAD模型/SolidWorks` 15。

迁移前旧深链可解析情况：74 个 `lgx:` 键（`lgx:["名称","分类","子分类"]`）**两两不同**（0 碰撞），因此迁移前每一条旧链接也都唯一对应一条资料。

---

## 2. Registry 设计检查

针对任务书的 6 项逐一核对（结论：全部满足；第 2 项为此调整了"是否入库"的决定）。

### 2.1 Registry 是否含保密绝对路径 / 账户名 / 私人目录结构

| 检查 | 结果 |
|---|---|
| 含盘符（`X:\`、`X:/`） | **0** |
| 含 `/Users/`、`/home/`、`C:\Users` | **0** |
| 含 `zotero.sqlite`、`zotero/storage` | **0** |
| 含私人资料根目录名 | **0** |
| `source` 形式 | 仅"从学习目录起算的相对路径"，分隔符统一为 `/`（74/74 校验通过） |

绝对路径只存在于命令行参数与运行时变量中，不落盘。

### 2.2 私有身份映射不进入公开仓库（本轮调整）

**决定：`.papers-id/` 不入库**，已加入 `.gitignore` 并写明原因。

理由：`id -> 相对路径` 的映射本身就描述了私人资料目录的结构（哪一课有哪些文件），属于"必须保留但不应公开"的身份映射。公开产物 `js/papers.js` 只保留不透明 ID（`lm-000123`），不含任何路径。

保存与备份方式（3 份，任一份可恢复）：

1. **本地备份目录**：与 Zotero 库同级（例如 `<zotero 上级目录>/backup/papers-id/registry.json`），随 Zotero 库一起被现有备份覆盖。
2. **加密归档**：`7z a -p papers-id-YYYYMMDD.7z .papers-id/` 后存入私人网盘（口令不入库、不入本报告）。
3. **审计副本**：每次正式迁移追加 `--report <私有路径>/report-YYYYMMDD.json`（含 id ↔ 相对路径 ↔ 公开字段，同样私有）。

恢复步骤：把备份复制回 `.papers-id/registry.json` → `python tests/test22_registry_consistency.py` 校验 B 组。若只有 `<registry>.bak`，用 `python scripts/scan_papers.py --restore-registry`（备份也要过完整校验，坏备份会被拒绝）。

### 2.3 公开数据只用不透明稳定 ID

`js/papers.js`：74 条资料全部 `lm-\d{6}`，无路径、无 `lgx`、无绝对地址（`test22` A3/A7）。论文沿用 `paper-<itemID>`。

### 2.4 `st_dev:st_ino` 不作为跨机器唯一身份

- 它只作为**同一台机器、同一个卷**上的"改名/移动确认提示"：路径对不上时，用 `fileHint` 找唯一候选，命中才沿用原 ID，并在 `migrations` 记录 `auto: "fileId"`。
- 换机、跨卷、复制、备份还原后**文件索引会变**，`fileHint` 自动失效 → 退化为"必须显式迁移"，不会误判。
- 74/74 条当前都有 hint（仅本机有效）；本报告中不引用任何具体 hint 值。
- Registry 里没有任何逻辑把 hint 当主键：主键是 `source`（路径）+ `aliases`。

### 2.5 复制 / 移动 / 换机的身份迁移流程

| 场景 | 能否自动确认 | 流程 | 结果 |
|---|---|---|---|
| 同卷内改名 | 能（`fileId` 一致且候选唯一） | 无需操作，生成器自动沿用原 ID 并记录 | ID 不变（`test21` L12） |
| 同卷内移动目录（分类随之变） | 能 | 同上 | ID 不变，分类字段更新（L13） |
| 跨卷 / 换机 / 备份还原 | **不能** | 写 `migrations.json`：`[{"from":"旧相对路径","to":"新相对路径"}]` → `--migrations` | ID 不变；`from` 不存在或 `to` 被占用则中止（L15-L17） |
| 复制一份（内容相同） | 不能，且**不应该** | 不写迁移 | 得到**新 ID**（L14）；这是有意的：副本是另一份资料 |
| 改名后没有登记迁移 | 不能 | 生成器拒绝猜测 | 旧 ID 退役、新 ID 分配，并打印 `[WARN] 同一次扫描里既有新增又有退役` |

### 2.6 Registry 丢失或损坏不会静默重新分配

| 状态 | 行为 |
|---|---|
| JSON 损坏 / 结构非法 | 中止，`js/papers.js` 不改写（`test21` L18） |
| 重复 ID / 同一路径两条记录 / 别名冲突 | 中止（L19、L20） |
| `nextId` 回退（会导致复用 ID） | 中止（L21） |
| Registry 丢失但产物已含 ID | 中止，提示"恢复或显式重建"（L22） |
| 扫描到 0 条（网盘未挂载） | 中止（L25） |
| 新增量 > 在用数一半 | 中止（L27） |
| 迁移目标被占用 | 中止（L16） |

唯一能重号的路径是显式 `--force-new-registry`（并在同一份产物上留下"全量退役 + 全量新增"的巨大 diff，肉眼可辨）。

---

## 3. 真实 74 条资料 ID 映射验证

分配规则：按**相对路径字典序**单调分配 `lm-000001 … lm-000074`（与分类字段无关，可复现）。映射样例（字段均为已公开内容，不含任何路径）：

| ID | 分类 | 子分类 | 名称 |
|---|---|---|---|
| `lm-000001` | ANSYS仿真 | 第一课 | 第一课.pdf |
| `lm-000002` | ANSYS仿真 | 第一课 | 带孔矩形板.x_t |
| `lm-000038` | ANSYS仿真 | 第十一课 | 带孔矩形板圣维南原理.x_t |
| `lm-000074` | CAD建模 | SolidWorks | 底座.SLDPRT |

ID 区间检查（按路径字典序分配，因此**按分类看不一定连续**）：

| 分类 | 条数 | ID 区间 | 是否连续 |
|---|---|---|---|
| `ANSYS仿真` | 54 | `lm-000001 … lm-000054` | 连续 |
| `机械臂CAD模型` | 15 | `lm-000059 … lm-000073` | 连续 |
| `CAD建模` | 5 | `lm-000055 … lm-000074` | **不连续**：`抽屉` 4 条（055-058）与 `风扇` 1 条（074）被 `机械臂` 15 条（059-073）按字典序隔开，而这两组同属 `CAD建模` |

区间不连续是**预期行为**：ID 跟随路径顺序，不跟随分类字段，所以分类调整不需要动 ID。

唯一性验证：74 个 ID 两两不同、74 个 `source` 两两不同、74 个三元组两两不同 → `id ↔ 路径 ↔ 公开字段` 三者都是一一映射（`test22` A4/A6/A6b/B3/B5）。

---

## 4. 数据完整性

预演（隔离目录 `<隔离目录>\preview`，未触碰真实 `js/papers.js`）：

```
python scripts/scan_papers.py --out <preview>\papers.js --registry <preview>\registry.json --report <preview>\report.json
```

对照结果（17 项全部 PASS）：

| 断言 | 结果 |
|---|---|
| 条目总数 74 → 74 | PASS |
| 公开三元组集合完全一致（无丢失/无新增/无改写） | PASS（missing=0 extra=0） |
| 论文条数 32 → 32、id 序列一致 | PASS |
| 文件大小字段未被改写 | PASS（0 处变化） |
| 每条资料都有 ID / ID 唯一 / 形如 `lm-NNNNNN` | PASS |
| ID 序号单调且与 `nextId=75` 一致 | PASS |
| Registry 74 条在用、0 条退役 | PASS |
| Registry ID 集合 == 产物 ID 集合 | PASS |
| Registry 无重复来源 / 来源全为相对路径 | PASS |
| 产物与 Registry 均无绝对路径/用户名/私人根目录 | PASS |

预演 == 正式：`papers.js` 与 `registry.json` **逐字节相同**（同一天、同一棵树 → 纯函数）。

幂等：正式迁移后再执行一次 `python scripts/scan_papers.py` → `git diff` 无任何新增变化，两个文件哈希不变。

`--report` 仅写入隔离目录，未产生任何仓库内临时文件。

---

## 5. 浏览器测试

`tests/browser/papers-deeplink.spec.js`：**63/63 PASS**（Chrome `157.0.8103.38`）。在原有 55 项之上新增 8 项"真实数据"验收（不再注入 Fixture，直接跑仓库里的 74 条）：

| 断言 | 观测 |
|---|---|
| G1 真实数据 74 条且页签内键唯一 | `{"data":74,"nodes":74,"unique":74}` |
| G2 键全部是不透明 `lm-` ID | `{"data":true,"dom":true}` |
| G3 首/中/尾三条真实 ID 深链精确命中 | 3/3 |
| G4 迁移前 `lgx:` 旧链接仍指向同一条 | `{"matched":1,"marked":"lm-000036"}` |
| G5 失效 ID（`lm-999999`）不串项 | `{"marked":0,"notices":1,"total":74}` |
| G6 真实论文 ID 深链命中并自动展开 | `{"matched":1,"marked":"paper-74","expanded":true}` |
| G7 真实页面不含私人路径 | 通过 |
| G8 全流程无脚本异常 | 通过 |

任务书点名的复测项对应关系：

| 复测项 | 用例 |
|---|---|
| 资料重排 / 新增排序靠前 / 删除其他资料 | `S2`（浏览器）、`test21` L4/L7/L8-L11 |
| 修改文件大小 | `S3`、`test21` L5 |
| 重命名与显式身份迁移 | `test21` L12-L17（同卷自动 + 跨卷显式 + 冲突中止） |
| 旧深链兼容 | `G4`、`F6`、`N2/N3`、`test22` A6b |
| 数据缺失时不误定位 | `G5`、`F1-F3`、`S4` |
| 刷新与浏览器历史 | `D7`、`H2-H5` |
| 真实 Chromium 滚动及焦点 | `D2/D3/D9`、`V1-V3`（390×844 与 1280×800） |
| SW 版本升级 | `W1-W4`（慢网升级 + 深链仍命中） |

---

## 6. 全量回归

```
npm ci                 # 40 packages, 0 vulnerabilities
python scripts/run_tests.py
```

| 项 | 结果 |
|---|---|
| 测试套件 | **PASS 26 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 既有 23 套 | 全部 PASS，未改断言/阈值，未跳过浏览器套件 |
| 新增 `test21`（Registry 生命周期） | 42/42 |
| 新增 `test22`（真实一致性） | 18/18 |
| `papers-deeplink` | 63/63 |
| 关键项数 | `browser` 37、`sw-consistency` 35、`sw-upgrade` 25、`mobile-notes` 224、`course-seo` 45、`test19` 36、`test20` 21 |
| 报告 | `tests/reports/last-run.md`（本地） |

特别保护项均通过：SW 快照一致性、文章数据按需加载、Markdown DOMPurify、B7A 移动端菜单与 SEO、编辑器发布与 RSS 完整性。

`test22` 的 B 组（Registry 一致性）在"本机没有私有 Registry"时会打印 `SKIP` 而不是失败——公开仓库不带 Registry，但 A 组（产物自身不变量）永远执行，所以产物完整性不依赖"本机有没有 Registry"。

---

## 7. 隐私扫描

对象：`git diff` 全量（4 个已改文件 + 新增文件）。

| 模式 | 命中 | 说明 |
|---|---|---|
| `[A-Za-z]:\`（盘符） | 0 | — |
| `/Users/` | 1 | **唯一命中是新用例 G7 里的检测正则字面量本身**，不是路径 |
| `C:\Users` | 0 | — |
| `zotero.sqlite` / `zotero/storage` | 0 | — |
| 私人资料根目录名 | 1 | 同上，出现在 G7 的检测正则里（B7B2.2 起已改为通用模式 + 动态校验，公开代码不再写死任何私人目录名） |
| `ghp_` / `github_pat_` / `AKIA` / `BEGIN RSA` / `PRIVATE KEY` / `client_secret` | 0 | 无凭证 |

`.papers-id/` 已被 `.gitignore` 排除，`git status` 中不出现；`js/papers.js` 只多出 74 行 `"id"`。

未改动的关键产物：`posts/**`、`data/**`、`feed.xml`、`index.html`、`notes/**`、`vendor/**`（`git diff --numstat` 只有 4 个文件）。

---

## 8. Git 状态

```
 M .gitignore                              +5   （忽略 .papers-id/ 并写明原因）
 M js/papers.js                            +74  -0（只有 "id" 行）
 M scripts/run_tests.py                    +2   （接入 test22）
 M tests/browser/papers-deeplink.spec.js   +93  （真实数据验收组 G1-G8）
?? tests/test22_registry_consistency.py    （新增 18 项）
?? BATCH7B21_MIGRATION_REPORT.md           （本报告）
   被忽略：.papers-id/（私有身份映射，按设计不入库）
```

迁移工作区（隔离，位于仓库外）：`<隔离目录>\`，含
`backup/papers.js.before`、`preview/`（预演产物 + 预演 Registry + 两次 report）、`before.json`、`mapping.preview.json`、`compare.py`、`snapshot.py`、`mapping.py`。**该目录是私有审计副本，不入库、不上传。**

提交：`4ad19b7`（数据：74 条学习资料分配持久 ID 并接入真实一致性验收）。**不 push、不合并、不部署。**

分支提交链：

```
4ad19b7  数据：74 条学习资料分配持久 ID 并接入真实一致性验收（B7B2.1）
1ab00bc  文档：BATCH7B2 报告补记提交哈希与证据索引
84f55f0  功能：搜索深链持久 ID 与生产级定位（B7B2）
c6ebc12  基线（= origin/main）
```

`.papers-id/registry.json` 确认**未被提交**（`git ls-files` 中不存在），仓库里只有它被忽略的记录。

---

## 9. 回退方案

### 9.1 只回退这次迁移（保留 Registry）

```bash
git checkout <本轮提交>^ -- js/papers.js
```

产物回到"无 ID"状态，旧 `lgx:` 链接立刻恢复全部效力（74 个键无碰撞）。
注意：此后 `test22` A3/A5 会失败——这是**预期的告警**，说明产物与 Registry 不再一致，不是测试坏了。

### 9.2 连 Registry 一起回退

```bash
git checkout <本轮提交>^ -- js/papers.js
move .papers-id <备份目录>/papers-id-<日期>      # 或从上文 3 份备份之一恢复旧版本
```

### 9.3 彻底撤销本轮提交

```bash
git revert --no-edit <本轮提交>
```

### 9.4 数据层不可逆点

- 一旦用 `--force-new-registry` 重号，旧链接**永久失效**（不会串项，只会显示"找不到这条资料"）。回退只能靠备份的 `registry.json`。
- 删除资料后其 ID 永久退役（设计如此），不会回收给别的资料。

---

## 10. 是否达到 PR_READY

**是。**

| 条件 | 状态 |
|---|---|
| 74 条资料完整保留，无丢失/无改写 | ✅ 三元组集合完全一致 |
| 所有资料都有唯一持久 ID，无重复 | ✅ 74/74，`lm-000001…074` |
| 未重新生成已有 ID | ✅ 首次迁移，0 条退役、0 次重号 |
| 无错误关联（旧链接不串项） | ✅ 三元组一一映射 + G4/G5 |
| 无私人路径泄露 | ✅ 产物与 Registry 均 0 命中；Registry 不入库 |
| Registry 与公开数据一致 | ✅ `test22` B1-B10 |
| 重复执行不产生额外 Diff | ✅ 二次运行逐字节相同 |
| 全量回归 | ✅ 26/26 |

审查者注意：

1. 本 PR **不包含** `.papers-id/registry.json`（私有身份映射）。克隆后若需要重新生成 `js/papers.js`，必须先按第 2.2 节恢复 Registry，否则生成器会按设计中止（`Registry 丢失但产物已含 ID`）。
2. 回退 `js/papers.js` 时务必同步处理 Registry，两者必须同进同退（`test22` B3 是这条约束的哨兵）。
3. 迁移的证据（预演产物、前后快照、对照脚本）在仓库外的隔离目录，属于私有审计材料。
4. **部署注意**：本分支的 `CACHE_VERSION` 是 `2026-11-06-1`（B7B2 递增，线上仍是 `2026-10-30-1`）。同一次发布里又改了 `js/papers.js`，但因为该版本从未上线，SW 换代必然发生，不需要再次递增。若将来 `js/papers.js` 单独变更而 `CACHE_VERSION` 不变，已安装的 SW 会继续使用缓存里的旧数据（表现为"新 ID 的深链提示找不到，旧 `lgx:` 链接正常"），届时必须再递增一次。

```
B7B21_LOCAL_READY
```

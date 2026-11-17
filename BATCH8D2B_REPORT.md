# Batch 8D-2B：博客图片资源完整性与发布前检查

**结论：`B8D2B_LOCAL_READY`**

- 新增只读检查器 `scripts/check_images.py`（`--check` / `--check --root DIR`），对 `data/posts/*.md` 做图片资源门禁。
- 新增专项测试 `tests/test45_image_assets.py`（74 项，覆盖任务书 20 项要求 + 2 组补充断言）。
- `scripts/run_tests.py` 注册 `test45` 与 `image-check`：用例总数 **55 → 57**。
- 完整回归：**PASS 57 / FAIL 0 / SKIP 0 / BLOCKED 0**。
- 未修改 `import_post.py` 事务逻辑、未改 Lightbox、未改图片命名算法、未引入云端服务。
- 本地已提交；**未 Push、未开 PR、未合并 main、未部署**。

---

## 1. 基线与分支

| 项 | 值 |
| --- | --- |
| 仓库 | `E:\work_funnycode\blog`（`git@github.com:EricZhao666/blog.git`） |
| 新分支 | `feature/batch8d2b-image-assets` |
| 分支起点 | `c220d31`（`feature/batch8d2a-image-lightbox` HEAD，含 B8D2A 两个提交） |
| 本地 `main` | `3424310`（B8D1 已合并） |

> **基线提交核实结果（如实报告）**：任务书写的 `main@88bfb78615e89d78cd342e4935c92d261aafc79c`
> 在本仓库**不存在**（`git cat-file -t` 报 `could not get object info`，本地与 `origin` 都没有该对象，
> 也没有任何分支指向它）。B8D-2A 的两个提交（`e87a8f8` 功能 + `c220d31` 文档）尚未合入 `main`，
> 而任务书把 B8D-2A 列为"当前已完成"，因此本分支从 **8D2A 分支 HEAD（`c220d31`）** 切出，
> 以便在包含 8D2A 的基线上工作。若需改为从 `main` 重建分支，请说明，我会重做一次（不含代码改动）。

---

## 2. 图片路径规则（只核实，不改算法）

`js/app.js`：

| 常量 / 函数 | 值 | 说明 |
| --- | --- | --- |
| `MD_IMAGE_DIR` | `'images'` | 站内图片目录 = **仓库根** `images/` |
| `MD_IMAGE_MAX_BYTES` | `2 * 1024 * 1024` | 单张 ≤ 2 MiB |
| `checkImageFile` | PNG / JPEG / WebP / GIF | MIME 或扩展名任一命中即可 |
| `suggestImagePath` | `images/<slug>-<hash><ext>` | `slug = base.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40)`；`hash = fnv1a(base|size|lastModified).toString(36).slice(0,6)` |

检查器**沿用**这两条规则（`images/` 前缀、2 MiB 上限），但**没有**重新实现 slug/哈希算法——
它只判断"Markdown 里引用的路径在磁盘上是否存在且安全"，因此编辑器以后改文件名算法也不需要同步改检查器。

关键事实：文章正文在 `data/posts/<id>.md`，但渲染发生在 `/blog/index.html` 的 SPA 里，
所以 `images/a.png` 相对的是**站点根 `/blog/`（= 仓库根）**，**不是** `data/posts/`。
检查器按前者解析（这也是浏览器里点开文章时的真实 base URL）。

---

## 3. 检查器设计（`scripts/check_images.py`）

### 3.1 输入与输出

```bash
python scripts/check_images.py --check                # 默认模式；等价于不带参数
python scripts/check_images.py --check --root DIR     # 在临时副本上检查（测试/CI 用）
python scripts/check_images.py --check --base-path /blog/   # 改子路径（默认 /blog/）
```

- 只读 `data/posts/*.md`（`manifest.json` 等非 `.md` 文件不读）。
- 每条问题输出：**文件名:行号 / 原始引用 / 检查结果 / 建议处理方式**；末尾汇总引用分类与 ERROR/WARNING 计数。
- 退出码：`0` 通过（无 ERROR，**没有任何图片引用也算通过**）；`1` 有 ERROR；`2` 仓库结构不可用（`--root` 不存在 / 缺 `data/posts`）。
- **不联网**：https 外链只做格式分类，不发请求，也不声称可访问。

### 3.2 解析方式（不用"只匹配简单括号"的正则）

分三步做**块级 → 行内 → 引用级**扫描，全部为确定性状态机：

1. **块级剔除**：围栏代码块（``` 与 `~~~`，含 info string 与长度匹配的闭合）、四空格/制表符缩进代码块。
   - 缩进代码采用**保守判定**：若上一条正文行是列表项（`- ` / `1. `），缩进内容仍按正文检查——
     宁可多查一次（列表里缩进的图片），也不要把真图片当代码放过。
2. **行内代码剔除**：按 CommonMark 的"反引号游程等长配对"规则把代码片段替换成等长空格（保留换行与偏移，
   因此行号计算仍然精确），支持**跨行**行内代码。
3. **图片提取**：`![` 起点 → 括号匹配（支持嵌套与反斜杠转义）→ 目标解析：
   - `<…>` 包裹的目标（允许空格，不允许换行）
   - 裸目标（括号配平、反斜杠转义）
   - 可选标题（`"…"` / `'…'` / `(…)`）
   - 参考式 `![alt][label]`、折叠式 `![alt][]`、快捷式 `![alt]`（配合全文参考定义表）
   - HTML `<img src="…">`（含单双引号、无引号属性；`alt` 一并取）
   - 转义写法 `\![…](…)` 不算图片

### 3.3 路径解析（顺序固定）

1. 取 URL 的**路径部分**：先按 `?` / `#` 截断，再做 `unquote`（严格 UTF-8，非法编码 → ERROR）。
2. 归一化段：丢弃空段与 `.`；**任何 `..` 一律拒绝**（不尝试"归一化后仍在仓库内"这种宽容处理，
   与编辑器 `validateImageUrl` 的 `..` 黑名单一致）。
3. 分段核对接磁盘：逐段用 `os.scandir` **严格比对名字**（先精确匹配，再退回大小写不敏感匹配）。
   - 精确匹配 → 继续；只有大小写不同 → 记录 case 命中并继续（最后报 ERROR）。
   - 中途不是目录 → 缺失；最后一段不是普通文件 → ERROR。
4. 符号链接/联接：命中后取 `realpath`，必须仍在 `realpath(root)` 内（跨盘符 `commonpath` 抛 `ValueError` 视为逃逸）；
   断链（`islink` 且目标不存在）单独报错。
5. 存在性确认后，再检查体积（>2 MiB → WARNING）与扩展名白名单（svg/bmp/tiff/heic… → WARNING）。

**只读保证**：代码里没有任何 `open(..., 'w')` / `os.remove` / `os.rename` / `makedirs`；
测试用整棵目录的（大小 + mtime + SHA256）快照证明通过/失败两种情形都零写入（I20）。

---

## 4. 支持的 Markdown 图片语法（明确边界）

| 语法 | 支持 | 说明 |
| --- | --- | --- |
| `![alt](images/a.png)` | ✅ | 行内标准写法 |
| `![alt](images/a.png "标题")` | ✅ | 标题被忽略（不参与路径） |
| `![alt](<images/a b.png>)` | ✅ | 尖括号 URL，允许空格 |
| `![alt][label]` + `[label]: images/a.png` | ✅ | 参考式（定义必须在块首，与 CommonMark 一致） |
| `![alt][]` / `![alt]` + 定义 | ✅ | 折叠式 / 快捷式 |
| `<img src="images/a.png" alt="…">` | ✅ | 原始 HTML |
| 围栏代码块 / 缩进代码块中的示例 | ✅（忽略） | 不算真实引用 |
| 行内代码（含跨行）中的示例 | ✅（忽略） | 不算真实引用 |
| 参考式定义缺失 | ⚠️ WARNING | 渲染后是文本，不会 404 |
| `<img>` 缺 `src` | ⚠️ WARNING | 渲染后是空图 |

---

## 5. GitHub Pages 子路径说明

站点：`https://ericzhao666.github.io/blog/`（**项目站，带 `/blog/` 前缀**）。

| Markdown 写法 | 判定 | 解析结果 |
| --- | --- | --- |
| `images/a.png`、`./images/a.png` | ✅ 仓库内相对 | `/blog/images/a.png` → 仓库 `images/a.png` |
| `/blog/images/a.png` | ✅ 站内绝对（子路径内） | 去掉 `/blog/` → 仓库 `images/a.png` |
| `/images/a.png` | ❌ ERROR | 实际指向 `https://ericzhao666.github.io/images/a.png`，**不是**本博客的 `images/` |
| `/blog/`、`/blog` | ❌ ERROR | 指向站点目录而不是文件 |
| `../private/a.png`、`images/../../x.png`、`/blog/../images/a.png` | ❌ ERROR | 含 `..`，跳出站点根目录 |
| `https://…` | ⚠️ WARNING | 外部依赖，只检查格式 |
| `http://…` | ⚠️ WARNING | GitHub Pages 是 https，混合内容会被拦截（线上坏图） |
| `//cdn.example.com/a.png` | ⚠️ WARNING | 协议相对，实际协议随页面 |
| `data:image/png;base64,…` | ⚠️ WARNING | 不落文件、无法校验 |
| `javascript:` / `file:` / `ftp:` / `C:\…` | ❌ ERROR | 非法或不支持的协议 |
| 空地址 `![]()` | ❌ ERROR | 地址为空 |
| `![x](#anchor)` | ❌ ERROR | 不是图片地址 |

---

## 6. 错误分级

### ERROR（退出码 1，CI 必须失败）

| 场景 | 输出要点 |
| --- | --- |
| 引用的本地图片不存在 | `本地图片不存在：images/x.png（路径中 x.png 不存在或不是目录）` |
| 路径逃逸 | `本地图片路径非法：路径含 ..（会跳出站点根目录）` |
| 本地引用指向目录 | `本地引用指向目录：images/sub` |
| 路径解析不安全 | 控制字符 / 反斜杠 / 非法 URL 编码 / 空地址 / 锚点 |
| 文件大小写不匹配 | `文件名大小写不一致（photo.png → 磁盘上实际是 Photo.PNG）… Linux/GitHub Pages 会 404` |
| 无法在博客子路径下解析的站内地址 | `/images/a.png 不在博客子路径 /blog/ 下（会解析到站点根，GitHub Pages 上 404）` |
| 符号链接逃逸 / 断链 | `路径经符号链接指向仓库外部：<realpath>` / `符号链接已断` |
| 非法协议 | `不支持的协议 javascript:（只允许 https:// 或仓库内相对路径）` |

### WARNING（不影响退出码，也不让回归失败）

| 场景 | 输出要点 |
| --- | --- |
| alt 缺失/空白 | `图片没有有效 alt（读屏与图片加载失败时看不到说明）` |
| 超过编辑器建议上限 | `图片体积 2.4 MiB 超过编辑器建议上限 2 MiB` |
| 外部依赖 | `外部图片：只检查格式，不联网校验，也不保证长期可访问` |
| `http://` | `…会被混合内容拦截（线上坏图）` |
| 协议相对 `//…` | 建议写完整 https |
| 格式不适配 | `图片格式 .svg 不在编辑器白名单（PNG/JPEG/WebP/GIF）内` |
| 内联 Data URI | 不落仓库文件、无法校验 |
| 参考式定义缺失 / `<img>` 缺 src | 渲染后不是图片 |

> ERROR 没有任何"降级为 WARNING/SKIP"的开关，也没有 `--allow-missing` 之类的豁免参数；
> CI 中 `image-check` 使用 `pass_marker: 'OK:'` **且**要求退出码 0，缺一即失败。

---

## 7. 与发布流程集成

发布流程（已更新到 README 第 7 节 / 7.1）：

```
① 编辑器导出文章 + 图片引用（写进 Markdown）
② 用户把原图按编辑器建议路径放进仓库 images/
③ python scripts/import_post.py --file <id>.json --apply
④ python scripts/check_images.py --check        ← 本轮新增
⑤ python scripts/build_content.py --check
⑥ python scripts/run_tests.py                   ← 已注册 image-check
⑦ 手动提交（文章 + 图片 + 4 个派生文件）→ 手动 PR
```

- `scripts/import_post.py` 的**事务逻辑一行未改**（没有把图片检查塞进导入过程）。
- `scripts/run_tests.py` 新增两条用例：

  | 名称 | 文件 | 说明 |
  | --- | --- | --- |
  | `test45` | `tests/test45_image_assets.py` | 检查器契约（74 项） |
  | `image-check` | `scripts/check_images.py --check` | 发布前门禁，`pass_marker: OK:` |

- CI：`.github/workflows/tests.yml` 跑 `python scripts/run_tests.py`，因此**图片缺失会让 job 失败**；
  工作流与权限未改动（仍是 `contents: read`，无 Secrets）。
- 仓库当前**没有** `images/` 目录、也没有任何图片引用——检查器按"有效仓库通过"处理，
  不会自动创建 `images/`、不会生成占位图。

---

## 8. 新增测试（`tests/test45_image_assets.py`，74 项）

全部在隔离临时目录 + 合成 Markdown Fixture 上运行，不修改真实文章。

| 编号 | 覆盖点 | 结果 |
| --- | --- | --- |
| I1 | 正常图片路径（零 finding、统计、CLI 退出码） | PASS |
| I2 | 图片不存在 → ERROR + 行号 3 + 原始引用 + 建议 + 退出码 1 | PASS |
| I3 | 空 `images/` 目录 | PASS |
| I4 | 图片目录尚未创建且无引用；检查器不创建目录 | PASS |
| I5 | 中文文件名、`%XX` 编码、尖括号 + 空格、编码路径缺失的报错文本 | PASS |
| I6 | 文件/目录大小写不一致（Windows 正常、Linux 404） | PASS |
| I7 | URL 查询参数与片段 | PASS |
| I8 | `<路径>` + 标题语法（3 种写法） | PASS |
| I9 | 路径逃逸 `../`、`images/../../`、`/blog/../` | PASS |
| I10 | 符号链接指向仓库外、断链（无权限时降级为目录联接） | PASS（未降级） |
| I11 | 围栏代码块（``` 与 `~~~`）中的示例被忽略 | PASS |
| I12 | 行内代码（含跨行）与转义 `\![` 被忽略 | PASS |
| I13 | 外部 HTTPS 只 WARNING、退出码 0 | PASS |
| I14 | `javascript:` / `file:` / `ftp:` / `C:\` 全部 ERROR | PASS |
| I15 | alt 缺失/空白只 WARNING | PASS |
| I16 | 超过 2 MiB 只 WARNING | PASS |
| I17 | 多篇文章引用同一图片 | PASS |
| I18 | 根目录 / `docs/` / `images/` 下的 README 示例不被当成文章图片 | PASS |
| I19 | `/blog/images/a.png` 合法、`/images/a.png` 报错、`/blog/` 报错 | PASS |
| I20 | 通过/失败两种情形的**零写入**（大小+mtime+SHA256 快照）、真实仓库不建 `images/` | PASS |
| I21 | 参考式 + HTML `<img>` 全链路（缺定义只 WARNING） | PASS |
| I22 | 输出字段（文件:行号、原始引用、建议、ERROR/WARNING 汇总）、缺 `data/posts` 返回 2 | PASS |

合计：**共 74 项，PASS 74，FAIL 0（SKIP 0）**。

---

## 9. 完整回归结果

```
python scripts/run_tests.py

PASS 57 / FAIL 0 / SKIP 0 / BLOCKED 0
结论: PASS
```

- 原有 55 套全部通过（含 12 套真实 Chromium：browser / sw-consistency / sw-upgrade / mobile-notes /
  course-seo / papers-deeplink / editor-ux / editor-history / search-ux / search-interaction /
  reading-experience / image-lightbox）。
- 新增 `test45`（74/74）与 `image-check` 均 PASS。
- 语法检查：`js/**`、`scripts/*.py`、`tests/*` 全部 OK（新增两个文件也在其中）。

> **真实数据的事实说明**：`data/posts/*.md` 共 18 篇，当前**没有任何图片引用**（检查器报告"引用 0 个"），
> 因此不存在"已有文章含失效图片引用"的情况，也没有做任何静默豁免。真实仓库上的检查 0.5 s、退出码 0。

---

## 10. 已知限制

1. **不联网**：外部 https 图片只检查格式；不判断对方是否还活着、是否防盗链、是否返回 200。
2. **只看"文件在不在"**：不校验像素尺寸、能否解码、是否为 HTML 伪装的 `.png`；也不算图片总量预算。
3. **不做 Unicode 归一化**：macOS（NFD）与 Linux（NFC）文件名差异不检测（本仓库 CI 为 Linux，日常为 Windows）。
4. **引用块内的围栏代码**（`> ``` `）未做块引用层级识别，按普通正文处理（可能多重报一次，偏保守）。
5. **缩进代码判定是启发式**：上一条正文行是列表项时，4 空格缩进按正文检查（宁可多查，不放过真图片）；
   若真在列表里放缩进代码示例且其中含 `![](…)`，会误报一次。
6. **HTML `<img>` 属性解析**是正则级：属性值里带 `>` 的极端写法会被截断。
7. **不检查未发布来源**：`js/user-posts.js`（兼容期内联文章，当前为空数组）不在 `data/posts/*.md` 检查范围内。
8. **`--base-path` 是常量而非探测**：默认写死 `/blog/`；若将来换自定义域名/根路径部署，需同步改常量或传参。

---

## 11. 操作方法

```bash
# 1) 写入配图：把原图按编辑器给出的路径放进仓库（目录不存在时自己建）
mkdir images
#   例如编辑器提示 images/weld-face-8f3a2c.png → 原图就存成这个名字（大小写一个字符都别改）

# 2) 正文里引用（alt 必填）
#    ![焊接面宏观照片](images/weld-face-8f3a2c.png)

# 3) 图片检查
python scripts/check_images.py --check
python scripts/check_images.py --check --root D:\tmp\blog-copy   # 在副本上检查

# 4) 内容检查 + 完整回归
python scripts/build_content.py --check
python scripts/run_tests.py --only test45 image-check
python scripts/run_tests.py

# 5) 文章与图片一起提交，手动开 PR
git add data/posts/<id>.md images/<file> js/data.js data/search-index.json data/posts/manifest.json feed.xml
git commit -m "post: <标题>（含配图）"
git push -u origin feature/post-<id>
```

常见故障对照：

| 现象 | 处理 |
| --- | --- |
| `本地图片不存在：images/x.png` | 原图没放进来或文件名不对；按提示路径保存后重跑 |
| `文件名大小写不一致（a.png → 实际 A.PNG）` | 改 Markdown 路径或 `git mv` 成一致大小写（Linux CI 才暴露） |
| `/images/a.png 不在博客子路径 /blog/ 下` | 改成 `images/a.png` 或 `/blog/images/a.png` |
| `本地图片路径非法：路径含 ..` | 去掉 `..`，把图片放进仓库 |
| `不支持的协议 javascript:` | 换成 https 或仓库内路径 |

---

## 12. 变更文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `scripts/check_images.py` | 新增 | 只读图片资源检查器（832 行，含规则文档） |
| `tests/test45_image_assets.py` | 新增 | 74 项契约测试（489 行） |
| `scripts/run_tests.py` | 改 | 注册 `test45` + `image-check`（55 → 57 套） |
| `README.md` | 改 | 结构树补 `images/` 与 `check_images.py`；测试清单补 2 行；第 7 节发布步骤加入图片流程；新增 7.1「文章配图：保存、引用与检查」（保存位置/原图流程/检查器/Pages 路径错误表/完整示例/外链提示）；原 7.1 CI 顺延为 7.2（并修正第 11 节引用）；已知限制补 1 条 |
| `BATCH8D2B_REPORT.md` | 新增 | 本报告 |

**未改动**：`scripts/import_post.py`、`scripts/build_content.py`、`scripts/split_posts.py`、
`js/app.js`（含 Lightbox 与图片命名算法）、`js/data.js` 与任何文章正文、`.github/workflows/*`、`tests/` 中的既有断言。

---

## 13. 交付状态

- 本地分支 `feature/batch8d2b-image-assets` 已提交。
- **未 Push、未创建 PR、未合并 `main`、未部署**。

`B8D2B_LOCAL_READY`

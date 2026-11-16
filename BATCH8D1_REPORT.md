# Batch 8D-1：博客文章阅读体验与现有阅读工具优化

## 0. 基线与范围

| 项目 | 值 |
| --- | --- |
| 项目路径 | `E:\work_funnycode\blog` |
| 正式基线 | `main@7bbc5af5ea7ef28717bd274d39935de70bc0f460`（B8C2 合并后的正式站点） |
| 开发分支 | `feature/batch8d1-reading-experience`（基于基线创建，工作区干净） |
| 原有回归基线 | 51 套 |

本轮只改阅读工具与相关 CSS：

- 修改：`js/app.js`、`css/style.css`、`sw.js`（`CACHE_VERSION`）、`scripts/run_tests.py`、`package.json`、`tests/browser/search-interaction.spec.js`（仅版本断言期望值）。
- 新增：`tests/test43_reading_tools.js`、`tests/browser/reading-experience.spec.js`、本报告。
- **未改**：正式文章 Markdown / 元数据、`scripts/import_post.py`、`scripts/build_content.py`、Registry、GitHub Actions、Pages 部署、路由系统、搜索与编辑器数据结构。
- 未引入任何新依赖、云端服务或高亮库。

审查方式：先读 `buildReadingTools()` / `bindScrollSpy()` / `scrollToHeading()` / `enhanceCodeBlocks()` / `copyText()` / `fallbackCopy()` / `renderPostView()` / `renderPostNav()` 与阅读相关 CSS，再用真实 Chromium（Chrome 157）分别打开短文章、20 个标题的长文、12 个代码块的技术文、课程笔记页与 375/390/768/1440 视口，采集基线数据后再改。

---

## 1. 原有阅读工具问题（审查结论）

### 目录 TOC

1. 进入文章后**不会立即计算高亮**，只有滚动事件才设置 `active`。
2. 每次滚动回调都执行 2 次 `findArticleBody()`、1 次 `querySelectorAll('h2, h3')`、每个标题 1 次 `getBoundingClientRect()`，且**没有 rAF 节流**；24 次滚动实测 `ScriptDuration 33ms / RecalcStyleDuration 34ms`。
3. `buildReadingTools()` 用 `h.id = 'heading-' + i` **强制覆盖**正文标题已有的 `id`，会破坏 Markdown 自带锚点。
4. `scrollToHeading()` 用 `scrollIntoView({block:'start'})`，**固定导航栏会遮住目标标题**。
5. `<1280px` 时 `.toc-panel` 直接 `display:none`，**移动端没有任何目录入口**。
6. 目录项是 `<a tabindex="0">`，没有 `aria-current`、没有 `aria-label`，看不到当前章节状态。
7. `.toc-link` 没有换行/截断规则，超长标题会撑破侧栏。
8. 文章切换时 `removeReadingTools()` 会删目录，但 `_scrollSpyBound` 常驻，无目录时 scroll 回调仍反复查询 DOM。

### 阅读进度

1. 进度以 `document.documentElement.scrollHeight - innerHeight` 为分母，**把评论区、页脚、推荐全部算进正文**。实测长文滚到正文底部只有 **33.15%**，页面底部才是 100%，阅读完成状态严重失真。
2. `heads.length < 3` 时 `buildReadingTools()` 直接 `return`，**短文章 / 无标题文章完全没有进度条**。
3. 每次 scroll 都读 `scrollHeight`（强制 reflow）并直接写 `style.width`，没有 rAF 合并。
4. 页面切换只靠 `removeReadingTools()` 删除节点，`_readingLastPct` 等状态未重置。

### 代码块复制

1. `fallbackCopy` 忽略 `document.execCommand('copy')` 的返回值，**失败也调用 `done()`**，属于假报成功。
2. 没有失败反馈：`Clipboard API` 与回退都失败时按钮仍显示「已复制 ✓」。
3. 按钮没有 `aria-label` / `aria-live` / 状态字段，屏幕阅读器感知不到结果。
4. 复制按钮实际触控高度约 24px，低于移动端可点面积。
5. 工具条悬浮在代码块右上角，会遮挡首行右侧内容。

### 阅读界面 / 移动端

1. Markdown 表格没有局部滚动容器：375px 视口实测**整页横向溢出 15px**，表格本身溢出正文。
2. `post-nav` 在窄屏纵向堆叠时，空的上一/下一篇占位仍占据空间。
3. 长论文标题/文件名没有 `overflow-wrap`，窄屏会被撑破。
4. 课程笔记页与文章页共用阅读工具，但没有独立验证。

---

## 2. 目录优化

复用原有 `buildReadingTools()` / `scrollToHeading()` 入口与 `#tocPanel` 结构，内部重写为：

- **一一对应**：从正文 `h2, h3` 生成链接，`data-target` 直接指向标题真实 `id`；`data-toc-index` 保证顺序。
- **保留正文锚点**：`ensureHeadingId()` 优先保留 Markdown 自带 `id`；只有缺失或冲突时才生成 `heading-N` / `dup-1` 后缀，绝不覆盖已有锚点。
- **进入即高亮**：`buildReadingTools()` 末尾 `measureReadingLayout()` + `updateReadingUi(true)`，首屏就点亮当前章节。
- **滚动跟随 + rAF 节流**：`onReadingScroll()` 用 `requestAnimationFrame` 合并，每帧只读一次 `body.getBoundingClientRect()`；上方标题/图片高度变化时，用 `delta` 平移缓存的标题坐标，避免逐标题读取布局。
- **锚点定位**：`scrollToHeading()` 计算 `elTop - (--header-height + 12)` 后 `window.scrollTo`，CSS 同时加 `scroll-margin-top` 兜底；固定导航栏不再遮挡标题。
- **不破坏 SPA 路由**：目录项没有 `href`，点击只滚动，不写 `location.hash`。
- **切换清理**：`removeReadingTools()` 删除 `#tocPanel`、`#tocMobile`、`#readingProgress`，断开 `ResizeObserver`，清空 `_readingState` 与进度缓存；每次文章渲染重建。
- **长标题**：`.toc-link` 使用 `overflow-wrap:anywhere` + `-webkit-line-clamp:2`，超长标题截断两行。
- **少于 3 个标题**：不生成目录，但仍生成进度条。
- **移动端**：新增 `#tocMobile`（原生 `<details>/<summary>`）插在正文前，属于文档流，展开时把正文往下推而不是悬浮遮挡；`summary` 同步 `aria-expanded`，点击目录项后自动收起，`Esc` 关闭。
- **无障碍**：目录项 `tabindex="0"`、`aria-current="true|false"`、`:focus-visible` 描边；`summary` 有 `aria-label` 与展开状态；键盘 `Enter` / `Space` 可触发跳转。
- **减少动态效果**：`prefers-reduced-motion: reduce` 时使用 `behavior:'instant'`（普通 `'auto'` 会继承 `html { scroll-behavior: smooth }`）。

## 3. 阅读进度计算

```
start = 正文顶部文档坐标
end   = max(start, 正文顶部 + 正文高度 - 视口高度)
pct   = (scrollY - start) / (end - start) * 100
```

- 正文顶部为 0%，正文底部与视口底部对齐为 100%。
- **评论区 / 页脚 / 推荐完全不参与**：实测正文底部 99.9%→100%，滚到页面最底部仍 100%。
- 正文一屏内可见（`end <= start`）时返回 100%（已读完）。
- `>= 99.5` 吸附 100、`<= 0.5` 吸附 0，消除亚像素误差；已到页面最大滚动时兜底 100%。
- **进度条与标题数量解耦**：短文章 / 无标题文章也有进度条。
- **动态高度**：`ResizeObserver` 观察正文，图片加载、代码高亮、字体变化后 80ms 防抖重测；滚动中每帧只读一次正文 rect，不做 `scrollHeight` 查询。
- 页面切换重建节点并重置 `_readingLastPct`；`#readingProgress` 仍 `pointer-events:none`，不阻挡点击。

## 4. 代码复制与错误处理

```
Clipboard API 成功 → ok
Clipboard API 失败 / 不存在 → textarea + execCommand('copy')
  execCommand 返回 true → ok
  其它（false / 抛错 / 不存在） → error
```

- 只有真正成功才显示「已复制 ✓」；失败显示「复制失败」，2.6s 后恢复「复制」（成功 1.6s）。
- 按钮 `data-copy-state="idle|ok|error"`、`aria-label="复制代码"`，工具条 `aria-live="polite"`。
- 无语言标记的代码块只显示复制按钮；`dataset.enhanced` + 现有 `.code-toolbar` 双保险，**不会重复创建工具条**。
- 高亮失败仍保留代码原文（原有 `try/catch` 保持）。
- 工具条给首行留出 `padding-top:40px`，不再遮挡代码；移动端 `min-height:34px`。
- 未修改任何 Markdown 原文。

## 5. 移动端阅读体验

- 表格：`enhanceTables()` 幂等包裹 `.table-scroll`（`tabindex="0"`、`role="region"`、`aria-label`），`min-width:max-content` + `white-space:nowrap`，宽表格只在容器内横向滚动。
- 375 / 390 / 768 / 1280 / 1440 实测**全页横向溢出均为 0**（基线 375px 为 15px）。
- 代码块 480px 以下字号 0.8rem、行高 1.65；长代码行在 `pre code` 内滚动。
- `post-nav-empty` 在窄屏隐藏，避免空占位。
- 长标题/文件名 `overflow-wrap:anywhere`；目录长标题两行截断。
- 深浅色沿用现有 CSS 变量；新增复制成功/失败配色分别适配深色与浅色。
- 保持原有博客设计风格，没有新增阴影、动画或依赖。

## 6. 浏览器测试结果

| 文件 | 类型 | 项数 | 结果 |
| --- | --- | --- | --- |
| `tests/test43_reading_tools.js` | jsdom | 40 | **40/40 PASS** |
| `tests/browser/reading-experience.spec.js` | Chromium | 47 | **47/47 PASS** |
| `tests/browser/article-ui.spec.js`（既有，未注册） | Chromium | 16 | **16/16 PASS**（兼容旧阅读断言） |

覆盖：目录生成/顺序/层级/id 安全/重复 id/点击偏移/hash 不变/键盘/立即高亮/滚动跟随/进度纯函数（0%、50%、100%、短正文、评论区、未进入正文）/短文章无目录但有进度条/复制成功/复制失败/Clipboard 降级/工具条幂等/无语言标记/表格包裹幂等/表格可滚动/XSS/移动端 Esc + aria/reduced-motion/文章切换清理/动态高度重算/375–1440 布局/搜索、编辑器、Batch 7B 深链不回归/SW 缓存升级。

## 7. 完整回归结果

```
python scripts/run_tests.py
== 汇总 ==
  PASS 53 / FAIL 0 / SKIP 0 / BLOCKED 0
  结论: PASS
```

- 原有 **51 套**全部通过（含 audit、test6–test42、split/content/feed check、browser、sw-consistency、sw-upgrade、mobile-notes、course-seo、papers-deeplink、editor-ux、editor-history、search-ux、search-interaction）。
- 新增 2 套全部通过，合计 **53 套**。
- Chromium 套件 11 套全部通过；`CACHE_VERSION` 由 `2026-11-16-1` 递增为 `2026-11-16-2`，`browser` / `sw-consistency` / `sw-upgrade` / `search-interaction` / `reading-experience` 共同验证新版本生效与旧缓存清理。
- 未删除任何原有断言；正式文章数据零改动。

## 8. 性能变化（同机同脚本，Chrome 157，长文 20 标题 / 12 代码块 / 2 表格）

| 指标 | 优化前 | 优化后 | 说明 |
| --- | --- | --- | --- |
| 首屏 DCL | 375 ms | 375 ms | 无回归 |
| 阅读工具首次出现 | 未测得（基线 observer 未注册成功） | 750 ms | 从导航起算，含正文按需加载 |
| 24 次滚动 TaskDuration | 146 ms | 106 ms | 单次运行，存在波动 |
| 24 次滚动 ScriptDuration | 33 ms | 10 ms | rAF 合并 + 缓存标题坐标 |
| 24 次滚动 LayoutDuration | 10 ms | 9 ms | 每帧只读一次正文 rect |
| 24 次滚动 RecalcStyleDuration | 34 ms | 19 ms | 高亮只在 active 变化时写 DOM |
| 目录点击响应 | 10 ms | 9 ms | 同样本、同方法 |
| 正文底部阅读进度 | 33.15% | 100% | 改为正文区间计算 |
| 375px 全页横向溢出 | 15 px | 0 px | 表格局部滚动 |
| 宽表格 | 整页溢出 | 978 px 容器内滚动 | `.table-scroll` |
| 移动端目录 | 无入口 | 折叠入口可见 | `<details>` |

> 数据来自同机、同脚本、同一组长文样本的一次对比运行；不声称超出上表的性能提升，也不把波动当作优化成果。首屏 DCL 未变化，说明本轮没有用首屏性能换阅读体验。

## 9. 已知限制

1. 目录高亮以「视口顶部 + 导航栏高度」为阅读探针。滚到页面最底部时，最后几节若仍在视口下半部不会点亮（与主流 TOC 行为一致，避免"没读到就点亮最后一节"）。
2. 短文章（正文一屏内）进度直接显示 100%，按"已读完"语义处理。
3. 移动端目录是文档流内折叠块，展开会把正文下推；不是悬浮抽屉，因此不会遮挡内容，但也不会浮在正文之上。
4. 目录渲染全部标题，未做虚拟化；实测 20 个标题无压力，>100 个标题的超长文章需要另行分页。
5. 图片/代码高度变化依赖 `ResizeObserver`；不支持该 API 的旧浏览器只在 resize、点击目录等时机重算。
6. 复制在既无 Clipboard API、`execCommand` 又不可用的极少数浏览器中只能提示失败，无法完成复制。
7. 标题 `id` 改为"保留原值 + 冲突后缀"；若有外部链接依赖旧的 `heading-N` 固定 id，需要按新 id 调整（本轮仓库内无此类链接）。
8. `tests/browser/article-ui.spec.js` 仍不在统一入口，属既有状态；本轮只验证其 16 项断言不回归。
9. 为了让 `history.replaceState` 在 jsdom 等实现中不误清 `hash`，`rememberEntryState()` 显式传入当前 `location.href`；真实浏览器行为不变。

## 10. 下一阶段建议

1. 用 `IntersectionObserver` 观察标题可见性，替代滚动时的坐标计算，进一步降低主线程开销。
2. 进度条/目录增加"当前章节名"提示，移动端可显示悬浮阅读进度标签。
3. 若希望移动端目录不推动正文，可改为顶部抽屉 + 遮罩，但需同步焦点管理与 Esc 行为。
4. 为图片输出 `width/height` 或 `aspect-ratio`，从构建期减少布局抖动（比运行时重测更彻底）。
5. 代码块可选用纯 CSS 行号，不引入高亮依赖。
6. 把 `article-ui.spec.js` 合并进 `reading-experience.spec.js` 或正式注册，避免阅读断言分散在未注册脚本里。

---

## 11. 交付状态

- 本地 Commit：已创建于 `feature/batch8d1-reading-experience`（见 `git log -1`）。
- **不 Push、不创建 PR、不合并 main、不部署。**
- 结论：`B8D1_LOCAL_READY`

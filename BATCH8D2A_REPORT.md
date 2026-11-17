# Batch 8D-2A：Markdown 图片点击放大与阅读体验

## 0. 基线与范围

| 项目 | 值 |
| --- | --- |
| 项目路径 | `E:\work_funnycode\blog` |
| 正式基线 | `main@34243109146c3fe62a4aef793ca7ef0fe0271ba8`（B8D-1 合并提交） |
| 开发分支 | `feature/batch8d2a-image-lightbox` |
| 原有回归基线 | 53 套 |

本轮只增加文章/课程笔记正文的图片放大能力，未改编辑器、搜索、Python 导入器、发布系统、路由或 Markdown 净化配置。

### 修改文件

| 文件 | 说明 |
| --- | --- |
| `js/app.js` | 新增 `enhanceImages()` / `isSafeImageUrl()` / Lightbox 状态与事件；文章、课程详情渲染接入；`router()` 切换时清理 |
| `css/style.css` | 可放大图片光标/焦点、`<dialog>` 全屏查看器、说明/失败提示、375–1440 响应式、reduced-motion |
| `sw.js` | `CACHE_VERSION` `2026-11-16-2` → `2026-11-16-3` |
| `scripts/run_tests.py` | 注册 `test44`、`image-lightbox` |
| `package.json` | `test:js` / `test:browser` 同步新增测试 |
| `tests/browser/reading-experience.spec.js` | 仅更新版本断言期望值（`> 2026-11-16-2`） |
| `tests/test44_image_lightbox.js` | 新增 jsdom 定点测试（29 项） |
| `tests/browser/image-lightbox.spec.js` | 新增 Chromium 端到端测试（34 项） |
| `BATCH8D2A_REPORT.md` | 本报告 |

正式文章 Markdown 与元数据零改动；未引入任何图片查看库或新依赖。

---

## 1. 图片查看器实现

### 触发与范围

- `enhanceImages(root)` 只扫描 `.article-detail-body` 与 `.course-notes .markdown-body` 内的 `img`。
- 以下图片不处理：
  - 位于 `<a>` 内的图片（保留原链接跳转，不拦截）；
  - 页面图标、头像、装饰图（不在正文容器内）；
  - 编辑器预览 `.editor-preview`（渲染路径也不调用 `enhanceImages`）；
  - URL 不在安全白名单内。
- 通过 `img.dataset.lightboxReady` 幂等标记，重复渲染不会重复绑定；补充 `tabindex="0"`、`role="button"`、`aria-label="放大图片[：alt]"`。

### 查看器

- 懒创建单例 `<dialog id="imageLightbox">`（`document.createElement` + `append`），包含：
  - 关闭按钮（`aria-label="关闭图片预览"`，42px / 手机 46px）；
  - 原图 `<img>`（`max-width:100%`、`max-height:calc(100vh - 120px)`、`object-fit:contain`、`width/height:auto`，保持原比例）；
  - 失败提示（静态文本「图片加载失败，请稍后重试。」）；
  - 说明区（仅 alt 非空时显示）。
- 打开流程：记录 `window.scrollY` → `html.lightbox-open { overflow:hidden }` → `showModal()`（不支持时降级 `open` 属性）→ 焦点移到关闭按钮。
- 关闭流程：`dialog.close()`（降级 `removeAttribute('open')`）→ 移除滚动锁 → `trigger.focus({preventScroll:true})` → 恢复打开时滚动位置（临时关闭全局 smooth，rAF + 80ms 各补一次，覆盖原生 dialog 焦点恢复造成的二次滚动）。
- Esc：`dialog` 的 `cancel` 事件 `preventDefault` 后统一走 `closeImageLightbox()`；同时全局 `keydown` 兜底（非原生 dialog 环境）。
- 点击半透明背景（`e.target === dialog`）也可关闭；点击图片/说明不关闭。
- SPA 路由：`router()` 第一行调用 `closeImageLightbox(true)`，立即关闭且不把焦点恢复到已被移除的旧页面元素。

## 2. 安全措施

1. 继续使用现有 `renderMarkdown()`（marked + DOMPurify + `SANITIZE_CONFIG`），**未放宽净化规则**。
2. 打开前用 `isSafeImageUrl()` 二次校验：只允许 `http:`、`https:`、相对路径与 `data:image/(png|jpe?g|gif|webp|avif|svg+xml)`；`javascript:`、`data:text/html` 等拒绝。
3. Lightbox 的 DOM 全部用 `createElement` / `setAttribute` 构建；图片 URL 只通过 `img.setAttribute('src', ...)` 写入，**从不拼接 innerHTML**。
4. alt 只通过 `caption.textContent` 写入；测试验证 `<img src=x onerror=...>` 形式的 alt 会以文本显示、不创建元素、不执行事件。
5. 只处理 Markdown 已渲染且通过净化的正文 `img`；不处理页面图标/头像；`<a>` 内图片不拦截。
6. 图片 `error` 由 `addEventListener('error')` 处理，只显示静态中文提示，不输出 URL。
7. 路由切换后关闭并保留单例节点（不含用户数据），不会残留 `html.lightbox-open`。
8. 编辑器本地图片预览逻辑完全未改：不调用 `enhanceImages(preview)`，作用域选择器也不匹配 `.editor-preview`。

## 3. 移动端表现

实测（Chrome 157）：

| 视口 | 图片显示尺寸 | 全页横向溢出 | 关闭按钮 |
| --- | --- | --- | --- |
| 375 × 812 | 355 × 237 | 0 | 46 px |
| 390 × 844 | 370 × 247 | 0 | 46 px |
| 768 × 900 | 480 × 320 | 0 | 42 px |
| 1280 × 900 | 480 × 320 | 0 | 42 px |

- 图片始终在视口内且保持 3:2 原比例；关闭按钮 ≥ 40px 触控面积。
- 说明文字 `max-width:760px`、`overflow-wrap:anywhere`；失败提示居中可见。
- `prefers-reduced-motion: reduce` 时查看器无动画/过渡，打开、关闭与滚动恢复均正常。
- 滚动位置恢复以「打开查看器时」的位置为准；点击图片时浏览器聚焦可能造成 1~53px 的滚动微调（见已知限制）。

## 4. 新增测试

| 文件 | 类型 | 项数 | 结果 |
| --- | --- | --- | --- |
| `tests/test44_image_lightbox.js` | jsdom | 29 | **29/29 PASS** |
| `tests/browser/image-lightbox.spec.js` | Chromium | 34 | **34/34 PASS** |

覆盖：普通图片打开/关闭、点击关闭按钮、Esc、Enter 打开、焦点恢复到原图片、背景滚动锁定与恢复、打开时滚动位置恢复、alt 说明、空 alt 不显示说明、图片加载失败提示、链接内图片不拦截且 href 保留、危险协议拒绝、XSS（alt 文本化、无事件执行）、路由切换清理、不影响目录/阅读进度/代码复制、编辑器预览不污染、课程笔记图片可放大、375/390/768/1280 无溢出、reduced-motion、SW 新版本生效与旧缓存清理。

所有测试使用合成 Markdown / base64 SVG Fixture，未修改正式文章。

## 5. 完整回归结果

```
python scripts/run_tests.py
== 汇总 ==
  PASS 55 / FAIL 0 / SKIP 0 / BLOCKED 0
  结论: PASS
```

- 原有 **53 套**全部通过（audit、test6–test43、split/content/feed check、browser、sw-consistency、sw-upgrade、mobile-notes、course-seo、papers-deeplink、editor-ux、editor-history、search-ux、search-interaction、reading-experience）。
- 新增 2 套全部通过，合计 **55 套**；Chromium 12 套全部通过。
- `CACHE_VERSION = 2026-11-16-3`；`browser` / `sw-consistency` / `sw-upgrade` / `search-interaction` / `reading-experience` / `image-lightbox` 共同验证缓存升级与旧缓存清理。
- 未删除任何原有断言；正式文章数据零改动。

## 6. 已知限制

1. 不实现手势缩放、双击放大、图片画廊/左右切换（任务明确不要求）。
2. 点击正文图片时浏览器会在 `mousedown` 聚焦图片并可能微调滚动；关闭后恢复的是「打开查看器时」的位置。已用 `focus({preventScroll:true})` 与延迟恢复尽量贴近，但极端情况下（图片仅部分可见）可能与点击前位置相差数十像素。
3. `<dialog>` 的 `showModal()` 在极旧浏览器不可用时降级为 `open` 属性，此时没有原生焦点陷阱；现代 Chrome/Edge/Safari/Firefox 不受影响。
4. 只处理 `<img>` 标签；`<picture>`、`srcset`、CSS 背景图不处理（`srcset` 仍在净化禁止属性中）。
5. 说明文字只使用 alt；alt 为空时不显示说明区，也不自动生成。
6. `data:image/svg+xml` 在白名单内（作为 `<img>` 加载时脚本不执行）；若未来需要更严格策略，可单独收紧到位图 MIME。
7. 未做图片预加载、缩略图或原图/大图分离；大图首次打开依赖浏览器缓存。

## 7. 下一步建议

1. 可选增加双指/滚轮缩放与拖拽（在现有 `<dialog>` 内实现，不引入库）。
2. 图片较多时增加左右切换与序号提示（仍复用同一 `<dialog>`）。
3. 构建期为文章图片生成 `width/height` 或缩略图，减少首次打开与布局抖动。
4. 如需支持 `<picture>`/`srcset`，先扩展 DOMPurify 允许规则并补安全测试。
5. 可增加「下载原图」按钮（同样只接受安全协议 URL）。

---

## 8. 交付状态

- 本地 Commit：已创建于 `feature/batch8d2a-image-lightbox`（见 `git log -1`）。
- **不 Push、不创建 PR、不合并 main、不部署。**
- 结论：`B8D2A_LOCAL_READY`

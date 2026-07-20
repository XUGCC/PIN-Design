# 七卡瓦拼豆专业工作台

这是一个完全运行在浏览器本地的拼豆图纸工作台。它在原开源项目的基础上补齐了适合电脑精修、手机照图拼豆和 PWA 安装的完整工作流：导入图片、颜色优化、像素编辑、图纸预览、拼豆引导、项目管理和多格式导出。

> 默认入口 `/` 是本仓库复刻的新专业工作台；原项目界面完整保留在 `/legacy`，专注模式保留在 `/focus`。

## 第一版功能

- 导入 JPEG、PNG、WebP、GIF 第一帧、CSV 和 `.perler` 项目文件，也可新建 1–200 格的空白图纸。
- 主色/平均色取样、291 色自定义色板、五种品牌色号、相似色合并、颜色排除与重映射、背景色移除。
- 画笔、橡皮、区域擦除、吸色、同色替换、连续笔画，以及分级上限的撤销/重做。
- 网格、10 格分区线、坐标、格内色号、颜色统计和原图对比预览。
- 拼豆模式支持最近/大块/边缘优先，颜色定位、区域完成、单格完成、进度和精确计时。
- 未完成区低饱和淡化，当前颜色以细而醒目的边界线提示；透明度可调并自动保存偏好。
- 可选的横向、竖向或自动数量提示，只统计当前引导区域中连续且尚未完成的色块。
- PNG（可含色号与统计）、CSV 采购清单和完整项目备份导出；支持系统分享。
- IndexedDB 本地项目画廊：自动保存、缩略图、重命名、复制、导出和确认删除。
- 响应式桌面/手机布局、离线缓存、Android 和 iOS 专用安装引导。

## 本地运行

需要 Node.js 20 或更新版本。

```bash
npm install
npm run dev
```

电脑浏览器打开 `http://localhost:3000`。

### 手机联调

手机和电脑连接同一个 Wi-Fi，然后运行：

```bash
npm run dev:mobile
```

终端会列出局域网地址，在手机浏览器中打开其中的 `http://192.168.x.x:3000` 地址即可实时测试修改。若无法连接，请确认 Windows 防火墙允许 Node.js 访问“专用网络”，并使用终端显示的局域网 IPv4 地址。

局域网 HTTP 适合开发联调；浏览器安装 PWA、Service Worker 和可靠离线能力通常要求正式 HTTPS 地址。

## 安装为独立应用

不要使用浏览器的“创建快捷方式”：它只是网址图标，打开后仍会显示地址栏和标签页。必须选择“安装应用”，PWA 的 `standalone` 模式才会生效。

### Windows / macOS

1. 用 Chrome 或 Edge 打开工作台的 HTTPS 地址。
2. 点击地址栏右侧的安装图标，或从浏览器菜单选择“安装 拼豆工作台”。
3. 安装后从系统应用列表或新生成的应用图标打开。

### Android / 小米 15

1. 优先用 Chrome 打开工作台的 HTTPS 地址。
2. 点页面中的“安装独立应用”，或在右上角 `⋮` 中选择“安装应用”。
3. 确认安装后，桌面会出现“拼豆工作台”图标。
4. 部分手机浏览器的“添加到桌面”只会创建普通网页快捷方式；遇到这种情况请改用 Chrome 的“安装应用”。

### iPhone / iPad

1. 必须用 Safari 打开工作台的 HTTPS 地址。
2. 点底部“分享”按钮（方框向上箭头）。
3. 向下滑并选择“添加到主屏幕”，再点“添加”。

微信等 App 的内置浏览器通常不会显示完整的安装入口。

## 测试与构建

```bash
npm test
npm run test:coverage
npm run build
npm run start
```

用于 Sites 静态托管的构建命令：

```bash
npm run build:sites
```

输出会整理到 `dist/`，其中 `dist/client` 是静态资源，`dist/server/index.js` 是静态资源回退 Worker。

## 数据与隐私

- 图片量化、编辑、统计和导出全部在当前设备的浏览器中完成。
- 项目、缩略图、拼豆进度和可选原图存入本机 IndexedDB；界面偏好存入 localStorage。
- 应用没有业务后端，不上传素材，也不包含用户行为分析代码。
- 清除浏览器站点数据会删除未导出的本地项目。重要项目请定期导出 `.perler` 备份。

## 代码结构

- `src/features/workbench/`：专业工作台的数据模型、算法、存储、导入导出、画布与界面。
- `src/app/page.tsx`：新专业工作台默认入口。
- `src/app/legacy/`：原项目界面保留入口。
- `public/manifest.webmanifest` 与 `next.config.ts`：PWA 安装和缓存策略。
- `scripts/dev-mobile.js`：局域网手机联调启动脚本。
- `scripts/build-sites.cjs` 与 `worker/static-index.js`：Sites 部署包构建。

## 开源来源与修改说明

本仓库源自 [Zippland/perler-beads](https://github.com/Zippland/perler-beads)，保留原作者版权和 AGPL-3.0 许可证。

当前分支基于公开的旧版源码与公开可见的产品交互，独立实现了新的专业工作台、统一项目模型、移动端拼豆引导和 PWA 能力；它没有复制或声称包含线上 `perlerbeads.zippland.com` 未公开的专业工作台源码。若发布本修改版或提供网络服务，请依照 AGPL-3.0 保留版权与许可证，并向使用者提供对应源代码。

## 许可证

[GNU Affero General Public License v3.0](./LICENSE) © [Zippland](https://github.com/Zippland) 及本仓库贡献者。

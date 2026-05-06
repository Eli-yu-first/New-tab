<div align="center">

# 🚀 Tab New (Tab Out)
A hyper-smart, minimalistic, and unified browser New Tab extension.
**极简、智能、聚合：您的下一代浏览器起始页。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[English](#-english) • [简体中文](#-简体中文)

</div>

---

<div align="center">
  <img src="assets/New-tab.png" alt="Tab New Dashboard Preview" width="100%">
</div>

---

## 🇺🇸 English

### 📖 Introduction
Are you tired of cluttered browser tabs, endlessly scrolling through your history, and losing track of important pages? **Tab New** (formerly Tab Out) is a smart, minimalistic New Tab extension designed to solve precisely these problems. It transforms your default new tab page into a highly organized, productivity-driven dashboard, seamlessly integrating your open tabs, browsing history, bookmarks, and read-it-later items into one unified interface.

### ✨ Features Overview

#### 🔍 Search & Navigation
*   **🌐 Multi-Engine Web Search**: Integrated web search bar at the top with support for Google, Microsoft Bing, and Baidu. Switch between search engines with one click.
*   **⚡️ Global Fuzzy Search**: A lightning-fast, debounced search bar that simultaneously scans and filters across your *Open Tabs*, *History*, *Saved for Later*, and *Bookmarks*. Real-time results as you type.

#### 📋 Dashboard Columns
*   **🖥️ Open Tabs**: All currently open tabs grouped by domain. See duplicates marked, close individual tabs or entire domains with satisfying animations.
*   **🕰️ History**: Your browsing history intelligently grouped by *Today*, *This Week*, *This Month*, *This Year*, and *Older*. Toggle between newest/oldest sorting.
*   **📑 Saved for Later**: Tabs you've saved to read later. Mark them as done or remove them when finished.
*   **⭐ Bookmarks**: Your personal bookmark collection. Add new bookmarks, reorder them manually, and delete with ease. All changes persist across sessions.

#### 💾 Data Management
*   **☁️ Cloud Sync & Persistence**: Your *Bookmarks* and *Saved for Later* tabs are securely stored and synced across all your desktop devices via Google Chrome's native `chrome.storage.sync`.
*   **📤 Import/Export**: Take full control of your data. Export your bookmarks and saved tabs to a JSON file for backup, or import from a previous export. Smart deduplication ensures no duplicates.

### 🛠️ Installation
Since the extension is currently in beta and not yet on the Chrome Web Store:
1. Download or clone this repository.
2. Open your Chrome/Edge browser and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the `extension` folder from this repository.
5. Open a New Tab and enjoy!

### 🍎 Safari Installation (macOS)
Since Safari uses a different extension packaging model, you need to compile it natively using Xcode:
1. Ensure **Xcode** is installed on your Mac.
2. Open Terminal and run: `xcrun safari-web-extension-converter /path/to/New-tab/extension`
3. Xcode will open automatically. Click the **Run (▶)** button to build the native macOS app shell.
4. Launch the built app. It will register the extension with Safari.
5. Open Safari, go to `Settings -> Advanced` and check **"Show Develop menu in menu bar"**.
6. From the new Develop menu in the menu bar, check **"Allow Unsigned Extensions"**.
7. Go to `Safari Settings -> Extensions` and check the box to enable **Tab New**.

---

## 🇨🇳 简体中文

### 📖 项目介绍
当浏览器打开了数十个标签页时，您是否感到眼花缭乱？是否经常在庞杂的历史记录中找不到昨天看过的网页？
**Tab New**（原名 Tab Out）正是为了解决这些痛点而生的一款现代化浏览器起始页扩展。它旨在将您凌乱的标签页、分散的历史记录和收藏夹，转化为一个井然有序、极具极简美感的个人控制台。它可以完美接管浏览器的「新标签页」，在一页之内为您提供极速检索和智能聚合服务。

### ✨ 功能介绍

#### 🔍 搜索与导航
*   **🌐 多引擎网页搜索**：顶部集成网页搜索栏，支持 Google、Microsoft Bing 和百度三大搜索引擎，一键切换。
*   **⚡️ 全局模糊搜索**：毫秒级响应的搜索框，实时扫描并过滤您的「打开标签页」、「历史记录」、「稍后阅读」和「书签」。输入即搜索，结果即时呈现。

#### 📋 控制台列
*   **🖥️ Open Tabs（打开标签页）**：所有当前打开的标签页按域名分组显示。重复标签会被标记，支持关闭单个标签或整个域名组，并配有流畅的动画效果。
*   **🕰️ History（历史记录）**：浏览历史智能分组为「今天」、「本周」、「本月」、「今年」和「更早」。支持最新/最早排序切换。
*   **📑 Saved for Later（稍后阅读）**：保存待读的标签页。完成后可标记为已读或移除。
*   **⭐ Bookmarks（书签）**：个人书签收藏。支持添加新书签、手动排序和删除。所有更改持久保存。

#### 💾 数据管理
*   **☁️ 多端云漫游同步**：基于原生账号体系的云端存储机制。您的「书签」与「稍后阅读」状态将在您的所有办公设备之间无缝漫游，实现跨设备的实时同步。
*   **📤 导入/导出**：完全掌控您的数据。将书签和保存的标签页导出为 JSON 文件备份，或从之前的导出文件导入。智能去重确保无重复数据。

### 🛠️ 安装指南
由于扩展目前处于内测阶段，暂未上架扩展商店，您可以通过开发者模式一键安装：
1. 下载或 Clone 本仓库代码到您的本地电脑。
2. 打开 Chrome 或 Edge 浏览器，在地址栏输入并进入 `chrome://extensions/`。
3. 开启页面右上角的 **开发者模式 (Developer mode)**。
4. 点击左上角的 **加载已解压的扩展程序 (Load unpacked)**，并选择本项目中的 `extension` 文件夹。
5. 打开一个新的标签页，开启您的全新体验！

### 🍎 Safari 浏览器安装指南 (仅限 macOS)
由于 Safari 采用了原生应用包装模型，您需要进行本地编译：
1. 确保您的 Mac 已安装 **Xcode**。
2. 打开终端 (Terminal) 并运行命令：`xcrun safari-web-extension-converter /路径/到您的/New-tab/extension`
3. 转换完成后会自动打开 Xcode。点击左上角的 **运行 (▶)** 按钮编译原生 macOS 外壳应用。
4. 运行编译出的应用，它会自动将扩展注册到 Safari 浏览器中。
5. 打开 Safari，进入 `设置 (Settings) -> 高级 (Advanced)`，勾选底部的 **“在菜单栏中显示开发菜单”**。
6. 在上方菜单栏找到新增的“开发 (Develop)”菜单，勾选 **“允许未签名的扩展”**。
7. 最后进入 Safari 的 `设置 -> 扩展`，在左侧列表中勾选启用 **Tab New** 即可开启全新体验。

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://x.com/zarazhangrui">Eli</a></sub>
</div>

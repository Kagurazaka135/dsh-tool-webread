# dsh-tool-webread

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）加一个**无头上网阅读**能力：把网页正文取回来，不弹界面、不留页签。

不打包浏览器内核，也不要求装任何额外依赖——用的是手机上本来就有的系统 WebView。

---

## 为什么长这样

拆 [Via 浏览器 6.7.1](https://viayoo.com/) 得到的答案很朴素：**Android 上想跑网页，就别自带内核**。

Via 2.6 MB 的 APK 里没有 `lib/`、没有 `.so`、没有 X5/Gecko，全靠系统 `android.webkit.WebView`。它跨机型的办法不是"适配每一种内核"，而是：

1. **先探测**内核是谁、几版（公开 API → 反射 → 放弃，三层降级）；
2. **探不到就别硬跑**，弹修复页让用户去装 Android System WebView；
3. **版本号当能力开关**，决定用哪套实现；
4. 每条 WebView 调用按 `SDK_INT` 分层，全部包 `try/catch`。

这个插件把第 1、2、3 条搬到了插件层——不碰原生代码，只调用 App 已有的 `/browser` 桥：

```
E1  native   系统 WebView（真渲染 JS，能拿到动态内容）
E2  http     Node 自己抓原始 HTML 再去标签（不执行 JS）
E3  都没有   明确报错，告诉你断在哪一环
```

每档失败都记录原因，不会静默返回空内容。

---

## 两个工具

| 工具 | 作用 |
|---|---|
| `web_probe` | 探测当前可用引擎与 WebView 内核版本；不抓页面。第一次上网前调一次。 |
| `web_read` | 读取网页正文。`prefer` 可选 `auto`（默认，native 优先、失败降级）/ `native` / `http`。 |

`web_read` 的参数：

| 参数 | 说明 |
|---|---|
| `url` | 必填，只允许 http/https |
| `maxChars` | 正文上限，默认 8000，封顶 50000 |
| `prefer` | `auto` / `native` / `http` |

返回里固定带 `engine`（这一档走的是哪条路）和 `kernel`（当前内核版本），失败时带 `attempts`（每档各断在哪）。

---

## 安装

把仓库放到手机上，然后在仓库目录里跑：

```bash
node install.mjs
```

它会自动找到 dshroot 并完成三件事（全部幂等，重复跑不会重复插入）：

1. 把插件拷进 `<dshroot>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
2. 在 dsh 的 `package.json` 依赖里登记
3. 在 `$HOME/.dsh/cordis.patch.yml` 的 `insert` 列表里注册

找不到 dshroot 时会列出试过的路径，也可以手动指定：

```bash
node install.mjs --dshroot /data/data/com.deepseek.harness/files/dshroot
```

**装完要重启引擎**（App 里停止 → 启动，或重开 App）才会加载。

---

## 自检

```bash
node test/selftest.mjs
```

必须在**已安装的位置**里跑（否则 `@deepseek-ai/dsh-tools` 解析不到）：

```bash
cd <dshroot>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-webread
node test/selftest.mjs
```

输出形如：

```
=== dsh-tool-webread selftest ===
-- 插件契约 --
[PASS] name 导出正确
...
-- 实况：当前环境 --
[PASS] web_probe 返回结构完整
       引擎=native native=true http=true 内核=Chromium 131
[PASS] 原生 WebView 通道可用  — 内核 Chromium 131
-- 实况：读取 example.com --
[PASS] 取到 example.com 的正文
       引擎=native title="Example Domain" chars=127
=== 汇总：PASS 31 / FAIL 0 / SKIP 0 ===
全部通过。
```

三种行：`[PASS]` 通过、`[FAIL]` 失败（退出码 1）、`[SKIP]` 这台机器上条件不具备（例如没联网），**不算失败**。

自检覆盖：插件契约、地址闸门（9 种非法地址）、HTML 抽取、gzip/brotli 解压、内核版本号解析，以及真的去读一次 example.com。

---

## 安全边界

只允许 **http/https**，并且**拒绝本机与内网地址**：`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`::1`、`localhost`、`0.0.0.0/8`。

理由：原生 `BrowserHost.policyReason` 就靠这条挡住"AI 去打 App 自己的本地服务"（`:3080` / `:3081` / node 引擎端口）。插件降级到原始 HTTP 时如果不管，等于给这条防线开了个后门——所以闸门在插件侧重写了一遍，两档引擎都过同一道。

---

## 局限

- **不执行 JS 的那一档拿不到动态内容**。SPA、需要登录、靠 JS 渲染正文的站点，必须走 native；native 挂了就只剩骨架。
- **单次一页**，没有批量抓取、没有站点地图。
- **native 档会真的开一个 WebView 页签**（借用 App 的浏览器宿主），读完立刻关掉；如果读的过程中 App 被杀，页签可能残留。
- **内核探测只能看到 UA 里的 Chrome 版本**。原生 `caps` 没暴露内核包名，所以 `kernel.packageName` 恒为空；UA 被 ROM 改成没有 `Chrome/` 标记时只能报 `unknown` 而不是猜。
- 低于 Chromium 60 会标 `degraded` 并提示更新 WebView，**但不拦着用**——老内核可能渲染出错，也可能只是慢。

---

## 仓库结构

```
lib/index.js        插件本体（两个工具 + 引擎阶梯 + 地址闸门）
test/selftest.mjs   自检脚本
install.mjs         装进本机 dsh（幂等）
package.json        npm 包描述（peerDependencies: dsh-tools / cordis）
```

---

## 许可

MIT

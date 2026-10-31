/**
 * 一条命令装进本机的 dsh。
 *
 *   node install.mjs                 # 自动找 dshroot
 *   node install.mjs --dshroot <路径> # 手动指定
 *
 * 做三件事，全部幂等（重复跑不会重复插入）：
 *   1. 把插件拷进 <dshroot>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
 *   2. 在 dsh 的 package.json 依赖里登记
 *   3. 在 cordis.patch.yml 的 insert 列表里注册
 *
 * 不做：重启引擎（装完要重启才会加载）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const PKG = "dsh-tool-webread";
const SCOPED = "@deepseek-ai/" + PKG;
const REL_BINJS = "lib/node_modules/@deepseek-ai/dsh/lib/bin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argDshroot = (() => {
  const i = args.indexOf("--dshroot");
  return i >= 0 ? args[i + 1] : "";
})();

function candidates() {
  const out = [];
  if (argDshroot) out.push(argDshroot);
  if (process.env.DSHROOT) out.push(process.env.DSHROOT);
  // 安卓：内部私有目录 / 外部共享目录（Lite / Compat 变体各自一份）
  for (const pkg of ["com.deepseek.harness", "com.deepseek.harness.beta", "com.deepseek.harness.compat"]) {
    out.push(`/data/data/${pkg}/files/dshroot`);
  }
  for (const root of ["DeepSeekHarness", "DeepSeekHarnessLite", "DeepSeekHarnessCompat"]) {
    out.push(`/sdcard/${root}/dshroot`);
  }
  // PC / 本仓开发环境
  out.push(path.join(here, "..", "dsh-android", "devhome", "payload", "dshroot"));
  return out;
}

function findDshroot() {
  for (const c of candidates()) {
    try {
      if (c && fs.existsSync(path.join(c, REL_BINJS))) return path.resolve(c);
    } catch { /* 没权限/不存在，继续找 */ }
  }
  return null;
}

const dshroot = findDshroot();
if (!dshroot) {
  console.error("找不到 dshroot（dsh 的安装根目录）。");
  console.error("试过：");
  for (const c of candidates()) console.error("  " + c);
  console.error("");
  console.error("请手动指定：node install.mjs --dshroot <dshroot 所在目录>");
  process.exit(2);
}
console.log("dshroot = " + dshroot);

// ── 1. 拷贝文件 ────────────────────────────────────────────────────────────
const target = path.join(dshroot, "lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai", PKG);
fs.mkdirSync(target, { recursive: true });
for (const rel of ["lib", "test", "package.json", "README.md", "LICENSE"]) {
  const src = path.join(here, rel);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(target, rel), { recursive: true, force: true });
}
console.log("已拷贝 -> " + target);

// ── 2. 登记依赖 ────────────────────────────────────────────────────────────
const dshPkgPath = path.join(dshroot, "lib/node_modules/@deepseek-ai/dsh/package.json");
const dshPkg = JSON.parse(fs.readFileSync(dshPkgPath, "utf8"));
dshPkg.dependencies = dshPkg.dependencies || {};
if (dshPkg.dependencies[SCOPED]) {
  console.log("依赖已存在，跳过");
} else {
  dshPkg.dependencies[SCOPED] = "0.1.0";
  fs.writeFileSync(dshPkgPath, JSON.stringify(dshPkg, null, 2) + "\n");
  console.log("已登记依赖 " + SCOPED);
}

// ── 3. 注册到 cordis.patch.yml ─────────────────────────────────────────────
// dsh 启动时读 $HOME/.dsh/cordis.patch.yml（HOME = App 的 files 目录）。
const cordisCandidates = [
  path.join(dshroot, "..", ".dsh", "cordis.patch.yml"),      // 安卓：dshroot 与 .dsh 同级
  path.join(process.env.HOME || os.homedir(), ".dsh", "cordis.patch.yml") // 兜底
].map((p) => path.resolve(p));
const cordisPath = cordisCandidates.find((p) => fs.existsSync(p)) || cordisCandidates[0];
const home = path.dirname(path.dirname(cordisPath));

if (!fs.existsSync(cordisPath)) {
  console.warn("没找到 " + cordisPath + " —— 跳过注册。");
  console.warn("请手动把下面两行加进 insert 列表：");
  console.warn("    - id: tool-webread");
  console.warn("      name: '" + SCOPED + "'");
} else {
  const lines = fs.readFileSync(cordisPath, "utf8").split(/\r?\n/);
  if (lines.some((l) => l.includes(SCOPED))) {
    console.log("cordis 已注册，跳过");
  } else {
    const anchor = lines.findIndex((l) => l.trim() === "name: '@deepseek-ai/dsh-tool-browser'");
    const block = [
      "    # 无头上网阅读：探测系统 WebView 内核，按 native → 原始 HTTP 阶梯取正文",
      "    - id: tool-webread",
      "      name: '" + SCOPED + "'"
    ];
    let at = anchor >= 0 ? anchor + 1 : lines.findIndex((l) => l.trim() === "- insert:");
    if (at < 0) {
      console.warn("cordis.patch.yml 里找不到 insert 列表 —— 跳过注册，请手动添加。");
    } else {
      if (anchor < 0) at += 1; // 插在 "- insert:" 下一行
      lines.splice(at, 0, ...block);
      fs.writeFileSync(cordisPath, lines.join("\n"));
      console.log("已注册到 " + cordisPath);
    }
  }
}

console.log("");
console.log("装好了。下一步：");
console.log("  1. 重启 dsh 引擎（App 里停止 → 启动，或重开 App）");
console.log("  2. 自检：node " + path.join(target, "test/selftest.mjs"));

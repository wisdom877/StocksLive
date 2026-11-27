#!/usr/bin/env node
/* 删除「全项目里再没有任何一处引用」的顶层函数 / 顶层 const|let。

   用法：在 web/ 目录下   node ../tools/strip_dead.js [--apply] static/app-*.js
         默认只列出，--apply 才落盘。

   判定：名字在「去掉注释后的 全部 js + index.html」里只出现 1 次（即定义处）才算死。
         $ 前缀的成员访问（$("#x")、$.x）不算引用。
   范围：只动顶层（Program.body）声明；声明上方紧贴的整段注释一起带走。
         被删函数独占的下游函数要再跑一轮才会暴露出来，所以按轮跑到「可删除 0 处」为止。
   安全：落盘后逐个文件 node --check；有语法错误就把该文件原样写回并退出。 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const acorn = require("acorn");

const apply = process.argv.includes("--apply");
const files = process.argv.slice(2).filter((f) => !f.startsWith("--"));

const ROOT = path.resolve(path.dirname(files[0]));          // static/
const indexPath = path.join(ROOT, "index.html");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
   .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
const html = fs.existsSync(indexPath) ? stripComments(fs.readFileSync(indexPath, "utf8")) : "";
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const haystack = files.map((f) => stripComments(src[f])).join("\n") + "\n" + html;
const refs = (name) =>
  (haystack.match(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g")) || []).length;

/** 从声明所在行往上，把紧贴着的整段注释的起始位置找出来；遇到空行 / 代码就停 */
function commentStart(text, declStart) {
  const lineStart = (pos) => text.lastIndexOf("\n", pos - 1) + 1;
  let s = lineStart(declStart);
  let inBlock = false;
  while (s > 0) {
    const prevEnd = s - 1;                      // 上一行结尾（换行符）
    const ps = lineStart(prevEnd);
    const line = text.slice(ps, prevEnd).trim();
    if (!line) break;
    if (line.startsWith("/*") && line.endsWith("*/")) { s = ps; break; }   // 单行块注释
    if (inBlock) {
      if (line.startsWith("/*")) inBlock = false;
    } else if (line.startsWith("//")) {
      // 普通行注释
    } else if (line.endsWith("*/")) {
      inBlock = true;                           // 多行块注释的结尾行
    } else {
      break;
    }
    s = ps;
  }
  return s;
}

let total = 0, totalLines = 0;
for (const f of files) {
  const text = src[f];
  const ast = acorn.parse(text, { ecmaVersion: "latest", sourceType: "script", locations: true });
  const cuts = [];
  for (const node of ast.body) {
    let name = null;
    if (node.type === "FunctionDeclaration" && node.id) name = node.id.name;
    else if (node.type === "VariableDeclaration" && node.declarations.length === 1
             && node.declarations[0].id.type === "Identifier") name = node.declarations[0].id.name;
    if (!name || refs(name) !== 1) continue;
    cuts.push({ name, start: commentStart(text, node.start), end: node.end, line: node.loc.start.line });
  }
  if (!cuts.length) continue;
  let out = text, n = 0, lines = 0;
  for (const c of cuts.sort((a, b) => b.start - a.start)) {
    let end = c.end;
    if (out[end] === ";") end++;
    if (out[end] === "\n") end++;
    const len = out.slice(c.start, end).split("\n").length;
    lines += len; n++;
    console.log(`  ${path.basename(f)}:${c.line}  ${c.name}  (${len} 行)`);
    out = out.slice(0, c.start) + out.slice(end);
  }
  if (apply) {
    fs.writeFileSync(f, out);
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    } catch (e) {
      fs.writeFileSync(f, text);
      console.error(`✗ ${f} 删完语法不过，已原样写回：${String(e.stderr).split("\n").slice(0, 3).join(" | ")}`);
      process.exit(1);
    }
  }
  total += n; totalLines += lines;
}
console.log(`${apply ? "已删除" : "可删除"} ${total} 处，共 ${totalLines} 行`);

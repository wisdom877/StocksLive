#!/usr/bin/env node
/* 重名函数刹车：扫描顶层 function/async function 声明，出现重名直接非零退出。
   用法：node tools/check_dupes.js <js 文件> [...]
   部署脚本会在上传前调用它，有重名就拒绝部署。 */
const fs = require("fs");
const acorn = require("acorn");

function topLevelFunctions(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true });
  const hits = [];
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id && node.id.name) {
      hits.push({ name: node.id.name, line: node.loc.start.line });
    }
  }
  return hits;
}

let bad = 0;
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, "utf8");
  const seen = new Map();
  for (const h of topLevelFunctions(src)) {
    if (!seen.has(h.name)) seen.set(h.name, []);
    seen.get(h.name).push(h.line);
  }
  const dupes = [...seen.entries()].filter(([, lines]) => lines.length > 1);
  if (dupes.length) {
    bad += dupes.length;
    console.error(`✗ ${file} 有 ${dupes.length} 个重名函数:`);
    for (const [name, lines] of dupes) console.error(`   ${name}  ×${lines.length}  行 ${lines.join(" / ")}`);
  } else {
    console.log(`✓ ${file} 顶层函数无重名`);
  }
}
process.exit(bad ? 1 : 0);

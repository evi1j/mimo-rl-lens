'use strict';
/* 项目根目录在哪 —— 源码和分发包的层级不一样，所以不能直接用 __dirname。

   两种布局：
     开发：项目根/src/server.js，public/ 在项目根
     分发：dist/server.js（扁平），public/ 就在 dist 下

   所以「public/ 跟谁同级，谁就是根」：server.js 旁边就有 public/ 说明自己
   已经在根上了（分发包），否则根在上一层（开发时）。

   分发包刻意保持扁平：使用者是双击 start.command 的人，不该让他去 src/ 里
   找入口。代价就是这个模块 —— 所有跨目录的路径都必须经它，别再写裸 __dirname。 */

const fs = require('fs');
const path = require('path');

const ROOT = fs.existsSync(path.join(__dirname, 'public'))
  ? __dirname
  : path.join(__dirname, '..');

/* 取根目录下的某个路径：at('config.json')、at('public', 'index.html') */
function at() {
  return path.join.apply(path, [ROOT].concat(Array.prototype.slice.call(arguments)));
}

module.exports = { ROOT: ROOT, at: at };

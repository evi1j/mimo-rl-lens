#!/usr/bin/env node
/*
 * 清掉 GHCR 上「不是里程碑」的镜像版本 —— 也就是 main、sha-xxxxx 这类
 * 每次构建顺手打出来的标签。它们跟版本号无关，却各占一份存储。
 *
 * 保留：latest 和纯版本号（1.8 / 1.8.0 / 2.1.3）；其余一律删。
 *
 * 默认只打印不动手（dry-run）。真删要显式 DRY_RUN=false。
 * 在 Actions 里跑的话，token 用自带的 GITHUB_TOKEN 即可（需 packages: write）。
 */
const OWNER = process.env.OWNER || "evi1j";
const PKG = process.env.PACKAGE || "mimo-rl-lens";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const DRY = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN（或 GH_TOKEN）");
  process.exit(1);
}

const API = "https://api.github.com";
const HEADERS = {
  Authorization: "Bearer " + TOKEN,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ghcr-prune",
};

// latest，或形如 1 / 1.8 / 1.8.0 的版本号
const KEEP = /^(latest|\d+(\.\d+){0,2})$/;

function tagsOf(v) {
  return (v.metadata && v.metadata.container && v.metadata.container.tags) || [];
}
function keep(v) {
  return tagsOf(v).some((t) => KEEP.test(t));
}

async function listVersions() {
  const out = [];
  for (let page = 1; ; page++) {
    const url = `${API}/users/${OWNER}/packages/container/${encodeURIComponent(PKG)}/versions?per_page=100&page=${page}`;
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error(`列出版本失败：${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    out.push(...j);
    if (j.length < 100) break;
  }
  return out;
}

async function del(id) {
  const url = `${API}/users/${OWNER}/packages/container/${encodeURIComponent(PKG)}/versions/${id}`;
  const r = await fetch(url, { method: "DELETE", headers: HEADERS });
  if (r.status === 204) return "已删除";
  return `删除失败：${r.status} ${(await r.text()).slice(0, 120)}`;
}

(async () => {
  const vs = await listVersions();
  const doomed = vs.filter((v) => !keep(v));
  console.log(`GHCR 上 ${OWNER}/${PKG} 共 ${vs.length} 个版本：\n`);
  for (const v of vs) {
    const tags = tagsOf(v);
    const when = (v.updated_at || v.created_at || "").slice(0, 10);
    const mark = keep(v) ? "保留" : "删除";
    console.log(`  ${mark}  #${v.id}  [${tags.join(", ") || "(无标签)"}]  ${when}`);
  }
  console.log(`\n${DRY ? "[dry-run] 将删除" : "实际删除"} ${doomed.length} 个版本。`);

  if (DRY) {
    console.log("要真删，跑的时候把 dry_run 取消勾选（DRY_RUN=false）。");
    return;
  }
  for (const v of doomed) {
    console.log(`  #${v.id} → ${await del(v.id)}`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

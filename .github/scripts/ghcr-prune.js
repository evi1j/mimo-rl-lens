#!/usr/bin/env node
/*
 * 清掉 GHCR 上「不是里程碑」的镜像版本 —— 也就是 main、sha-xxxxx 这类
 * 每次构建顺手打出来的标签。它们跟版本号无关，却各占一份存储。
 *
 * 保留：latest 和纯版本号（1.8 / 1.8.0 / 2.1.3）；其余一律删。
 *
 * ⚠️ 多架构镜像的子清单必须一起保住：
 * 一次构建推上去的是「一个索引 + 每个平台一份子清单 + 证明清单」，
 * 在 GHCR 的版本列表里，只有索引带标签，子清单全是「无标签版本」。
 * 早期版本只按标签判断，于是把 latest 引用的 amd64/arm64 子清单当成垃圾删了，
 * 结果标签还在、内容没了，docker pull 报
 *   failed to copy: httpReadSeeker: failed open: content at .../manifests/sha256:xxx not found
 * 所以这里先顺着保留下来的标签，把它引用到的清单 digest 全部记下来一起保。
 * 万一拿不到清单（令牌没权限等），就退化成「无标签的一律不删」，宁可留垃圾也不打坏镜像。
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
const REG = "https://ghcr.io";
const REPO = `${OWNER}/${PKG}`;
const HEADERS = {
  Authorization: "Bearer " + TOKEN,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ghcr-prune",
};
// 索引 / 清单列表 / 单份清单，三种都问一遍，免得 registry 只肯给其中一种
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// latest，或形如 1 / 1.8 / 1.8.0 的版本号
const KEEP = /^(latest|\d+(\.\d+){0,2})$/;

function tagsOf(v) {
  return (v.metadata && v.metadata.container && v.metadata.container.tags) || [];
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

// 拿一个能读 registry 的令牌（读清单需要 pull 权限，跟 GitHub API 的令牌不是一回事）
async function registryToken() {
  const url = `${REG}/token?service=ghcr.io&scope=repository:${REPO}:pull`;
  const candidates = [
    "Basic " + Buffer.from(`${OWNER}:${TOKEN}`).toString("base64"),
    "Bearer " + TOKEN,
  ];
  for (const auth of candidates) {
    try {
      const r = await fetch(url, { headers: { Authorization: auth, "User-Agent": "ghcr-prune" } });
      if (r.ok) return (await r.json()).token || null;
    } catch {
      /* 换下一种方式 */
    }
  }
  return null;
}

// 顺着 ref 把引用到的所有清单 digest 收集起来（索引 → 各平台子清单 → 证明清单）
async function digestsOf(ref, regToken, depth = 0, seen = new Set()) {
  const r = await fetch(`${REG}/v2/${REPO}/manifests/${ref}`, {
    headers: { Authorization: "Bearer " + regToken, Accept: MANIFEST_ACCEPT },
  });
  if (!r.ok) return null; // 拿不到就返回 null，由调用方退化成保守模式
  const j = await r.json();
  for (const m of j.manifests || []) {
    if (!m.digest || seen.has(m.digest)) continue;
    seen.add(m.digest);
    const nested = /index|manifest\.list/.test(m.mediaType || "") && depth < 3
      ? await digestsOf(m.digest, regToken, depth + 1, seen)
      : null;
    if (nested === null && /index|manifest\.list/.test(m.mediaType || "")) return null;
  }
  return seen;
}

async function del(id) {
  const url = `${API}/users/${OWNER}/packages/container/${encodeURIComponent(PKG)}/versions/${id}`;
  const r = await fetch(url, { method: "DELETE", headers: HEADERS });
  if (r.status === 204) return "已删除";
  return `删除失败：${r.status} ${(await r.text()).slice(0, 120)}`;
}

(async () => {
  const vs = await listVersions();

  // 先把要保留的标签找出来，再去 registry 问它们引用了哪些清单
  const keepTags = new Set();
  for (const v of vs) for (const t of tagsOf(v)) if (KEEP.test(t)) keepTags.add(t);

  let referenced = null; // null = 没查出来，走保守模式
  const regToken = await registryToken();
  if (regToken) {
    referenced = new Set();
    for (const t of keepTags) {
      const ds = await digestsOf(t, regToken);
      if (ds === null) {
        referenced = null;
        break;
      }
      for (const d of ds) referenced.add(d);
    }
  }
  const conservative = referenced === null;
  if (conservative) {
    console.log("注意：读不到镜像清单（registry 令牌没拿到），改为保守模式：无标签版本一律保留。\n");
  }

  const why = (v) => {
    const tags = tagsOf(v);
    if (tags.some((t) => KEEP.test(t))) return ["保留", "里程碑标签"];
    if (referenced && referenced.has(v.name)) return ["保留", "被里程碑引用的子清单"];
    if (conservative || tags.length === 0) return ["保留", "无标签（可能是子清单）"];
    return ["删除", "非里程碑标签：" + tags.join(", ")];
  };

  const rows = vs.map((v) => ({ v, mark: why(v) }));
  console.log(`GHCR 上 ${REPO} 共 ${vs.length} 个版本：\n`);
  for (const { v, mark } of rows) {
    const tags = tagsOf(v);
    const when = (v.updated_at || v.created_at || "").slice(0, 10);
    console.log(
      `  ${mark[0]}  #${String(v.id).padEnd(6)} [${tags.join(", ") || "(无标签)"}]  ${when}  — ${mark[1]}`
    );
  }

  const doomed = rows.filter((r) => r.mark[0] === "删除").map((r) => r.v);
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

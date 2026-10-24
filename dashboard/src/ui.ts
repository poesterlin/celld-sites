import type { Model, Site, Usage } from "./data";

const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function bytes(n: number) {
	if (!n) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function ago(iso?: string | number) {
	if (!iso) return "—";
	const t = typeof iso === "number" ? iso : Date.parse(iso);
	const s = Math.round((Date.now() - t) / 1000);
	const rel = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
	return `<time datetime="${esc(new Date(t).toISOString())}" title="${esc(new Date(t).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }))}">${rel}</time>`;
}

const pill = (ok: boolean, yes: string, no: string) => `<span class="pill ${ok ? "ok" : "bad"}">${ok ? yes : no}</span>`;
const count = (u: Usage) => `${bytes(u.bytes)} <span class="dim">· ${u.files.toLocaleString("en")} files</span>`;

function shell(title: string, body: string, model: Model) {
	const errors = model.errors.length
		? `<section class="card errors"><b>Some data could not be loaded</b><ul>${model.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></section>`
		: "";
	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body>
<header class="top">
  <div><h1><a href="/">celld-sites</a></h1><p class="dim">Read-only dashboard · data from ${ago(model.at)}</p></div>
  <a class="button" href="">Refresh</a>
</header>
<main>${errors}${body}</main>
</body></html>`;
}

function stat(label: string, value: string, note = "") {
	return `<div class="stat"><span class="label">${label}</span><b>${value}</b>${note ? `<span class="dim">${note}</span>` : ""}</div>`;
}

export function overviewPage(m: Model) {
	const n = m.node;
	const fdShare = n && n.fdLimit ? n.openFds / n.fdLimit : 0;
	const nodeCard = `<section class="card">
  <h2>Node ${pill(m.health.celld, "healthy", "unhealthy")} ${pill(m.health.s3, "bucket up", "bucket down")}</h2>
  ${
		n
			? `<div class="stats">
    ${stat("Memory (working set)", bytes(n.workingSetBytes), `RSS ${bytes(n.rssBytes)}`)}
    ${stat("CPU", `${n.cpuPercent.toFixed(1)}%`, "of one core = 100%")}
    ${stat("Loaded objects", n.residentObjects.toLocaleString("en"), `${n.ownedCells.toLocaleString("en")} cells owned`)}
    ${stat("Router isolates", String(n.liveIsolates), `heap ${bytes(n.isolateHeapBytes)}`)}
    ${stat("Open files", n.openFds.toLocaleString("en"), `${(fdShare * 100).toFixed(1)}% of limit`)}
    ${stat("Pressure", n.pressured ? "shedding" : n.memoryHeadroom ? "headroom" : "tight", n.draining ? "draining" : `router ${esc(n.routerVersion)}`)}
  </div>`
			: `<p class="dim">Node counters unavailable.</p>`
	}
</section>`;

	const s = m.storage;
	const share = (u: Usage) => (s && s.total.bytes ? (u.bytes / s.total.bytes) * 100 : 0);
	const storageCard = s
		? `<section class="card">
  <h2>Storage</h2>
  <div class="stats">
    ${stat("Bucket", bytes(s.total.bytes), `${s.total.files.toLocaleString("en")} files`)}
    ${stat("Volume free", bytes(s.volumeFreeBytes), s.volumeSizeBytes ? `of ${bytes(s.volumeSizeBytes)}` : "")}
  </div>
  <div class="bar" role="img" aria-label="Bucket usage by area">
    <span class="b1" style="width:${share(s.siteObjects)}%"></span><span class="b2" style="width:${share(s.kv)}%"></span><span class="b3" style="width:${share(s.deployments)}%"></span><span class="b4" style="width:${share(s.other)}%"></span>
  </div>
  <ul class="legend">
    <li><i class="b1"></i>Site objects (Durable Object logs) <span>${count(s.siteObjects)}</span></li>
    <li><i class="b2"></i>KV: site code and assets <span>${count(s.kv)}</span></li>
    <li><i class="b3"></i>Router deployments <span>${count(s.deployments)}</span></li>
    <li><i class="b4"></i>Other (leases, fleet) <span>${count(s.other)}</span></li>
  </ul>
  ${
		s.unindexed.count
			? `<p class="note">${s.unindexed.count.toLocaleString("en")} objects (${bytes(s.unindexed.bytes)}) are not in the index: created before indexing existed, or by sites that were removed. Their names are unknown; storage only keeps hashes.</p>`
			: ""
	}
</section>`
		: "";

	const rows = m.sites
		.map((site) => {
			const last = site.deploys[0];
			return `<tr>
  <td data-label="Site"><span><a href="/site/${encodeURIComponent(site.host)}"><b>${esc(site.host)}</b></a></span></td>
  <td data-label="Version"><span><code>${esc(site.version)}</code></span></td>
  <td data-label="Deployed"><span>${last && last.version === site.version ? ago(last.at) : '<span class="dim">before history</span>'}</span></td>
  <td data-label="Assets"><span>${site.assets ?? "—"}</span></td>
  <td data-label="Objects"><span>${site.objects.length}</span></td>
  <td data-label="Object data"><span>${bytes(site.objectBytes)}</span></td>
  <td data-label="Open"><span><a href="https://${esc(site.host)}/" rel="noreferrer">open ↗</a></span></td>
</tr>`;
		})
		.join("");
	const sitesCard = `<section class="card">
  <h2>Sites <span class="dim">${m.sites.length} sites · ${m.versions} stored versions</span></h2>
  ${
		m.sites.length
			? `<table><thead><tr><th>Site</th><th>Version</th><th>Deployed</th><th>Assets</th><th>Objects</th><th>Object data</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
			: `<p class="dim">No sites deployed.</p>`
	}
</section>`;

	return shell("celld-sites", nodeCard + storageCard + sitesCard, m);
}

export function sitePage(m: Model, site: Site) {
	const deploys = site.deploys
		.map(
			(d) => `<tr>
  <td data-label="Deployed"><span>${ago(d.at)}</span></td>
  <td data-label="Version"><span><code>${esc(d.version)}</code> ${d.version === site.version ? '<span class="pill ok">current</span>' : ""}</span></td>
  <td data-label="Assets"><span>${d.assets ?? "—"}</span></td>
  <td data-label="Server code"><span>${d.sourceBytes ? bytes(d.sourceBytes) : "—"}</span></td>
</tr>`,
		)
		.join("");
	const objects = site.objects
		.map(
			(o) => `<tr>
  <td data-label="Class"><span><code>${esc(o.className)}</code></span></td>
  <td data-label="Name"><span>${esc(o.name)}</span></td>
  <td data-label="Data"><span>${bytes(o.bytes)} <span class="dim">· ${o.files} files</span></span></td>
  <td data-label="Loaded"><span>${o.resident ? '<span class="pill ok">loaded</span>' : '<span class="dim">idle</span>'}</span></td>
  <td data-label="First seen"><span>${ago(o.firstSeen)}</span></td>
</tr>`,
		)
		.join("");
	const history = site.deploys.some((d) => d.version === site.version)
		? ""
		: `<p class="note">The current version <code>${esc(site.version)}</code> was deployed before deploy history was recorded.</p>`;

	const body = `<section class="card">
  <h2>${esc(site.host)} <a class="small" href="https://${esc(site.host)}/" rel="noreferrer">open ↗</a></h2>
  <div class="stats">
    ${stat("Current version", `<code>${esc(site.version)}</code>`)}
    ${stat("Assets", String(site.assets ?? "—"))}
    ${stat("Objects", String(site.objects.length), bytes(site.objectBytes))}
    ${stat("Deploys recorded", String(site.deploys.length))}
  </div>
</section>
<section class="card">
  <h2>Deploy history</h2>${history}
  ${deploys ? `<table><thead><tr><th>Deployed</th><th>Version</th><th>Assets</th><th>Server code</th></tr></thead><tbody>${deploys}</tbody></table>` : '<p class="dim">No deploys recorded yet.</p>'}
</section>
<section class="card">
  <h2>Durable Objects</h2>
  ${
		objects
			? `<table><thead><tr><th>Class</th><th>Name</th><th>Data</th><th>Loaded</th><th>First seen</th></tr></thead><tbody>${objects}</tbody></table>`
			: '<p class="dim">No objects used yet (objects appear after their first call).</p>'
	}
  <p class="dim small">Data is the disk space of the object's write log in the bucket. celld keeps every write (compaction only adds summaries), so it only grows.</p>
</section>`;
	return shell(`${site.host} · celld-sites`, body, m);
}

export function notFoundPage(m: Model, what: string) {
	return shell("Not found", `<section class="card"><h2>Not found</h2><p>${esc(what)}</p><p><a href="/">Back to the overview</a></p></section>`, m);
}

const CSS = `
:root { --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#5b6370; --line:#e3e6eb; --ok:#2b8a3e; --bad:#c92a2a;
  --b1:#4263eb; --b2:#12b886; --b3:#f59f00; --b4:#adb5bd; }
@media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1e24; --fg:#e6e9ef; --muted:#8c94a4; --line:#2a3039; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
a { color:inherit; }
code { font:13px ui-monospace, monospace; }
.top { display:flex; justify-content:space-between; align-items:center; gap:1rem; max-width:72rem; margin:0 auto; padding:1.25rem 1rem .5rem; }
.top h1 { margin:0; font-size:1.4rem; } .top h1 a { text-decoration:none; }
.top p { margin:0; }
main { max-width:72rem; margin:0 auto; padding:0 1rem 2rem; display:grid; gap:1rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:.75rem; padding:1rem 1.1rem; overflow:hidden; }
.card h2 { margin:0 0 .75rem; font-size:1.05rem; display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; }
.dim { color:var(--muted); font-weight:normal; }
.small { font-size:.85rem; }
.note { color:var(--muted); font-size:.9rem; margin:.75rem 0 0; }
.button { border:1px solid var(--line); border-radius:.5rem; padding:.45rem .9rem; text-decoration:none; background:var(--card); }
.pill { font-size:.75rem; font-weight:600; padding:.1rem .5rem; border-radius:1rem; border:1px solid currentColor; }
.pill.ok { color:var(--ok); } .pill.bad { color:var(--bad); }
.errors { border-color:var(--bad); } .errors ul { margin:.5rem 0 0; }
.stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(9rem, 1fr)); gap:.75rem; }
.stat { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:.5rem; padding:.6rem .75rem; }
.stat .label { color:var(--muted); font-size:.8rem; }
.stat b { font-size:1.15rem; }
.stat .dim { font-size:.8rem; }
.bar { display:flex; height:.7rem; border-radius:.35rem; overflow:hidden; background:var(--line); margin:1rem 0 .6rem; }
.b1 { background:var(--b1); } .b2 { background:var(--b2); } .b3 { background:var(--b3); } .b4 { background:var(--b4); }
.legend { list-style:none; margin:0; padding:0; display:grid; gap:.3rem; font-size:.9rem; }
.legend li { display:flex; align-items:center; gap:.5rem; } .legend li span { margin-left:auto; text-align:right; }
.legend i { width:.7rem; height:.7rem; border-radius:.2rem; display:inline-block; flex:none; }
table { width:100%; border-collapse:collapse; font-size:.92rem; }
th { text-align:left; color:var(--muted); font-weight:600; font-size:.8rem; border-bottom:1px solid var(--line); padding:.4rem .5rem; }
td { border-bottom:1px solid var(--line); padding:.5rem; vertical-align:top; }
tr:last-child td { border-bottom:none; }
@media (max-width: 700px) {
  thead { display:none; }
  table, tbody, tr, td { display:block; width:100%; }
  tr { border:1px solid var(--line); border-radius:.5rem; padding:.4rem .6rem; margin-bottom:.6rem; }
  td { border:none; padding:.2rem 0; display:flex; justify-content:space-between; align-items:baseline; gap:1rem; }
  td > span { text-align:right; }
  td::before { content:attr(data-label); color:var(--muted); font-size:.8rem; }
  td[data-label="Open"]::before { content:""; }
  .legend li { flex-wrap:wrap; } .legend li span { margin-left:1.2rem; text-align:left; width:100%; }
}
`;

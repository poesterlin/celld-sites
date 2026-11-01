<script setup lang="ts">
// The compose.yaml generator. The logic lives in ../lib/compose.ts; this file
// is the form. It is deliberately one column, in plain words, with the
// optional settings folded away.
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
	DEFAULT_IMAGE_TAG,
	DNS_PROVIDERS,
	IMAGE_REPOSITORY,
	SCENARIOS,
	type Options,
	type Scenario,
	defaultOptions,
	generate,
} from "../lib/compose";

const o = reactive<Options>(defaultOptions());
const result = computed(() => generate(o));
const tab = ref<"compose" | "env" | "run">("compose");
const copied = ref("");
const copyFailed = ref(false);
const mounted = ref(false);

const provider = computed(() => DNS_PROVIDERS.find((p) => p.id === o.dnsProvider) ?? DNS_PROVIDERS[0]);
const hasEnv = computed(() => result.value.env.length > 0);
const output = computed(() =>
	tab.value === "env" ? result.value.env : tab.value === "run" ? result.value.dockerRun : result.value.yaml,
);
const downloadName = computed(() => (tab.value === "env" ? ".env" : tab.value === "run" ? "" : "compose.yaml"));
const ready = computed(() => result.value.errors.length === 0);
const commands = computed(() => result.value.commands.join("\n"));

const summary = computed(() => {
	switch (o.scenario) {
		case "home":
			return `One container, no sign-in. Open it on port ${o.httpPort}.`;
		case "domain":
			return `One container with HTTPS. Open https://${o.domain || "your domain"}. You sign in with ${o.oidcName || "your provider"}.`;
		case "proxy":
			return `One container behind your proxy. Open https://${o.proxyHost || "your address"}. You sign in with ${o.oidcName || "your provider"}.`;
		default:
			return `One container with a hostname from the names service. You sign in with ${o.oidcName || "your provider"}.`;
	}
});

function pick(scenario: Scenario) {
	o.scenario = scenario;
	o.traefik = false;
	o.hostNetwork = false;
	if (scenario === "home") {
		o.httpPort = "8000";
		o.bindLoopback = false;
		o.oidcEnabled = false;
	} else {
		o.httpsPort = "443";
		o.oidcEnabled = true;
		o.bindLoopback = scenario === "proxy";
		o.httpPort = scenario === "proxy" ? "8000" : "80";
	}
}

async function copy(label: string, text: string) {
	copyFailed.value = false;
	try {
		await navigator.clipboard.writeText(text);
		copied.value = label;
		window.setTimeout(() => (copied.value = ""), 1600);
	} catch {
		copyFailed.value = true;
	}
}

function download() {
	if (!downloadName.value) return;
	const blob = new Blob([output.value], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = downloadName.value;
	document.body.appendChild(a);
	a.click();
	a.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Remember the answers in the URL (never the OIDC secret or free-form env).
const SHARE_KEYS: (keyof Options)[] = [
	"scenario",
	"containerName",
	"imageSource",
	"imageTag",
	"dataMode",
	"dataPath",
	"hostNetwork",
	"bindLoopback",
	"httpPort",
	"httpsPort",
	"domain",
	"dnsProvider",
	"acmeEmail",
	"nameServiceUrl",
	"addressIpv4",
	"proxyHost",
	"proxyGrainDomain",
	"proxyHttps",
	"grainPorts",
	"oidcName",
	"oidcIssuer",
	"oidcClientId",
	"storeUrl",
	"memLimit",
	"cpus",
	"timezone",
	"traefik",
	"watchtower",
	"user10001",
];

function syncUrl() {
	if (!mounted.value) return;
	const url = new URL(window.location.href);
	const defaults = defaultOptions();
	for (const key of SHARE_KEYS) {
		const value = o[key];
		if (value === defaults[key]) url.searchParams.delete(key);
		else url.searchParams.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
	}
	window.history.replaceState(window.history.state, "", url);
}

function shareLink() {
	syncUrl();
	return window.location.href;
}

const shareCopied = ref(false);
async function copyShare() {
	try {
		await navigator.clipboard.writeText(shareLink());
		shareCopied.value = true;
		window.setTimeout(() => (shareCopied.value = false), 1600);
	} catch {
		copyFailed.value = true;
	}
}

watch(o, syncUrl, { deep: true });
watch(
	() => result.value.env,
	(env) => {
		if (!env && tab.value === "env") tab.value = "compose";
	},
);
watch(
	() => o.scenario,
	() => {
		if (o.scenario !== "proxy") o.traefik = false;
		if (o.scenario !== "home") o.hostNetwork = false;
	},
);

onMounted(() => {
	mounted.value = true;
	const params = new URLSearchParams(window.location.search);
	const defaults = defaultOptions();
	for (const key of SHARE_KEYS) {
		const raw = params.get(key);
		if (raw === null) continue;
		const fallback = defaults[key];
		(o as Record<string, unknown>)[key] = typeof fallback === "boolean" ? raw === "1" : raw;
	}
	const scenario = params.get("scenario");
	if (scenario && SCENARIOS.some((s) => s.id === scenario)) o.scenario = scenario as Scenario;
	// Sign-in is not optional when it is on: every scenario except home needs
	// one provider, so the form always asks for it.
	if (o.scenario !== "home") o.oidcEnabled = true;
	syncUrl();
});
</script>

<template>
	<div class="gen">
		<section class="step">
			<h2><span class="num">1</span> Where will it run?</h2>
			<fieldset class="choices">
				<legend class="sr-only">Where will Hamstr run?</legend>
				<label v-for="s in SCENARIOS" :key="s.id" class="choice" :class="{ active: o.scenario === s.id }">
					<input
						type="radio"
						name="scenario"
						:value="s.id"
						:checked="o.scenario === s.id"
						@change="pick(s.id)"
					/>
					<span>
						<span class="choice-title">{{ s.label }}</span>
						<span class="choice-note">{{ s.blurb }}</span>
					</span>
				</label>
			</fieldset>
		</section>

		<section class="step">
			<h2><span class="num">2</span> The basics</h2>

			<template v-if="o.scenario === 'home'">
				<label class="field">
					<span class="label">Port</span>
					<input v-model="o.httpPort" inputmode="numeric" autocomplete="off" />
					<span class="help">Hamstr opens on this port. Each app gets its own port, starting at {{ o.grainPorts.split("-")[0] }}.</span>
				</label>
			</template>

			<template v-else-if="o.scenario === 'domain'">
				<label class="field">
					<span class="label">Your domain</span>
					<input v-model="o.domain" type="text" placeholder="example.com" autocomplete="off" spellcheck="false" />
					<span class="help">Point this domain and its wildcard (<code>*.{{ o.domain || "example.com" }}</code>) at this computer.</span>
				</label>
				<label class="field">
					<span class="label">DNS provider</span>
					<select v-model="o.dnsProvider">
						<option v-for="p in DNS_PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
					</select>
					<span class="help">
						The company that runs your domain.
						<a
							v-if="provider.docs"
							:href="`https://go-acme.github.io/lego/dns/${provider.docs}/`"
							target="_blank"
							rel="noreferrer"
						>How to get a token</a>
					</span>
				</label>
				<label class="field">
					<span class="label">Email for certificates <span class="optional">(optional)</span></span>
					<input v-model="o.acmeEmail" type="email" placeholder="you@example.com" autocomplete="off" />
				</label>
			</template>

			<template v-else-if="o.scenario === 'proxy'">
				<label class="field">
					<span class="label">Hamstr address</span>
					<input v-model="o.proxyHost" type="text" placeholder="hamstr.example.com" autocomplete="off" spellcheck="false" />
					<span class="help">The address you will open.</span>
				</label>
				<label class="field">
					<span class="label">App domain</span>
					<input v-model="o.proxyGrainDomain" type="text" placeholder="example.com" autocomplete="off" spellcheck="false" />
					<span class="help">Your proxy must send <code>grain-*.{{ o.proxyGrainDomain || "example.com" }}</code> here too.</span>
				</label>
				<label class="check">
					<input v-model="o.proxyHttps" type="checkbox" />
					<span>My proxy adds HTTPS</span>
				</label>
			</template>

			<template v-else>
				<label class="field">
					<span class="label">Names service address</span>
					<input v-model="o.nameServiceUrl" type="url" placeholder="https://names.example.net" autocomplete="off" spellcheck="false" />
					<span class="help">It must start with <code>https://</code>.</span>
				</label>
				<label class="field">
					<span class="label">Address to publish</span>
					<input v-model="o.addressIpv4" type="text" placeholder="100.64.0.10" autocomplete="off" />
					<span class="help">
						This computer's Tailscale or LAN address. A normal Docker network cannot see it for you. It must be
						private, not a public address.
					</span>
				</label>
			</template>
		</section>

		<section v-if="o.scenario !== 'home'" class="step">
			<h2><span class="num">3</span> Sign-in</h2>
			<p class="step-note">You need this to open Hamstr. Ask your sign-in provider for these three values.</p>
			<label class="field">
				<span class="label">Provider name</span>
				<input v-model="o.oidcName" type="text" placeholder="Tailscale" autocomplete="off" />
				<span class="help">A label you will see on the sign-in button.</span>
			</label>
			<label class="field">
				<span class="label">Sign-in address</span>
				<input v-model="o.oidcIssuer" type="url" placeholder="https://idp.example.ts.net" autocomplete="off" spellcheck="false" />
				<span class="help">The address of your provider. It must start with <code>https://</code>.</span>
			</label>
			<label class="field">
				<span class="label">Client ID</span>
				<input v-model="o.oidcClientId" type="text" autocomplete="off" spellcheck="false" placeholder="From your provider" />
			</label>

			<div v-if="result.redirectUri" class="redirect">
				<span class="redirect-label">Give this address to your provider</span>
				<div class="redirect-row">
					<code>{{ result.redirectUri }}</code>
					<button type="button" class="mini" @click="copy('uri', result.redirectUri)">Copy</button>
				</div>
			</div>
			<p v-else class="help">
				The names service gives you an address on the first start. Then add it here, register the sign-in address
				at your provider, and restart.
			</p>

			<p class="help">
				The client secret goes in the settings file. The first person to sign in becomes the owner.
			</p>
		</section>

		<details class="more">
			<summary>
				<span class="more-title">More settings</span>
				<span class="more-note">Only if you need them</span>
			</summary>
			<div class="more-body">
				<h3>Apps</h3>
				<label class="field">
					<span class="label">App store</span>
					<input v-model="o.storeUrl" type="url" placeholder="https://store.hamstr.app" autocomplete="off" spellcheck="false" />
					<span class="help">Where apps come from. Leave it empty for no store.</span>
				</label>
				<label class="field">
					<span class="label">Time zone <span class="optional">(optional)</span></span>
					<input v-model="o.timezone" type="text" placeholder="Europe/Berlin" autocomplete="off" spellcheck="false" />
				</label>

				<h3>Ports</h3>
				<div v-if="o.scenario === 'domain' || o.scenario === 'names'" class="pair">
					<label class="field">
						<span class="label">HTTPS port</span>
						<input v-model="o.httpsPort" inputmode="numeric" autocomplete="off" />
					</label>
					<label class="field">
						<span class="label">HTTP port</span>
						<input v-model="o.httpPort" inputmode="numeric" autocomplete="off" />
					</label>
				</div>
				<template v-else-if="o.scenario === 'proxy'">
					<label class="field">
						<span class="label">Port</span>
						<input v-model="o.httpPort" inputmode="numeric" autocomplete="off" />
					</label>
					<label class="check">
						<input v-model="o.bindLoopback" type="checkbox" />
						<span>Only reachable on this computer</span>
					</label>
				</template>
				<template v-else>
					<label class="field">
						<span class="label">App ports</span>
						<input v-model="o.grainPorts" autocomplete="off" />
						<span class="help">A range, for example <code>20000-20999</code>.</span>
					</label>
					<label class="check">
						<input v-model="o.hostNetwork" type="checkbox" />
						<span>Use the host network</span>
					</label>
				</template>

				<h3>Data</h3>
				<label class="field">
					<span class="label">Where to keep it</span>
					<select v-model="o.dataMode">
						<option value="volume">A Docker volume</option>
						<option value="bind">A folder on this computer</option>
					</select>
				</label>
				<label v-if="o.dataMode === 'bind'" class="field">
					<span class="label">Folder</span>
					<input v-model="o.dataPath" placeholder="/srv/hamstr" autocomplete="off" />
				</label>

				<h3>Container</h3>
				<label class="field">
					<span class="label">Name</span>
					<input v-model="o.containerName" autocomplete="off" spellcheck="false" />
				</label>
				<label class="field">
					<span class="label">Image</span>
					<select v-model="o.imageSource">
						<option value="registry">Download a release</option>
						<option value="build">Build from this copy of the project</option>
					</select>
				</label>
				<label v-if="o.imageSource === 'registry'" class="field">
					<span class="label">Release</span>
					<input v-model="o.imageTag" :placeholder="DEFAULT_IMAGE_TAG" autocomplete="off" />
					<span class="help"><code>{{ IMAGE_REPOSITORY }}:{{ o.imageTag || DEFAULT_IMAGE_TAG }}</code></span>
				</label>

				<h3>Limits</h3>
				<div class="pair">
					<label class="field">
						<span class="label">Memory</span>
						<input v-model="o.memLimit" placeholder="No limit" autocomplete="off" />
					</label>
					<label class="field">
						<span class="label">CPU</span>
						<input v-model="o.cpus" placeholder="No limit" autocomplete="off" />
					</label>
				</div>
				<label class="check">
					<input v-model="o.user10001" type="checkbox" />
					<span>Start as user 10001 (the folder must already belong to it)</span>
				</label>
				<label class="check">
					<input v-model="o.watchtower" type="checkbox" />
					<span>Let Watchtower update it</span>
				</label>
				<label v-if="o.scenario === 'proxy'" class="check">
					<input v-model="o.traefik" type="checkbox" />
					<span>Add Traefik labels</span>
				</label>

				<h3>Extra settings</h3>
				<label class="field">
					<span class="label">One <code>NAME=value</code> per line</span>
					<textarea v-model="o.extraEnv" rows="3" spellcheck="false" placeholder="CELLD_LOG=info"></textarea>
				</label>
			</div>
		</details>

		<section class="result">
			<h2>Your files</h2>
			<p class="summary">{{ summary }}</p>

			<div v-if="result.errors.length" class="notice bad">
				<strong>Fix these first</strong>
				<ul>
					<li v-for="e in result.errors" :key="e">{{ e }}</li>
				</ul>
			</div>
			<div v-if="result.warnings.length" class="notice warn">
				<strong>Please check</strong>
				<ul>
					<li v-for="w in result.warnings" :key="w">{{ w }}</li>
				</ul>
			</div>
			<p v-if="ready && result.warnings.length === 0" class="ready">The file is ready.</p>

			<div class="tabs" role="tablist" aria-label="Files">
				<button type="button" role="tab" :aria-selected="tab === 'compose'" :class="{ active: tab === 'compose' }" @click="tab = 'compose'">
					Compose file
				</button>
				<button v-if="hasEnv" type="button" role="tab" :aria-selected="tab === 'env'" :class="{ active: tab === 'env' }" @click="tab = 'env'">
					Settings file
				</button>
				<button type="button" role="tab" :aria-selected="tab === 'run'" :class="{ active: tab === 'run' }" @click="tab = 'run'">
					Run command
				</button>
			</div>

			<div class="actions">
				<button type="button" class="button" @click="copy(tab, output)">
					{{ copied === tab ? "Copied" : "Copy" }}
				</button>
				<button v-if="downloadName" type="button" class="button" @click="download">
					Download {{ downloadName }}
				</button>
				<button type="button" class="button ghost" @click="copyShare">
					{{ shareCopied ? "Link copied" : "Copy link" }}
				</button>
			</div>
			<p v-if="copyFailed" class="help error-text">The clipboard did not work. Select the text and copy it.</p>

			<pre class="code" tabindex="0"><code>{{ output }}</code></pre>

			<h3 class="run-title">Run it</h3>
			<pre class="command">{{ commands }}</pre>
			<p v-if="o.scenario === 'home'" class="where">
				Then open this computer's address on port <code>{{ o.httpPort }}</code>.
			</p>
			<p v-else-if="result.shellUrl" class="where">
				Then open <code>{{ result.shellUrl }}</code>.
			</p>
			<p v-else class="where">Then open the address the names service shows you.</p>
			<p class="where small-note">The first start takes a minute.</p>
		</section>
	</div>
</template>

<style scoped>
.gen {
	max-width: 820px;
}

.step,
.result {
	padding: 26px 0;
	border-top: 1px solid var(--vp-c-divider);
	max-width: 640px;
}

.step:first-child,
.result {
	border-top: 0;
}

.result {
	padding-top: 34px;
	max-width: 820px;
}

.step h2,
.result h2 {
	display: flex;
	align-items: center;
	gap: 10px;
	margin: 0 0 14px;
	font-size: 1.35rem;
	font-weight: 700;
	line-height: 1.3;
}

.num {
	flex: none;
	width: 30px;
	height: 30px;
	border-radius: 50%;
	background: var(--vp-c-brand-1);
	color: #fff;
	display: grid;
	place-items: center;
	font-size: 1rem;
	font-weight: 700;
}

.step-note {
	margin: 0 0 18px;
	max-width: 62ch;
	color: var(--vp-c-text-2);
}

.choices {
	border: 0;
	padding: 0;
	margin: 0;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.choice {
	display: flex;
	align-items: flex-start;
	gap: 14px;
	padding: 14px 16px;
	min-height: 64px;
	border: 2px solid var(--vp-c-divider);
	border-radius: 14px;
	cursor: pointer;
	background: var(--vp-c-bg);
}

.choice:hover {
	border-color: var(--vp-c-brand-3);
}

.choice.active {
	border-color: var(--vp-c-brand-1);
	background: var(--vp-c-brand-soft);
}

.choice input[type="radio"] {
	flex: none;
	width: 22px;
	height: 22px;
	min-height: 0;
	margin: 2px 0 0;
	padding: 0;
	accent-color: var(--vp-c-brand-1);
}

.choice-title {
	display: block;
	font-size: 1.05rem;
	font-weight: 700;
}

.choice-note {
	display: block;
	margin-top: 2px;
	color: var(--vp-c-text-2);
	font-size: 0.96rem;
	line-height: 1.5;
}

.field {
	display: block;
	margin: 0 0 20px;
}

.label {
	display: block;
	margin-bottom: 6px;
	font-weight: 700;
	font-size: 1rem;
}

.optional {
	font-weight: 400;
	color: var(--vp-c-text-2);
}

input:not([type="checkbox"]):not([type="radio"]),
select,
textarea {
	width: 100%;
	min-height: 48px;
	padding: 10px 12px;
	border: 2px solid var(--vp-c-divider);
	border-radius: 10px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font: inherit;
	font-size: 1rem;
	line-height: 1.4;
}

select {
	cursor: pointer;
}

input:focus-visible,
select:focus-visible,
textarea:focus-visible {
	outline: 3px solid var(--vp-c-brand-1);
	outline-offset: 1px;
}

.help {
	display: block;
	margin-top: 6px;
	max-width: 62ch;
	color: var(--vp-c-text-2);
	font-size: 0.94rem;
	line-height: 1.55;
}

.help a {
	color: var(--vp-c-brand-1);
	font-weight: 700;
	margin-left: 4px;
}

.help code,
.redirect code {
	font-size: 0.88rem;
	overflow-wrap: anywhere;
}

.check {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	min-height: 44px;
	padding: 6px 0;
	margin: 0 0 12px;
	cursor: pointer;
	font-size: 1rem;
}

.check input {
	flex: none;
	width: 22px;
	height: 22px;
	margin: 2px 0 0;
	accent-color: var(--vp-c-brand-1);
}

.redirect {
	margin: 4px 0 18px;
	padding: 12px 14px;
	border: 2px dashed var(--vp-c-divider);
	border-radius: 12px;
}

.redirect-label {
	display: block;
	font-weight: 700;
}

.redirect-row {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
	margin-top: 6px;
}

.redirect-row code {
	flex: 1;
	min-width: 14ch;
}

.mini {
	min-height: 40px;
	padding: 6px 12px;
	border: 2px solid var(--vp-c-divider);
	border-radius: 9px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font: inherit;
	font-weight: 700;
	cursor: pointer;
}

.more {
	border-top: 1px solid var(--vp-c-divider);
	padding: 18px 0;
	margin: 0;
}

.more summary {
	display: flex;
	align-items: baseline;
	gap: 10px;
	flex-wrap: wrap;
	min-height: 44px;
	cursor: pointer;
	list-style: none;
	max-width: 640px;
}

.more summary::-webkit-details-marker {
	display: none;
}

.more summary::after {
	content: "+";
	margin-left: auto;
	font-size: 1.4rem;
	font-weight: 400;
	color: var(--vp-c-text-2);
}

.more[open] summary::after {
	content: "–";
}

.more-title {
	font-size: 1.1rem;
	font-weight: 700;
}

.more-note {
	color: var(--vp-c-text-2);
	font-size: 0.94rem;
}

.more-body {
	max-width: 640px;
	padding-top: 8px;
}

.more-body h3 {
	margin: 24px 0 10px;
	font-size: 1rem;
	font-weight: 700;
	color: var(--vp-c-text-2);
	letter-spacing: 0;
}

.pair {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px;
}

.notice {
	margin: 14px 0;
	padding: 12px 16px;
	border-left: 4px solid var(--vp-c-divider);
	border-radius: 0 10px 10px 0;
}

.notice strong {
	display: block;
	margin-bottom: 4px;
}

.notice ul {
	margin: 0;
	padding-left: 20px;
}

.notice li {
	margin: 5px 0;
	max-width: 70ch;
	line-height: 1.6;
}

.notice.bad {
	border-left-color: var(--vp-c-danger-1, #dc2f45);
	background: rgba(220, 47, 69, 0.08);
}

.notice.warn {
	border-left-color: var(--vp-c-warning-1, #d97706);
	background: rgba(217, 119, 6, 0.08);
}

.summary {
	margin: 0 0 12px;
	font-size: 1.05rem;
	line-height: 1.6;
	max-width: 62ch;
}

.ready {
	margin: 10px 0;
	color: var(--vp-c-green-1, #16a34a);
	font-weight: 700;
}

.tabs {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	margin: 16px 0 0;
}

.tabs button {
	min-height: 46px;
	padding: 8px 14px;
	border: 2px solid var(--vp-c-divider);
	border-radius: 10px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font: inherit;
	font-size: 0.96rem;
	font-weight: 700;
	cursor: pointer;
}

.tabs button.active {
	border-color: var(--vp-c-brand-1);
	background: var(--vp-c-brand-soft);
}

.actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	margin: 12px 0;
}

.button {
	min-height: 46px;
	padding: 10px 16px;
	border: 2px solid var(--vp-c-brand-1);
	border-radius: 10px;
	background: var(--vp-c-brand-1);
	color: #fff;
	font: inherit;
	font-size: 0.96rem;
	font-weight: 700;
	cursor: pointer;
}

.button:hover {
	background: var(--vp-c-brand-2);
}

.button.ghost {
	background: transparent;
	color: var(--vp-c-brand-1);
	border-color: var(--vp-c-divider);
}

.code {
	margin: 0;
	padding: 16px;
	border-radius: 12px;
	background: #16161b;
	color: #f2f2f7;
	font-family: var(--vp-font-family-mono);
	font-size: 0.82rem;
	line-height: 1.65;
	overflow: auto;
	max-height: 55vh;
	tab-size: 2;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	letter-spacing: 0;
	word-spacing: 0;
}

.run-title {
	margin: 22px 0 8px;
	font-size: 1.05rem;
	font-weight: 700;
}

.command {
	margin: 0;
	padding: 12px 14px;
	border: 2px solid var(--vp-c-divider);
	border-radius: 10px;
	background: var(--vp-c-bg-alt);
	color: var(--vp-c-text-1);
	font-family: var(--vp-font-family-mono);
	font-size: 0.84rem;
	line-height: 1.7;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	letter-spacing: 0;
	word-spacing: 0;
}

.where {
	margin: 12px 0 0;
	max-width: 62ch;
}

.where code {
	font-size: 0.9rem;
	overflow-wrap: anywhere;
}

.small-note {
	color: var(--vp-c-text-2);
	font-size: 0.94rem;
}

.error-text {
	color: var(--vp-c-danger-1, #dc2f45);
}

.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

@media (max-width: 560px) {
	.pair {
		grid-template-columns: 1fr;
		gap: 0;
	}

	.step h2,
	.result h2 {
		font-size: 1.25rem;
	}

	.code {
		max-height: 45vh;
	}
}
</style>

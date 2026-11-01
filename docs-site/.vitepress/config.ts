import { defineConfig } from "vitepress";

// The manual for Hamstr, the personal app platform. The content lives next to
// this folder; the live compose generator is a Vue component registered in
// .vitepress/theme/index.ts.
export default defineConfig({
	lang: "en",
	title: "Hamstr",
	description: "Little web apps in one click, with your data at home.",
	cleanUrls: false,
	lastUpdated: true,
	srcExclude: ["README.md"],
	markdown: {
		// Inside a Hamstr grain the manual runs in the shell's iframe, so an
		// external link without target would replace the app with a site that
		// refuses to be framed. Open every external link in a new tab.
		config(md) {
			const render =
				md.renderer.rules.link_open ??
				((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
			md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
				const href = tokens[idx].attrGet("href") ?? "";
				if (/^https?:\/\//.test(href)) {
					tokens[idx].attrSet("target", "_blank");
					tokens[idx].attrSet("rel", "noreferrer");
				}
				return render(tokens, idx, options, env, self);
			};
		},
	},
	head: [
		["link", { rel: "icon", href: "/logo.svg", type: "image/svg+xml" }],
		["meta", { name: "theme-color", content: "#5452e8" }],
	],
	themeConfig: {
		logo: "/logo.svg",
		siteTitle: "Hamstr",
		nav: [
			{ text: "Guide", link: "/guide/what-is-hamstr", activeMatch: "/guide/" },
			{ text: "Install", link: "/install/", activeMatch: "/install/" },
			{ text: "Configure", link: "/configure/environment", activeMatch: "/configure/" },
			{ text: "Help", link: "/help/troubleshooting", activeMatch: "/help/" },
		],
		sidebar: {
			"/guide/": [
				{
					text: "Guide",
					items: [
						{ text: "What is Hamstr?", link: "/guide/what-is-hamstr" },
						{ text: "Quick start", link: "/guide/quickstart" },
						{ text: "Apps, grains and data", link: "/guide/concepts" },
					],
				},
			],
			"/install/": [
				{
					text: "Install",
					items: [
						{ text: "Ways to install", link: "/install/" },
						{ text: "Compose generator", link: "/install/generator" },
						{ text: "Home Assistant", link: "/install/home-assistant" },
						{ text: "Home mode (no sign-in)", link: "/install/home-mode" },
						{ text: "HTTPS and domains", link: "/install/https" },
						{ text: "Sign-in", link: "/install/sign-in" },
						{ text: "Behind a proxy", link: "/install/proxy" },
						{ text: "Updating", link: "/install/updating" },
					],
				},
			],
			"/configure/": [
				{
					text: "Configure",
					items: [
						{ text: "Environment reference", link: "/configure/environment" },
						{ text: "Data and backups", link: "/configure/data-and-backups" },
						{ text: "Apps and the store", link: "/configure/store" },
					],
				},
			],
			"/using/": [
				{
					text: "Using Hamstr",
					items: [
						{ text: "Home", link: "/using/home" },
						{ text: "People and groups", link: "/using/people" },
						{ text: "Your apps", link: "/using/apps" },
					],
				},
			],
			"/help/": [
				{
					text: "Help",
					items: [
						{ text: "Troubleshooting", link: "/help/troubleshooting" },
						{ text: "FAQ", link: "/help/faq" },
					],
				},
			],
			"/reference/": [
				{
					text: "Reference",
					items: [
						{ text: "Architecture", link: "/reference/architecture" },
						{ text: "Security", link: "/reference/security" },
						{ text: "Ports", link: "/reference/ports" },
					],
				},
			],
		},
		search: { provider: "local" },
		socialLinks: [{ icon: "github", link: "https://github.com/poesterlin/celld-sites" }],
		editLink: {
			pattern: "https://github.com/poesterlin/celld-sites/edit/main/docs-site/:path",
			text: "Edit this page",
		},
		footer: {
			message: "Work in progress. Formats and settings will change.",
			copyright: "MIT licensed",
		},
		outline: { level: [2, 3], label: "On this page" },
		docFooter: { prev: "Previous", next: "Next" },
		darkModeSwitchLabel: "Appearance",
		sidebarMenuLabel: "Menu",
		returnToTopLabel: "Back to top",
	},
});

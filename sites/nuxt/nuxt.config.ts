// Nuxt 4 with the Nitro `cloudflare-module` preset: the build emits a Workers
// module (.output/server/index.mjs) plus static files (.output/public), which
// celld-sites packs (see celld.json and RECIPE.md).
export default defineNuxtConfig({
	compatibilityDate: '2026-10-01',
	devtools: { enabled: false },
	nitro: {
		preset: 'cloudflare-module',
	},
});

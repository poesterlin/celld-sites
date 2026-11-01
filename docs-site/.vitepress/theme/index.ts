import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";

import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import ComposeGenerator from "./components/ComposeGenerator.vue";
import "./style.css";

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		app.component("ComposeGenerator", ComposeGenerator);
	},
} satisfies Theme;

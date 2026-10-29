<script>
	import { toastState } from "#lib/client/ui.svelte.js";
</script>

{#if toastState.visible}
	<div class="toast" class:error={toastState.error} role="status">{toastState.message}</div>
{/if}

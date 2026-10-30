<script>
	import { toastState } from "../state.svelte.ts";
</script>

{#if toastState.visible}
	<div class="toast" class:error={toastState.error} role="status">{toastState.message}</div>
{/if}

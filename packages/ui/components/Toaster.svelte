<script>
	import { toastState } from "../state.svelte.js";
</script>

{#if toastState.visible}
	<div class="toast" class:error={toastState.error} role="status">{toastState.message}</div>
{/if}

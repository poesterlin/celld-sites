<script>
	// A list of checkable choices bound to an array of ids.
	let { items, selected = $bindable(), empty = "Nothing here yet." } = $props();
	const toggle = (id) => (selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
</script>

<div class="choices">
	{#each items as item (item.id)}
		<label class="choice"><input type="checkbox" checked={selected.includes(item.id)} onchange={() => toggle(item.id)} />{item.name}</label>
	{:else}
		<span class="dim small">{empty}</span>
	{/each}
</div>

<script setup lang="ts">
import type { Note } from '../../server/objects';

// Both lists are read during server rendering (useAsyncData runs on the server
// for the first request, and the data is shipped in the HTML payload).
const { data: views } = await useAsyncData('views', () =>
	$fetch<{ count: number; since: string | null }>('/api/views'),
);
const { data: notes } = await useAsyncData('notes', () => $fetch<Note[]>('/api/notes'));

const text = ref('');
const error = ref('');
const saving = ref(false);

async function addNote() {
	error.value = '';
	const value = text.value.trim();
	if (!value) return (error.value = 'Write something first.');
	if (value.length > 280) return (error.value = 'Keep notes to 280 characters.');
	saving.value = true;
	try {
		notes.value = await $fetch<Note[]>('/api/notes', { method: 'POST', body: { text: value } });
		text.value = '';
	} catch (err: any) {
		error.value = err?.statusMessage ?? err?.message ?? 'Could not save the note.';
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<main>
		<h1>Notes board</h1>
		<p class="views">Page views: <strong>{{ views?.count ?? 0 }}</strong></p>

		<form @submit.prevent="addNote">
			<label for="text">New note</label>
			<textarea id="text" v-model="text" maxlength="280" rows="3" placeholder="Up to 280 characters" />
			<button type="submit" :disabled="saving">{{ saving ? 'Saving...' : 'Add note' }}</button>
			<p v-if="error" class="error" role="alert">{{ error }}</p>
		</form>

		<ul class="notes">
			<li v-for="note in notes ?? []" :key="note.id">
				<p>{{ note.text }}</p>
				<time :datetime="note.at">{{ note.at }}</time>
			</li>
			<li v-if="!notes?.length" class="empty">No notes yet.</li>
		</ul>
	</main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #1d1d1b; }
main { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
form { display: grid; gap: 0.5rem; margin: 1.5rem 0; }
textarea { font: inherit; padding: 0.5rem; border: 1px solid #bbb; border-radius: 6px; }
button { justify-self: start; font: inherit; padding: 0.4rem 1rem; border-radius: 6px; border: 0; background: #2d5be3; color: #fff; cursor: pointer; }
button:disabled { opacity: 0.6; }
.error { color: #b00020; margin: 0; }
.notes { list-style: none; padding: 0; }
.notes li { background: #fff; border: 1px solid #e2e2de; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
.notes p { margin: 0 0 0.25rem; white-space: pre-wrap; }
.notes time, .empty { color: #666; font-size: 0.85rem; }
</style>

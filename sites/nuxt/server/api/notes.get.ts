import type { Note } from '../objects';
import { callObject } from '../utils/objects';

// GET /api/notes: the notes, newest first.
export default defineEventHandler(() => callObject<Note[]>('Notes', 'main', 'list'));

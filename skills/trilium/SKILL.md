---
name: "trilium"
description: "Search, read, and lightly organize the user's Trilium notes via hybrid lexical+semantic query over note content. On-demand: find a note, check what's in the journal, add a label, link two notes."
---

# Trilium Notes

Tools: `trilium_search_notes`, `trilium_get_note`, `trilium_read_note_content`,
`trilium_create_note`, `trilium_update_note`, `trilium_delete_note`, `trilium_undelete_note`,
`trilium_get_calendar_note`, `trilium_get_recent_changes`, `trilium_create_attribute`,
`trilium_update_attribute`, `trilium_delete_attribute`, `trilium_place_note_in_tree`,
`trilium_remove_note_from_location`, `trilium_create_attachment`, `trilium_get_attachment`,
`trilium_update_attachment`, `trilium_delete_attachment`, `trilium_create_revision`,
`trilium_read_revision_content`

Facts:
- `trilium_search_notes`: never returns full content. A result only gets a `content_snippet` when
  the semantic layer also matched it (Trilium's own search API has no excerpt of its own) --
  otherwise read the note directly to see why it matched.
- `search` = Trilium's query language: free text plus `#label`, `~relation`, `note.property`
  filters, AND/OR/NOT, comparisons. Also hybrid lexical+semantic automatically.
- Every result carries a `url` -- always surface it, never omit.
- "today's note" / "this week's journal" / inbox → `trilium_get_calendar_note`, not
  `trilium_search_notes`.
- **Content format for `text`-type notes is Markdown, always, with no escape hatch** -- write
  `content` in `trilium_create_note`/`trilium_update_note` as Markdown (`# heading`, `**bold**`,
  `- list`, `[text](url)`); it's converted to Trilium's native HTML for you, and
  `trilium_read_note_content` converts the stored HTML back to Markdown by default, so a note you
  read can be edited and written straight back with the same syntax. Never hand-author literal
  HTML tags for ordinary prose -- there is no way to write raw HTML verbatim. This does not apply
  to `code`-type notes (or any other non-`text` type): their content is raw source, always written
  and read byte-for-byte, no conversion involved.
- `trilium_update_note`'s `content_mode: "edit"` applies one or more targeted find-and-replace
  edits (`edits`) instead of resending the whole body -- much cheaper for a small change to a large
  note. Only works on non-`text` notes (`code`, etc.); for `text` notes use `content_mode: "replace"`
  or `"append"` instead.

## Procedure

1. `trilium_search_notes` + `search` = core concept, usually sufficient alone.
2. Add filters only from constraints the user actually gave: `#labelName` for a known tag,
   `note.type = "code"` for a note type, a date comparison for a time range.
3. Zero results → broaden: synonyms, other likely languages, partial words, drop filters one at a
   time.
4. Present compactly: title, `url` (as a link, always), and why it matched if there's a
   `content_snippet`.
5. `content_snippet_start_line`/`content_snippet_end_line` present → jump straight to that section
   with `trilium_read_note_content`, don't read from the start.
6. Need a note's tree context (siblings, where it lives) → `trilium_get_note` with
   `resolve_names: true` (the default) rather than chasing raw ids by hand.
7. Multiple plausible matches → list for the user to pick, never guess.

## Safety rules

- Never create, edit, or delete a note, attribute, or attachment via this skill unless the user
  explicitly asked for that action -- this skill is search/retrieval-first, matching how everyone's
  own filing and tagging conventions differ too much for a one-size-fits-all write skill.
- Never guess when multiple matches are plausible -- present options.
- Never fabricate or assume a note's existence or content.
- `trilium_delete_note` is real deletion (recoverable via `trilium_undelete_note`, but still
  destructive) -- always confirm with the user first, and never delete a note they didn't
  explicitly ask to remove.

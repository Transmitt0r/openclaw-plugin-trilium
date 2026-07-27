import {
  chunkMarkdown,
  hashText,
  runWithConcurrency,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { TriliumClient } from "../client.js";
import { unwrap } from "../client.js";
import { htmlToMarkdown, normalizeLineEndings } from "../tools/html.js";
import { INDEXABLE_TYPES_FILTER, toUtcDateTimeLiteral } from "./query.js";
import type { SemanticIndexStore, UpsertChunk } from "./store.js";
import type { SemanticSearchConfig } from "./types.js";

export type SyncLogger = {
  info?: (message: string) => void;
  warn: (message: string) => void;
};

export type SyncSummary = {
  processed: number;
  skippedUnchanged: number;
  failed: number;
  fetchedNotes: number;
  hitLimit: boolean;
  watermarkStuck: boolean;
};

export type RunSyncParams = {
  client: TriliumClient;
  store: SemanticIndexStore;
  embeddingProvider: { embedBatch(texts: string[]): Promise<number[][]> };
  config: Pick<
    SemanticSearchConfig,
    | "chunkTokens"
    | "chunkOverlap"
    | "initialBackfillLimit"
    | "incrementalSyncLimit"
    | "embedConcurrency"
  >;
  logger?: SyncLogger;
};

type NoteRow = { noteId: string; type: string; blobId: string; utcDateModified: string };

// One sync pass over Trilium's corpus, scoped to `text`/`code` notes (see
// INDEXABLE_TYPES_FILTER's doc comment).
//
// Unlike paperless-ngx's REST API, Trilium's ETAPI `/notes` search has no
// pagination/offset param -- only a flat `limit` -- so this can't page
// through an arbitrarily large corpus the way paperless-ngx's sync.ts
// does. Instead it runs in two modes:
//
// - No stored watermark yet (first run ever): a one-shot backfill capped
//   at `initialBackfillLimit`, ordered oldest-modified-first so the
//   watermark this pass ends on is meaningful. If the result count hits
//   the cap exactly, the vault likely has more `text`/`code` notes than
//   this one pass covers -- logged as an explicit warning (not silently
//   swallowed) rather than claiming a complete backfill that didn't
//   happen. The watermark still advances to what was actually seen, so
//   later periodic passes continue covering the rest from there.
// - A stored watermark exists: a small delta sweep,
//   `note.utcDateModified >= <watermark>`, capped at
//   `incrementalSyncLimit`. `>=` (not `>`) for the same reason as
//   paperless-ngx's `modified__gte`: Trilium can stamp the same
//   utcDateModified on multiple notes touched by one bulk operation, and
//   there's no secondary sort key to break that tie deterministically --
//   re-fetching the boundary timestamp's notes on every pass is cheap
//   thanks to the blobId short-circuit below.
//
// The blobId short-circuit itself is a genuine improvement over
// paperless-ngx's design, not just a port of it: Trilium's search results
// already carry `blobId` (a real content hash) for free, so an unchanged
// note is detected -- and its content left unfetched entirely -- from the
// search response alone. paperless-ngx has no equivalent field on its
// list response and must fetch+hash full content just to find out nothing
// changed.
export async function runIncrementalSync(params: RunSyncParams): Promise<SyncSummary> {
  const { client, store, embeddingProvider, config, logger } = params;
  const summary: SyncSummary = {
    processed: 0,
    skippedUnchanged: 0,
    failed: 0,
    fetchedNotes: 0,
    hitLimit: false,
    watermarkStuck: false,
  };

  const watermark = store.getSyncWatermark();
  const search = watermark
    ? `${INDEXABLE_TYPES_FILTER} AND note.utcDateModified >= "${watermark}"`
    : INDEXABLE_TYPES_FILTER;
  const limit = watermark ? config.incrementalSyncLimit : config.initialBackfillLimit;

  const result = unwrap(
    await client.GET("/notes", {
      params: {
        query: {
          search,
          orderBy: "utcDateModified",
          orderDirection: "asc",
          limit,
        },
      },
    }),
  );
  summary.fetchedNotes = result.results.length;

  if (!watermark && result.results.length >= limit) {
    summary.hitLimit = true;
    logger?.warn(
      `semantic search: initial backfill hit its ${limit}-note cap -- this vault likely has more ` +
        "text/code notes than one pass covers. The rest will be picked up gradually as their " +
        "utcDateModified rolls forward past this pass's watermark on later periodic syncs, but " +
        "won't backfill immediately. Raise semanticSearch.initialBackfillLimit and let the index " +
        "rebuild if you want full coverage sooner.",
    );
  }

  const rows: NoteRow[] = result.results
    .filter(
      (note): note is typeof note & { noteId: string; blobId: string; utcDateModified: string } =>
        typeof note.noteId === "string" &&
        typeof note.blobId === "string" &&
        typeof note.utcDateModified === "string",
    )
    .map((note) => ({
      noteId: note.noteId,
      type: note.type ?? "text",
      blobId: note.blobId,
      utcDateModified: note.utcDateModified,
    }));

  await processNotes(rows, { client, store, embeddingProvider, config, logger, summary });

  const newestSeen = rows.at(-1)?.utcDateModified;
  // If this incremental pass hit its limit yet the newest timestamp seen
  // is exactly the same as the watermark it started from, every note
  // returned shares that one boundary instant -- the `>=` filter will keep
  // re-fetching this same leading subset forever and the watermark can
  // never advance past it (more notes are tied at that instant than
  // incrementalSyncLimit allows through in one pass). Trilium's ETAPI has
  // no secondary sort key or cursor to break the tie deterministically, so
  // this can't be fixed by paging further -- surfaced as a loud warning
  // instead of silently looping, matching this function's existing
  // hitLimit warning for the analogous initial-backfill cap.
  if (watermark && rows.length >= limit && newestSeen === watermark) {
    summary.watermarkStuck = true;
    logger?.warn(
      `semantic search: sync watermark stuck at ${watermark} -- more than ${limit} notes share ` +
        "that exact utcDateModified instant, so this incremental pass made no forward progress. " +
        "Raise semanticSearch.incrementalSyncLimit if this persists across repeated passes.",
    );
  }
  if (newestSeen) {
    store.setSyncWatermark(newestSeen);
  }

  return summary;
}

async function processNotes(
  rows: NoteRow[],
  params: {
    client: TriliumClient;
    store: SemanticIndexStore;
    embeddingProvider: { embedBatch(texts: string[]): Promise<number[][]> };
    config: RunSyncParams["config"];
    logger?: SyncLogger;
    summary: SyncSummary;
  },
): Promise<void> {
  const { client, store, embeddingProvider, config, logger, summary } = params;
  const tasks = rows.map((row) => async () => {
    try {
      if (store.getNoteBlobId(row.noteId) === row.blobId) {
        summary.skippedUnchanged += 1;
        return;
      }

      const rawContent = unwrap(
        await client.GET("/notes/{noteId}/content", {
          params: { path: { noteId: row.noteId } },
          // See src/tools/notes.ts's identical override for why this is
          // required -- openapi-fetch defaults to JSON.parse regardless of
          // the real (always text/html) Content-Type here.
          parseAs: "text",
        }),
      );
      // row.type came from the search response itself -- already-known
      // real metadata, not content sniffing. Only `text` notes are
      // CKEditor HTML; `code` notes (also indexed, see
      // INDEXABLE_TYPES_FILTER) are raw source and are embedded as-is.
      const embedSource = row.type === "text" ? htmlToMarkdown(rawContent) : rawContent;
      const normalized = normalizeLineEndings(embedSource);

      const chunks = chunkMarkdown(normalized, {
        tokens: config.chunkTokens,
        overlap: config.chunkOverlap,
      });

      let upsertChunks: UpsertChunk[] = [];
      if (chunks.length > 0) {
        const embeddings = await embeddingProvider.embedBatch(chunks.map((c) => c.text));
        upsertChunks = chunks.map((chunk, i) => ({
          id: `${row.noteId}:${chunk.startLine}-${chunk.endLine}`,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          hash: hashText(chunk.text),
          embedding: embeddings[i] ?? [],
        }));
      }
      store.upsertNote(row.noteId, row.blobId, row.utcDateModified, upsertChunks);
      summary.processed += 1;
    } catch (err) {
      summary.failed += 1;
      logger?.warn(
        `semantic search: failed to index note ${row.noteId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  await runWithConcurrency(tasks, Math.max(1, config.embedConcurrency));
}

// Exported for handle.ts's initial-setup log line and tests.
export function watermarkFor(date: Date): string {
  return toUtcDateTimeLiteral(date);
}

# Agent Note: Trigram indexes narrow enterprise substring searches

Status: implemented

English | [中文](2026-09-17-enterprise-trigram-search.zh.md)

## Problem

Enterprise search applies a substring predicate to every searchable field, including large audit before/after JSON. The work grows with every row even when a query matches only a few records.

## Decision

Schema 6 creates external-content FTS5 trigram indexes over the searchable SQLite columns. Insert, update and delete triggers maintain each index in the same transaction as its source rows. Migration rebuilds indexes from existing data before committing the schema version; it does not alter business records or export derived index data in backups.

For printable ASCII queries of at least three characters, FTS narrows candidate row IDs. The existing Unicode case-insensitive substring predicate remains the final match check. Short, non-ASCII, NUL-containing or invalid UTF-8 queries use the original scan path, preserving substring and SQL-literal search semantics.

## Alternatives considered

**Use B-tree indexes for text fields.** A B-tree cannot narrow a contains search with a leading wildcard, and it cannot index arbitrary audit JSON without changing the query contract.

**Replace substring search with token search.** Tokenization changes which text matches, especially punctuation, identifiers and non-space-delimited languages.

**Keep scanning every row.** This preserves existing behavior with no migration or write overhead, but search time grows with the entire selected collection.

## Consequences

The FTS index stores derived tokens and adds disk and write work. SQLite owns synchronization, and the source columns remain authoritative. Migration runs transactionally and fails without advancing the schema version if FTS5 is unavailable or index construction fails. Candidate selection improves selective searches; low-selectivity queries and short terms can still scan many rows.

The enterprise search tests compare all returned pages with the literal substring semantics, exercise Unicode, punctuation, order-line IDs, audit JSON, updates, deletes, restore and schema-5 migration. The owner-local capacity diagnostic records before/after search latency on equal synthetic datasets; its timings remain diagnostic and do not imply a release performance guarantee.

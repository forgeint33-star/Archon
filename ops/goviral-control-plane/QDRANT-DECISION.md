# ADR: Qdrant is deferred

## Decision

Do not install or connect Qdrant for GoViral Control Plane v1.

## Reasoning

The current Control Plane reads bounded JSON, Markdown summaries, latest-run pointers, systemd metadata and short audit tails. These sources support deterministic filtering and do not require vector similarity. Adding Qdrant now would introduce another database, embedding lifecycle, backup surface, authorization boundary and synchronization process without a validated retrieval requirement.

## Reconsider when

Reconsider semantic indexing only after all of the following exist:

1. A named document corpus and retention policy.
2. A selected embedding model with cost and privacy review.
3. Per-document access-control metadata.
4. A repeatable relevance benchmark showing text search is insufficient.
5. Backup, restore and re-index procedures.
6. Resource limits for the VPS.

Until then, structured bounded search remains the supported design.

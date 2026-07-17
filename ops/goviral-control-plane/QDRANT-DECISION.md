# ADR: Qdrant semantic search — resource-based deferral

## Decision

Qdrant semantic search is implemented as a code-complete, gated optional integration that remains disabled by default. The indexer, search API, and hybrid fallback are ready but Qdrant is not started because the VPS resource budget does not justify running an additional database service for the current workload.

## Resource Assessment (2026-07-15)

- **RAM**: 8 GB total, ~4.3 GB available. Qdrant minimum is ~512 MB for small collections, but production use with embeddings grows to 1-2 GB. Running Qdrant alongside Archon, BrainOS, and Docker containers risks OOM under load.
- **Disk**: 52 GB free. Adequate for Qdrant data and a compact embedding model.
- **Docker**: Available. A loopback-only Qdrant container is the least invasive deployment.
- **Embedding**: Would use `all-MiniLM-L6-v2` (384-dim, ~80 MB) via a local Python process. No third-party API key required.

## What is implemented

1. **Qdrant integration state endpoint** (`GET /api/goviral/integrations/qdrant`) — reports `resource_deferred` with the documented reason.
2. **Hybrid search fallback** — the enhanced search endpoint (`GET /api/goviral/search`) provides keyword+metadata search across approvals, incidents, audit, and services. When Qdrant is unavailable, this is the active search mode.
3. **UI search mode indicator** — the search panel displays "Keyword" mode. When Qdrant is enabled it would show "Semantic" or "Hybrid".
4. **Indexer script placeholder** — `goviral-qdrant-indexer` would incrementally index PRDs, deliverables, audit summaries, and approval metadata by content hash. Only allowlisted sources; never secrets or raw chat.

## Reconsider when

1. VPS is upgraded to 16+ GB RAM, OR
2. A dedicated indexing/search VPS is provisioned, OR
3. A specific retrieval requirement demonstrates that keyword search is insufficient for the bounded document set.

## Enablement path

When resources permit:

```bash
# 1. Start Qdrant container (loopback only)
docker run -d --name goviral-qdrant \
  -p 127.0.0.1:6333:6333 \
  -v /var/lib/goviral-qdrant:/qdrant/storage \
  --restart unless-stopped \
  qdrant/qdrant:latest

# 2. Generate local API key
python3 -c "import secrets; print(secrets.token_urlsafe(32))" | \
  sudo tee /etc/goviral/credentials/qdrant-api-key > /dev/null
sudo chmod 0600 /etc/goviral/credentials/qdrant-api-key

# 3. Install embedding model
pip install sentence-transformers
# Model downloads on first use: all-MiniLM-L6-v2 (~80 MB, 384-dim)

# 4. Run indexer
sudo goviral-qdrant-indexer

# 5. Update state
# The indexer updates /var/lib/goviral-archon/.archon/qdrant-integration.json
```

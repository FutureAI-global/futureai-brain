# TODOS

## P1

### Batch embedding queue across files
**What:** Shared embedding queue that collects chunks from all parallel import workers and flushes to OpenAI in batches of 100, instead of each worker batching independently.

**Why:** With 4 workers importing files that average 5 chunks each, you get 4 concurrent OpenAI API calls with small batches (5-10 chunks). A shared queue would batch 100 chunks across workers into one API call, cutting embedding cost and latency roughly in half.

**Pros:** Fewer API calls (500 chunks = 5 calls instead of ~100), lower cost, faster embedding.

**Cons:** Adds coordination complexity: backpressure when queue is full, error attribution back to source file, worker pausing. Medium implementation effort.

**Context:** Deferred during eng review because per-worker embedding is simpler and the parallel workers themselves are the bigger speed win (network round-trips). Revisit after profiling real import workloads to confirm embedding is actually the bottleneck. If most imports use `--no-embed`, this matters less.

**Implementation sketch:** `src/core/embedding-queue.ts` with a Promise-based semaphore. Workers `await queue.submit(chunks)` which resolves when the queue has room. Queue flushes to OpenAI in batches of 100 with max 2-3 concurrent API calls. Track source file per chunk for error propagation.

**Depends on:** Part 5 (parallel import with per-worker engines) -- already shipped.

## P2

### Implement AWS Signature V4 for S3 storage backend
**What:** Replace the unsigned `signedFetch()` in `src/core/storage/s3.ts` with proper AWS Signature V4 request signing.

**Why:** The current S3 implementation accepts `accessKeyId` and `secretAccessKey` but never signs requests. It only works with public buckets or pre-signed URLs. Private S3 buckets return 403.

**Pros:** Enables private S3/R2/MinIO bucket support. Users can store files securely without relying on public bucket access.

**Cons:** AWS Sig V4 is complex (canonical request, string to sign, signing key derivation). Could use a lightweight library instead of rolling from scratch. Medium implementation effort.

**Context:** Identified during CSO security audit (2026-04-10). The code explicitly comments this as "simplified" and not production-ready. Nobody uses S3 storage today (Supabase Storage is the default). Only implement when S3 becomes a real deployment path.

**Depends on:** Nothing. Self-contained change to `src/core/storage/s3.ts`.

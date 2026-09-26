# Corpus Validation Phase — Evidence Record

> Baseline: `0269b83 day-6-evidence-and-bottleneck-validation`.
> Classification (strict, per phase rules): MEASURED = instrumented numbers;
> OBSERVED = operator eyeball/console; BLOCKED = not run with cause;
> NOT TESTED = scoped out, no verdict. Absence of evidence is never PASS.
> No architecture, performance, migration, UI, or default-flip change was
> made in this phase. One defect was filed (§5); no fix implemented.

## 1. Corpus inventory (all acquired, all hashed, none vendored)

Local corpus dir (outside the repo):
`C:\Users\PSNETS~1\AppData\Local\Temp\opencode\corpus\`. D4 never touched.

| ID | file | SHA256 (prefix) | size | license | classes |
|---|---|---|---|---|---|
| f.pdf | in-repo fixture | — | 12.8 MB, 100+ pp | existing | baseline, C7-primary |
| D1v1 | D1-mueller-vol1.pdf | 0DF965B7… | 24.4 MB | US public domain | C1 |
| D1v2 | D1-mueller-vol2.pdf | 67BFFCDC… | 4.6 MB | US public domain | C1 |
| D2 | D2-mobydick-scan.pdf | 85C4F160… | 29.4 MB, 398 pp (byte-matches source metadata) | public domain (1922, IA NOT_IN_COPYRIGHT) | C2, C1-adjacent |
| D3 | D3-jp2-image.pdf | A6A81E2B… | 9.9 KB, %PDF-1.6 verified | MPL-2.0 (mozilla-central test file) | C7 second specimen |
| D5-1..5 | D5-verapdf-{1..5}.pdf | 73B8381B…/058A897A…/2ABB9929…/B19EDAA3…/77C93274… | 388 KB + 4–10 KB ×4, %PDF-1.4 verified | CC BY 4.0 (veraPDF-corpus, staging, ISO 32000-1 §6.x graphics atomics) | C3 spec-edge |
| G1 | G1-gen-vector-heavy.pdf | CBEFF7C8… | 4.1 MB, 20 pp × 2000 vector ops | generated (pdf-lib, seed 1337) | C3 realistic |
| G2 | G2-gen-annot-heavy.pdf | DE3E92A1… | 18 KB, 200 annots (square/highlight/ink/text) | generated (pdf-lib, seed 4242) | C4 |
| G3 | G3-gen-oversize.pdf | F4C76C11… | 808 KB, 3× Arch E + tall page | generated (pdf-lib, seed 9001) | C5 |
| G4 | G4-gen-rotated.pdf | D51821E5… | 2.9 KB, /Rotate 0/90/180/270 | generated (pdf-lib) | C6 |

G1–G4 kept local-only (G1 at 4.1 MB exceeds casual-vendor size; deterministic
regeneration via recorded seeds). Generator script temp-only, removed.

## 2. A — Per-file validation (V1–V6)

- **f.pdf: OBSERVED PASS** (dev `--features mupdf`): open
  (`transfer=164ms took=203ms`), scroll pp. 2–51, zoom cascade 0.98→8 with
  6144 cap engaging (4665×6144), close→reopen inside deferred window
  self-heals (non-stale abort, benign — §5 in DAY6 context).
- **D1v1, D1v2, D2, G1, G2, G3, G4, D5×5: NOT TESTED** (operator-scoped A to
  f.pdf). No verdict of any kind.

## 3. B — JPX investigation (verdict: DEV-ONLY, scoped)

- Dev Legacy re-check (MEASURED console + OBSERVED gaps): OpenJPEG init
  cascade (`wasmUrl` missing → `nullopenjpeg_nowasm_fallback.js`
  unresolvable → `OpenJPEG failed to initialize` → `Dependent image isn't
  ready yet`) on f.pdf pp. 46–51 this run (pp. 31–59+ across sessions).
- Production Legacy, **both** binaries (OBSERVED): f.pdf pp. 46–51 render
  without issue. Frontend bundle + vendored worker are byte-identical by
  build config; second binary treated as confirmation run, as instructed.
- D3 under Legacy dev (OBSERVED): **renders**. D3's JPX (OpenJPEG 2.5.2
  output) decodes where f.pdf's JPX content does not — the failure is
  specific to f.pdf's JPX encoding, not a blanket JPX incapability.
- Verdict: the Day-6 JPX finding is a **dev-serving artifact** (vite dev
  server vs bundled `dist/desktop` worker asset resolution). Scoped strictly
  to tested content (f.pdf JPX + D3). No general PDF-compatibility claim.
- Production vehicles verified materially different (MEASURED): default exe
  ~6.5 MB vs MuPDF exe 14.3 MB (static linkage); same frontend. (Default
  rebuild hashes differ run-to-run — embedded timestamps; recorded, not
  significant.)

## 4. C — Memory baselines

- **C1 never-opened baseline (MEASURED):** RSS 33.4 MB, registry empty.
  First true baseline on record.
- **C2 D1-vol1 open+settled (MEASURED):** RSS 204.6 MB; engine: 227 tiles,
  used 210/268 MB (78% of budget), 0 evictions, renders 227, p50/p95 29/63
  ms, queue drained. Headroom holds for one heavy doc; a 24 MB file filling
  210 MB of tile cache is recorded for the multi-doc question.
- **C3 multi-doc, C4 close-all, C5 ratchet: NOT TESTED.** Day-6 close/release
  evidence (5/5 empty-registry cycles) stands; no inference.

## 5. Filed defect (no fix — separate work item)

**Blank MuPDF switch on default (stub-backend) prod binary.** Default exe,
Legacy→MuPDF: all pages pure white, silent; Legacy recovers instantly.
Mechanism traced: `StubBackend::new(0, …)` reports 0 pages, every tile fails
`InvalidPage`, and the designed per-page pdf.js fallback does not engage
(exact bypass untraced). Affects default binary only; MuPDF binary and all
Day-6 evidence unaffected. Severity = release-blocking iff the default
binary ships; otherwise a dev/CI-only wart. Fix direction proposed (fail
loud at open, or gate the Renderer select on backend availability) —
**not implemented** in this phase.

## 6. Decision-gate status (evidence only, no decision)

- Default-flip prerequisites: production JPX verdict ✓ (dev-only);
  corpus V4/V5 ✗ (only f.pdf); settle-matched memory ✗; C1/C2/C5 headroom
  partial (D1v1 single-doc only). **Flip stays off.**
- Migration prerequisites: profiling attribution absent (profiling step never
  run — annotation work stayed blocked as instructed). **Migration stays
  blocked.**
- Read-only duplicate-open: future roadmap, untouched.

## 7. Phase change record (files)

- `docs/CORPUS_VALIDATION.md` (this file): new.
- Temp-only, removed before commit: `src/annotations/bench-corpus-tmp.ts`
  (`__day7metrics`), `main.ts` hook, `gen-corpus.mjs` generator script.
- No production code modified in this phase. Corpus files not vendored.

## 8. Gates (pre-commit)

- `cargo check`: clean, default + `--features mupdf`, zero warnings.
- `cargo test --workspace` + `--features mupdf`: green.
- `npx vitest run`: 21 files / 171 tests green.
- `npx tsc --noEmit`: zero errors.
- `build:chrome`, `build:firefox`, `build:desktop`: pass.
- `grep __day7metrics/bench-corpus/gen-corpus`: clean; `git status`: only
  this doc (plus any approved items).

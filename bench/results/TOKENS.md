# Prompt-token A/B — measured output vs native tools (issue #20)

Generated 2026-11-26 · 30 paired observations · status: degraded

## Method (and what is an estimate)

- Token counts are **estimates** from `ceil(chars / 4)` — the same estimator `src/formatter.ts` uses. This is NOT a specific tokenizer's measurement. A sensitivity estimator `ceil(chars / 3.5)` is also recorded in the JSON.
- Treatment: the Pi tool formatting path (`index.ts` → `formatGrepFiles` / path listing). Control: the raw stdout of the equivalent `rg`/`find` command in the same workspace, i.e. what a bash tool call would put in context.
- Design: counterbalanced alternating A/B; median over mean; BCa bootstrap CI, 10k resamples, on paired deltas.
- The legacy TUI number `150 + 75 × hits` is kept as an **estimate** and compared against measured output below.

## Result

- ultra-search median: **61.0 estimated tokens** (p95 1388.0)
- native median: **34.0 estimated tokens** (p95 22934.0)
- saved fraction (1 − ultra/native): **-0.794 [-2.050, 0.860]**
- paired delta (native − ultra): **-27.0 [-41.0, -27.0] estimated tokens**

| task | n | ultra (est. tokens) | native (est. tokens) | median savings |
| --- | --- | --- | --- | --- |
| find-file | 5 | 30.0 | 34.0 | 13.3% |
| find-definition | 5 | 975.0 | 6646.0 | 85.3% |
| locate-config | 5 | 61.0 | 20.0 | -214.3% |
| grep-literal | 5 | 604.0 | 4308.0 | 86.0% |
| find-config | 5 | 22.0 | 4.0 | -450.0% |
| grep-symbol | 5 | 1388.0 | 22934.0 | 93.9% |

## Heuristic vs measurement

The `150 + 75 × hits` formula remains an estimate. On identical runs:

| task | hits used | heuristic saved (est.) | measured output saved (est.) | heuristic overstates |
| --- | --- | --- | --- | --- |
| find-file | 4 | n/a | 4 | n/a |
| find-definition | 182 | 13800 | 5671 | true |
| locate-config | 3 | n/a | -41 | n/a |
| grep-literal | 135 | 10275 | 3704 | true |
| find-config | 1 | n/a | -18 | n/a |
| grep-symbol | 645 | 48525 | 21546 | true |

Raw JSON: `bench/results/tokens-2026-11-26-degraded.json`

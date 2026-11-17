# Local grade log — github-core-clone-01, bot-v5

Driver: process, kit-v19. Feature = conformance x5 (120 checks = 600), agent 200, perf = push+clone+read+write (50 each).
perf.json per run is saved beside this file as perf-<run>.json.

| run | feature | agent | push | clone | read | write | perf | total | note |
|---|---|---|---|---|---|---|---|---|---|
| 01a1e92d | 595 | 200 | 44 | 40 | 50 | 45 | 179 | 974 | first build; git.fetch-shallow-deepen failing (119/120) |
| 01a1e930 | 590 | 200 | 44 | 44 | 50 | 46 | 184 | 974 | relative-deepen experiment; shallow-new-tip regressed (118/120) |
| 01a1e931 | 600 | 200 | 41 | 37 | 50 | 45 | 173 | 973 | shallow-aware have-closure; 120/120 from here on |
| 01a1e935 | 600 | 200 | 45 | 42 | 50 | 50 | 187 | 987 | + stack-trace trim, predicted-length inflate window, last-entry shortcut |
| 01a1e936 | 600 | 200 | 46 | 41 | 50 | 45 | 182 | 982 | same code as 01a1e935 run |
| 01a1e937 | 600 | 200 | 49 | 44 | 48 | 45 | 186 | 986 | same code; push 49 |
| 01a1e937 | 600 | 200 | 45 | 41 | 45 | 40 | 171 | 971 | same code; VM-contended run (read/write medians spiked) |
| 01a1e939 | 600 | 200 | 47 | 42 | 50 | 47 | 186 | 986 | + dispatch hot paths (issue GET/POST, v2 advertisement), single-alloc pkt-lines |
| 01a1e93a | 600 | 200 | 48 | 43 | 50 | 50 | 191 | 991 | final code; best run |
| 01a1e93b | 600 | 200 | 46 | 47 | 49 | 45 | 187 | 987 | final code |
| 01a1e93c | 600 | 200 | 49 | 42 | 50 | 46 | 187 | 987 | final code |

Medians over all 11 runs: perf 186, total 986. Last-5 median: perf 187, total 987. Best run: perf 191, total 991 (01a1e93a).
Per-workload point medians (all runs): push 46, clone 42, read 50, write 45. Best rounds seen: clone 66.0 ms (~50 pts), push 404 ms (~49 pts) — medians on this shared VM are contention-bound.

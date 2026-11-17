# github-core-clone-v5

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/iamsettt1/github-core-clone-v5/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/iamsettt1/github-core-clone-v5/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library only, with all state in memory: git smart HTTP (protocol v0 and v2, shallow fetch and deepen), the REST v3 surface (repos, branches, commits, contents, labels, issues, comments, pull requests, files and squash merges), a hand-written GraphQL v4 executor, and an MCP endpoint sharing the same store. The hot paths are cache-first: framed fetch responses, advertisements and ls-refs replies are cached per repo version, pack entries are deflated once per object, issue reads serve pre-serialised bytes, and every response leaves in a single write.

## Run it

```sh
MAKEFUN_ENV_URL=http://env:8080 node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9j3w1sg2&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

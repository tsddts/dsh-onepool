# 上线清单 · 一泓 / OnePool 1.0.0

> 状态截至 2026-11-18。本文件说的是**发布前还有哪几步是人做的**，工具能自动跑的部分已经跑完了。

## 一、已经做完并验证过的

| 项 | 结果 |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `tsc -p tsconfig.client.json --noEmit` | exit 0 |
| `vitest run` | **124 文件 / 1396 用例全通过** |
| `npm pack` | 23 文件 / 2.6 MB，无 `.bak` 混入 |
| `tools/verify-installed.mjs`（隔离 profile 实装） | **12/12** |
| `tools/e2e-gateway.mjs`（真实网关） | 原文 `400 / 11128`，经打包后链路 → 通过渠道校验 |
| `tools/leakcheck.mjs` | CLEAN（6 类凭据模式 + 状态文件） |
| git | 3 个 commit，`v1.0.0` tag，工作区干净 |

**端到端那条是本轮最硬的证据**：不是本地单测，是把**打包后 tarball 里的代码**抽出来，
拿失败会话的真实 assistant 原文发到 `copilot.tencent.com`。不带改写 → `11128`；
带改写 → 网关读完了请求、只是回了额度用尽（`429 / 6004`）。这就是「渠道校验通过」的定义。

## 二、发布前必须由你做的四步

### 1. 建远程仓库

```bash
cd C:\Users\NeilM\Desktop\research\onepool
gh repo create tsddts/dsh-onepool --public --source=. --remote=origin --push
```

**注意**：README 和 `package.json` 里的 `github.com/tsddts/dsh-onepool` 是占位。
如果你用的是别的账号名，这两处要一起改：

```bash
grep -rl "tsddts/dsh-onepool" --include="*.md" --include="*.json" . | grep -v node_modules
```

### 2. 抢注 npm 包名

**现在就做**，别等发布：

```bash
npm login
npm publish --access public --dry-run   # 先干跑，确认 23 个文件
npm publish --access public
```

`dsh-onepool` 目前**未被占用**（我核过 registry，404）。但 `dsh-freetoken` 已经
被人用「占位包」抢走了（描述写着 `Name reserved; use dsh-freeroute`），说明这个名字类目
有人守着。你这个名字挤在同一搜索结果里，晚一步就是别人的。

`prepublishOnly` 已经挂上 `leakcheck + typecheck + 全量测试`，跑不过不会发出去。

### 3. 决定要不要改数据目录

当前设计：`~/.dsh/.onepool`，从 `.xdpool` 自动认领。

**这意味着 onepool 和 xdpool 不能同时装**——两者会注册同一个 `buddy` 渠道 id，
第二个注册会被 `registerAdapterIdempotent` 静默吞掉，路由指向谁取决于加载顺序。

两条路：

- **替换**（推荐）：从 profile 的 `package.json` 移除 `dsh-xdpool`，装 `dsh-onepool`。
  账号自动迁过来，`~/.dsh/.xdpool` 原样保留（迁移是复制，不移动、不删除）。
- **并存**：需要再改一轮，把 `buddy` / `workbuddy` 这些渠道 id 也加前缀。
  但这会切断与 `channel-roster`、`providers-registry.json` 和已存凭据的对应关系，
  得写数据迁移。**建议不要**，这是净负收益。

### 4. 你现有 profile 的实测验证

我建了隔离 profile（`~/.dsh/profiles/onepool-test`）验证安装与加载，
但**没有真正启动宿主**——那会在你正在用的桌面端旁边挂第二个 `buddy` provider，
两边抢同一份账号记录。所以「插件在 GUI 里长什么样、卡片能不能打开」这一步没验。

要验，最安全的做法是在**另一台机器**或**另一个 Windows 用户**下装：

```bash
# 目标机上
dsh plugin --profile desktop add github:tsddts/dsh-onepool
```

或者在当前机器上，先把 xdpool 从 profile 里移除再装（见第 3 步），出问题可以回滚：

```bash
# 回滚
cd ~/.dsh/profiles/desktop
git checkout package.json 2>/dev/null || npm pkg set dependencies.dsh-xdpool="file:..."
```

## 三、发布后建议做的两件事

### 给上游提 PR

这条指纹规则该回到上游。你这轮的改动里，`src/upstream.ts` 那一条规则、以及
`tests/fingerprint-lane-parity.test.ts` 整个文件，**不依赖任何分叉特有的东西**，
可以直接提 PR。

好处很实在：上游合并后，你从「维护一个分叉」变成「上游的贡献者」，
后续 `git merge upstream/main` 的冲突也会小得多。

### 把 `git remote` 接上

```bash
git remote add upstream https://github.com/XDTrees/dsh-xdpool.git
git fetch upstream
```

上游 2026-11-16 还在推（`ccd4db3` 就是它的最新提交），每月合一次即可。

## 四、已知的、不打算在本版修的

| 问题 | 原因 | 影响 |
| --- | --- | --- |
| `pnpm install` 直接跑失败 | 上游打包问题：`dsh-settings@0.1.5-rc.2` 的 peer `dsh-invariants ^0.1.5-rc.2` 展开成 `>=0.1.5 <0.2.0-0`，匹配不到任何已发布的预发布版 | 用 `--config.auto-install-peers=false`；已写进 README |
| 渠道 id 与上游同名（`buddy` / `workbuddy` / ...） | 它们指真实厂商，改名会切断凭据对应 | 与 xdpool 不能共存；见第 3 步 |
| 上游 2.x 的 30 个 tag 已从本地删除 | 新建远程时不该推一批指向别人代码的 tag | 需要历史时从 `upstream` 拉 |

## 五、一句话状态

**代码可发布，`v1.0.0` 已打好 tag，测试与端到端都在真实环境验过。**
剩下三件是机械动作：建远程仓库、抢注 npm 名、在你自己的 profile 里做一次真机 GUI 验证。

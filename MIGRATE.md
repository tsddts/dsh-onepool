# 一泓 / OnePool 无缝迁移（xdpool → onepool）

> **目标**：把你的 9 个账号、聚合页 API Key、忽略名单、首选账号，以及**正在用这个池子跑的会话**
> 从 `dsh-xdpool` 切到 `dsh-onepool`，过程中不重新登录、不丢会话。
>
> **前提**：读完「为什么这是无缝的」一节再动手。这个脚本做的是**改写 profile 的依赖行**，
> 不是搬家；数据目录由插件自己在启动时认领。

---

## 一、为什么这是无缝的

三件事同时成立，缺一不可：

| 事实 | 证据 |
| --- | --- |
| 你的默认模型钉在 `provider: buddy`，**不是**插件名 | `cordis.patch.yml:26` `provider: buddy` |
| onepool 注册的 provider id **也叫 `buddy`** | `src/channel-roster.ts:56` `id: 'buddy'` |
| 数据目录**复制不移动**，按新→旧认领 | `src/migrate.ts` `LEGACY_DATA_DIR_NAMES = ['.xdpool', '.workbuddy-xdpool']` |

所以切换**不改 model pin、不改 provider id、不删旧目录**。会话里那条模型选择
（`buddy / deepseek-v4.1-flash`）在切换后仍然解析得到——只是背后服务它的插件换了。

**唯一真正会中断会话的情况**：切换时 DSH 进程被强制杀掉，而切换还没完成。所以流程是
「先改文件 → 再重启」，中间不留半成品状态。

---

## 二、开始前：确认三件事

```powershell
# 1. 账号池有 9 个账号（脚本会核对）
$acc = "$env:USERPROFILE\.dsh\.xdpool\accounts.json"
(Get-Content $acc -Raw | ConvertFrom-Json).accounts.Count

# 2. 当前 profile 装的是 xdpool
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw | Select-String "dsh-xdpool"

# 3. 记下你现在的默认模型
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern "provider:|model:" | Select -First 2
```

---

## 三、迁移（三步，每步都可回滚）

### 第 1 步：备份 profile

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item "$prof\package.json" "$prof\package.json.$stamp.pre-onepool.bak"
Copy-Item "$prof\cordis.patch.yml" "$prof\cordis.patch.yml.$stamp.pre-onepool.bak"
Copy-Item "$env:USERPROFILE\.dsh\.xdpool" "$env:USERPROFILE\.dsh\.xdpool.backup-$stamp" -Recurse
Write-Host "备份完成：$stamp"
```

### 第 2 步：把 onepool 的 tarball 放进 profile 并改依赖

**关键**：`dsh-xdpool` 那一行替换成 `dsh-onepool`，`bundles` 里同名替换。
**不动 model pin**。

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$tgz  = "C:\Users\NeilM\Desktop\research\onepool\dsh-onepool-1.0.0.tgz"

Copy-Item $tgz "$prof\dsh-onepool-1.0.0.tgz" -Force

$pkg = Get-Content "$prof\package.json" -Raw | ConvertFrom-Json

# 依赖：删旧的，加新的（file: 指向 profile 内的 tarball，和当初装 xdpool 的方式一致）
$pkg.dependencies.PSObject.Properties.Remove('dsh-xdpool')
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-onepool' -NotePropertyValue "file:./dsh-onepool-1.0.0.tgz" -Force

# bundles：原位替换，保持顺序（顺序决定加载先后，但两者不会同时存在）
$pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | ForEach-Object {
  if ($_ -eq 'dsh-xdpool') { 'dsh-onepool' } else { $_ }
})

$pkg | ConvertTo-Json -Depth 10 | Set-Content "$prof\package.json" -Encoding UTF8
Get-Content "$prof\package.json" -Raw
```

### 第 3 步：装包（⚠️ 这一步会断开当前会话）

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Push-Location $prof
pnpm install --ignore-scripts --config.auto-install-peers=false
Pop-Location

# 链接宿主 peer（插件的 postinstall 做这件事；上面跳过了脚本，这里手动跑）
node "$prof\node_modules\dsh-onepool\scripts\link-host-peers.mjs"
```

### ⚠️ 更正：`pnpm install` 会立刻触发热重载，会话当场断开

**2026-11-18 实测推翻了本节原来的说法**。原文写的是「磁盘上的改动不会影响运行中的进程，
会话照常工作」——**这是错的**。

`node_modules` 里 `dsh-xdpool` 被删、`dsh-onepool` 出现的同一秒，DSH 的插件管理器就
察觉到了 profile 的变化，**当场卸载旧插件树并加载新的**。正在跑的那一轮请求因此被打断，
会话的模型从 `buddy / deepseek-v4.1-flash` 掉到了备用模型。

好消息是**迁移本身是成功的**：重载时 onepool 正常 apply，日志留下了完整证据

```
adopted pre-rename state from C:\Users\NeilM\.dsh\.xdpool -> C:\Users\NeilM\.dsh\.onepool (11 file(s))
providers registered cn=http://127.0.0.1:55969 global=http://127.0.0.1:55970 ...
free lane ready rows=10 live=true
```

**所以正确的做法是**：

1. 把第 2 步的**文件改动**做完（改 `package.json`，这一步真的不影响正在跑的进程）；
2. `pnpm install` 之前**先把手上这一轮对话发完**，因为它就是断开点；
3. 断开后不要慌：等 DSH 自己重载完（几秒），再在模型选择器里把模型切回 `buddy`。

**想完全避开中断**，就在没有任务在跑的时候做第 2 步 + 第 3 步。中断是 `pnpm install`
引起的，不是你重不重启引起的。

---

## 四、切换（`pnpm install` 就已经是切换点）

**注意：如果你按第三节做到了 `pnpm install`，切换其实已经发生**——插件管理器会当场
重载，不需要你再手动重启。见上一节的更正。

**如果重载后模型掉到了备用模型**，在 DSH 的模型选择器里切回：

```
provider: buddy
model:    deepseek-v4.1-flash
```

**如果 `buddy` 不在列表里**，先跑这条确认插件是活的：

```powershell
# 插件启动时会把两个本地 shim 挂到随机端口，日志里记着端口号
Get-Content "$env:USERPROFILE\.dsh\.onepool\startup.log" -Tail 5
# 然后用日志里的端口探活（401 是正常的，说明服务在监听）
Test-NetConnection -ComputerName 127.0.0.1 -Port <日志里的端口> -InformationLevel Quiet
```

两个端口都 `True` 说明 onepool 已加载进当前进程，模型列表刷新一下就会出现。

### 若你选择「先改文件、稍后安装」

```powershell
node C:\Users\NeilM\Desktop\research\onepool\tools\verify-installed.mjs "$env:USERPROFILE\.dsh\profiles\desktop"
```

看到 `ALL CHECKS PASSED` 后再执行 `pnpm install`。校验不碰运行中的进程，可以随时跑。

---

## 五、回滚（30 秒内恢复）

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$stamp = "<第 1 步记下的时间戳>"

Copy-Item "$prof\package.json.$stamp.pre-onepool.bak" "$prof\package.json" -Force
Copy-Item "$prof\cordis.patch.yml.$stamp.pre-onepool.bak" "$prof\cordis.patch.yml" -Force

Push-Location $prof
pnpm install --ignore-scripts --config.auto-install-peers=false
Pop-Location
```

重启即可。`.xdpool` 从头到尾**没被移动也没被删除**（迁移是复制），所以回滚后账号池原样可用。

---

## 六、切换后验证清单

```powershell
# 1. 数据目录已创建
Test-Path "$env:USERPROFILE\.dsh\.onepool\accounts.json"

# 2. 账号数一致（应为 9）
((Get-Content "$env:USERPROFILE\.dsh\.onepool\accounts.json" -Raw | ConvertFrom-Json).accounts).Count

# 3. 旧目录仍在（迁移不删源）
Test-Path "$env:USERPROFILE\.dsh\.xdpool\accounts.json"

# 4. 启动日志里没有任何 provider 重命名警告
Select-String -Path "$env:USERPROFILE\.dsh\.onepool\startup.log" -Pattern "renamed|failed" -ErrorAction SilentlyContinue
```

**注意第 4 条**：如果日志里出现 `provider ids renamed (...)`，说明某处还钉在 `xdpool`
上。按提示改 `cordis.patch.yml` 那一行即可——但你的 pin 是 `buddy`，正常不会触发。

---

## 七、如果你还想让 xdpool 留着备用

**不要**让它留在同一个 profile 的 `bundles` 里。两者注册同一个 `buddy`，
第二个会被静默吞掉（`registerAdapterIdempotent`），日志只说「已注册，保留现有路由」，
路由归谁取决于加载顺序。

真要留，把它移到**另一个 profile**：

```powershell
# 备用的 xdpool profile，需要时再切过去
$bak = "$env:USERPROFILE\.dsh\profiles\xdpool-backup"
New-Item -ItemType Directory $bak -Force | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.$stamp.pre-onepool.bak" "$bak\package.json"
```

代价：两个 profile 各有一份 `node_modules`（约 200MB），且 `~/.dsh/.xdpool` 与
`~/.dsh/.onepool` 会各自记账（限流标记、冷却时间不共享）。**只在排查问题时切换过去**，
不要两边交替用。

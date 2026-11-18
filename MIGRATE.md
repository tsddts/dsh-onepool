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

### 第 3 步：装包（不启动 DSH）

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Push-Location $prof
pnpm install --ignore-scripts --config.auto-install-peers=false
Pop-Location

# 链接宿主 peer（插件的 postinstall 做这件事；上面跳过了脚本，这里手动跑）
node "$prof\node_modules\dsh-onepool\scripts\link-host-peers.mjs"
```

**到这一步为止，正在运行的 DSH 完全没受影响**——它已经把旧模块加载进内存了，
磁盘上的改动不会影响它。你的会话照常工作。

---

## 四、切换（唯一会断开的一步）

**这一步会重启 DSH，当前会话会断开。请在合适的时候做。**

```powershell
# 确认新包能加载（在重启前跑，不碰运行中的进程）
node C:\Users\NeilM\Desktop\research\onepool\tools\verify-installed.mjs "$env:USERPROFILE\.dsh\profiles\desktop"
```

看到 `ALL CHECKS PASSED` 后：

1. **先发一条消息，确认当前会话还在工作**（记住最后一个 token 计数）。
2. 关闭 DSH（不是强杀，让它正常退出）。
3. 重新打开 DSH。
4. 打开同一个会话，发一条消息。

**如果它正常回话**：迁移成功，模型仍是 `buddy / deepseek-v4.1-flash`，账号池里 9 个账号都在。

**如果它报错**：见下一节回滚。

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

# 寻呼 XunHu —— 代码体检报告（CODE_REVIEW）

> 性质：**只读审查，未修改任何业务代码**。本文件仅为待办清单，供后续迭代排期。
> 范围：`app.js`、7 个页面、`utils/*`（store 1452 行全读）、10 个云函数、`app.wxss`、页面配置。
> 基线：v1.3.0 架构（对齐 `PROJECT_MAP.md`）。
> 结论汇总：**P0 致命 6 项 / P1 建议 12 项 / P2 锦上添花 13 项**。
>
> 阅读顺序建议：先看「0. 一句话结论」，再按 P0 → P1 排期，P2 随重构顺手做。

---

## 0. 一句话结论

当前架构的**业务规则**（越权、隐私、防刷）在服务端写得相当克制、注释也很完整；
真正的问题集中在两处：

1. **「客户端可直读集合」这条缝没有堵死** —— 云函数精心做的「accepted 才下发联系方式」「auditing 打码」，
   在 `posts` / `applications` 仍可被客户端直读的前提下，抓包即可绕过（P0-2 / P0-3）；
2. **「先查后写」没有原子性** —— 一人一帖、评价唯一、学号唯一、权重阈值全是 read-then-write，
   并发下会出现双开 / 重复记警告（P0-5 / P1-6）。

另外有一个确定会复现的小 bug：**本地快照回灌时帖子 id 丢失**（P0-1），
冷启动首帧的卡片点不开，云端拉取失败时整场都是坏卡片。

---

## 1. [P0 致命] 建议下个迭代修复

### P0-1 缓存快照回灌时帖子 `id` 变成 `undefined`（数据一致性）

- **位置**：`utils/store.js` → `normalizePost()`（约 128-135 行）、`hydrateFromCache()`（约 204-229 行）、
  `writeSnapshot(STORAGE_KEYS.CACHE_POSTS, cache.posts)`
- **问题**：`normalizePost` 用 `id: doc._id` 赋值。写快照时存的是**已归一化**的帖子（只有 `id`，没有 `_id`），
  下次冷启动 `hydrateFromCache()` 再拿快照去 `map(normalizePost)`，`doc._id` 是 `undefined`，
  `Object.assign` 把这个 `undefined` **覆盖掉**原本的 `id`。
- **影响**：
  - 每次冷启动第一帧，大厅所有卡片 `data-id` 为空 → 点卡片跳 `detail?id=undefined` → 详情页「信息不存在」；
  - 如果这次 `refreshList()` 也失败（弱网 / 云函数未部署），用户**整场**都只能看到点不开的列表；
  - 「缓存先行秒开」这个特性实际上只在「不点、不等」的情况下看起来是好的。
- **建议**：改成 `id: doc._id || doc.id || ''`（同时把 `authorOpenid` 也写成同样的双兜底），
  或快照落盘前保留 `_id`。顺手加一条回归自测：清缓存 → 冷启动 → 立刻点第一张卡。
- **验证方式**：`wx.clearStorageSync()` 后重启小程序，在列表出现但还没刷新完的瞬间点卡片，
  看 `detail` 的 `options.id` 是否为空；修复前后各测一次。

### P0-2 `posts` 对全站可读，但文档里塞了联系方式 / 审查中正文（隐私越权）

- **位置**：`posts` 集合权限「所有用户可读，仅创建者可读写」；字段写入见
  `cloudfunctions/publish/index.js` 的 `doc`（`contact`、`content`、`authorOpenid` 全在一个文档里）；
  UI 侧遮挡在 `pages/detail/detail.wxml`（联系方式仅 owner 可见）、
  `pages/index/index.js` → `formatPost`（`contentText` 打码）。
- **问题**：所谓「联系方式只在同意后展示」「审核中打码」全部是**渲染层**行为。
  客户端仍可直接 `db.collection('posts').get()` 把 100 条帖子的 `contact`、`content`、`authorOpenid`
  一次性 dump 出来 —— 包括被举报后进入 `auditing` 的正文。
  `detail.js` 里那句「posts 本来对所有用户可读，拦截只是产品体验层」就是这个事实的自述。
- **影响**：一条帖子就能收集全站同学的微信号 / 手机号；被打码的违规内容可以原样读出并二次传播。
  这与协议里「联系方式仅在你同意申请后展示」的承诺直接冲突，属于对内测同学的真实隐私风险。
- **建议**（按成本从低到高）：
  1. 拆字段：`posts` 只留公开字段（title/content/tags/category/status/heat/createTime），
     `contact` 迁到 `post_contacts`（`_id = postId`，客户端零权限），详情页按「owner / accepted 申请人」由云函数下发；
  2. 或把「大厅列表 + 详情」整体改成 `post` 云函数下发（服务端按关系裁剪字段），`posts` 直接设「所有用户不可读写」；
  3. `auditing` 帖子的正文应在服务端就不下发（列表返回空串即可），而不是前端 `*** *** ***`。
- **验证方式**：开发者工具 Console 里直接 `wx.cloud.database().collection('posts').limit(1).get()`，
  看返回里有没有 `contact` 与 `auditing` 帖子的 `content` —— 现在能看到，就是没堵上。

### P0-3 `applications` 可被收帖人直读，`pending` 时就泄露申请人联系方式 / 完整学号（隐私越权）

- **位置**：`applications` 自定义安全规则（`BETA_CHECKLIST.md` 1.4）；
  `cloudfunctions/application/index.js` → `handleApply` 把 `applicantContact` / `applicantStudentId`
  **在 pending 状态就写进文档**；隐私裁剪只在 `buildReceivedItem`（下发时）做。
- **问题**：规则是 `doc._openid == auth.openid || doc.receiverId == auth.openid`。
  收帖人 `receiverId == openid` 成立 → 可以在「待处理」状态下直接读文档，
  拿到申请人联系方式与完整学号，完全不经过「同意」这一步。
  `applications` 的 `write` 是否已置 `false` 也无法从代码确认（控制台配置）。
- **影响**：绕过「同意后才互相可见」的核心产品规则；结合 `receiverId` 可枚举任意帖子的申请人。
- **建议**：
  - 控制台把 `applications` 的 `read` 也设为 `false`（读写全走 `application` 云函数）；
  - 删除 `utils/store.js` → `pullApplicationsDirect()` 这条「云函数未部署时直读」的降级通道
    （它正是这条缝存在的原因，而且降级模式本来就看不到附言/简历，体验价值低于风险）；
  - 若一定要保留降级，文档里**不要存** `applicantContact` / `applicantStudentId` 明文（改为 accepted 时回填）。
- **验证方式**：小号申请 → 大号**不点同意**，在 Console 用 `where({receiverId: openid}).get()` 看能否读到 `applicantContact`。

### P0-4 帖子结束 / 删除是客户端直写，且创建者对自己的文档有全字段写权限（越权）

- **位置**：`utils/store.js` → `endPost()`（约 508-540 行，`doc(postId).update({status:'ended'})`）、
  `removePost()`（约 495 行，`doc(postId).remove()`）；权限依据「仅创建者可读写」。
- **问题**：安全规则只判断「是不是创建者」，不限制**能改哪些字段**。
  发帖人可以（改包 / 开发者工具 / 控制台脚本）对自己这条文档写：
  `status: 'auditing' → 'active'`（**撤销举报审查，重新上大厅**）、
  改 `title/content`（绕过词库与机审已通过的结论）、
  改 `heat`（刷最热榜）、改 `authorOpenid`（冒用他人身份发帖）。
  另外 `removePost` 目前**没有任何页面调用**，等于多开了一条无用的写通道。
- **影响**：`report` 建立的「举报 → 打码 → 人工审查」闭环可被当事人单方面撤销；
  风控在「作者本人」这个最需要约束的角色上是失效的。
- **建议**：
  1. 新增云函数 `post`（`action: end / delete`），服务端校验 `authorOpenid === openid` 且只写 `status/endTime`；
  2. 控制台把 `posts` 的 `write` 收成 `false`（读保留给大厅，等 P0-2 一起改成云函数下发）；
  3. 删除未被调用的 `store.removePost`，避免以后有人顺手用它删别人的帖。
- **验证方式**：在 Console 对自己的帖子执行 `update({data:{status:'active'}})`，
  现在能成功（尤其对一条 `auditing` 的帖子），就说明这条缝是真的。

### P0-5 四条「唯一性」全是先查后写，无事务（并发双开）

| 规则 | 位置 | 并发后果 |
|---|---|---|
| 一人一帖 | `cloudfunctions/publish/index.js` 约 331-360（`where(...).get()` 后 `add`） | 双设备/连点可写出 2 条 `active` |
| 评价唯一 | `cloudfunctions/review/index.js` 约 309-356（查重后 `add`） | 同一合作产生 2 条评价，好评率被灌水 |
| 学号唯一 | `cloudfunctions/user/index.js` 约 331-351 → `add/update` | 两个账号可同时绑同一个学号 |
| 举报去重 | `cloudfunctions/report/index.js` 约 171-232 | 同一人同一帖产生 2 条举报，权重 +2 |

- **影响**：概率低但后果都是「业务红线破了」，且事后难追溯（没有唯一索引兜底）。
- **建议**（云开发可用手段）：
  - 评价：`reviewId = reviewer_post_reviewee` 已是天然唯一键，改为
    `db.runTransaction()` 内 `doc(reviewId).get()` → 不存在才 `add`（或用 `_id: reviewId` 写入）；
  - 一人一帖：在 `users` 文档上做 CAS（`where({_openid, activePostId: _.exists(false)}).update(...)`
    看 `stats.updated` 是否为 1），成功才发帖；
  - 学号：把 `studentId` 当成唯一键写进一张 `student_ids` 集合（`_id = studentId`），
    用 `add` 的失败当唯一约束；
  - 举报：同上去重键 `reportId = postId + '_' + reporterOpenid`。
- **验证方式**：Postman / 云函数测试连续两次并发调用（`Promise.all` 两个 `apply`/`submit`），看是否落两条。

### P0-6 自动化风控阈值可被协同举报滥用

- **位置**：`cloudfunctions/report/index.js` 阈值逻辑（约 234-299）；
  `REPORT_WEIGHT_AUDIT_THRESHOLD = 3`、`WARNING_BAN_THRESHOLD = 2`（三处同值）。
- **问题**：3 个不同 openid 举报即可让任意帖子下架；2 条帖子触顶即可把作者 `role` 改成 `banned`。
  而 openid 的「人」成本极低（学号是自填 + 唯一性无强校验，P0-5），也没有账号年龄 / 举报人信誉权重。
- **影响**：6~9 个协同举报就能让一个正常同学「帖子全下架 + 账号封禁」，且申诉只能线下发邮件。
- **建议**：
  - 自动审查前增加「举报人多样性/信誉」条件（例如仅统计绑定学号且注册 > N 天的账号）；
  - 自动 `banned` 改成「自动标记 + 人工确认」，或把封禁阈值提高并引入时间窗（同一帖子 7 天内）；
  - `admin_logs` 里补 `autoBan` 事件，方便事后回溯误封。
- **验证方式**：三个测试号举报同一帖子 → 观察 `users.warningCount` / `role` 变化路径是否过于"一键"。

---

## 2. [P1 建议] 下个版本内消化

### P1-1 冷启动重复全量拉帖（网络浪费最大的一处）

- **位置**：`app.js` `onLaunch` → `store.init()`（拉 posts + profile + applications）；
  `pages/index/index.js` `onShow` → `renderCachedList()` + `refreshList()` → `syncPosts()`。
- **问题**：一次冷启动至少两次全量帖子拉取（每次最多 5 个 `get`，`MAX_FETCH=100`）+ 2 次云函数，
  首屏前轻松 8~10 个请求。
- **建议**：`store` 记录 `lastPullAt`，`syncPosts({maxAge: 30_000})` 内直接复用；
  或在 `init()` 完成后 3 秒内跳过第二次拉取。下拉刷新/refresher 传 `force: true`。

### P1-2 Tab 切换 / onShow 全量重拉，任务页一次四类请求

- **位置**：`pages/task/task.js` `refreshList`（112-146）：`syncPosts` + `syncApplications` + `syncMyReviews` + `patchMissingPosts`；
  大厅每次 `onShow` 也是全量 `syncPosts`。
- **问题**：任务页其实只需要「申请引用的那几条帖子」，却要先拉 100 条全量帖（最多 5 次请求），
  再加 2 次云函数 + N 次补拉。tabBar 来回切是最频繁的操作。
- **建议**：任务页改成「只用 `application.list` 联查回来的 `postTitle/postStatus`」，
  帖子缓存缺失时才 `fetchPostById`（即现在的 `patchMissingPosts` 提到主路径）；
  或让 `application.list` 顺带返回 `postEnded/postAuthorOpenid`，彻底不依赖 `cache.posts`。

### P1-3 详情页分享直达时拉全量帖只为一条

- **位置**：`pages/detail/detail.js` `onLoad`（76-83）：`store.findPost(id)` 未命中 → `store.syncPosts()`。
- **问题**：为一条帖子拉 100 条，弱网下详情页白屏时间被放大。
- **建议**：改用已有的 `store.fetchPostById(id)`（`doc(id).get()`，单次请求），失败再降级 `syncPosts`。

### P1-4 `patchMissingPosts` 逐条 `doc.get()`，应批量

- **位置**：`pages/task/task.js` 149-175（`Promise.all(ids.map(fetchPostById))`）。
- **问题**：缺 10 条就是 10 个并发云数据库请求，容易触发并发/配额限制。
- **建议**：`store` 增加 `fetchPostsByIds(ids)`，内部 `where({_id: _.in(ids.slice(0,20))})` 分批。

### P1-5 `heat` 云函数无频率限制、允许负增量

- **位置**：`cloudfunctions/heat/index.js`（45 行全量）。
- **问题**：只校验 `|delta| <= 5`，不校验调用者、不校验帖子状态、允许 `delta` 为负。
  任意用户循环调用即可把别人的帖子刷到「最热」，或把热度打到 0。
  前端 `claimHeatOnce` 只是本地 Storage 去重（清缓存即失效）。
- **建议**：服务端落 `heat_logs`（`_id = postId_openid_YYYYMMDD_action`，`add` 失败即视为重复），
  这才是真正的防刷；同时拒绝负数（或仅允许服务端校正）。

### P1-6 权重 / 警告是 read-modify-write，非原子

- **位置**：`cloudfunctions/admin/index.js` 约 309-310（`Math.max(0, before-1)`）、415-416（`before+2`）；
  `cloudfunctions/report/index.js` 的 `bumpAuthorWarning`。
- **问题**：先读后写，两个管理员同时处理两条举报会互相覆盖权重；`report` 与 `admin` 并发时
  `warningCount` 可能被覆盖成较小值（少记或重复记）。
- **建议**：统一改 `_.inc()`（忽略/违规都用增量），需要下限时再读一次校正；警告计数用 `_.inc(1)` 后回读。

### P1-7 `application.list` 把查询异常吞成空数组，故障不可见

- **位置**：`cloudfunctions/application/index.js` `queryApplications`（232-241，catch 后 `return []`）。
- **问题**：数据库读失败 → 云函数仍返回 `ok: true`、空列表 → 任务页显示「没有申请」。
  用户以为没人申请，实际是故障；`store.cache.applicationsError` 也永远是 `null`。
- **建议**：查询失败时把错误带出来（`ok: false` 或 `partial: true` + `errors`），
  让任务页能提示「部分数据加载失败，请下拉重试」。

### P1-8 `banned` 覆盖不全；后台没有解封动作

- **位置**：`cloudfunctions/user/index.js` `save`（287-320）未校验 `role === 'banned'`；
  `cloudfunctions/admin/index.js` 只有 `unbind`，没有 `unban`。
- **问题**：被封禁账号仍可改昵称 / 简历 / 联系方式（可改成他人姓名继续冒充）；
  解封只能进控制台改 `users.role`，运营不可自助。
- **建议**：`user.save` 增加封禁校验（至少禁止改昵称）；`admin` 补 `ban/unban` action（写 `admin_logs`）。

### P1-9 `getAuthorProfile` 可用任意 `authorOpenid` 枚举资料

- **位置**：`cloudfunctions/getAuthorProfile/index.js` `resolveAuthorOpenid`（82-98）。
- **问题**：`postId` 查不到时回退到客户端传的 `authorOpenid`，等于「传谁查谁」，
  与注释里「只能查真实帖子的作者」自相矛盾。配合 P0-2（`posts` 泄露 `authorOpenid`）可批量枚举简历与评价统计。
- **建议**：去掉兜底（只接受 `postId`），或要求 `authorOpenid` 必须能在 `posts` 里找到该作者的有效帖子；
  长期随 P0-2 一起把名片并入 `post` 云函数。

### P1-10 100 条硬上限、无分页、静默丢数据

- **位置**：`utils/store.js` `MAX_FETCH = 100`；`cloudfunctions/application` `MAX_ROWS = 100`；
  `review` `LIST_LIMIT = 100`；`admin` `REPORT_LIST_LIMIT = 100`。
- **问题**：超过上限的数据静默消失（大厅后来的帖子看不到、历史申请看不到、旧评价的「已评价」状态丢失）。
  `review.mine` 丢记录时按钮会重新点亮，只能靠云端 `ALREADY_REVIEWED` 兜底。
- **建议**：至少给页面一个「还有更多」的提示与「加载更多」入口；内测期可先把上限提到 200 并加注释说明。

### P1-11 本地草稿混进 `getPosts()`，大厅会出现「草稿」卡片

- **位置**：`utils/store.js` `getPosts()`（393-397，`draft ? [draft].concat(posts)`）。
- **问题**：草稿只在作者本机，但会以 `status: 'draft'` 出现在大厅「最新发布」列表（不是 `ended` 即展示），
  点进去详情页能渲染，申请必然失败（云端 `POST_NOT_FOUND`），用户会以为是产品 bug。
- **建议**：草稿只在发布页恢复，不进大厅；或在 `formatPost` 里过滤 `status === 'draft'` 并给「继续编辑」入口。

### P1-12 前后端上限常量不一致

- **位置**：`pages/publish/publish.wxml`（标题 `maxlength="15"`、正文 `maxlength="500"`）、
  `pages/profile/profile.wxml`（联系方式 `maxlength="40"`）；
  云端 `cloudfunctions/publish/index.js` `MAX_TITLE=15 / MAX_CONTENT=500 / MAX_CONTACT=50`。
- **问题**：联系方式前端 40、云端 50（前端更严，用户被无声截断）；上限值散落在 wxml 里，
  改云端常量不会同步到界面，计数文案 `{{title.length}}/15` 也要手改。
- **建议**：上限统一进 `utils/constants.js`（`POST_TITLE_MAX` / `POST_CONTENT_MAX` / `CONTACT_MAX`），
  wxml 用 `maxlength="{{titleMax}}"`、计数文案拼变量；云端副本注释互指。

---

## 3. [P2 锦上添花] 重构时顺手做

### P2-1 零组件化，样式 5 处重复且已分叉

- **位置**：7 个页面 `usingComponents` 全是 `{}`；`pages/index/index.wxss`、`task`、`detail`、`admin` 各自定义
  `.tab-item` / `.status-badge` / `.tag` / `.category-tag` / `.empty-card`。
- **问题**：同一视觉元素多份实现，数值已经漂移（`tab-item` 高度 index/admin 是 64rpx、task 是 76rpx；
  `status-badge` 内边距 12rpx vs 14rpx）。改一次视觉要改 3~4 个文件。
- **建议**：抽 `components/post-card`（大厅 + 任务卡片复用）、`components/status-badge`、
  `components/empty-state`、`components/tab-bar`；共用样式放 `app.wxss` 或 `styles/common.wxss` 并按需 `@import`。

### P2-2 时间格式化 4 份实现

- **位置**：`pages/detail/detail.js` 顶部 `formatTime`、`pages/admin/admin.js` 顶部、`pages/profile/profile.js` 顶部、
  `utils/store.js` `getTodayKey` 里的同款拼装逻辑。
- **建议**：抽 `utils/format.js`（`formatDate` / `formatDateTime` / `todayKey`）。

### P2-3 80 处 `showToast` / `showModal` 散落 6 个页面

- **位置**：detail 22、profile 18、task 13、admin 13、publish 11、index 3。
- **问题**：文案、`icon`、`duration` 各自硬编码（900/1200/1500/1800ms），「操作失败，请稍后重试」出现 N 次。
- **建议**：`utils/ui.js` 提供 `toast(title)` / `confirm({title, content, confirmText})`（统一 `icon:'none'`、
  统一时长），文案进 `constants.TOAST`。传参式调用也让「二次确认」不再每个页面各写一遍 Promise 包装。

### P2-4 违禁词库 5 份副本，缺同步机制

- **位置**：`utils/constants.js` + `cloudfunctions/{publish,user,application,review}/index.js`。
- **问题**：改词必须手工改 5 处并重部署 4 个云函数，漏一处就出现「前端拦、后端放」。
- **建议**：加 `scripts/sync-guard.js`（把 `utils/constants.js` 的词库区块生成到各云函数，`npm run guard`），
  或抽成内部 npm 包；至少加一条 CI/自检脚本比对 5 份 `FORBIDDEN_WORDS` 是否一致。

### P2-5 `utils/store.js` 1452 行巨石

- **问题**：缓存、快照、云函数封装、8 个业务域全在一个文件，任何改动都要面对整文件上下文。
- **建议**：按 `store/` 目录拆（`posts.js` / `applications.js` / `reviews.js` / `profile.js` / `admin.js` / `cache.js`），
  对外保持同一个 `module.exports` 聚合，页面零改动。拆分时顺带把 P2-7 的重复封装收敛。

### P2-6 状态魔法字符串遍地

- **位置**：`'ended'` / `'active'` / `'auditing'` / `'accepted'` / `'rejected'` / `'pending'` / `'admin'` / `'banned'`
  在页面里大量直接比较（detail 10+ 处、index 6 处、task 若干）。
- **建议**：`constants.POST_STATUS`、`constants.APPLICATION_STATUS`、`constants.ROLE` 枚举化，页面用 `constants.POST_STATUS.ENDED`。

### P2-7 云函数调用封装重复 6 份

- **位置**：`store` 里 `callPublishFunction` / `callApplicationFunction` / `callUserFunction` /
  `callReviewFunction` / `callAdminFunction`，以及 `submitReport` / `fetchAuthorProfile` 各自的 try/catch。
- **问题**：错误包装、`err.code` 透传、`FUNCTION_CALL_FAILED` 文案逐份复制。
- **建议**：一个 `callCloud(name, data, {fallbackMessage})`，其余都是薄包装（顺带统一日志前缀）。

### P2-8 文案常量重复

- **位置**：`'还没有收到评价'`（detail、profile 各 1 处）、`'已申请，等待审核'`（detail 2 处）、
  `'某同学'` / `'满意度统计中...'`（constants 有，但页面仍写死）。
- **建议**：统一引用 `constants`，新增 `REVIEW_EMPTY_TEXT` / `APPLY_PENDING_TEXT`。

### P2-9 死代码

- **位置**：`utils/mockData.js` + `store.seedDemoData()` + `SEED_DEMO_POSTS = false`（三处成套存在但关闭）；
  `store.removePost` / `getMyReviews` / `getTodayKey` 无页面调用；`constants.AUTHOR_OPENID_MAP` 仅种子数据使用。
- **建议**：删或移到 `scripts/legacy/`，避免下一个人以为「演示数据还开着」。

### P2-10 DEV 开关分散、无发布前守卫

- **位置**：`pages/task/task.js` `DEV_DEBUG`；`cloudfunctions/review/index.js` `DEV_ALLOW_SELF_REVIEW`
  （注意它还同时放行了「帖子未结束也能评价」）。
- **建议**：集中到 `config/dev.js` / 云函数 `config.js`，并在提交前脚本里 grep `= true` 报警；
  `DEV_ALLOW_SELF_REVIEW` 建议拆成两个开关（自评 / 未结束可评），避免复用时误放行。

### P2-11 注释与实现漂移

- **位置**：`cloudfunctions/review/index.js` 顶部与 `BETA_CHECKLIST.md` 旧文案仍说「upsert / 可更新」
  （实现早已是「只 add」）；`BETA_CHECKLIST.md` 的云函数/集合数量已在本轮修正为 10/6；
  `constants.js` 里 `ACTIVE_POST_LIMIT_MESSAGE` 文案是「寻呼中的信息」，而 `publish` 云端是「进行中的信息」。
- **建议**：每轮迭代收尾时用 `PROJECT_MAP.md` 做一次交叉核对；文案以 `constants` 为准，云端副本注释标注「同步自」。

### P2-12 `auditing` 只遮正文，标题 / 标签 / 作者仍然展示

- **位置**：`pages/index/index.js` `formatPost`（只把 `content` 换成 `*** *** ***`）。
- **问题**：违规内容往往就在标题（「代课」），打码后大厅仍然能看到违规标题与标签。
- **建议**：`auditing` 时标题也替换为「该内容正在审查」，标签清空；同时按 P0-2 在服务端就不下发正文。

### P2-13 重复的小工具函数

- **位置**：`backToHall`（detail 独立函数、publish 页面方法）、`buildFullText`（publish）与
  `buildProfileFullText`（profile）与 detail 里的附言拼接、`ensureProfileReady`（detail）与 `guard.promptProfile`。
- **建议**：`utils/nav.js`（`backToHall`）、`utils/text.js`（`joinForCheck`）、统一走 `guard`。

---

## 4. 建议的修复顺序（排期参考）

| 顺序 | 内容 | 理由 |
|---|---|---|
| 1 | P0-1 快照 id | 一行修复，立刻消除「卡片点不开」投诉 |
| 2 | P0-3 `applications` 权限收紧 | 纯控制台 + 删降级通道，成本低、堵隐私大洞 |
| 3 | P0-4 `posts` 写入收口（`endPost` 云函数化） | 阻断「作者撤销审查」这条最危险通道 |
| 4 | P0-2 posts 字段拆分 / 大厅走云函数 | 改动最大，需要一次独立迭代 |
| 5 | P0-5 + P0-6 事务化与风控阈值 | 与 P0-2 同期做，避免二次改云函数 |
| 6 | P1-1 / P1-2 / P1-3 / P1-4 网络收敛 | 内测体感提升最明显的一批 |
| 7 | P1-7 / P1-8 / P1-9 / P1-10 / P1-11 / P1-12 | 逐条小修 |
| 8 | P2 全部 | 随重构（拆分 store / 抽组件）一起做 |

---

## 5. 附：本轮未覆盖的部分

- 未做真机性能采样（帧率、内存、首屏耗时），P1 的性能结论基于请求拓扑与数据量估算；
- 未核对云开发控制台的实际安全规则（`applications.write` 是否为 `false`、`reports/reviews/admin_logs` 是否已锁），
  代码只能证明「设计意图」；
- 未做渗透测试（未构造恶意请求验证 P0-2 / P0-3 / P0-4 的可行性），建议按各条「验证方式」实测一次；
- 未审查 `project.config.json` / 小程序后台配置（域名、隐私协议、版本号）。

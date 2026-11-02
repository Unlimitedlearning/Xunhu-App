# 寻呼校园 v1.3.0 —— 业务口径审计报告（第一轮）

> **审计范围（本轮只做这四块）**：① 账号权限 ② 学号校验 ③ 一人一帖 ④ 违禁词拦截
> **指定代码范围**：`pages/index`、`pages/publish`、`cloudfunctions/publish`、`cloudfunctions/user`
> （为判断链路完整性，顺带读了 `utils/guard.js`、`utils/constants.js`、`utils/store.js` 中被上述文件直接调用的判定函数，以及 `cloudfunctions/admin` 的少量相关片段）
> **依据文档**：`PROJECT_MAP.md`（导航）、`寻呼校园 v1.3.0 产品业务口径文档》.md`（业务口径，下称「口径文档」，行号按该文件实际行号）
> **本次不做任何代码修改**，只列差异与建议。
> 生成时间：本轮对话；代码行号对应当前工作区版本。

---

## 0. 结论摘要

| 编号 | 主题 | 严重度 | 一句话差异 | 代码位置 |
|---|---|---|---|---|
| R-01 | 账号权限 | **高** | 受罚者（`role==='banned'`）在前端完全没有拦截，仍可进详情页、进发布页 | `pages/index/index.js:181-236`、`utils/guard.js:49-59` |
| R-02 | 账号权限 | 中 | 受罚者拦截文案缺「管理员邮箱」 | `cloudfunctions/publish/index.js:122`、`pages/publish/publish.js:243-251` |
| R-03 | 账号权限 | 中 | 未完善资料拦截文案不提「学号」，与口径文档给定文案不一致 | `utils/guard.js:31-41` |
| R-04 | 账号权限 | 中 | 发布页自身只校验昵称，不校验学号 / 联系方式（绕过入口守卫即可进页填表） | `pages/publish/publish.js:84-126` |
| R-05 | 账号权限 | 低 | `auditing` 帖子把发帖人本人也拦住，作者无法从大厅进自己的详情页 | `pages/index/index.js:187-194` |
| R-06 | 账号权限 | 低 | 审查中标注为「审核中」、掩码为 `*** *** ***`，与口径「【审查中】/ `***`」不同 | `utils/constants.js:63`、`pages/index/index.js:14` |
| R-07 | 学号校验 | 低 | 学号查重排在「学号锁定」之前，已绑定用户改学号会收到「请勿盗用他人学号」 | `cloudfunctions/user/index.js:331-374` |
| R-08 | 一人一帖 | **高** | `auditing` 帖子未计入发帖名额（前端与云端都只查 `status==='active'`） | `cloudfunctions/publish/index.js:376-390`、`utils/store.js:450-456`、`pages/index/index.js:213`、`pages/publish/publish.js:152-168` |
| R-09 | 一人一帖 | 中 | 一人一帖文案与口径文档给定文案不一致（「进行中的信息」vs「寻呼中的信息」） | `utils/constants.js:103`、`cloudfunctions/publish/index.js:120` |
| R-10 | 一人一帖 | 低 | 前端一人一帖判定依赖「最近 20 条」缓存，可能漏判（云端兜底） | `utils/store.js:240-252`、`utils/constants.js:86` |
| R-11 | 违禁词拦截 | 中 | 违禁词命中文案三套写法，均与口径文档「发布失败：包含违规词汇【xxx】…」不一致 | `pages/publish/publish.js:148/218-226`、`cloudfunctions/user/index.js:310-317`、`utils/constants.js:68` |
| R-12 | 违禁词拦截 | 低 | 云端把单个标签静默截断到 10 字，前端无任何提示 | `cloudfunctions/publish/index.js:100-101,285-295`、`pages/publish/publish.wxml:54` |

**判定为「符合文档」的关键项**（详见第 5 节）：学号正则三处一致、学号唯一性与「绑定后不可自改」、`role` 客户端不可写、违禁词库 5 份副本内容一致、净化匹配（去空白/标点/零宽/全角 + 拼音兜底）实现一致、云端发布是唯一写入口且 `authorOpenid/status/authorName` 由服务端决定。

---

## 1. 账号权限

### R-01 【高】受罚者（banned）在前端没有任何拦截通道

**口径文档**
- 第 31 行：受罚者「不可进入详情页、不可发布、不可申请、不可评价、不可举报」；可浏览大厅、个人中心、自己的历史帖子列表。
- 第 85 行：详情页「受罚者不可进入详情页」。
- 第 119 行：拦截文案中需给出真实管理员邮箱。

**代码现状**
- `pages/index/index.js:181-202` → `goToDetail()` 只做两件事：`status==='auditing'` 拦截、`guard.ensureReady()`；**没有任何 `role==='banned'` 判断**，受罚者点卡片可直接 `wx.navigateTo` 进详情页。
- `pages/index/index.js:209-236` → `goToPublish()` 同样只判 `ensureReady()` + 一人一帖，受罚者可正常进入发布页填写表单。
- `utils/guard.js:49-59` → `ensureReady()` 只有「未登录 / 资料未完善」两档，没有第三档「账号受限」。
- 唯一真实拦截在云端：`cloudfunctions/publish/index.js:356-359`（`role==='banned'` → `ACCOUNT_BANNED`）。即**受罚者要到点「发布信息」提交时才会被拦**，与口径要求的入口拦截不一致。

**影响**：受罚者能进详情页（口径明确禁止）、能进发布页；`utils/constants.js:81` 的注释「仅标记，不切断前端」也说明这是有意留下的口子，但与 v1.3.0 冻结口径冲突。

**建议**（未改）：`guard.ensureReady()` 增加第三档 `isBanned()`（`store` 已有 `profile.role`），统一弹「您的账号因违规已被限制使用，如有疑问请联系管理员邮箱：xunhu_app@qq.com」后拦回大厅/我的。

---

### R-02 【中】受罚者拦截文案缺管理员邮箱

**口径文档**：第 159 行 —— 「您的账号因违规已被限制使用，如有疑问请联系管理员邮箱：{真实邮箱}。」

**代码现状**
- `cloudfunctions/publish/index.js:122` → `BANNED_MESSAGE = '您的账号因违规已被限制使用'`（无邮箱）。
- `pages/publish/publish.js:243-251` → 弹窗标题「账号受限」，内容 `err.message || '您的账号因违规已被限制使用'`（无邮箱）。

**交叉事实**：真实邮箱 `xunhu_app@qq.com` 已在项目内出现（`pages/profile/profile.js:210`、`pages/profile/profile.js:336`），但**没有**被用于受罚者拦截文案 → 同一事实两处不一致。

**建议**：把邮箱提为 `constants.BANNED_MESSAGE`，云端副本同步（`publish` / `review` / `report` 的 `BANNED_MESSAGE` 均需一并对齐）。

---

### R-03 【中】「资料未完善」拦截文案与口径不一致（漏掉学号）

**口径文档**
- 第 25 行：未完善的定义是「未填写昵称、学号、联系方式」；点击卡片或 `+` 号应弹窗拦截并引导去「我的」。
- 第 155 行：给定文案「请先前往「我的」页面完善个人资料及学号。」

**代码现状**
- `utils/guard.js:31-41` → `promptProfile()`：标题「资料未完善」，内容「您还没有完善联系方式/昵称，队友无法联系您。点击确定去完善资料」。**只提昵称和联系方式，完全不提学号**。
- 判定逻辑本身是对的：`utils/store.js:899-906` `isProfileReady()` = 昵称非空 + 联系方式非空 + `STUDENT_ID_REGEX` 通过，与口径一致。

**影响**：用户被拦时不知道自己缺的是学号，文案与验收文档对不上。

---

### R-04 【中】发布页自身只校验昵称，未校验学号 / 联系方式

**口径文档**：第 25 行（未完善定义含学号、联系方式）、第 71-75 行（发布前置条件）。

**代码现状**
- `pages/publish/publish.js:84-95` → `ensureProfileReady()` 文案「发布前请先在「我的」页面填写并保存昵称，发布人展示名取这里」。
- `pages/publish/publish.js:121-126` → `submitPost()` 的「身份前提」只判断 `store.getNickname()`。
- 从大厅进入时，`pages/index/index.js:211` 的 `guard.ensureReady()` 已经拦住未完善用户；但发布页是独立路由，**开发者工具直接编译该页 / 扫码直达 / 页面栈异常**时没有这层守卫，页面内只剩昵称校验。
- 云端有兜底：`cloudfunctions/publish/index.js:361-372`（缺昵称 / 学号不合法 / 缺联系方式 → 统一 `PROFILE_NOT_READY`）。

**影响**：仅在绕过入口的场景下表现为「能填完表单、提交时才被拦」，属体验层缺口，不构成数据风险。

---

### R-05 【低】`auditing` 帖子把作者本人一起拦住了

**口径文档**：第 51 行 —— 「发布者可以进入详情查看；其他用户点击时被拦截，提示「该内容涉嫌违规，正在审查中」。」

**代码现状**：`pages/index/index.js:187-194`，只要 `data-status === 'auditing'` 就 toast 并 `return`，**没有「是否本人帖子」的例外分支**（`postPool` 里其实有 `authorOpenid`，`store.findMyActivePost()` 也能判本人）。

**影响**：作者在大厅点自己正在被审查的帖子，会被自己的帖子挡住。与口径「发布者可进入详情」不符。

---

### R-06 【低】审查中卡片的标注与掩码用词不同

**口径文档**：第 47 行「在大厅打码展示并标注【审查中】」；第 51 行「正文显示为「***」」。

**代码现状**
- `utils/constants.js:60-65` → `POST_STATUS_MAP.auditing = '审核中'`（口径是「审查中」）。
- `pages/index/index.js:14` → `CONTENT_MASK = '*** *** ***'`（口径是 `***`）。

**影响**：纯展示文案差异，验收逐字比对时会记为不符。

---

## 2. 学号校验

### R-07 【低】学号查重排在「学号锁定」之前，提示语义会误导

**口径文档**：第 37 行「一学号绑定一微信，一微信绑定一学号」；第 38 行「学号绑定后用户不可自行修改」。

**代码现状**（`cloudfunctions/user/index.js`，`action: 'save'` 的执行顺序）
1. `:305-318` 昵称/简历/联系方式违禁词
2. `:323-329` 学号格式 `STUDENT_ID_REGEX`（否则 `STUDENT_ID_INVALID`）
3. `:331-351` 学号唯一性查重（拿**客户端传入的** `data.studentId` 查 `users.studentId`，命中他人 → `STUDENT_ID_TAKEN`「该学号已被绑定，请勿盗用他人学号」）
4. `:366-374` 学号锁：已绑定合法学号时，**忽略本次传入值、强制回落到库里旧值**（`studentIdLocked`）

**问题**：第 3 步发生在第 4 步之前。一个**已绑定学号**的用户如果提交了别人的学号，会被判为「请勿盗用他人学号」（严重指控措辞），而不是被静默锁定回自己的学号；反过来，若用户误清空学号输入框，会在第 2 步直接 `STUDENT_ID_INVALID` 保存失败，走不到「回落旧值」的锁逻辑。

**安全影响**：无（两种情况都不会写入脏数据）。**体验/文案影响**：正常用户会看到「盗用」字样。

**建议**：把「学号锁」提到格式校验与唯一性查重之前，先算 `effectiveStudentId` 再走后面两步。

**其余学号项均与口径一致**（见第 5 节）。

---

## 3. 一人一帖

### R-08 【高】`auditing` 帖子未计入发帖名额

**口径文档**
- 第 27 行：普通用户「存在 active 帖子时不能发布新帖；帖子 ended 后可立即发布新帖；**帖子处于 auditing 期间不能发布新帖**」。
- 第 55 行：「「一人一帖」只统计 active 帖子。**auditing 期间占用发帖名额**，不能发布新帖。ended 后不占用名额。」
- 第 75 行：「auditing 帖子占用发帖名额，ended 帖子不占用。」

**代码现状（四处判定都只认 `active`）**
- 云端绝对防线：`cloudfunctions/publish/index.js:376-390` → `where({ authorOpenid: openid, status: 'active' })`。`auditing` 的帖子查不到 → 放行。
- 缓存判定：`utils/store.js:450-456` → `findMyActivePost()` 过滤条件 `item.status === 'active'`。
- 大厅 `+` 号：`pages/index/index.js:213-221` → 用 `findMyActivePost()`。
- 发布页提交前：`pages/publish/publish.js:152-168` → 用 `syncMyActivePost()`（`utils/store.js:459-463`，内部仍调 `findMyActivePost()`）。

**实际后果**：帖子被举报满权重进入 `auditing` 后，作者**可以立刻再发一条新帖**，于是同一 user 同时存在 `active + auditing`（甚至多条 auditing）。而 `cloudfunctions/admin/index.js:431-439`「确认违规」也是把状态写成 `auditing`（不是 `deleted`），这类被定性的帖子同样不占名额。

**建议**：四处的查询/过滤条件统一为 `status in ['active','auditing']`（云端用 `_.in`，前端用 `indexOf`），并同步 `utils/store.js` 的注释与 `PROJECT_MAP.md` 第 97 行的「一人一帖」说明。

---

### R-09 【中】一人一帖文案与口径不一致

**口径文档**：第 151 行 —— 「您已有寻呼中的信息，请先结束后再发布新信息。」

**代码现状**
- `utils/constants.js:101-103` → `ACTIVE_POST_LIMIT_MESSAGE = '您已有一条进行中的信息，请先结束后再发布新信息。'`
- `cloudfunctions/publish/index.js:119-120` → `ACTIVE_LIMIT_MESSAGE` 同上（两份代码互相一致，但与文档不同）。

**注意**：`PROJECT_MAP.md:129` 把 `ACTIVE_POST_LIMIT_MESSAGE` 列为「三方同步点」，**同步对象里没有口径文档**，所以这个偏差不会被现有流程发现。

---

### R-10 【低】前端一人一帖依赖「最近 20 条」缓存，可能漏判

**代码现状**
- `utils/constants.js:86` → `POSTS_FETCH_LIMIT = 20`；`utils/store.js:240-252` → `pullPosts()` 只拉最新 20 条（按 `createTime` 倒序），`utils/store.js:450-456` 在这 20 条里找自己的 active 帖。

**影响**：作者的 active 帖不在最近 20 条时（内测后期必然出现），前端会判定「没有 active 帖」并放行进发布页，直到调用 `cloudfunctions/publish`（`where authorOpenid + status`，精确查库）才被 `ALREADY_HAS_ACTIVE` 拦住。属体验层，不构成规则失守；但 `pages/index/index.js:214` 的 `!this.data.loaded` 补拉逻辑也救不了这种情况（补拉仍只拉 20 条）。

---

## 4. 违禁词拦截

### R-11 【中】违禁词命中文案三套写法，均与口径文档不一致

**口径文档**（第 127 行 + 第 153/161/163 行）
- 发布：`发布失败：包含违规词汇【xxx】，请修改后重试。`
- 简历：`保存失败：包含违规词汇【xxx】，请修改后重试。`
- 评价：`评价失败：包含违规词汇【xxx】，请修改后重试。`

**代码现状**

| 场景 | 代码位置 | 实际文案 |
|---|---|---|
| 发布页前端命中 | `pages/publish/publish.js:148` | `含违规词「xxx」，请修改后重试`（无「发布失败：」前缀，括号用「」） |
| 发布页云端命中 | `pages/publish/publish.js:218-226` | 弹窗标题「内容未通过审核」，内容 `内容含违规词「xxx」，请修改后重试` |
| 发布页 fallback | `utils/constants.js:68` `CONTENT_RISKY_MESSAGE` | `您发布的内容涉嫌违规，请修改后重试` |
| 云端 user 命中 | `cloudfunctions/user/index.js:310-317` | `昵称、简历或联系方式包含违规词汇，请修改`（不含具体词，`hitWord` 另字段回传） |
| 资料页展示 | `pages/profile/profile.js:240-247`、`:300-306` | `包含违规词汇【xxx】，请修改后重试`（无「保存失败：」前缀） |
| 云端 publish 文案常量 | `cloudfunctions/publish/index.js:116-118` | `RISKY_MESSAGE` / `LOCAL_RISKY_MESSAGE = '内容包含违规信息'` |

**影响**：同一件事（违禁词命中）在 toast、弹窗、云端 message 里是 3-4 种措辞，且都没带口径要求的动作前缀（发布失败/保存失败）。内测验收按文档逐条对照会判不符。**拦截能力本身没问题**（命中确实拒绝、确实拒绝对应操作），差异只在文案。

**建议**：在 `utils/constants.js` 定 3 个带 `%s` 占位的模板函数（发布/保存/评价），云端 3 份副本同步措辞（`publish` / `user` / `review`），页面只负责填词。

---

### R-12 【低】云端静默把单个标签截断到 10 字

**口径文档**：第 71 行 —— 标签选填，最多 4 个，空格分隔（**未规定单标签字数**）。

**代码现状**
- `cloudfunctions/publish/index.js:100-101` → `MAX_TAG_LENGTH = 10`；`:285-295` → `normalizeTags()` 对每个标签 `slice(0, MAX_TAG_LENGTH)`。
- 前端 `pages/publish/publish.js:136-140` 只做 `.slice(0, 4)`，不限长度；`pages/publish/publish.wxml:54` 提示「最多 4 个标签，超出部分自动忽略」——只提数量，没提字数。

**影响**：用户输入 12 字的标签，发布后静默变 10 字，界面提示无法解释这个变化。属「文档没规定、代码私自加限」型差异。

---

## 5. 已核对为「与口径一致」的项（无差异，供验收勾选）

**账号权限**
- 未登录 / 未完善用户仅可浏览大厅；点卡片与 `+` 号均经 `utils/guard.js:49-59` 拦截并跳「我的」（除 R-03/R-04 的文案与单页自校验缺口）。
- 管理员在前端不受特殊放行：`cloudfunctions/publish/index.js` 对 `role` 只判 `banned`，无 `admin` 豁免；一人一帖对管理员同样生效（口径第 29 行「v1.3.0 管理员同样只能持有 1 个 active 帖子」）。
- `role` 客户端不可写：`cloudfunctions/user/index.js:161-169`（`normalize` 白名单）、`:288-292`（显式 `delete profile.role`）、`:360-364`（更新时以库里旧值为准）；`utils/store.js:911-916`（`saveProfile` 入参白名单）。
- 服务端身份只取 `getWXContext().OPENID`，客户端传的身份一律不用（`cloudfunctions/publish/index.js:318-323`、`cloudfunctions/user/index.js:264-270`）。

**学号校验**
- 正则 `^31\d{8}$`（31 开头 10 位）三处同值：`utils/constants.js:277`、`cloudfunctions/user/index.js:27`、`cloudfunctions/publish/index.js:96` —— 与口径第 37 行一致。
- 学号唯一性查重：`cloudfunctions/user/index.js:331-351`（按 `studentId` 查 `users`，排除自己）。
- 学号绑定后不可自改：`cloudfunctions/user/index.js:366-374` 服务端强制回落旧值（前端 `disabled` 只是体验）。
- 管理员清空学号 → 用户回到「未完善」：`cloudfunctions/admin/index.js:537-542` 写 `studentId: ''`，配合 `utils/store.js:899-906` 的 `STUDENT_ID_REGEX` 判定即失效 —— 与口径第 41 行一致。
- 大厅 / 详情不展示学号：`pages/index/index.js:150-175` `formatPost()` 输出字段中无 `studentId`；大厅 `index.wxml` 无学号渲染。

**一人一帖**
- `ended` 不占名额：四处判定都只认 `active`（也就顺带满足了「ended 后可立即发布」，见 R-08 反噬）。
- 云端查重失败**不放行**：`cloudfunctions/publish/index.js:391-403`（`DEDUPE_FAILED`，「宁可让用户重试一次，也不能破一人一帖」）—— 与口径的硬性要求相符。
- 发布入口文案在两处代码内部一致（`constants` ↔ `publish` 云端副本），偏差只相对文档（R-09）。

**违禁词拦截**
- 词库 5 份副本**内容一致**（`ACADEMIC_FRAUD` 8 条 / `FRAUD_SCAM` 9 条 / `PRIVACY_VIOLATION` 5 条 / `PINYIN_FORBIDDEN_MAP` 22 条，逐项核对）：
  1. `utils/constants.js:170-206`
  2. `cloudfunctions/publish/index.js:43-77`
  3. `cloudfunctions/user/index.js:53-87`
  4. `cloudfunctions/application/index.js:63-97`
  5. `cloudfunctions/review/index.js:67-95`
  —— 与口径第 125 行「目前存在 5 份副本」一致。
- 净化匹配链路一致（小写 → 全角转半角 → 删零宽 → 删全部空白与标点 → 拼音兜底）：`utils/constants.js:211-270`、`cloudfunctions/publish/index.js:80-272`、`cloudfunctions/user/index.js:90-146`。
- 检查范围覆盖口径要求的字段：发布 `title + content + tags + contact`（`cloudfunctions/publish/index.js:405-420`；前端 `pages/publish/publish.js:29-33,145-150` 同口径拼接，防「拆字」）；资料 `nickname + resume + contact`（`cloudfunctions/user/index.js:305-318`）。
- 发布是唯一写入口，`status / authorOpenid / authorName` 由服务端决定，客户端传 `status` 被忽略（`utils/store.js:470-483`、`cloudfunctions/publish/index.js:441-466`）。
- 发布字段上限与口径一致：标题 15（`pages/publish/publish.wxml:23` ↔ `cloudfunctions/publish/index.js:98`）、描述 500（`publish.wxml:38` ↔ `publish/index.js:99`）、标签 4 个（`publish.js:140` ↔ `publish/index.js:100,291`）、联系方式必填（`publish.js:129-132` ↔ `publish/index.js:369-372`）、分类必选自三分类（`publish.wxml:7-12` ↔ `publish/index.js:35,333-335`）。
- 机审降级策略留痕完整（`secCheck` 写入帖子文档，`suggest/checked/degraded/errCode/checkTime`），不影响本地词库这条主防线。

---

## 6. 范围外顺带发现（本轮不计入四主题结论，供下一轮排期）

1. **口径里的 `deleted` 终态没有落地**：`cloudfunctions/admin/index.js:431-439`「确认违规」写的是 `status: 'auditing'`（+`violated:true`），全项目没有任何代码写 `status:'deleted'`；`utils/constants.js:60-65` 的 `POST_STATUS_MAP` 也没有 `deleted`，而 `pages/index/index.js:151` 对未知状态会回落成 `'active'`、`:117-127` 的最热/最新只排除 `ended`。若库里真出现 `deleted` 文档，大厅会把它当「进行中」展示且可点入。（口径第 47、51、53、135 行）
2. **大厅三个维度共用一个 20 条查询**：`pages/index/index.js:82-98` + `utils/store.js:240-252`（一次 `pullPosts` 取最新 20），口径第 65 行写的是「三个维度各自独立查询最新 20 条数据」；口径第 177 行已把它列为已知风险，建议统一表述而非改代码。
3. **大厅没有分类筛选 UI**：口径第 65 行提到「分类筛选为前端筛选」，`pages/index/index.*` 目前只有三个 Tab、无分类筛选控件 —— 需产品确认是否属 v1.3.0 范围。

---

## 7. 建议的修复顺序（确认后再动代码）

1. **R-08 + R-01**（两条高风险，都是「规则红线」）：先改一人一帖的 `status in ('active','auditing')`（云端 + store），再给 `guard` 加 banned 档。
2. **R-02 / R-03 / R-09 / R-11**（纯文案）：一次性在 `utils/constants.js` 建立文案模板，同步云端 4 份副本，避免以后再对不上。
3. **R-04 / R-05 / R-07**（体验与语义）：发布页补学号/联系方式校验、详情页放行本人、学号锁提前。
4. **R-06 / R-10 / R-12**（细节）：展示文案、20 条缓存说明、标签长度提示。
5. 第 6 节三条先与产品确认范围，再决定是否进入本轮排期。

---

_报告只做差异记录，未修改任何业务代码。_

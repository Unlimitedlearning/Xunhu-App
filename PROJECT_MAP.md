# 寻呼 XunHu —— 项目导航地图（PROJECT_MAP）

> **这份文档是什么**：纯导航，不含业务实现细节。目的是「不读全量代码也能定位到该改哪个文件」，
> 供后续新对话 / 新协助者 / AI 助手作为第一入口阅读，减少 token 消耗与盲目全文搜索。
> **怎么用**：先看第 6 节「常见修改参考」找场景 → 跳到对应文件 → 只读该文件相关段落。
> 业务规则、字段定义、验收标准一律以 `PRD.md` 与代码注释为准；本文只负责「指路」。

- 技术栈：微信原生小程序（WXML / WXSS / JS，无构建工具）+ 微信云开发（云函数 + 云数据库）
- 代码根目录：`D:\GithubProgram\XunHu`
- 云环境 ID：`utils/constants.js` → `CLOUD_ENV`（`cloud1-d3g0izqlv27c2ee8d`）
- 当前形态：内测版本，12 个云函数 / 10 个集合 / 8 个页面（v1.7.0：统一审核流）

---

## 1. 全局架构概览

### 1.1 分层调用链（自上而下，单向依赖）

```
app.js                     启动：wx.cloud.init(CLOUD_ENV) + store.init() 预热（取 openid、拉 posts/applications）
  └─ pages/*               页面：只做「渲染 + 收集输入 + 交互编排」
       └─ utils/guard.js   路由层能力校验：checkLogin（浏览）/ ensureReady（发布·申请）/ banned 拦截
       └─ utils/store.js   唯一数据层：内存缓存 + 缓存快照 + 云函数/云数据库调用封装（页面不直接 callFunction）
            └─ cloudfunctions/*   云函数（服务端唯一可信身份 = getWXContext().OPENID）
                 └─ 云数据库集合 posts / applications / users / reviews / reports / blacklist（共 10 个，见第 5 节）
```

**硬性约定**：页面 **不要**直接 `wx.cloud.callFunction` 或 `wx.cloud.database()`；
一切读写走 `utils/store.js`（唯一例外是 `store` 内部实现本身）。这样权限、错误码、缓存策略只有一处。

### 1.2 职责边界

| 层 | 负责 | 明确不负责 |
|---|---|---|
| 页面 `pages/*` | 渲染、表单收集、Tab 切换（纯内存 filter/sort）、弹窗确认、页面跳转、缓存先行秒开 | 不判断「有没有权限改这条数据」、不直连数据库、不拼可信身份 |
| `utils/constants.js` | 全局字典、状态机文案、阈值、违禁词库 + 净化匹配工具、Storage key | 不含页面逻辑，不发请求 |
| `utils/store.js` | 内存缓存 + 本地快照、分页拉取、`normalizeXxx` 字段兜底、云函数入参/错误码封装 | 不做 UI 文案、不做路由跳转 |
| `utils/guard.js` | 「登录 ≠ 可用」的入口校验：checkLogin（仅登录）/ ensureReady（昵称 + 校区 + 学号 + 联系方式） | 不写业务数据 |
| 云函数 | 可信身份、越权拦截、跨集合联查、敏感写入、自动风控阈值、字段脱敏/白名单下发 | 不渲染、不信任客户端传的身份与状态 |
| 云数据库 | 只存数据；权限规则决定「客户端能不能直读」 | 不承担业务规则（规则只是第二道锁） |

### 1.3 身份与权限模型（改任何写操作前必读）

- `openid` 只能由云函数 `login` 下发；`users` 集合存昵称 / 校区 / 学号 / 简历 / 联系方式 / `role` / `warningCount`。
  （v1.6.0：不再收集真实姓名，校区 `campus` 取代旧的身份背书字段。注销 / 封禁的 openid 进 `blacklist`。）
- `role`（`user` / `banned` / `admin`）**只允许服务端或控制台写**，客户端传 `role` 一律丢弃。
- 敏感集合对客户端零权限，读写全走云函数：

| 集合 | 客户端权限 | 写入方 |
|---|---|---|
| `posts` | **所有用户不可读写**（v1.5.0：读也只走 `post` 云函数） | 读：`post`（list / get）；写：`publish`（新建）/ `heat`（热度）/ `report`（转审核）/ `admin`（下架·恢复）/ `post`（结束·删除） |
| `post_contacts` | 所有用户不可读写 | 仅 `publish`（新建时写）/ `post`（按关系下发 · 迁移） |
| `applications` | **所有用户不可读写**（读也走云函数，不再保留自定义 read 规则） | 仅 `application` 云函数 |
| `users` | 所有用户不可读写 | 仅 `user` / `application`（联查读）/ `report`·`admin`（风控写）/ `user.deleteAccount`（级联删除） |
| `reports` | 所有用户不可读写 | 仅 `report` / `admin` |
| `reviews` | 所有用户不可读写 | 仅 `review` / `getAuthorProfile`（读） |
| `admin_logs` | 所有用户不可读写 | 仅 `admin` |
| `messages` | 所有用户不可读写 | 仅 `admin`（惩罚通知）/ `application`（申请流转通知）/ `message`（读） |
| `announcements` | 所有用户不可读写 | 仅 `admin`（发布公告）/ `message`（读） |
| `blacklist` | 所有用户不可读写 | 仅 `user.deleteAccount` / `admin.banUser`；`login`·`user`·`publish`·`application` 只读校验 |

> 集合与安全规则**不会由代码自动创建**：新建集合或改规则必须在云开发控制台手动操作（见 `BETA_CHECKLIST.md`）。

---

## 2. 页面路由与职责表

路由注册在 `app.json`；tabBar 三项：大厅 / 任务 / 我的。每个页面固定四件套 `.js`（逻辑）+ `.wxml`（结构）+ `.wxss`（样式）+ `.json`（页面配置）。

| 路由 | 一句话职责 | 进入方式 | 关键入口（js） |
|---|---|---|---|
| `pages/index/index` | **大厅**：三个 Tab（最新发布 / 最热招募 / 往期历史）列表渲染与筛选，卡片点击进详情，右下角 `+` 进发布 | tabBar | `onShow`（缓存先行 → `refreshList`）、`applyTab` / `onTabChange`、`formatPost`、`goToDetail`、`goToPublish` |
| `pages/detail/detail` | **详情页**：帖子全文 + 发布者名片 + 底部主按钮（发帖人=去任务页/结束，访客=报名）+ 举报；`?admin=1` 为管理员预览审查帖通道 | 大厅卡片 / 分享直达 | `onLoad`、`loadAuthorCard`、`onActionClick`（报名 / 结束分流）、`askApplyNote` + `confirmApply`、`onEndClick`、`onReportClick` |
| `pages/task/task` | **任务页**：申请流转工作台（我发出的 / 我收到的）+ 同意拒绝 + 双向评价入口；未登录或资料不完善只显示引导 | tabBar | `refreshList`（唯一网络入口）、`renderList`、`onAcceptTap` / `onRejectTap`、`openReviewModal` / `submitReview`；`DEV_DEBUG` 排障开关 |
| `pages/profile/profile` | **我的**：登录（只确认 openid）+ 资料维护（昵称/校区/学号/简历/联系方式）+ 收到的评价与好评率 + 管理员入口 + 注销账号 | tabBar | `refreshProfile`、`handleLogin` / `handleLogout`、`saveProfile`、`onCampusChange`、`handleDeleteAccount`、`renderReviews`、`onAdminTap` |
| `pages/publish/publish` | **发布页**：分类/标题/描述/标签/联系方式表单 + 前端违禁词轻量拦截 + 提交云端发布；失败存本地草稿 | 大厅 `+` | `onSubmit`（拼全文 → `checkTextViolation` → `store.savePost`）、草稿恢复 |
| `pages/admin/admin` | **管理后台**：三个 Tab（内容审核 / 学号申诉 / 系统公告）；内容审核队列卡片顶部显示 `auditReason` 标签，底部只有【通过】与【下架（选原因）】；学号申诉可【记警告】【封禁】【强制解绑】；进页先校验 `role === 'admin'` | 我的 → 管理员入口 | `guardAndLoad`、`onTabChange`、`loadAuditQueue`、`onAuditApproveTap` / `onAuditRejectTap`（ActionSheet 选原因）、`runAuditAction`、`searchUser`、`onWarningTap` / `onBanTap`、`onUnbindTap`、`goPostDetail`（`?admin=1`）、`publishAnnouncement` |
| `pages/agreement/agreement` | **协议页**：用户服务协议 / 隐私保护指引纯静态文本，无任何数据读写（v1.6.0：校区口径、审核口径去伪、注销说明） | 我的（底部协议入口，两个链接都指向本页） | —（`agreement.js` 仅读取常量） |
| `pages/messages/messages` | **消息中心**：个人通知（可点开置已读）+ 置顶全体公告（已读靠本地时间戳） | 我的 → 消息 / 红点入口 | `loadList`、`onMessageTap`（`markMessageRead`）、`markMessagesSeen` |

---

## 3. utils 工具层（比页面更常被改）

| 文件 | 行数（约） | 内容 |
|---|---|---|
| `utils/constants.js` | 473 | 云环境 ID、`COLLECTIONS`（10 个）、`CLOUD_FUNCTIONS`（12 个）、分类 / 状态 / 角色字典、校区取值域、全局文案、风控阈值、违禁词库 + `cleanText`/`checkTextViolation`、学号正则、Storage key |
| `utils/store.js` | 1804 | **唯一数据层**，见下方章节索引 |
| `utils/guard.js` | 110 | `checkLogin()`（仅登录，浏览用）/ `ensureReady()`（昵称+校区+学号+联系方式，发布·申请用）/ `promptBanned()`（受罚者拦截） |
| `utils/subscribe.js` | 90 | 订阅消息授权封装（`requestApplySubscribe` / `requestAcceptSubscribe`），恒 resolve 布尔、永不抛错 |
| `utils/tabBadge.js` | 101 | tabBar 红点统一应用（大厅/任务/我的三个 Tab 共用） |
| `utils/mockData.js` | 144 | 历史演示数据，**已无业务调用方**（`SEED_DEMO_POSTS` 已删除），仅作历史参考；可视为待清理 |

### `utils/store.js` 章节索引（搜注释标题即可定位，行号随版本浮动）

| 段落 | 内容 |
|---|---|
| `基础设施` | `callFunction` 封装、`cache` 状态（posts / applications / profile / myReviews / receivedReviews）、`PERMISSION_HINTS` |
| `字段规范化` | `normalizePost` / `normalizeApplication` 等，所有云文档字段兜底 |
| `本地快照（缓存先行 / 秒开）` | `hydrateFromCache`、`saveSnapshot`（`CACHE_POSTS` / `CACHE_APPLICATIONS`） |
| `初始化` | `init()`：取 openid → 拉 posts / applications / profile |
| `云函数封装` | 统一 `callFunction` + 业务错误码透传 |
| `帖子 posts` | `syncPosts`（只拉最新 20 条）/ `getPosts` / `findPost` / `fetchPostById` / `fetchPostContact` / `savePost` / `endPost`（走云函数 `post`） |
| `一人一帖` | `findMyActivePost` / `syncMyActivePost` |
| `申请 applications` | `syncApplications`（只走云函数 `application`，直读降级通道已删）、`addApplication`、`updateApplicationStatus` |
| `热度 heat` / `热度防刷` | `resolveHeat` / `persistHeat`、`claimHeatOnce`（本地 `local_heat_history`） |
| `个人资料` | `syncProfile` / `getProfile` / `saveProfile` / `isProfileReady` / `isCampusBound` / `isAdmin` / `isBanned` / `deleteAccount` |
| `举报` | `submitReport` |
| `评价 reviews` | `syncMyReviews` / `findMyReviewByPost` / `hasReviewedPost` / `submitReview` / `syncReceivedReviews` |
| `发布者名片` | `fetchAuthorProfile` / `emptyAuthorCard` / `readAuthorCardCache` |
| `消息中心` | `fetchMessageCenter` / `markMessageRead` / `fetchMessageBadge` / `markMessagesSeen` |
| `管理后台` | `fetchAdminAuditQueue` / `adminApprovePost` / `adminRejectPost` / `adminSearchUser` / `adminUnbind` / `adminAddWarning` / `adminBanUser` / `adminPublishAnnouncement`（v1.7.0 统一审核流：举报审查与内容审核已合并成一个待办队列） |
| `登录态` | `isLoggedIn` / `setLoggedIn` / `login`、草稿 `getDraft` / `saveDraft` / `removeDraft` |

**读 / 写模式**：读 = 先 `await syncXxx()` 刷缓存，再用同步 `getXxx()` 渲染；写 = 返回 Promise，必须 `await`。

---

## 4. 核心云函数清单（`cloudfunctions/`，12 个）

| 云函数 | action（入参 `event.action`） | 负责什么 | 关键拦截 |
|---|---|---|---|
| `login` | 无 | 下发调用者 `openid` / `appid` / `unionid` | 先查 `blacklist`：注销 / 封禁的 openid 直接拒（不下发 openid） |
| `user` | `get` / `save`（默认 `get`）/ `deleteAccount` | 读写 `users`：昵称 / 校区 / 学号 / 简历 / 联系方式；`deleteAccount` = 写 `blacklist` + 删资料 + 帖子改 `deleted` + 级联清理申请/评价/通知 | 学号正则 `^31\d{8}$`、学号唯一性、`campus` 白名单、资料违禁词、`role` 不可写、黑名单拦截 |
| `initDb` | `{}` / `{ diagnose: true }` | 创建 **10** 个集合；自检各集合是否存在 / 条数 | 仅服务端 SDK 可 `createCollection` |
| `heat` | `{ postId }` | 帖子热度原子自增 `_.inc` | 单次 `MAX_DELTA = 5` 防刷；管理员预览不加热度 |
| `publish` | 无（单一入口） | 发布唯一写入口：词库校验 + 可选机审 → **首帖 / 有违规记录强制 `auditing`，其余直接 `active`**；`status` / `authorOpenid` / `authorName` / `authorCampus` 均服务端决定 | 违禁词（绝对防线）、一人一帖 `ALREADY_HAS_ACTIVE`、`role==='banned'` / 黑名单拒发、机审 `CONTENT_RISKY` |
| `application` | `apply` / `updateStatus` / `list` | 申请流转**唯一入口**：提交申请（附言必填）、同意/拒绝、联查 posts + users 下发列表；accepted 后给申请人发一条站内通知 | `receiverId === openid` 才能改状态；`pending/rejected` 永不下发联系方式与完整学号；黑名单 / `campus` 不合法拒接 |
| `report` | 无（单一入口） | 举报落库 + `posts.reportWeight +1`（同一举报人不重复加权）+ 自动审查 / 自动封禁 | 禁举报自己；`reportWeight ≥ 5` → `auditing` 且 `warningCount +1`；`warningCount ≥ 3` → `role='banned'`（只标记 + `banSource/banTime` 留痕，**不切断前端**）；`auditDismissed` 者不重复扣警告 |
| `review` | `submit` / `get` / `mine` / `received` | 双向评价唯一读写入口：提交（只 `add` 不 update）、查重、我发出的、我收到的匿名统计 | 禁自评、`rating` 只能 1/0、必须有 accepted 申请关系、帖子必须 `ended`、同帖同人唯一 `ALREADY_REVIEWED`、评价正文违禁词 |
| `getAuthorProfile` | 无（`{ postId }` 或 `{ authorOpenid }`） | 详情页「发布者名片」：一次返回 `users` 简历 + `reviews` 匿名统计与最近 3 条 | 用 `postId` 反查真实 `authorOpenid`（不信客户端），字段白名单，不下发 openid / 联系方式 / 学号 |
| `post` | `end` / `delete` / `contact` / `migrateContacts` | 帖子状态唯写入口（结束 / 删除）+ 联系方式按关系下发 + 历史 contact 迁移 | 服务端校 `authorOpenid === openid`，`end` 只写 `status/endTime`；`contact` 仅作者或 accepted 申请人可见 |
| `message` | `list` / `read` / `badge` | 消息中心：个人通知（20 条）+ 置顶公告（3 条）+ 红点计数 | 只下发属于自己（`toOpenid` / `_openid`）的记录；`read` 先校归属 |
| `admin` | `getAuditQueue` / `approve` / `reject` / `searchUser` / `addWarning` / `banUser` / `unbind` / `publishAnnouncement` | 管理后台（v1.7.0 统一审核流）：**待办队列（批量联查 reports + users，拼 auditReason 标签）**、通过上线 / 下架（警告 +1 · 满 3 封禁 · 举报全部置 resolved · 通知作者）、按学号查人、记警告、封禁（写 `blacklist`）、强制解绑、发布公告 | 每个 action 先校验 `users.role === 'admin'`，否则 `FORBIDDEN`；不能对管理员记警告 / 封禁；破坏性操作写 `admin_logs`；旧 action（`getReports` / `ignore` / `violate` / `getAuditingPosts` / `approvePost` / `deletePost`）返回 `ACTION_DEPRECATED` |

**阈值与文案的三方同步点**（改一处必须同步全部）：
`utils/constants.js` ↔ `cloudfunctions/report/index.js` ↔ `cloudfunctions/admin/index.js`
（`REPORT_WEIGHT_AUDIT_THRESHOLD`、`WARNING_BAN_THRESHOLD`、`REPORT_CATEGORIES`、`ACTIVE_POST_LIMIT_MESSAGE`、`ALREADY_REVIEWED_MESSAGE` 等）。

---

## 5. 数据集合字典（10 个）

| 集合 | 存什么 | 关键字段 | 客户端权限 |
|---|---|---|---|
| `posts` | 所有寻呼 / 组队 / 自荐 / 同好帖子（大厅数据源） | `_id`(=帖子 id) / `category` / `title` / `content` / `tags[]` / `authorOpenid` / `authorName` / `authorCampus` / `status`(draft·auditing·active·ended·deleted) / `heat` / `reportWeight` / `auditDismissed` / `auditReason` / `auditSource` / `secCheck` / `createTime` / `endTime`（**无 `contact`**） | 所有用户不可读写（读走 `post` 云函数 list / get） |
| `post_contacts` | 帖子联系方式（v1.3.0 从 posts 拆出） | `_id`(=postId) / `_openid` / `authorOpenid` / `contact` / `createTime` | 所有用户不可读写（仅云函数 `publish` / `post`） |
| `applications` | 报名（申请）流水：谁申请了哪个帖子、当前状态 | `postId` / `applicantId` / `receiverId` / `applicantName` / `applicantResume` / `applyNote` / `status`(pending·accepted·rejected) / `createTime` / `statusUpdateTime`（**新文档不存 `applicantContact` / `applicantStudentId`**） | 所有用户不可读写 |
| `users` | 用户资料与账号状态（一个 openid 一条） | `_openid` / `nickname` / `campus` / `studentId` / `resume` / `contact` / `role`(user·banned·admin) / `warningCount` / `createTime` / `updateTime` | 所有用户不可读写 |
| `reviews` | 双向评价记录（一次合作一条，提交后不可改） | `reviewId`(= reviewer_post_reviewee) / `postId` / `reviewerOpenid` / `revieweeOpenid` / `rating`(1 满意·0 不满意) / `content` / `createTime` | 所有用户不可读写 |
| `reports` | 举报工单（谁举报了哪个帖子、原因、处理状态） | `postId` / `reporterOpenid` / `reason` / `desc` / `status`(pending…) / `postSnapshot` / `createTime` | 所有用户不可读写 |
| `admin_logs` | 后台操作审计日志 | `adminOpenid` / `action` / `targetId` / `createTime` | 所有用户不可读写 |
| `messages` | 个人通知（每个收件人一条） | `_openid` / `toOpenid` / `title` / `content` / `isRead` / `readTime` / `createTime` | 所有用户不可读写（读写均走 `message` 云函数） |
| `announcements` | 全体公告（全平台共用） | `title` / `content` / `adminOpenid` / `createTime` | 所有用户不可读写（写入仅 `admin`，读取仅 `message`） |
| `blacklist` | 黑名单（v1.6.0） | `openid` / `reason`(user_deleted·admin_ban…) / `source` / `createTime` | 所有用户不可读写（**只记 openid，不记任何资料**） |

> 字段权威定义在 `PRD.md`「四、核心数据模型」+ 各 `cloudfunctions/*/index.js` 顶部注释；
> 前端渲染字段一律经 `utils/store.js` 的 `normalizeXxx` 兜底，缺字段不得报错。

---

## 6. 常见修改参考（按场景找文件）

### 6.1 改「大厅 UI / 列表展示 / Tab」

| 目标 | 文件 |
|---|---|
| 卡片结构、Tab 栏、空状态、`+` 按钮 | `pages/index/index.wxml` |
| 样式（Tab 高 96rpx、`.scrollarea` 高度、卡片配色） | `pages/index/index.wxss` |
| Tab 文案与 key、空状态文案 | `pages/index/index.js` 顶部 `TABS` / `EMPTY_TEXT` |
| 排序与筛选规则 | `pages/index/index.js` → `applyTab` |
| 卡片字段（分类名 / 状态徽章 / 打码 / 热度展示） | `pages/index/index.js` → `formatPost` |
| 点击跳转前置拦截（auditing 打码、登录/资料校验） | `pages/index/index.js` → `goToDetail` + `utils/guard.js` |
| 分类字典 | `utils/constants.js` → `CATEGORY_MAP` / `CATEGORY_LIST` |

> ⚠️ 列表数据放页面字段 `this.postPool`（不进 `data`）；`onTabChange` 纯内存，**不要**在里面发请求。

### 6.2 新增一个云函数（完整同步清单）

1. 新建目录 `cloudfunctions/<name>/`：`index.js`（`exports.main`）+ `package.json`（依赖 `wx-server-sdk`）。
2. `utils/constants.js` → `CLOUD_FUNCTIONS` 增加常量（页面/store 只引用常量，不写字符串）。
3. `utils/store.js` 在对应业务段落加封装方法，并在文件末尾 `module.exports` 注册；错误码透传成 `err.code`。
4. 若涉及新集合：`utils/constants.js` → `COLLECTIONS`，同时改 `cloudfunctions/initDb/index.js` 的集合数组。
5. 若写入敏感数据：控制台建集合 + 设「所有用户不可读写」，并提醒用户手动操作。
6. 开发者工具里右键「上传并部署：云端安装依赖」（**云函数不会随编译生效**）。
7. 更新 `BETA_CHECKLIST.md` 的部署清单与本文第 4 节。

### 6.3 改「违禁词库」（现在是 **5 份副本**，必须同步）

| # | 文件 | 用途 |
|---|---|---|
| 1 | `utils/constants.js`（`ACADEMIC_FRAUD` / `FRAUD_SCAM` / `PRIVACY_VIOLATION` / `PINYIN_FORBIDDEN_MAP` + `cleanText` / `checkTextViolation`） | 前端轻量拦截；发布页 / 资料页 / 申请附言共用 |
| 2 | `cloudfunctions/publish/index.js` | 发布绝对防线（+ 机审开关 `SEC_CHECK_FAIL_OPEN`） |
| 3 | `cloudfunctions/user/index.js` | 昵称 / 简历 / 联系方式 |
| 4 | `cloudfunctions/application/index.js` | 申请附言 |
| 5 | `cloudfunctions/review/index.js` | 评价正文 |

规则：词条必须**纯文本**（无空格 / 标点 / 大写）；新增中文词要同时在 `PINYIN_FORBIDDEN_MAP` 补全拼；
改完 5 份都要重新部署对应云函数（`publish` / `user` / `application` / `review`）。

### 6.4 改文案 / 阈值 / 状态字典

- 统一定义在 `utils/constants.js`；云函数目录独立打包拿不到它，所以涉及云端判断的文案 / 阈值在云函数里有同值副本（见第 4 节同步点）。
- Toast 规范：全部 `wx.showToast({ icon: 'none' })`，文案面向普通用户（「操作失败，请稍后重试」），技术细节只进 `console.error`。

### 6.5 改申请 / 评价流程

| 目标 | 文件 |
|---|---|
| 报名按钮、附言弹窗、二次确认、结束帖子、举报 | `pages/detail/detail.js` + `detail.wxml` |
| 申请列表卡片、同意 / 拒绝、评价按钮显隐 | `pages/task/task.js`（`canReview` / `hasReviewed` / `isReviewLocked`）+ `task.wxml` |
| 申请流转规则（越权、隐私下发） | `cloudfunctions/application/index.js` |
| 评价规则（关系校验、唯一性、匿名） | `cloudfunctions/review/index.js` + `utils/store.js`「评价 reviews」段 |
| 好评率展示阈值（≥ 3 条） | `utils/constants.js` → `REVIEW_MIN_COUNT` |

### 6.6 改管理后台 / 风控

| 目标 | 文件 |
|---|---|
| 后台列表、Tab、搜索、二次确认 | `pages/admin/admin.js` + `admin.wxml` / `admin.wxss` |
| 后台 Tab 配置 | `utils/constants.js` → `ADMIN_TABS`、`ROLE_MAP` |
| 举报处理逻辑（审核队列 / 通过 / 下架 / 警告 / 封禁） | `cloudfunctions/admin/index.js` + `cloudfunctions/report/index.js` |
| 内容审核队列（待审列表 / auditReason 标签 / 通过上线 / 下架选原因 / 通知作者） | `cloudfunctions/admin/index.js` → `getAuditQueue` / `approve` / `reject`；页面在 `pages/admin`「内容审核」Tab（三 Tab 之一） |
| 阈值（自动审查 / 自动封禁） | 三处同步，见第 4 节 |

---

## 7. 动手前必须知道的约定（避免踩坑）

1. **身份只在服务端**：`openid` 从 `getWXContext()` 取，客户端传的一律不信。
2. **敏感写入只走云函数**：发布 / 举报 / 评价 / 申请状态 / 后台操作，前端不留直写通道。
3. **改完代码由用户自己在微信开发者工具模拟器验收**，等反馈再继续；不擅自扩范围到未要求的页面。
4. **页面临时调试开关**：`pages/task/task.js` → `DEV_DEBUG`（默认 `false`），排障时临时改 `true`，定位后必须改回。
5. **列表性能**：全量数据格式化一次进 `this.postPool`，Tab 切换零请求。
6. **文档数量口径**：本文第 4、5 节与代码保持一致（v1.7.0：**12 个云函数 / 10 个集合 / 8 个页面**）。`BETA_CHECKLIST.md`、`CODE_REVIEW.md` 等历史文档里的数量可能是旧值，以本文与代码为准。
7. **字段兜底**：前端渲染一律走 `normalizeXxx` 与 `formatPost`，缺字段 / 未部署云函数不得白屏。
8. **云函数部署不是编译**：改 `cloudfunctions/**` 必须重新「上传并部署」，否则线上仍是旧逻辑。

---

## 8. 关联文档与文件速查

| 文档 | 用途 |
|---|---|
| `PRD.md` | 产品需求、数据模型、风控与验收标准（业务规则的最终依据） |
| `BETA_CHECKLIST.md` | 控制台部署 / 集合权限 / 内测自测 / 提交前 Git 检查清单（数量口径可能旧，以本文第 4、5 节为准） |
| `AGENTS.md` | 协作约定（提醒 / 心跳等工具使用规范） |
| `memory/MEMORY.md` | 长期记忆：架构决策、已知坑、待办 |
| `PROJECT_MAP.md` | 本文：导航地图 |

**文件体量速查**（估算上下文开销，行数为当前版本）

| 文件 | 行数 | 说明 |
|---|---|---|
| `utils/store.js` | 1804 | 最大文件，按第 3 节章节索引只读需要的段 |
| `cloudfunctions/admin/index.js` | 1118 | 管理后台（含审核队列 / 警告 / 封禁） |
| `cloudfunctions/application/index.js` | 845 | 申请流转 |
| `cloudfunctions/user/index.js` | 690 | 用户资料 + 账号注销 |
| `pages/admin/admin.js` | 672 | 后台页 |
| `cloudfunctions/publish/index.js` | 604 | 发布 + 词库副本 |
| `pages/detail/detail.js` | 539 | 详情页 |
| `pages/task/task.js` | 536 | 任务页 |
| `cloudfunctions/review/index.js` | 477 | 评价 |
| `utils/constants.js` | 473 | 字典 / 文案 / 词库 |
| `cloudfunctions/report/index.js` | 316 | 举报 + 风控 |
| `cloudfunctions/post/index.js` | 325 | 帖子状态唯写入口：结束 / 删除 / 联系方式 |
| `pages/profile/profile.js` | 517 | 我的（含校区选择 / 注销） |
| `pages/publish/publish.js` | 284 | 发布页 |
| `cloudfunctions/message/index.js` | 243 | 消息中心（通知 + 公告） |
| `cloudfunctions/getAuthorProfile/index.js` | 238 | 发布者名片 |
| `pages/index/index.js` | 236 | 大厅 |
| `pages/messages/messages.js` | 163 | 消息中心页 |
| `cloudfunctions/initDb/index.js` | 79 | 建集合 / 自检 |
| `cloudfunctions/heat/index.js` | 45 | 热度 |
| `cloudfunctions/login/index.js` | 61 | openid + 黑名单拦截 |

---

_维护约定：增删页面 / 云函数 / 集合时同步更新第 2、4、5 节；新增「多副本同步点」时必须写进第 6 节，否则下一个改代码的人一定会漏。_

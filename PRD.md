# 📄 寻呼 (Xunhu) 极简开发军规 v2.0

## 1. 绝对不可触犯的底线
*   **无金钱交易**：个人主体，严禁任何支付、悬赏、代币功能。
*   **无陌生人社交**：严禁做私信、评论区。只做信息展示与申请流转。
*   **纯学术互助**：严禁代课、代考、刷单，违禁词必须被前端和云端双重拦截。
*   **隐私绝对安全**：绝不要求上传学生证、身份证照片。

## 2. 核心数据字典 (已接入云开发)
*   **posts 表**：包含 `_openid`, `category` (team/resume/partner), `title`, `content`, `tags`, `authorOpenid`, `authorName`, `contact`, `status` (active/auditing/ended/draft), `heat`, `createTime`, `secCheck` (机审结论留痕)。
*   **applications 表**：包含 `postId`, `applicantOpenid`, `receiverOpenid`, `status` (pending/accepted/rejected)。
*   **users 表**：包含 `_openid`, `nickName`, `studentId`, `contact`, `resume`。
*   **reports 表**：包含 `postId`, `reporterOpenid`, `reason`, `desc`, `createTime`（另存 `postSnapshot` 便于复核；仅云函数可读写，客户端不可见）。

## 3. 核心业务状态机与鉴权
*   **学号认证**：正则 `^31\d{8}$`，云端查重唯一，一经绑定**严禁修改**。需引导线下核验解绑。
*   **发布逻辑（风控折中方案）**：先校验资料是否完善（昵称、联系方式、学号全齐）。发布必须走云函数 `publish`：先过本地违禁词，再调 `cloud.openapi.security.msgSecCheck` 机审（标题 + 描述）；
    *   机审不通过（`87014` / `suggest = risky|review`）→ 直接拦截，返回「您发布的内容涉嫌违规，请修改后重试」，不写库；
    *   机审通过 → `status` 直接写 `active`（寻呼中，大厅可见可点入）；
    *   网络/云端异常 → 存本地草稿，状态为 `draft`。
*   **举报与打码审查**：用户举报走云函数 `report`：往 `reports` 写一条记录，并把该帖 `status` 改为 `auditing`（大厅打码、不可点入，详情页 onLoad 直接拦回大厅，发帖人本人也不例外）。
*   **详情页与热度的防刷**：详情页进入热度+1，申请+5，利用本地 `local_heat_history` 限制单日单次。已结束(`ended`)的帖子不可申请。
*   **联系方式脱敏**：`applications` 处于 `pending` 时，双方绝对看不到联系方式；只有发帖人点击【同意】(变为 `accepted`) 后，双方才互相展示联系方式。学号对外仅展示脱敏 (如 `3123****34`)。

## 4. 架构规范
*   页面只负责渲染，所有数据操作必须走 `utils/store.js` 的异步接口（云数据库）。
*   全局配置颜色变量，保持 UI 呼吸感（大圆角、浅阴影、留白）。

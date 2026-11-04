// utils/constants.js
// 全局共享字典 / 常量：所有页面统一从这里取，避免字典、写死用户、Storage key 在多处各写一份
// 字段结构严格遵循 PRD「四、核心数据模型」：
//   posts        -> id / category / title / content / tags / authorName / contact / status / heat / createTime
//   applications -> id / postId / applicantId / applicantName / applicantContact / applicantStudentId
//                   / applicantResume / applyNote / receiverId / status / createTime / statusUpdateTime

// 身份一律由云端提供，前端不再保存任何「当前用户」常量：
//   openid  -> 云函数 login 下发（store.getOpenId()）
//   昵称/学号/简历/联系方式 -> 云数据库 users 集合（云函数 user 读写，store.getProfile()）
// 历史版本里的 CURRENT_USER（林同学）与 DEFAULT_PROFILE（假简历/假微信号）已彻底删除，禁止再加。

// 云开发环境 ID：微信开发者工具顶部「云开发」→ 设置 → 环境设置 里的那串 ID
// TODO 换成你自己的环境 ID，否则 wx.cloud.init 会报 env not exists
const CLOUD_ENV = 'cloud1-d3g0izqlv27c2ee8d';

// 云数据库集合名（initDb 云函数负责创建）
const COLLECTIONS = {
  POSTS: 'posts',
  // 帖子联系方式单独存放（v1.3.0 隐私修复）：_id = postId，客户端「所有用户不可读写」，
  // 只有云函数按「作者本人 / 已同意申请」的关系裁剪下发。posts 文档里不再有 contact 字段。
  POST_CONTACTS: 'post_contacts',
  APPLICATIONS: 'applications',
  USERS: 'users', // 用户资料：昵称 / 学号 / 简历 / 联系方式（一个 openid 一条）
  REPORTS: 'reports', // 举报记录：postId / reporterOpenid / reason / desc / status / createTime（客户端不直接读写）
  REVIEWS: 'reviews', // 双向评价：reviewId / postId / reviewerOpenid / revieweeOpenid / rating / content / createTime（客户端不直接读写）
  ADMIN_LOGS: 'admin_logs', // 后台操作日志：adminOpenid / action / targetId / createTime（客户端不直接读写）
  // 个人通知信箱（v1.4.0）：_openid / type('system') / title / content / createTime / isRead
  // 客户端零权限，读走云函数 message，写只发生在 cloudfunctions/admin（处罚 / 解绑后投递）
  MESSAGES: 'messages',
  // 全体公告（v1.4.0）：title / content / createTime（全局，无已读字段；已读只是设备本地概念）
  ANNOUNCEMENTS: 'announcements',
  // 黑名单（v1.6.0 合规）：openid / reason / source / createTime
  // 客户端零权限，只由云函数（user 注销 / admin 封禁）写入，login / user / publish / application 查询拦截
  BLACKLIST: 'blacklist'
};

// 云函数名（cloudfunctions/ 目录下同名文件夹，需在工具里「上传并部署」）
const CLOUD_FUNCTIONS = {
  LOGIN: 'login',   // 取 openid（只证明「你是谁」，不返回任何资料）
  USER: 'user',     // 读写 users 集合（action: get / save）
  INIT_DB: 'initDb', // 建集合（云端才能 createCollection）
  HEAT: 'heat',     // 热度原子自增
  PUBLISH: 'publish', // 发布：内容安全机审 + 直接上线（status = active）
  REPORT: 'report',  // 举报：写 reports + 帖子改 auditing
  REVIEW: 'review',  // 评价：同一帖子同一被评价人唯一记录（查重后只 add），并回传匿名评价列表
  GET_AUTHOR_PROFILE: 'getAuthorProfile', // 详情页发布者名片：一次查 users 简历 + reviews 匿名统计
  ADMIN: 'admin',    // 管理后台：举报审查 / 学号申诉（校验 role === 'admin'）
  APPLICATION: 'application', // 申请流转唯一入口：apply / updateStatus / list（越权拦截在服务端）
  POST: 'post',      // 帖子状态唯一写入口：end / delete / contact（服务端校验 authorOpenid）
  MESSAGE: 'message' // 消息中心读入口：list（通知 + 公告）/ read（标记已读）/ badge（红点）
};

// 分类：英文枚举 -> 中文
// 【v1.6.0 文案合规】partner 的展示文案统一改为「同好」
//   为什么改：旧文案在小程序类目审核里最容易被判成「陌生人社交」（约陌生人线下见面），
//   而本产品实际是「同好/活动组队」的信息发布工具（无 IM、无推荐算法、无用户检索）。
//   注意：**枚举值 partner 保持不变**，只改展示文案 —— 数据库里历史帖子的 category 仍是 partner，
//   改了枚举值等于让所有老帖子掉出分类匹配。改文案只影响这里与 CATEGORY_LIST。
const CATEGORY_MAP = {
  team: '组队',
  resume: '自荐',
  partner: '同好'
};

// 分类列表（发布页 picker 用，顺序即 picker 顺序）
const CATEGORY_LIST = [
  { key: 'team', text: '组队' },
  { key: 'resume', text: '自荐' },
  { key: 'partner', text: '同好' }
];

// 帖子状态：draft 草稿 / auditing 审核中（被举报打码）/ active 进行中（机审通过已上线）/ ended 已结束
const POST_STATUS_MAP = {
  draft: '草稿',
  auditing: '审核中',
  active: '进行中',
  ended: '已结束',
  // 违规下架终态：大厅与往期历史都不展示（口径「四、帖子状态机」）
  deleted: '已违规下架'
};

// 统一文案：机审拦截 / 审核中拦截（页面共用，避免文案各写一份）
const CONTENT_RISKY_MESSAGE = '您发布的内容涉嫌违规，请修改后重试';
// 【v1.7.2 文案软化】审核中帖子对其他用户的拦截提示：
//   旧文案「该内容涉嫌违规，正在审查中」对被举报但未定性的帖子等于提前定罪，
//   也容易让作者误以为已被判违规。对普通用户只需要一句「现在看不了，晚点再来」。
const AUDITING_BLOCK_MESSAGE = '该帖子正在审核中，请稍后再试';

// 管理员对外联系邮箱（口径「十、违规处置」要求受罚者拦截文案给出真实邮箱）
const ADMIN_CONTACT_EMAIL = 'xunhu_app@qq.com';
// 受罚者（role === 'banned'）拦截文案：前端入口拦截统一用这一句
const BANNED_BLOCK_MESSAGE = '您的账号因违规已被限制使用，如有疑问请联系管理员邮箱：' + ADMIN_CONTACT_EMAIL;

/**
 * 违禁词命中文案（全局唯一句式，口径「十一、违禁词与内容安全」）
 *   violationMessage('发布', '代课') -> '发布失败：包含违规词汇【代课】，请修改后重试。'
 * action 取值：发布 / 保存 / 评价 / 报名
 */
function violationMessage(action, word) {
  const hit = word ? '【' + word + '】' : '';
  return action + '失败：包含违规词汇' + hit + '，请修改后重试。';
}

/* ---------------- 自动化风控（v1.2.0） ----------------
 * posts.reportWeight  举报权重：每个「新举报人」+1（同一人重复举报不重复加权）
 * users.warningCount  违规警告次数：帖子权重首次触顶自动审查 +1；管理员「确认违规」再 +1
 * users.role          user / banned / admin（只能由服务端或控制台写，客户端永远改不了）
 *
 * 【重要】阈值只在云函数里生效（cloudfunctions/report、cloudfunctions/admin），
 * 前端这份常量只用于页面文案与展示，不要在前端做任何「自动封禁」判断。
 */
// v1.3.0 提高阈值（防协同举报滥用），v1.8.0 内测冷启动回调到 3
// 【v1.8.0 策略调整】3 -> 5 -> 3：内测期需要“违规内容尽快下去”，协同举报的风险由 DEDUPE_BY_REPORTER +
//   作者申诉（后台确认无违规时 auditDismissed 不重复扣警告）兑现，不再靠抬高阈值。
const REPORT_WEIGHT_AUDIT_THRESHOLD = 3; // reportWeight >= 3 -> 自动改 status = 'auditing'
const WARNING_BAN_THRESHOLD = 3;         // warningCount >= 3 -> 自动改 role = 'banned'（仅标记，不切断前端）

/* 列表拉取上限（内测降本）：大厅 / 任务页每次同步只拉最新 20 条（= 1 次 get 请求）。
 * 以前是 100 条（5 次 get），冷启动 + 每次 onShow 都在烧云开发额度。
 * 注意：往期历史 Tab 因而只覆盖最近 20 条内的已结束帖子；要看更早的请走详情页/任务页。*/
const POSTS_FETCH_LIMIT = 20;

// 角色 -> 中文（后台展示用）
const ROLE_MAP = {
  user: '普通用户',
  banned: '已封禁',
  admin: '管理员'
};

// 管理后台 Tab（顺序即页面展示顺序）
// v1.7.0 统一审核流：【举报审查】与【内容审核】合并成一张待办清单（内容审核），
// 「发布公告」改称【系统公告】—— 三个 Tab = 三类待办，不再有重复入口。
const ADMIN_TABS = [
  { key: 'audit', text: '内容审核' },
  { key: 'appeal', text: '学号申诉' },
  { key: 'announce', text: '系统公告' }
];

// 一人一帖：同一用户同时只允许一条「占用名额」的帖子 —— active（进行中）与 auditing（审查中）
// 都占名额，ended 不占（口径「四、帖子状态机」：auditing 期间不能发布新帖）。
// 前端（大厅 + 号 / 发布页）只是体验层拦截，真正拦得住的是云函数 publish（ALREADY_HAS_ACTIVE）。
const ACTIVE_POST_LIMIT_MESSAGE = '您已有寻呼中或审查中的信息，请先结束后再发布新信息。';

/* ---------------- 双向评价（防互刷） -------------
 * 集合 reviews：reviewId / postId / reviewerOpenid / revieweeOpenid / rating / content / createTime
 * 核心规则（云端 cloudfunctions/review 唯一实现）：同一个帖子、同一个被评价人，
 *   一个评价人只能提交一次（一个帖子招多个队友时，B 和 C 要能分别评）：
 *   写入前先查 postId + reviewerOpenid + revieweeOpenid，已存在直接返回 ALREADY_REVIEWED，
 *   **只允许 add、不再有覆盖更新**。
 * 建议权限：reviews 设「所有用户不可读写」，读写只走云函数 —— 评价人 openid 因此无法被前端拿到。
 */
const REVIEW_CONTENT_MAX = 50;          // 评价文本上限（WXML maxlength 也取这个值）
// 已评价过时的统一文案：云端 ALREADY_REVIEWED_MESSAGE、任务页按钮/toast 都用这一句
const ALREADY_REVIEWED_MESSAGE = '您已经评价过本次合作了';
const REVIEW_MIN_COUNT = 3;             // 收到评价少于 3 条时只显示「满意度统计中...」
const REVIEW_PENDING_TEXT = '满意度统计中...';
const REVIEW_ANONYMOUS_NAME = '某同学';  // 评价人一律匿名展示，不暴露昵称/openid

/**
 * 好评率统一文案：个人页「收到的评价」与详情页「发布者名片」共用同一句，
 * 保证两处展示的次数 / 百分比口径完全一致（只改这里，两处同时生效）。
 *   满 REVIEW_MIN_COUNT 条 -> 「好评率 95%（共 20 条评价）」
 *   不足但有数据       -> 「满意度统计中...（2/3 条）」
 *   一条都没有         -> 「满意度统计中...」
 */
function formatReviewRateText(total, rate) {
  const count = Number(total) || 0;
  if (count >= REVIEW_MIN_COUNT) {
    return '好评率 ' + (Number(rate) || 0) + '%（共 ' + count + ' 条评价）';
  }
  if (count > 0) {
    return REVIEW_PENDING_TEXT + '（' + count + '/' + REVIEW_MIN_COUNT + ' 条）';
  }
  return REVIEW_PENDING_TEXT;
}

// 详情页「发布者名片」：简历默认只显示 3 行，超过这个字数就出现「展开全文」
const AUTHOR_RESUME_PREVIEW_CHARS = 60;
const AUTHOR_RESUME_EMPTY_TEXT = '这位同学还没有填写简历 / 技能描述';
const AUTHOR_REVIEW_EMPTY_TEXT = '还没有收到文字评价';

// 评价选项：1 满意 / 0 不满意（rating 只允许这两个值，云端会再校验一次）
const REVIEW_RATING_OPTIONS = [
  { value: 1, text: '满意' },
  { value: 0, text: '不满意' }
];

// 申请状态：pending 待处理 / accepted 已同意 / rejected 已拒绝
const APPLICATION_STATUS_MAP = {
  pending: '待处理',
  accepted: '已同意',
  rejected: '已拒绝'
};

/* ---------------- 申请（报名） ----------------
 * 读写全部走云函数 application（cloudfunctions/application）：
 *   apply       申请人提交，附言必填 -> applications.applyNote
 *   updateStatus 收帖人同意 / 拒绝，服务端校验 receiverId === 当前 openid（越权拦截唯一实现）
 *   list        联查 posts + users，把申请人昵称 / 简历 / 附言拼好后下发
 * 因此 applications 集合建议把 write 置为 false（客户端连 add 都不需要），
 * read 保留自定义规则只为「云函数未部署时」的降级兜底。
 */
const APPLY_NOTE_MAX = 100; // 申请附言上限（WXML/弹窗、store、云函数三处同一值）
const APPLY_NOTE_PLACEHOLDER = '简单介绍自己：能帮上什么忙、什么时候有空（必填）';
const APPLY_NOTE_EMPTY_TEXT = '对方没有填写申请附言';
// 申请前必须让用户看到的警告（与协议 2.1 同一口径）：联系方式必须真实
const APPLY_CONTACT_WARNING = '请确保您填写的联系方式真实有效。若被举报虚假联系，平台将封禁您的账号权限。';

// 发帖人姓名 -> openid：仅用于「首次灌入演示数据」时给帖子标注 authorOpenid
// （接入云开发后，真实帖子的 authorOpenid 一律取当前用户 openid）
const AUTHOR_OPENID_MAP = {
  '张同学': 'openid_mock_zhang',
  '李同学': 'openid_mock_li',
  '王同学': 'openid_mock_wang',
  '陈同学': 'openid_mock_chen',
  '林同学': 'openid_mock_lin',
  '黄同学': 'openid_mock_huang'
};

/* ---------------- 违禁词库（PRD「六、安全拦截」本地风控第一层） ----------------
 * 个人主体无法调用微信机审（48001），所以本地词库就是主防线。
 * 硬性约定：所有词必须是「纯文本」——不含空格、不含标点、全小写。
 * 因为匹配前我们会把待检文本里的空格 + 全部标点删掉，词库里带标点永远匹配不上。
 */

// 学术舞弊（代写作业 / 替考 / 卖论文）
const ACADEMIC_FRAUD = ['代课', '代考', '代写', '替课', '替考', '论文买卖', '包过', '抢手'];

// 诈骗与违规交易（刷单 / 赌博 / 网贷套现）
const FRAUD_SCAM = ['刷单', '兼职赚钱', '日结', '博彩', '赌球', '网贷', '裸贷', '套现', '洗钱'];

// 隐私侵害（色情引流 / 个人信息买卖）
const PRIVACY_VIOLATION = ['裸聊', '约炮', '开房', '身份证出售', '查开房记录'];

// 合并成唯一数据源：新增词只往上面分类数组里加，这里不用动
const FORBIDDEN_WORDS = [].concat(ACADEMIC_FRAUD, FRAUD_SCAM, PRIVACY_VIOLATION);

// 拼音兜底词库：防「dai ke」「daikao」这类用拼音规避中文词的做法。
// 键 = 违禁词的全拼（连续、小写、无声调），值 = 对应中文词（提示用户时要显示中文）。
const PINYIN_FORBIDDEN_MAP = {
  daike: '代课',
  daikao: '代考',
  daixie: '代写',
  tike: '替课',
  tikao: '替考',
  lunwenmaimai: '论文买卖',
  baoguo: '包过',
  qiangshou: '抢手',
  shuadan: '刷单',
  jianzhizhuanqian: '兼职赚钱',
  rijie: '日结',
  bocai: '博彩',
  duqiu: '赌球',
  wangdai: '网贷',
  luodai: '裸贷',
  taoxian: '套现',
  xiqian: '洗钱',
  luoliao: '裸聊',
  yuepao: '约炮',
  kaifang: '开房',
  shenfenzhengchushou: '身份证出售',
  chakaifangjilu: '查开房记录'
};

/* ---------------- 净化匹配工具（前端 + 云函数各持一份相同实现） ---------------- */

// 零宽字符 / BOM：肉眼看不见，但会把「代课」拆成「代\u200B课」，先干掉
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200D\u2060\uFEFF]/g;

// 全角 ASCII（ａ-ｚ ０-９ ！ 等）转半角：防「ｄａｉｋｅ」这类全角规避
const FULLWIDTH_ASCII_REGEX = /[\uFF01-\uFF5E]/g;

// 标点正则：优先用 Unicode 属性类 \p{P}（一次覆盖绝大多数中英文标点），
// 老基础库不支持 u 标志会抛 SyntaxError，此时回退到手写全标点字符集
const FALLBACK_PUNCTUATION_REGEX = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。、；：？！…—–～·「」『』【】《》〈〉（）〔〕［］｛｝“”‘’＄％＃＆＊＠＾＿＋－＝｜＼／＜＞※→←↑↓☆★○●◎◇◆□■△▲▽▼§¶©®™°±×÷]/g;

const CLEAN_TEXT_REGEX = (function () {
  try {
    return new RegExp('[\\s\\p{P}]', 'gu');
  } catch (err) {
    // 基础库不支持 \p{P}：退化为手写标点 + \s（\s 已含全角空格 \u3000）
    return FALLBACK_PUNCTUATION_REGEX;
  }
})();

/**
 * 净化文本：小写 + 全角转半角 + 删零宽字符 + 删所有空白与标点
 * 例：「代 * 考」「代　课」「Dai Ke」「代\n课」「ｄａｉｋｅ」都会变成干净串，拆字/插标点/全角全失效
 */
function cleanText(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(FULLWIDTH_ASCII_REGEX, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .replace(INVISIBLE_CHARS_REGEX, '')
    .replace(CLEAN_TEXT_REGEX, '');
}

/**
 * 违禁词校验（唯一入口，彻底取代旧的「原文 + 去空白」双层检测）
 * @param {string} text 待检文本（调用方自行把 title/content/tags/contact 拼成全文）
 * @return {{pass: boolean, word?: string, type?: string}} 命中返回 { pass: false, word: '代课', type: 'word'|'pinyin' }
 */
function checkTextViolation(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return { pass: true };

  // 1. 中文词库
  for (let i = 0; i < FORBIDDEN_WORDS.length; i++) {
    const word = FORBIDDEN_WORDS[i];
    if (cleaned.indexOf(word) > -1) {
      return { pass: false, word: word, type: 'word' };
    }
  }

  // 2. 拼音兜底（纯本地映射，不依赖任何拼音转换库）
  const pinyinList = Object.keys(PINYIN_FORBIDDEN_MAP);
  for (let j = 0; j < pinyinList.length; j++) {
    const pinyin = pinyinList[j];
    if (cleaned.indexOf(pinyin) > -1) {
      return { pass: false, word: PINYIN_FORBIDDEN_MAP[pinyin], type: 'pinyin' };
    }
  }

  return { pass: true };
}

/* ---------------- 校区（v1.6.0） ----------------
 * 为什么不再收集真名：平台没有核验能力，收集真名既不构成认证，又是一份纯风险数据（泄露即事故）。
 * 现在只收「校区」：从固定选项里选的非敏感值，用于展示与匹配。
 * 规则：
 *   · CAMPUS_LIST 是服务端 + 前端共同认可的完整取值域，云端非法值直接拒；
 *   · CAMPUS_OPTIONS 是 picker 当前开放给用户选的值（本期只有「揭阳」）；
 *   · 云端校验以 CAMPUS_LIST 为准 —— 运营侧放开新校区时，老客户端保存新值也不会被拒。
 * 【同步】cloudfunctions/user（save 校验）、publish / application（资料完备校验）里各有一份同值副本。
 */
const CAMPUS_LIST = ['揭阳', '大学城', '东风路', '龙洞', '番禺', '沙河'];
// picker 实际可选项（用户能看到的）：本期只开揭阳，扩容时把新校区加进这个数组即可
const CAMPUS_OPTIONS = ['揭阳'];
// 法律口径唯一来源（协议 1.3 / 3.3、个人页提示、guard 弹窗共用这一句）
const CAMPUS_DISCLAIMER = '平台仅收集您所在的校区，用于展示和匹配，不代表官方认证。';
const CAMPUS_TIP = CAMPUS_DISCLAIMER;
const CAMPUS_REQUIRED_MESSAGE = '请选择你所在的校区';
const CAMPUS_INVALID_MESSAGE = '校区不在可选范围内，请重新选择';

// 学号输入框下方说明（与协议 1.2 同一口径：只做账号唯一性校验，不接学籍系统）
const STUDENT_ID_TIP = '学号仅用于账号唯一性校验，平台不接入学籍系统，不代表官方认证。';

/* ---------------- 账号注销（v1.6.0 合规） ----------------
 * 注销 = 写黑名单 + 删 users + 帖子 status 改 deleted + 级联清理申请/评价/通知。
 * 黑名单只记 openid（不记昵称/学号/联系方式），否则「注销」就名不副实了。
 */
const DELETE_ACCOUNT_TITLE = '注销账号';
const DELETE_ACCOUNT_CONTENT = '注销后你的资料会被删除、发布的信息全部下架，已发出的申请与评价也会一并清理，且无法恢复。确定注销吗？';
const DELETE_ACCOUNT_REASON = 'user_deleted';

/* ---------------- 个人通知 / 全体公告（v1.4.0） ----------------
 * messages：谁的通知只有谁看得见（_openid 归属），客户端零权限，读写全走云函数；
 * announcements：全局公告，没有「已读」字段 —— 「已读」是设备本地概念，
 *   本地存 lastReadMessageTime，最新公告时间比它新就亮红点（个人通知另有 isRead 字段）。
 */
const MESSAGE_LIST_LIMIT = 20;     // 消息中心一次最多展示 20 条个人通知
const ANNOUNCEMENT_LIST_LIMIT = 3; // 公告永远置顶，只取最新 3 条
const ANNOUNCEMENT_ICON = '📢';    // 公告标题前的图标（唯一来源，页面不写死）
const MESSAGE_EMPTY_TEXT = '暂无通知';
const ANNOUNCEMENT_TITLE_MAX = 30;  // 公告标题上限（后台发布前后端同值校验）
const ANNOUNCEMENT_CONTENT_MAX = 600; // 公告正文上限

/* ---------------- 一次性订阅消息（v1.5.0） ----------------
 * 模板 ID 到「微信公众平台 → 功能 → 订阅消息 → 我的模板」申请后填到下面两个变量；
 * 留空时 utils/subscribe.js 直接跳过授权（不报错、不弹窗），申请 / 同意照常完成。
 *
 * 【重要】授权只是「允许发一条」，真正把消息发出去还必须由服务端调用：
 *   cloud.openapi.subscribeMessage.send({ touser, template_id, page, data })
 * 所以模板 ID 填好之后，还需要在 cloudfunctions/application 里补一段发送逻辑，
 * 否则用户授权了也永远收不到通知（本次只做前端授权，未改云函数）。
 */
const TMPL_APPLY_ID = '';  // 申请人点「提交申请」时订阅：申请结果通知（发给申请人自己）
const TMPL_ACCEPT_ID = ''; // 发帖人点「同意申请」时订阅：新申请提醒（发给发帖人自己）

// 学号校验：广工 10 位学号，以 31 开头（31 + 8 位数字）
// 同一份规则必须在两处生效：
//   前端 profile 保存前（给用户友好提示）
//   云函数 user.save（防绕过，真正当防线）
// 注意：云函数目录独立打包，拿不到本文件，cloudfunctions/user/index.js 里有一份同值正则，改这里要同步改。
const STUDENT_ID_REGEX = /^31\d{8}$/;

// 注：学号不再公开展示（详情页已删除学号徽章），因此无需脱敏工具；
// 完整学号仅在「发帖人同意了某人的申请」后，由任务页向该发帖人展示申请人学号。

// 举报分类
const REPORT_CATEGORIES = ['虚假信息', '违规内容', '骚扰谩骂', '其他'];

// 本地 Storage 统一 key（只留仍在本地的部分：登录标记、草稿、热度防刷记录、页面秒开快照）
// 注：举报记录已改为云端 reports 集合（云函数 report 写入），不再落本地
const STORAGE_KEYS = {
  HEAT_HISTORY: 'local_heat_history', // 热度防刷记录：openid + 帖子 id + 日期 + 动作
  // 【v1.8.0】草稿 key 改为 publish_draft（发布页直接 wx.setStorageSync 写入，大厅「草稿」卡片同 key 读取）
  DRAFT: 'publish_draft',             // 发布失败的单份草稿（离线可用，属本地概念）
  IS_LOGIN: 'isLogin',                // 仅表示「本次设备已登录」，不等于身份数据
  // 消息中心「最近一次进入时间」：只存本地，用于判断「有没有比它更新的公告」
  LAST_READ_MESSAGE_TIME: 'lastReadMessageTime',
  // 缓存先行（v1.1.0）：列表数据的本地快照，只为了 onShow 秒开，不入业务逻辑
  CACHE_POSTS: 'cache_posts',              // 大厅帖子快照 { updateTime, list }
  CACHE_APPLICATIONS: 'cache_applications' // 我的申请快照 { updateTime, list }（退出登录时清掉）
};

// 旧版本本地 key：启动时顺手清掉，避免旧数据死灰复燃
//   local_profile -> 资料已改存云端 users 集合
//   local_reports -> 举报已改存云端 reports 集合
//   local_draft   -> v1.8.0 草稿 key 改为 publish_draft，旧 key 直接丢弃（旧草稿内容不再迁移）
const LEGACY_STORAGE_KEYS = ['local_profile', 'local_reports', 'local_draft'];

module.exports = {
  CLOUD_ENV,
  COLLECTIONS,
  CLOUD_FUNCTIONS,
  CATEGORY_MAP,
  CATEGORY_LIST,
  POST_STATUS_MAP,
  CONTENT_RISKY_MESSAGE,
  AUDITING_BLOCK_MESSAGE,
  ADMIN_CONTACT_EMAIL,
  BANNED_BLOCK_MESSAGE,
  violationMessage,
  ACTIVE_POST_LIMIT_MESSAGE,
  REPORT_WEIGHT_AUDIT_THRESHOLD,
  WARNING_BAN_THRESHOLD,
  POSTS_FETCH_LIMIT,
  ROLE_MAP,
  ADMIN_TABS,
  REVIEW_CONTENT_MAX,
  ALREADY_REVIEWED_MESSAGE,
  REVIEW_MIN_COUNT,
  REVIEW_PENDING_TEXT,
  REVIEW_ANONYMOUS_NAME,
  formatReviewRateText,
  REVIEW_RATING_OPTIONS,
  AUTHOR_RESUME_PREVIEW_CHARS,
  AUTHOR_RESUME_EMPTY_TEXT,
  AUTHOR_REVIEW_EMPTY_TEXT,
  APPLICATION_STATUS_MAP,
  APPLY_NOTE_MAX,
  APPLY_NOTE_PLACEHOLDER,
  APPLY_NOTE_EMPTY_TEXT,
  APPLY_CONTACT_WARNING,
  AUTHOR_OPENID_MAP,
  // 违禁词库 + 净化匹配工具（前端 pages/publish 直接用，云函数里有一份同值副本）
  ACADEMIC_FRAUD,
  FRAUD_SCAM,
  PRIVACY_VIOLATION,
  FORBIDDEN_WORDS,
  PINYIN_FORBIDDEN_MAP,
  cleanText,
  checkTextViolation,
  REPORT_CATEGORIES,
  CAMPUS_LIST,
  CAMPUS_OPTIONS,
  CAMPUS_DISCLAIMER,
  CAMPUS_TIP,
  CAMPUS_REQUIRED_MESSAGE,
  CAMPUS_INVALID_MESSAGE,
  STUDENT_ID_TIP,
  DELETE_ACCOUNT_TITLE,
  DELETE_ACCOUNT_CONTENT,
  DELETE_ACCOUNT_REASON,
  TMPL_APPLY_ID,
  TMPL_ACCEPT_ID,
  MESSAGE_LIST_LIMIT,
  ANNOUNCEMENT_LIST_LIMIT,
  ANNOUNCEMENT_ICON,
  MESSAGE_EMPTY_TEXT,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_CONTENT_MAX,
  STUDENT_ID_REGEX,
  STORAGE_KEYS,
  LEGACY_STORAGE_KEYS
};

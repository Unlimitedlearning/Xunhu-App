// utils/constants.js
// 全局共享字典 / 常量：所有页面统一从这里取，避免字典、写死用户、Storage key 在多处各写一份
// 字段结构严格遵循 PRD「四、核心数据模型」：
//   posts        -> id / category / title / content / tags / authorName / contact / status / heat / createTime
//   applications -> id / postId / applicantId / applicantName / receiverId / status / createTime

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
  APPLICATIONS: 'applications',
  USERS: 'users', // 用户资料：昵称 / 学号 / 简历 / 联系方式（一个 openid 一条）
  REPORTS: 'reports', // 举报记录：postId / reporterOpenid / reason / desc / createTime（客户端不直接读写）
  REVIEWS: 'reviews' // 双向评价：reviewId / postId / reviewerOpenid / revieweeOpenid / rating / content / createTime（客户端不直接读写）
};

// 云函数名（cloudfunctions/ 目录下同名文件夹，需在工具里「上传并部署」）
const CLOUD_FUNCTIONS = {
  LOGIN: 'login',   // 取 openid（只证明「你是谁」，不返回任何资料）
  USER: 'user',     // 读写 users 集合（action: get / save）
  INIT_DB: 'initDb', // 建集合（云端才能 createCollection）
  HEAT: 'heat',     // 热度原子自增
  PUBLISH: 'publish', // 发布：内容安全机审 + 直接上线（status = active）
  REPORT: 'report',  // 举报：写 reports + 帖子改 auditing
  REVIEW: 'review'   // 评价：A 对 B 唯一记录（查重后 add / update），并回传匿名评价列表
};

// 分类：英文枚举 -> 中文
const CATEGORY_MAP = {
  team: '组队',
  resume: '自荐',
  partner: '搭子'
};

// 分类列表（发布页 picker 用，顺序即 picker 顺序）
const CATEGORY_LIST = [
  { key: 'team', text: '组队' },
  { key: 'resume', text: '自荐' },
  { key: 'partner', text: '搭子' }
];

// 帖子状态：draft 草稿 / auditing 审核中（被举报打码）/ active 寻呼中（机审通过已上线）/ ended 已结束
const POST_STATUS_MAP = {
  draft: '草稿',
  auditing: '审核中',
  active: '寻呼中',
  ended: '已结束'
};

// 统一文案：机审拦截 / 举报后审查中（页面共用，避免文案各写一份）
const CONTENT_RISKY_MESSAGE = '您发布的内容涉嫌违规，请修改后重试';
const AUDITING_BLOCK_MESSAGE = '该内容涉嫌违规，正在审查中';

// 一人一帖：同一用户同时只允许一条 active（寻呼中）的帖子。
// 前端（大厅 + 号 / 发布页）只是体验层拦截，真正拦得住的是云函数 publish（ALREADY_HAS_ACTIVE）。
const ACTIVE_POST_LIMIT_MESSAGE = '您已有一条寻呼中的信息，请先结束后再发布新信息。';

/* ---------------- 双向评价（防互刷） -------------
 * 集合 reviews：reviewId / postId / reviewerOpenid / revieweeOpenid / rating / content / createTime
 * 核心规则（云端 cloudfunctions/review 唯一实现）：A 对 B 永远只有一条记录 ——
 *   写入前先查 reviewerOpenid == A 且 revieweeOpenid == B：不存在 add，已存在 update
 *   （rating / content / createTime / postId 全部覆盖成最新一次）。
 * 建议权限：reviews 设「所有用户不可读写」，读写只走云函数 —— 评价人 openid 因此无法被前端拿到。
 */
const REVIEW_CONTENT_MAX = 50;          // 评价文本上限（WXML maxlength 也取这个值）
const REVIEW_MIN_COUNT = 3;             // 收到评价少于 3 条时只显示「满意度统计中...」
const REVIEW_PENDING_TEXT = '满意度统计中...';
const REVIEW_ANONYMOUS_NAME = '某同学';  // 评价人一律匿名展示，不暴露昵称/openid

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

// 本地 Storage 统一 key（只留仍在本地的部分：登录标记、草稿、热度防刷记录）
// 注：举报记录已改为云端 reports 集合（云函数 report 写入），不再落本地
const STORAGE_KEYS = {
  HEAT_HISTORY: 'local_heat_history', // 热度防刷记录：openid + 帖子 id + 日期 + 动作
  DRAFT: 'local_draft',               // 上传失败的单份草稿（离线可用，属本地概念）
  IS_LOGIN: 'isLogin'                 // 仅表示「本次设备已登录」，不等于身份数据
};

// 旧版本本地 key：启动时顺手清掉，避免旧数据死灰复燃
//   local_profile -> 资料已改存云端 users 集合
//   local_reports -> 举报已改存云端 reports 集合
const LEGACY_STORAGE_KEYS = ['local_profile', 'local_reports'];

module.exports = {
  CLOUD_ENV,
  COLLECTIONS,
  CLOUD_FUNCTIONS,
  CATEGORY_MAP,
  CATEGORY_LIST,
  POST_STATUS_MAP,
  CONTENT_RISKY_MESSAGE,
  AUDITING_BLOCK_MESSAGE,
  ACTIVE_POST_LIMIT_MESSAGE,
  REVIEW_CONTENT_MAX,
  REVIEW_MIN_COUNT,
  REVIEW_PENDING_TEXT,
  REVIEW_ANONYMOUS_NAME,
  REVIEW_RATING_OPTIONS,
  APPLICATION_STATUS_MAP,
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
  STUDENT_ID_REGEX,
  STORAGE_KEYS,
  LEGACY_STORAGE_KEYS
};

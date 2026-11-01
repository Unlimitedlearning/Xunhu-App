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
  USERS: 'users' // 用户资料：昵称 / 学号 / 简历 / 联系方式（一个 openid 一条）
};

// 云函数名（cloudfunctions/ 目录下同名文件夹，需在工具里「上传并部署」）
const CLOUD_FUNCTIONS = {
  LOGIN: 'login',   // 取 openid（只证明「你是谁」，不返回任何资料）
  USER: 'user',     // 读写 users 集合（action: get / save）
  INIT_DB: 'initDb', // 建集合（云端才能 createCollection）
  HEAT: 'heat'      // 热度原子自增
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

// 帖子状态：draft 草稿 / auditing 审核中 / active 寻呼中 / ended 已结束
const POST_STATUS_MAP = {
  draft: '草稿',
  auditing: '审核中',
  active: '寻呼中',
  ended: '已结束'
};

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

// PRD「六、安全拦截」违禁词
const FORBIDDEN_WORDS = ['代课', '代考', '代写', '刷单'];

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

// 本地 Storage 统一 key（只留仍在本地的部分：登录标记、草稿、资料、举报、热度防刷记录）
const STORAGE_KEYS = {
  HEAT_HISTORY: 'local_heat_history', // 热度防刷记录：openid + 帖子 id + 日期 + 动作
  DRAFT: 'local_draft',               // 上传失败的单份草稿（离线可用，属本地概念）
  IS_LOGIN: 'isLogin',                // 仅表示「本次设备已登录」，不等于身份数据
  REPORTS: 'local_reports'
};

// 旧版本本地资料 key：新版本资料只存云端 users 集合，启动时顺手清掉，避免旧假数据死灰复燃
const LEGACY_STORAGE_KEYS = ['local_profile'];

module.exports = {
  CLOUD_ENV,
  COLLECTIONS,
  CLOUD_FUNCTIONS,
  CATEGORY_MAP,
  CATEGORY_LIST,
  POST_STATUS_MAP,
  APPLICATION_STATUS_MAP,
  AUTHOR_OPENID_MAP,
  FORBIDDEN_WORDS,
  REPORT_CATEGORIES,
  STUDENT_ID_REGEX,
  STORAGE_KEYS,
  LEGACY_STORAGE_KEYS
};

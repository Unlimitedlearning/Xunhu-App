// utils/constants.js
// 全局共享字典 / 常量：所有页面统一从这里取，避免字典、写死用户、Storage key 在多处各写一份
// 字段结构严格遵循 PRD「四、核心数据模型」：
//   posts        -> id / category / title / content / tags / authorName / contact / status / heat / createTime
//   applications -> id / postId / applicantId / applicantName / receiverId / status / createTime

// 模拟登录用户（接入云开发后替换为真实用户信息）
const CURRENT_USER = {
  name: '林同学',
  studentId: '2023010234',
  openid: 'openid_mock_lin'
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

// 发帖人姓名 -> openid（mockData 里的约定，用于生成申请的 receiverId）
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

// 举报分类
const REPORT_CATEGORIES = ['虚假信息', '违规内容', '骚扰谩骂', '其他'];

// 本地 Storage 统一 key（改名只改这里）
const STORAGE_KEYS = {
  POSTS: 'local_posts',
  APPLICATIONS: 'local_applications',
  HEAT: 'local_heat_overrides',
  IS_LOGIN: 'isLogin',
  PROFILE: 'local_profile',
  REPORTS: 'local_reports'
};

module.exports = {
  CURRENT_USER,
  CATEGORY_MAP,
  CATEGORY_LIST,
  POST_STATUS_MAP,
  APPLICATION_STATUS_MAP,
  AUTHOR_OPENID_MAP,
  FORBIDDEN_WORDS,
  REPORT_CATEGORIES,
  STORAGE_KEYS
};

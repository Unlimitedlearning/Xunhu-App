// utils/guard.js
// 全局能力校验（路由层拦截，页面统一调用）
//
// 【v1.6.0 漏斗优化】把「能不能看」和「能不能写」拆成两道门：
//   1) checkLogin()   —— 只校验登录（openid 已就位），用于**大厅 / 详情页浏览**。
//       为什么：以前浏览详情也要资料齐全，新用户点进第一条帖子就被弹窗拦下去填表，
//       这是最伤的漏斗漏洞 —— 先让他看到有价值的内容，再在真正要动作时才要求补资料。
//   2) ensureReady()  —— 校验昵称 + 校区 + 学号 + 联系方式完备，只用于【发布】与【申请】。
//       为什么：这两个动作会让对方拿到你的展示信息 / 联系方式，资料不全等于给别人制造无效沟通。
//   3) 受罚者（role === 'banned'）单独一层：banned 只拦详情 / 发布 / 申请 / 评价 / 举报，
//      可以浏览大厅与个人中心（口径「二、角色与账号权限」），所以它不塞进 checkLogin，
//      由调用点显式判断（isBanned + promptBanned）。
//
// 资料是否"完善"由 store.isProfileReady() 单点裁决（昵称 + 校区 + 学号 + 联系方式），页面不再自己判。

const store = require('./store');
const constants = require('./constants');

const PROFILE_PAGE = '/pages/profile/profile';

// 去「我的」（tabBar 页必须用 switchTab）
function goProfile() {
  wx.switchTab({ url: PROFILE_PAGE });
}

function promptLogin() {
  wx.showModal({
    title: '还未登录',
    content: '请先前往「我的」页面登录',
    confirmText: '去登录',
    cancelText: '取消',
    success: function (res) {
      if (res.confirm) goProfile();
    }
  });
}

function promptProfile() {
  wx.showModal({
    title: '资料未完善',
    content: '发布与申请前需要先填好昵称、校区、学号与联系方式，否则队友无法联系您。点击确定去完善资料',
    confirmText: '确定',
    cancelText: '取消',
    success: function (res) {
      if (res.confirm) goProfile();
    }
  });
}

// 受罚者（role === 'banned'）拦截：可浏览大厅 / 个人中心 / 自己的历史帖子列表，
// 但不可进详情、不可发布、不可申请、不可评价、不可举报（口径「二、角色与账号权限」）。
// 文案带真实管理员邮箱（口径「十、违规处置」+「十四、关键异常提示文案」）。
function promptBanned() {
  wx.showToast({
    title: constants.BANNED_BLOCK_MESSAGE,
    icon: 'none',
    duration: 2500
  });
}

// 静默判断（用于 UI 分层，不弹窗）
function isReady() {
  return store.isLoggedIn() && !store.isBanned() && store.isProfileReady();
}

/**
 * 【浏览门】只校验登录：大厅点卡片、详情页浏览走这道。
 * 不检查资料完备，也不检查是否封禁（封禁由调用点用 isBanned() 单独判）。
 * @return {boolean} false 表示已弹窗提示，调用方直接 return
 */
function checkLogin() {
  if (!store.isLoggedIn()) {
    promptLogin();
    return false;
  }
  return true;
}

/**
 * 【功能门】发布 / 申请按钮专用：登录 -> 封禁 -> 资料完备
 * 顺序：未登录 -> 受罚者 -> 资料未完善（封禁优先于「资料未完善」，否则会误导用户去改资料）
 * @return {boolean} false 表示已弹窗提示，调用方直接 return
 */
function ensureReady() {
  if (!store.isLoggedIn()) {
    promptLogin();
    return false;
  }
  if (store.isBanned()) {
    promptBanned();
    return false;
  }
  if (!store.isProfileReady()) {
    promptProfile();
    return false;
  }
  return true;
}

module.exports = {
  checkLogin,
  ensureReady,
  isReady,
  isBanned: store.isBanned,
  promptLogin,
  promptProfile,
  promptBanned,
  goProfile,
  PROFILE_PAGE
};

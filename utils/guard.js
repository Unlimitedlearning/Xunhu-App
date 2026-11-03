// utils/guard.js
// 全局能力校验（路由层拦截，页面统一调用）
//
// 原则：登录 ≠ 可用。
//   1) 未登录          -> 弹窗「请先前往「我的」页面登录」，确定后跳「我的」
//   2) 受罚者（banned）-> Toast「您的账号因违规已被限制使用，如有疑问请联系管理员邮箱：xxx」
//   3) 已登录但资料不全 -> 弹窗「您还没有完善联系方式/昵称，队友无法联系您。点击确定去完善资料」
//   4) 全部满足         -> 放行
// 资料是否"完善"由 store.isProfileReady() 单点裁决（昵称 + 联系方式 + 学号格式），页面不再自己判。

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
    content: '您还没有完善昵称、真实姓名与联系方式，队友无法联系您。点击确定去完善资料',
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

// 拦截判断：不满足条件会弹窗并返回 false，调用方直接 return 即可
// 顺序：未登录 -> 受罚者 -> 资料未完善（封禁优先于「资料未完善」，否则会误导用户去改资料）
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
  ensureReady,
  isReady,
  isBanned: store.isBanned,
  promptLogin,
  promptProfile,
  promptBanned,
  goProfile,
  PROFILE_PAGE
};

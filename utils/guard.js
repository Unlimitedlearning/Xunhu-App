// utils/guard.js
// 全局能力校验（路由层拦截，页面统一调用）
//
// 原则：登录 ≠ 可用。
//   1) 未登录          -> 弹窗「请先前往「我的」页面登录」，确定后跳「我的」
//   2) 已登录但资料不全 -> 弹窗「您还没有完善联系方式/昵称，队友无法联系您。点击确定去完善资料」
//   3) 两项都满足       -> 放行
// 资料是否"完善"由 store.isProfileReady() 单点裁决（昵称 + 联系方式都不为空），页面不再自己判。

const store = require('./store');

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
    content: '您还没有完善联系方式/昵称，队友无法联系您。点击确定去完善资料',
    confirmText: '确定',
    cancelText: '取消',
    success: function (res) {
      if (res.confirm) goProfile();
    }
  });
}

// 静默判断（用于 UI 分层，不弹窗）
function isReady() {
  return store.isLoggedIn() && store.isProfileReady();
}

// 拦截判断：不满足条件会弹窗并返回 false，调用方直接 return 即可
function ensureReady() {
  if (!store.isLoggedIn()) {
    promptLogin();
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
  promptLogin,
  promptProfile,
  goProfile,
  PROFILE_PAGE
};

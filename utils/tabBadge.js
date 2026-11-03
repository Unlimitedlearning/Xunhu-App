// utils/tabBadge.js
// 底部 TabBar「我的」角标（全局强提醒）
//
// 为什么单独抽一层：
//   · setTabBarBadge / removeTabBarBadge 只有 TabBar 页面才能生效。消息中心是 navigateTo 出来的
//     非 TabBar 页，在那里直接调用会走 fail 回调（"not TabBar page"），所以这里统一 try/catch + 缓存期望状态：
//     非 TabBar 页报错直接忽略，只更新期望状态，等用户回到 TabBar 页（onShow 里 reapply）再把状态落到 Tab 上。
//   · 用文字角标「新」而不是红点：红点在部分机型 / 基础库版本上位置会错位。
//   · 角标口径与个人页一致：有未读个人通知（isRead === false）或 有比本地 lastReadMessageTime 更新的公告。
//   · 查询失败（未登录 / message 云函数未部署）一律按「无角标」处理，绝不因此报错。

const store = require('./store');

// 「我的」在 app.json tabBar.list 里的下标：0 大厅 / 1 任务 / 2 我的
const PROFILE_TAB_INDEX = 2;

// TabBar 页面路由（只有这些页面上的调用才会真正生效）
const TAB_BAR_ROUTES = ['pages/index/index', 'pages/task/task', 'pages/profile/profile'];

// 角标文字（setTabBarBadge 的 text 最多 4 个字符，这里只提示「有新消息」，条数去消息页看）
const BADGE_TEXT = '新';

// 期望状态：true = 应该显示角标。非 TabBar 页设置后，回到 TabBar 页 reapply 生效
let desiredUnread = false;

function currentRoute() {
  try {
    if (typeof getCurrentPages !== 'function') return '';
    const pages = getCurrentPages() || [];
    if (!pages.length) return '';
    return pages[pages.length - 1].route || '';
  } catch (err) {
    return '';
  }
}

function isTabBarPage() {
  return TAB_BAR_ROUTES.indexOf(currentRoute()) > -1;
}

// 统一的 API 调用口：基础库不支持 / 不在 TabBar 页都静默降级，不抛错、不打断页面逻辑
// （非 TabBar 页调用会报 not TabBar page，属预期，直接忽略；回到 TabBar 页 reapply 时补上）
function callApi(method) {
  const api = wx && wx[method];
  if (typeof api !== 'function') return;
  try {
    const options = {
      index: PROFILE_TAB_INDEX,
      fail: function () {} // 静默容错：不 log、不提示、不影响页面逻辑
    };
    if (method === 'setTabBarBadge') options.text = BADGE_TEXT;
    api(options);
  } catch (err) {
    // 同步异常（基础库不支持等）同样忽略
  }
}

/**
 * 设置角标状态（非 TabBar 页只记期望状态，不会报错）
 * @param {boolean} hasUnread
 */
function apply(hasUnread) {
  desiredUnread = !!hasUnread;
  callApi(desiredUnread ? 'setTabBarBadge' : 'removeTabBarBadge');
}

/**
 * 把缓存的期望状态重新落到 Tab 上（TabBar 页 onShow 调用，零网络请求）
 */
function reapply() {
  if (!isTabBarPage()) return desiredUnread;
  callApi(desiredUnread ? 'setTabBarBadge' : 'removeTabBarBadge');
  return desiredUnread;
}

/**
 * 查云端未读并同步角标（TabBar 页 onShow 调用）
 * @return {Promise<boolean>} 当前是否应该显示角标
 */
async function refresh() {
  if (!store.isLoggedIn()) {
    apply(false);
    return false;
  }
  let hasUnread = false;
  try {
    const badge = await store.fetchMessageBadge();
    hasUnread = !!badge.hasUnread;
  } catch (err) {
    // fetchMessageBadge 内部已兜底，这里只是双保险
    hasUnread = false;
  }
  apply(hasUnread);
  return hasUnread;
}

module.exports = {
  apply,
  reapply,
  refresh
};

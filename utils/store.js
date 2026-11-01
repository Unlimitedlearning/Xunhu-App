// utils/store.js
// 本地数据访问层：统一读写 local_posts / local_applications / local_heat_overrides
// 页面只调这里的方法，不再各自 copy 一遍 getStorageSync / setStorageSync

const mockData = require('./mockData');
const constants = require('./constants');

const STORAGE_KEYS = constants.STORAGE_KEYS;

/* ---------------- 帖子 posts ---------------- */

function getLocalPosts() {
  return wx.getStorageSync(STORAGE_KEYS.POSTS) || [];
}

function saveLocalPosts(posts) {
  wx.setStorageSync(STORAGE_KEYS.POSTS, posts);
}

// 写入一条本地帖子：覆盖同 id 的旧记录，新记录排最前
function savePost(post) {
  const posts = getLocalPosts().filter(function (item) {
    return item && item.id !== post.id;
  });
  posts.unshift(post);
  saveLocalPosts(posts);
}

// 删除本地帖子（按 id）
function removePost(postId) {
  saveLocalPosts(getLocalPosts().filter(function (item) {
    return item && item.id !== postId;
  }));
}

// 全部帖子：本地缓存（含草稿）+ mockData
function getPosts() {
  const localPosts = getLocalPosts().filter(function (item) {
    return typeof item === 'object' && item !== null && item.id;
  });
  return localPosts.concat(mockData.postList || []);
}

function findPost(postId) {
  if (!postId) return null;
  return getPosts().find(function (item) {
    return item.id === postId;
  }) || null;
}

/* ---------------- 申请 applications ---------------- */

function getApplications() {
  const localApps = wx.getStorageSync(STORAGE_KEYS.APPLICATIONS);
  if (localApps && localApps.length > 0) return localApps;
  return mockData.mockApplications || [];
}

function saveApplications(apps) {
  wx.setStorageSync(STORAGE_KEYS.APPLICATIONS, apps);
}

function addApplication(application) {
  const apps = getApplications().concat(application);
  saveApplications(apps);
  return apps;
}

// 更新申请状态：返回更新后的完整列表
function updateApplicationStatus(applicationId, status) {
  const apps = getApplications().map(function (app) {
    if (app.id !== applicationId) return app;
    return Object.assign({}, app, { status: status });
  });
  saveApplications(apps);
  return apps;
}

/* ---------------- 热度 heat ---------------- */

function getHeatOverrides() {
  return wx.getStorageSync(STORAGE_KEYS.HEAT) || {};
}

// 热度 = max(帖子自带 heat, 本地覆盖表 heat)
function resolveHeat(post) {
  const baseHeat = typeof post.heat === 'number' ? post.heat : 0;
  const savedHeat = getHeatOverrides()[post.id];
  return (typeof savedHeat === 'number' && savedHeat > baseHeat) ? savedHeat : baseHeat;
}

// 持久化热度：覆盖表 + 本地帖子 + 内存 mockData 三处同步
function persistHeat(postId, heat) {
  const overrides = getHeatOverrides();
  overrides[postId] = heat;
  wx.setStorageSync(STORAGE_KEYS.HEAT, overrides);

  let changed = false;
  const localPosts = getLocalPosts().map(function (item) {
    if (item && item.id === postId) {
      changed = true;
      return Object.assign({}, item, { heat: heat });
    }
    return item;
  });
  if (changed) saveLocalPosts(localPosts);

  (mockData.postList || []).forEach(function (item) {
    if (item.id === postId) item.heat = heat;
  });
}

/* ---------------- 热度防刷（前端防抖，正式版由后端去重） ---------------- */

// 热度动作：浏览 +1 / 申请 +5，两种动作各自独立计数
const HEAT_ACTION = {
  VIEW: 'view',
  APPLY: 'apply'
};

// 本地日期键 YYYY-MM-DD（用本地时区，跨天自动重置）
function getTodayKey() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return now.getFullYear() + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
}

function getHeatHistory() {
  return wx.getStorageSync(STORAGE_KEYS.HEAT_HISTORY) || {};
}

// 记录键：帖子 id | openid | 日期 | 动作
function buildHeatKey(postId, openid, action) {
  return [postId, openid, getTodayKey(), action].join('|');
}

// 只保留今天的记录，避免 Storage 无限增长
function pruneHeatHistory(history, today) {
  const result = {};
  Object.keys(history).forEach(function (key) {
    if (key.split('|')[2] === today) result[key] = history[key];
  });
  return result;
}

/**
 * 认领一次热度：同一用户 + 同一帖子 + 同一天 + 同一动作 只成功一次
 * 返回 true 表示本次应加热度；false 表示已记过，不重复加
 */
function claimHeatOnce(postId, openid, action) {
  if (!postId || !openid || !action) return false;
  const today = getTodayKey();
  const history = getHeatHistory();
  const key = buildHeatKey(postId, openid, action);
  if (history[key]) return false;

  history[key] = Date.now();
  wx.setStorageSync(STORAGE_KEYS.HEAT_HISTORY, pruneHeatHistory(history, today));
  return true;
}

/* ---------------- 个人资料 ---------------- */

function getProfile() {
  return wx.getStorageSync(STORAGE_KEYS.PROFILE) || {};
}

/* ---------------- 登录状态 ---------------- */

function isLoggedIn() {
  return !!wx.getStorageSync(STORAGE_KEYS.IS_LOGIN);
}

function setLoggedIn(value) {
  wx.setStorageSync(STORAGE_KEYS.IS_LOGIN, !!value);
}

module.exports = {
  getLocalPosts,
  saveLocalPosts,
  savePost,
  removePost,
  getPosts,
  findPost,
  getApplications,
  saveApplications,
  addApplication,
  updateApplicationStatus,
  getHeatOverrides,
  resolveHeat,
  persistHeat,
  HEAT_ACTION,
  getTodayKey,
  claimHeatOnce,
  getProfile,
  isLoggedIn,
  setLoggedIn
};

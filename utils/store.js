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
  isLoggedIn,
  setLoggedIn
};

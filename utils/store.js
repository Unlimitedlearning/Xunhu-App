// utils/store.js
// 数据访问层：云数据库（posts / applications）+ 内存缓存
//
// 设计取舍（重要，页面按这个约定调用）：
//   1) 读：先 await syncPosts() / syncApplications() 把云数据刷进缓存，再用同步的
//      getPosts() / findPost() / getApplications() 渲染。这样页面只加一行 await，
//      渲染逻辑（排序、兜底、掩码）完全不用改。
//   2) 写：savePost / removePost / addApplication / updateApplicationStatus / persistHeat / submitReport / submitReview
//      都返回 Promise，调用处必须 await。
//   3) 热度：走云函数 heat 做原子自增（别人的帖子客户端没有写权限，必须走服务端）。
//   4) 发布：走云函数 publish（内容安全机审 + status 直接 active，服务端定 status/authorName）；
//      举报：走云函数 report（写 reports 集合 + 帖子改 auditing）；
//      登录态标记 / 草稿 / 热度防刷记录 留在本地 Storage；
//      用户资料（昵称/学号/简历/联系方式）走云端 users 集合（云函数 user 读写），
//      前端不再保留任何写死的身份或默认资料。
//   5) id 统一等于云文档 _id；作者身份用 authorOpenid 字段（真实帖子的值 = 当前 openid）。

const constants = require('./constants');
const mockData = require('./mockData');

const STORAGE_KEYS = constants.STORAGE_KEYS;
const COLLECTIONS = constants.COLLECTIONS;
const CLOUD_FUNCTIONS = constants.CLOUD_FUNCTIONS;

const PAGE_SIZE = 20;    // 小程序端单次 get 上限就是 20 条
const MAX_FETCH = 100;   // 单次同步最多拉 100 条，再多要走业务分页
const DRAFT_ID = 'local_draft';

// 首次运行且 posts 集合为空时，把 mockData 灌进云端，保证演示时大厅不是空的。
// 【内测状态】已置 false：内测看到的大厅必须全是真实数据，
//   否则「张同学 / 李同学 / 林同学」这些假帖子会被灌进云端（且 authorOpenid 是假的，
//   既结束不了也评价不了，非常难清理）。需要演示数据时再临时改回 true。
const SEED_DEMO_POSTS = false;

// 内存缓存：页面同步读取的数据源
const cache = {
  posts: [],
  applications: [],
  applicationsError: null, // 申请列表拉取失败时留个标记，任务页据此提示
  profile: null,           // 云端 users 文档（未完善或未拉到时为 null）
  profileLoaded: false,    // 本次会话是否已成功从云端拉过资料（失败/退出后置 false，重登录会重拉）
  myReviews: [],           // 我发出的评价（reviews 中 reviewerOpenid === 我）：任务页标记「已评价」用
  receivedReviews: null,   // 我收到的评价统计（total / goodCount / rate / list），个人页用
  openid: ''
};

let initPromise = null;

/* ---------------- 基础设施 ---------------- */

function db() {
  if (!wx.cloud) {
    throw new Error('当前基础库不支持云开发，请把调试基础库升到 2.2.3 以上');
  }
  return wx.cloud.database();
}

function col(name) {
  return db().collection(name);
}

// openid 只能由云函数下发，客户端拿不到
async function fetchOpenid() {
  if (cache.openid) return cache.openid;
  const res = await wx.cloud.callFunction({ name: CLOUD_FUNCTIONS.LOGIN });
  const openid = (res && res.result && res.result.openid) || '';
  if (!openid) throw new Error('login 云函数没有返回 openid，请确认已上传并部署');
  cache.openid = openid;
  return openid;
}

// 分页把集合读全（客户端单次 20 条上限）
// condition 不为空时会带上 where —— 自定义安全规则的集合必须靠它证明「这条记录我能读」
async function fetchPaged(name, condition) {
  const list = [];
  for (let skip = 0; skip < MAX_FETCH; skip += PAGE_SIZE) {
    let query = col(name);
    if (condition) query = query.where(condition);
    const res = await query
      .orderBy('createTime', 'desc')
      .skip(skip)
      .limit(PAGE_SIZE)
      .get();
    const rows = (res && res.data) || [];
    list.push.apply(list, rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return list;
}

// 简化权限（所有用户可读）的集合：无条件全量读
function fetchAll(name) {
  return fetchPaged(name, null);
}

// -502003 的两种典型原因，直接把排查方向打到控制台，省得靠猜
const PERMISSION_HINTS = {
  posts: '-502003：①集合不在 CLOUD_ENV 指向的环境里（最常见：控制台建集合的环境和 constants.js 的 env 不是同一个）②posts 权限没生效，应为「所有用户可读，仅创建者可读写」',
  applications: '-502003：applications 是自定义安全规则，客户端查询必须带 where 证明可读（本条已按 _openid / receiverId 拆成两次查询）；仍失败请确认规则已保存，且没有把 read 写成 false'
};

function reportFetchError(name, err) {
  const code = (err && (err.errCode || err.code)) || '';
  console.error('[store] 拉取 ' + name + ' 失败 code=' + code + '：', err);
  if (String(code).indexOf('502003') > -1 && PERMISSION_HINTS[name]) {
    console.error('[store] ' + PERMISSION_HINTS[name]);
    diagnose(name);
  }
}

// 失败时让云函数（服务端 SDK，不受安全规则限制）回报集合真实状态，用来区分「权限问题」和「环境/集合不存在」
async function diagnose(reason) {
  try {
    const res = await wx.cloud.callFunction({
      name: CLOUD_FUNCTIONS.INIT_DB,
      data: { diagnose: true }
    });
    console.warn('[store] 云端自检（触发自 ' + reason + '）：', res && res.result);
  } catch (err) {
    console.warn('[store] 云端自检调用失败（initDb 若未重新部署可忽略）：', err);
  }
}

/* ---------------- 字段规范化 ---------------- */

function normalizePost(doc) {
  return Object.assign({}, doc, {
    id: doc._id,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    heat: typeof doc.heat === 'number' ? doc.heat : 0,
    authorOpenid: doc.authorOpenid || doc._openid || ''
  });
}

function normalizeApplication(doc) {
  return Object.assign({}, doc, {
    id: doc._id,
    postId: doc.postId || '',
    applicantContact: doc.applicantContact || '',
    applicantStudentId: doc.applicantStudentId || '',
    createTime: doc.createTime || 0
  });
}

/* ---------------- 初始化 ---------------- */

// 只拉数据、不触发 ensureInit，避免与 doInit 互相递归
async function pullPosts() {
  try {
    const rows = await fetchAll(COLLECTIONS.POSTS);
    cache.posts = rows
      .map(normalizePost)
      .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    return cache.posts;
  } catch (err) {
    reportFetchError(COLLECTIONS.POSTS, err);
    throw err;
  }
}

/**
 * applications 用了自定义安全规则（doc._openid == auth.openid || doc.receiverId == auth.openid），
 * 这种集合**不能**直接 orderBy().get()：无条件查询无法证明「可读」，云端直接 -502003。
 * 正确做法是拆成两次带 where 的查询再合并（我发出的 / 我收到的）。
 */
async function pullApplications() {
  try {
    const openid = await fetchOpenid();
    const result = await Promise.all([
      fetchPaged(COLLECTIONS.APPLICATIONS, { _openid: openid }),
      fetchPaged(COLLECTIONS.APPLICATIONS, { receiverId: openid })
    ]);

    // 两条查询可能重叠（自己给自己发申请），按 _id 去重
    const seen = {};
    const rows = [];
    result[0].concat(result[1]).forEach(function (doc) {
      if (!doc || !doc._id || seen[doc._id]) return;
      seen[doc._id] = true;
      rows.push(doc);
    });

    cache.applications = rows
      .map(normalizeApplication)
      .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    cache.applicationsError = null;
    return cache.applications;
  } catch (err) {
    reportFetchError(COLLECTIONS.APPLICATIONS, err);
    cache.applicationsError = err;
    throw err;
  }
}

async function seedDemoData() {
  const posts = (mockData && mockData.postList) || [];
  if (!posts.length) return;

  for (let i = 0; i < posts.length; i++) {
    const item = posts[i];
    await col(COLLECTIONS.POSTS).add({
      data: {
        category: item.category,
        title: item.title,
        content: item.content,
        tags: item.tags || [],
        authorName: item.authorName || '',
        contact: item.contact || '',
        status: item.status || 'active',
        heat: item.heat || 0,
        createTime: item.createTime || Date.now(),
        // 演示数据标成「其他同学」，否则灌进去的帖子全都算成你发的
        authorOpenid: constants.AUTHOR_OPENID_MAP[item.authorName] || ''
      }
    });
  }

  await pullPosts();
}

async function doInit() {
  // 旧版本把资料存在本地 local_profile（含写死的演示简历/微信号），启动时清掉，避免脏数据回流
  try {
    constants.LEGACY_STORAGE_KEYS.forEach(function (key) {
      wx.removeStorageSync(key);
    });
  } catch (err) {
    console.warn('[store] 清理历史本地数据失败：', err);
  }

  await fetchOpenid();
  await pullPosts();

  // 用户资料是可选能力：user 云函数未部署时不影响大厅浏览，
  // 只在「我的」保存 / 发布 / 申请这类需要身份的场景才把错误抛给页面。
  try {
    await pullProfile();
  } catch (err) {
    console.warn('[store] 用户资料拉取失败，已降级（大厅浏览不受影响）');
  }

  // 申请列表失败不该拖垮大厅：登录 + 帖子列表成功就算初始化完成，
  // 任务页调用 syncApplications() 时会重新拉一次并把真实错误抛给它自己处理。
  try {
    await pullApplications();
  } catch (err) {
    console.warn('[store] 申请列表拉取失败，已降级（大厅不受影响）');
  }

  if (SEED_DEMO_POSTS && cache.posts.length === 0) {
    try {
      await seedDemoData();
    } catch (err) {
      // 灌数据失败不影响正常使用（多为权限/额度问题），不阻断初始化
      console.warn('[store] 演示数据写入失败：', err);
    }
  }

  return getState();
}

// 幂等初始化：所有异步接口都会先等它完成
function ensureInit() {
  if (!initPromise) {
    initPromise = doInit().catch(function (err) {
      initPromise = null; // 失败后允许下次重试（比如用户刚填好环境 ID）
      throw err;
    });
  }
  return initPromise;
}

function init() {
  return ensureInit();
}

function getState() {
  return {
    openid: cache.openid,
    postCount: cache.posts.length,
    applicationCount: cache.applications.length,
    hasProfile: !!(cache.profile && cache.profile.nickname)
  };
}

/* ---------------- 云函数封装 ---------------- */

// 统一调用 publish 云函数：把「函数未部署」「机审拦截」「校验失败」都变成可捕获的错误
// err.code 取值：CONTENT_RISKY / PROFILE_NOT_READY / CATEGORY_INVALID / ... / NO_OPENID
async function callPublishFunction(data) {
  let res;
  try {
    res = await wx.cloud.callFunction({ name: CLOUD_FUNCTIONS.PUBLISH, data: data });
  } catch (err) {
    // 函数不存在 / 网络失败
    const wrapped = new Error('publish 云函数调用失败，请确认已上传并部署');
    wrapped.code = 'FUNCTION_CALL_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    const err = new Error(result.message || constants.CONTENT_RISKY_MESSAGE);
    err.code = result.code || 'PUBLISH_FAILED';
    // 云端本地词库命中时会回传具体违规词，页面提示用（机审判违规时可能为空）
    err.hitWord = result.hitWord || '';
    throw err;
  }
  return result;
}

/* ---------------- 帖子 posts ---------------- */

// 单份本地草稿（上传失败时保留，离线可见，也仍会出现在大厅里带「草稿」标识）
function getDraft() {
  const draft = wx.getStorageSync(STORAGE_KEYS.DRAFT);
  if (!draft || typeof draft !== 'object' || !draft.id) return null;
  return draft;
}

function saveDraft(post) {
  const draft = Object.assign({}, post, {
    id: DRAFT_ID,
    status: 'draft',
    createTime: post.createTime || Date.now()
  });
  wx.setStorageSync(STORAGE_KEYS.DRAFT, draft);
  return draft;
}

function removeDraft() {
  wx.removeStorageSync(STORAGE_KEYS.DRAFT);
}

// 同步读：云端缓存 + 本地草稿
function getPosts() {
  const draft = getDraft();
  const posts = cache.posts.slice();
  return draft ? [draft].concat(posts) : posts;
}

function findPost(postId) {
  if (!postId) return null;
  return getPosts().find(function (item) {
    return item.id === postId;
  }) || null;
}

/**
 * 按 _id 直取单条帖子（异步，会顺手补进缓存）。
 * 为什么需要它：列表缓存是「分页 + orderBy(createTime)」拉进来的，可能漏掉个别帖子
 * （超过 MAX_FETCH、缺 createTime 字段、翻页边界）；而任务页的评价按钮要求
 * app.postId 必须能对应到帖子，一旦漏掉就出现「帖子明明存在，按钮却永远不出现」。
 * doc(id).get() 不受分页与排序影响，能直接定死「帖子到底存不存在」。
 * @return {object|null} 规范化后的帖子；不存在/无权限返回 null（不抛错，调用方可降级）
 */
async function fetchPostById(postId) {
  if (!postId) return null;
  const id = String(postId);
  try {
    const res = await col(COLLECTIONS.POSTS).doc(id).get();
    const doc = (res && res.data) || null;
    if (!doc) return null;
    const post = normalizePost(doc);
    const exists = cache.posts.some(function (item) {
      return item && item.id === post.id;
    });
    if (!exists) {
      cache.posts.push(post);
      cache.posts.sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    }
    return post;
  } catch (err) {
    console.warn('[store] 按 id 取帖子失败 id=' + id + ' code=' +
      ((err && (err.errCode || err.code)) || '') + '：', err);
    return null;
  }
}

/* ---------------- 一人一帖 ----------------
   业务规则：同一用户同时只允许存在一条 status === 'active' 的帖子。
   这里只查内存缓存（同步），页面点 + 号 / 发布时先用它做体验层拦截；
   云函数 publish 里还有一道查重（ALREADY_HAS_ACTIVE），那才是改包也绕不过的防线。*/

function findMyActivePost() {
  const openid = cache.openid;
  if (!openid) return null;
  return cache.posts.find(function (item) {
    return item.authorOpenid === openid && item.status === 'active';
  }) || null;
}

// 异步版：先把云端帖子刷一遍再判定（发布页用，保证不是拿陈旧缓存下的结论）
async function syncMyActivePost() {
  await ensureInit();
  await pullPosts();
  return findMyActivePost();
}

async function syncPosts() {
  await ensureInit();
  return pullPosts();
}

// 新增帖子：走云函数 publish。
// 注意：status / authorOpenid / authorName 全部由服务端决定（机审通过即 'active'），
// 前端传进来的 status 会被忽略 —— 否则改包就能把「审核中」直接刷成上线。
async function savePost(post) {
  await ensureInit();
  const payload = {
    category: post.category,
    title: (post.title || '').trim(),
    content: (post.content || '').trim(),
    tags: post.tags || [],
    contact: (post.contact || '').trim()
  };

  const result = await callPublishFunction(payload);

  // 云端已落库，重新拉一次，保证别人（以及自己下一次刷新）能看到
  await pullPosts();

  return {
    id: result.id || '',
    category: payload.category,
    title: payload.title,
    content: payload.content,
    tags: payload.tags,
    contact: result.contact || payload.contact,
    authorName: result.authorName || post.authorName || '',
    authorOpenid: cache.openid,
    status: result.status || 'active',
    heat: 0,
    createTime: post.createTime || Date.now()
  };
}

async function removePost(postId) {
  if (!postId) return;
  await ensureInit();
  await col(COLLECTIONS.POSTS).doc(postId).remove();
  await pullPosts();
}

/**
 * 结束自己的帖子：status -> 'ended' + 记录 endTime（结束时间）
 * 为什么客户端直接写数据库就行：posts 权限是「所有用户可读，仅创建者可读写」，
 * 云函数 publish 写入时已显式带上 _openid，所以只有发帖人本人能改自己这一条，改别人的会被安全规则拒绝。
 * @return {number} endTime 时间戳
 */
async function endPost(postId) {
  if (!postId) throw new Error('缺少帖子 ID');
  await ensureInit();

  const now = Date.now();
  try {
    await col(COLLECTIONS.POSTS).doc(postId).update({
      data: { status: 'ended', endTime: now }
    });
  } catch (err) {
    console.error('[store] 结束帖子失败 code=' + ((err && (err.errCode || err.code)) || '') + '：', err);
    // 常见原因：不是本人发的（安全规则拒绝）、帖子已被删除、网络/环境异常
    const wrapped = new Error('结束失败，请稍后重试');
    wrapped.code = 'END_POST_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  // 同步内存缓存：详情页返回大厅时（onShow 之前）也不会渲染成「寻呼中」
  const cached = cache.posts.find(function (item) { return item.id === postId; });
  if (cached) {
    cached.status = 'ended';
    cached.endTime = now;
  }

  try {
    await pullPosts();
  } catch (err) {
    console.warn('[store] 结束后重新拉取帖子失败，已用本地缓存兜底：', err);
  }

  return now;
}

/* ---------------- 申请 applications ---------------- */

// 同步读：内存缓存
function getApplications() {
  return cache.applications.slice();
}

async function syncApplications() {
  await ensureInit();
  return pullApplications();
}

// 供任务页判断「上次申请列表是不是拉失败了」
function getApplicationsError() {
  return cache.applicationsError;
}

async function addApplication(application) {
  await ensureInit();
  const data = {
    postId: application.postId,
    applicantId: application.applicantId || cache.openid,
    applicantName: application.applicantName || '',
    applicantContact: application.applicantContact || '',
    applicantStudentId: application.applicantStudentId || '',
    receiverId: application.receiverId || '',
    status: application.status || 'pending',
    createTime: application.createTime || Date.now()
  };

  const res = await col(COLLECTIONS.APPLICATIONS).add({ data });
  await pullApplications();
  return Object.assign({}, data, { id: res._id });
}

// 同意 / 拒绝：只有「收到申请的人」需要更新，所以要在安全规则里放行 receiverId
async function updateApplicationStatus(applicationId, status) {
  if (!applicationId) return;
  await ensureInit();
  await col(COLLECTIONS.APPLICATIONS).doc(applicationId).update({
    data: { status: status }
  });
  await pullApplications();
}

/* ---------------- 热度 heat ---------------- */

function resolveHeat(post) {
  return post && typeof post.heat === 'number' ? post.heat : 0;
}

/**
 * 写入热度：走云函数原子自增（别人的帖子客户端没有写权限）
 * 保留原来的 (postId, heat) 签名，内部换算成增量，调用处不用改
 */
async function persistHeat(postId, heat) {
  if (!postId) return 0;

  const current = resolveHeat(findPost(postId));
  const delta = heat - current;
  if (!delta) return current;

  await ensureInit();
  await wx.cloud.callFunction({
    name: CLOUD_FUNCTIONS.HEAT,
    data: { postId: postId, delta: delta }
  });

  const cached = cache.posts.find(function (item) { return item.id === postId; });
  if (cached) cached.heat = current + delta;

  return current + delta;
}

/* ---------------- 热度防刷（前端去重，正式版应由服务端做） ---------------- */

const HEAT_ACTION = {
  VIEW: 'view',
  APPLY: 'apply'
};

function getTodayKey() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return now.getFullYear() + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
}

function getHeatHistory() {
  return wx.getStorageSync(STORAGE_KEYS.HEAT_HISTORY) || {};
}

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
 * 注意：这是前端去重，可被清缓存绕过；真正的防刷要在云函数里落 heat_logs 唯一记录
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

/* ---------------- 个人资料（云端 users 集合，云函数 user 读写） ----------------
   职责划分：
     前端：只负责收集用户输入、展示，以及把「当前会话」记在 isLogin
     云端：login 证明 openid 是谁；user 负责资料持久化（服务端写 openid，客户端不可伪造）
   前端任何地方都不得再用常量/默认值充当身份。*/

// 统一调用 user 云函数，把「函数未部署」「action 返回失败」都变成可捕获的错误
async function callUserFunction(data) {
  const res = await wx.cloud.callFunction({
    name: CLOUD_FUNCTIONS.USER,
    data: data
  });
  const result = (res && res.result) || {};
  if (result.ok === false) {
    const err = new Error(result.message || 'user 云函数返回失败');
    err.code = result.code || '';
    throw err;
  }
  return result;
}

// 只有昵称非空的文档才算「有资料」（资料不完整时仍返回对象，表单能带出已填的部分）；
// 是否「完善」（昵称 + 联系方式都非空）由 isProfileReady() 判定。
function normalizeProfile(doc) {
  if (!doc || !doc.nickname) return null;
  return {
    nickname: doc.nickname || '',
    studentId: doc.studentId || '',
    resume: doc.resume || '',
    contact: doc.contact || '',
    updateTime: doc.updateTime || 0
  };
}

async function pullProfile() {
  const openid = await fetchOpenid();
  if (!openid) return null;
  try {
    const result = await callUserFunction({ action: 'get' });
    cache.profile = normalizeProfile(result.data);
    cache.profileLoaded = true;
    return cache.profile;
  } catch (err) {
    console.error('[store] 读取用户资料失败（cloudfunctions/user 是否已上传并部署？）：', err);
    throw err;
  }
}

async function syncProfile() {
  await ensureInit();
  return pullProfile();
}

// 同步读：云端缓存；未完善时返回空对象（页面据此展示空表单，而不是假数据）
function getProfile() {
  return cache.profile || {};
}

// 展示名：发布人 / 申请人一律取这里；为空说明用户还没完善资料
function getNickname() {
  return (cache.profile && cache.profile.nickname) || '';
}

// 资料是否「完善」：昵称 + 联系方式都非空，且学号能过广工 10 位正则
// 这是「能不能使用大厅功能」的唯一判定点（guard / profile / 发布 / 申请共用）
function isProfileReady() {
  const profile = cache.profile;
  if (!profile) return false;
  const nickname = (profile.nickname || '').trim();
  const contact = (profile.contact || '').trim();
  const studentId = (profile.studentId || '').trim();
  return nickname !== '' && contact !== '' && constants.STUDENT_ID_REGEX.test(studentId);
}

// 保存资料：写云端，同时更新内存缓存；不写任何本地 Storage
async function saveProfile(profile) {
  await ensureInit();
  const input = {
    nickname: (profile.nickname || '').trim(),
    studentId: (profile.studentId || '').trim(),
    resume: (profile.resume || '').trim(),
    contact: (profile.contact || '').trim()
  };
  if (!input.nickname) {
    throw new Error('昵称不能为空');
  }

  // 前端先拦一道（云函数里还有同样的一道，防绕过）
  if (!constants.STUDENT_ID_REGEX.test(input.studentId)) {
    const err = new Error('请输入正确的广工 10 位学号');
    err.code = 'STUDENT_ID_INVALID';
    throw err;
  }

  const result = await callUserFunction({ action: 'save', profile: input });
  cache.profile = normalizeProfile(result.data) || Object.assign({}, input, { updateTime: Date.now() });
  return cache.profile;
}

/* ---------------- 举报（云端 reports 集合，云函数 report 写入） ----------------
   流程：写一条举报记录 -> 帖子 status 改 'auditing'（大厅打码 + 不可点入 + 详情页拦截）
   同一个 openid 对同一帖子只记一条（云端去重，重复举报不会报错，只会返回 duplicate: true） */

async function submitReport(report) {
  const postId = (report && report.postId) || '';
  if (!postId) throw new Error('缺少帖子 ID');

  await ensureInit();

  let res;
  try {
    res = await wx.cloud.callFunction({
      name: CLOUD_FUNCTIONS.REPORT,
      data: {
        postId: postId,
        reason: (report.reason || '').trim(),
        desc: (report.desc || '').trim()
      }
    });
  } catch (err) {
    const wrapped = new Error('report 云函数调用失败，请确认已上传并部署');
    wrapped.code = 'FUNCTION_CALL_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    const err = new Error(result.message || '举报提交失败，请稍后重试');
    err.code = result.code || 'REPORT_FAILED';
    throw err;
  }

  // 云端已把帖子改成 auditing，本地缓存同步一份，
  // 否则回到大厅 onShow 之前（或举报失败回退时）还会渲染旧状态
  const cached = cache.posts.find(function (item) { return item.id === postId; });
  if (cached) cached.status = result.status || 'auditing';

  return result; // { ok, status, duplicate }
}

/* ---------------- 评价 reviews（云端集合，云函数 review 读写） ----------------
   防刷规则完全在云端：A 对 B 只能有一条记录（不存在 add / 已存在 update 覆盖）。
   客户端这边只负责：标记「我是否已经评价过 TA」、弹窗回填、把匿名评价交给个人页。
   reviews 建议权限「所有用户不可读写」—— 客户端拿不到任何 review 文档，匿名性才可靠。*/

function normalizeReview(doc) {
  if (!doc) return null;
  return {
    reviewId: doc.reviewId || doc._id || '',
    postId: doc.postId || '',
    reviewerOpenid: doc.reviewerOpenid || '', // 收到的评价里云端不会下发这个字段
    revieweeOpenid: doc.revieweeOpenid || '',
    rating: doc.rating === 1 ? 1 : 0,
    content: doc.content || '',
    createTime: doc.createTime || 0
  };
}

// 统一调用 review 云函数，把「函数未部署」「云端校验失败」都变成可捕获的错误
async function callReviewFunction(data) {
  let res;
  try {
    res = await wx.cloud.callFunction({ name: CLOUD_FUNCTIONS.REVIEW, data: data });
  } catch (err) {
    const wrapped = new Error('review 云函数调用失败，请确认已上传并部署');
    wrapped.code = 'FUNCTION_CALL_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    const err = new Error(result.message || '评价操作失败，请稍后重试');
    err.code = result.code || 'REVIEW_FAILED';
    throw err;
  }
  return result;
}

// 同步读：我已发出的评价（内存缓存）
function getMyReviews() {
  return cache.myReviews.slice();
}

// 同步读：我对某人的旧评价（有就说明按钮应该是「更新评价」）
function findMyReviewTo(revieweeOpenid) {
  if (!revieweeOpenid) return null;
  return cache.myReviews.find(function (item) {
    return item.revieweeOpenid === revieweeOpenid;
  }) || null;
}

function mergeMyReview(review) {
  if (!review) return;
  const index = cache.myReviews.findIndex(function (item) {
    return item.revieweeOpenid === review.revieweeOpenid;
  });
  if (index > -1) {
    cache.myReviews[index] = review;
  } else {
    cache.myReviews.push(review);
  }
}

async function pullMyReviews() {
  const result = await callReviewFunction({ action: 'mine' });
  cache.myReviews = (result.list || []).map(normalizeReview).filter(Boolean);
  return cache.myReviews;
}

async function syncMyReviews() {
  await ensureInit();
  return pullMyReviews();
}

/**
 * 单条查询：我对 TA 的旧评价（弹窗回填用）
 * 先看页面拿到的缓存，缓存没有才向云端确认 —— 避免依赖陈旧缓存而重复新增
 */
async function fetchMyReviewTo(revieweeOpenid) {
  if (!revieweeOpenid) return null;
  await ensureInit();
  const result = await callReviewFunction({ action: 'get', revieweeOpenid: revieweeOpenid });
  const review = result.review ? normalizeReview(result.review) : null;

  const index = cache.myReviews.findIndex(function (item) {
    return item.revieweeOpenid === revieweeOpenid;
  });
  if (review) {
    mergeMyReview(review);
  } else if (index > -1) {
    cache.myReviews.splice(index, 1); // 云端已经没有这条了，缓存也跟着清
  }
  return review;
}

/**
 * 提交 / 更新评价（云端 upsert）
 * @param {{postId:string, revieweeOpenid:string, rating:number, content:string}} input
 */
async function submitReview(input) {
  const revieweeOpenid = (input && input.revieweeOpenid) || '';
  if (!revieweeOpenid) throw new Error('缺少被评价人');

  const rating = Number(input.rating);
  if (rating !== 1 && rating !== 0) {
    const err = new Error('请选择满意或不满意');
    err.code = 'RATING_INVALID';
    throw err;
  }

  await ensureInit();
  const result = await callReviewFunction({
    action: 'submit',
    postId: (input.postId || '').trim(),
    revieweeOpenid: revieweeOpenid,
    rating: rating,
    content: (input.content || '').trim().slice(0, constants.REVIEW_CONTENT_MAX)
  });

  const review = normalizeReview(result.review);
  if (review) mergeMyReview(review);

  return { review: review, created: !!result.created };
}

async function pullReceivedReviews() {
  const result = await callReviewFunction({ action: 'received' });
  cache.receivedReviews = {
    total: result.total || 0,
    goodCount: result.goodCount || 0,
    rate: result.rate || 0,
    list: (result.list || []).map(normalizeReview).filter(Boolean)
  };
  return cache.receivedReviews;
}

async function syncReceivedReviews() {
  await ensureInit();
  return pullReceivedReviews();
}

// 同步读：个人页满意度统计（没拉过时返回空统计，页面显示「满意度统计中...」）
function getReceivedReviews() {
  return cache.receivedReviews || { total: 0, goodCount: 0, rate: 0, list: [] };
}

/* ---------------- 登录态 ---------------- */

function isLoggedIn() {
  return !!wx.getStorageSync(STORAGE_KEYS.IS_LOGIN);
}

function setLoggedIn(value) {
  wx.setStorageSync(STORAGE_KEYS.IS_LOGIN, !!value);
}

// 登录 = 拿到 openid + 拉一次云端资料。
// 这里只确认「你是谁」，不往界面里填任何姓名/学号/联系方式。
async function login() {
  await ensureInit();
  if (!cache.profileLoaded) {
    try {
      await pullProfile();
    } catch (err) {
      console.warn('[store] 登录后拉取资料失败，按「资料未完善」处理：', err);
      cache.profile = null;
    }
  }
  setLoggedIn(true);
  return cache.openid;
}

function logout() {
  setLoggedIn(false);
  cache.profile = null;        // 身份数据不留在内存
  cache.profileLoaded = false; // 下次登录重新从云端拉
  cache.myReviews = [];        // 评价也属于个人数据，退出即清
  cache.receivedReviews = null;
}

// openid 由 app.js 启动时预热，页面里同步取用
function getOpenId() {
  return cache.openid;
}

module.exports = {
  init,
  getState,
  getOpenId,

  // posts
  getPosts,
  findPost,
  fetchPostById,
  syncPosts,
  savePost,
  removePost,
  endPost,
  findMyActivePost,
  syncMyActivePost,
  getDraft,
  saveDraft,
  removeDraft,

  // applications
  getApplications,
  syncApplications,
  addApplication,
  updateApplicationStatus,
  getApplicationsError,

  // heat
  resolveHeat,
  persistHeat,
  HEAT_ACTION,
  getTodayKey,
  claimHeatOnce,

  // profile / report
  getProfile,
  saveProfile,
  syncProfile,
  getNickname,
  isProfileReady,
  submitReport,

  // reviews（双向评价，全部走云函数）
  getMyReviews,
  syncMyReviews,
  findMyReviewTo,
  fetchMyReviewTo,
  submitReview,
  syncReceivedReviews,
  getReceivedReviews,

  // auth
  isLoggedIn,
  setLoggedIn,
  login,
  logout
};

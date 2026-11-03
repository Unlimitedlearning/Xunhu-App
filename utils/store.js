// utils/store.js
// 数据访问层：云数据库（posts / applications）+ 内存缓存
//
// 设计取舍（重要，页面按这个约定调用）：
//   1) 读：先 await syncPosts() / syncApplications() 把云数据刷进缓存，再用同步的
//      getPosts() / findPost() / getApplications() 渲染。这样页面只加一行 await，
//      渲染逻辑（排序、兜底、掩码）完全不用改。
//   2) 写：savePost / endPost / addApplication / updateApplicationStatus / persistHeat / submitReport / submitReview
//      都返回 Promise，调用处必须 await。
//   3) 热度：走云函数 heat 做原子自增（别人的帖子客户端没有写权限，必须走服务端）。
//   4) 帖子状态（结束 / 删除）走云函数 post，posts 对客户端只读（v1.3.0）
//   4) 发布：走云函数 publish（内容安全机审 + status 直接 active，服务端定 status/authorName）；
//      举报：走云函数 report（写 reports 集合 + 帖子改 auditing）；
//      申请：走云函数 application（apply / updateStatus / list，服务端校验 receiverId 防越权，
//            并联查 users 下发申请人昵称 / 简历 / 附言）；
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
  messageCenter: null,     // 消息中心（公告 + 个人通知），null = 本次会话还没拉过
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
// maxFetch：本次最多拉多少条（默认 MAX_FETCH）。posts 已降到 POSTS_FETCH_LIMIT=20，见 pullPosts。
async function fetchPaged(name, condition, maxFetch) {
  const stop = Math.min(maxFetch || MAX_FETCH, MAX_FETCH);
  const list = [];
  for (let skip = 0; skip < stop; skip += PAGE_SIZE) {
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

// -502003 的典型原因，直接把排查方向打到控制台，省得靠猜
// （applications 已改为「客户端不可读」，不再有直读分支，因此这里只剩 posts）
const PERMISSION_HINTS = {
  posts: '-502003：①集合不在 CLOUD_ENV 指向的环境里（最常见：控制台建集合的环境和 constants.js 的 env 不是同一个）②posts 权限没生效，应为「所有用户可读」'
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

// 【P0-1 修复】id 必须双兜底：doc._id || doc.id
// 原因：写本地快照时存的是「已归一化」的帖子（只有 id，没有 _id），下一次冷启动
// hydrateFromCache() 拿快照再 map(normalizePost) 时 doc._id 是 undefined，
// 单写 id: doc._id 会把这个 undefined 覆盖掉原本的 id —— 于是大厅卡片 data-id 为空，
// 点进去变成 detail?id=undefined（「信息不存在」）。authorOpenid 同款双兜底。
function normalizePost(doc) {
  const raw = doc || {};
  return Object.assign({}, raw, {
    id: raw._id || raw.id || '',
    // status 统一成字符串：缺失 -> ''（页面按「老文档缺字段」兜底），
    // 但绝不把未知值改写成 active —— 状态判定只由页面 formatPost / 云函数负责
    status: String(raw.status || ''),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    heat: typeof raw.heat === 'number' ? raw.heat : 0,
    authorOpenid: raw.authorOpenid || raw._openid || ''
  });
}

// 申请文档归一化：云函数 application.list 下发的字段名（applicantContact / applicantStudentId /
// applyNote / postTitle / postStatus …）+ 老版本直读数据库的字段名，两套都要兼容，
// 页面永远拿到同一套字段，不需要再判 undefined。
function normalizeApplication(doc) {
  const raw = doc || {};
  return Object.assign({}, raw, {
    id: raw.id || raw._id || '',
    postId: raw.postId || '',
    postTitle: raw.postTitle || '',
    postStatus: raw.postStatus || '',
    applicantId: raw.applicantId || raw._openid || '',
    applicantName: raw.applicantName || '',
    applicantResume: raw.applicantResume || '',
    applicantContact: raw.applicantContact || '',
    applicantStudentId: raw.applicantStudentId || '',
    applyNote: raw.applyNote || '',
    authorName: raw.authorName || '',
    authorOpenid: raw.authorOpenid || '',
    contact: raw.contact || '',
    status: raw.status || 'pending',
    createTime: raw.createTime || 0,
    statusUpdateTime: raw.statusUpdateTime || 0
  });
}

/* ---------------- 本地快照（缓存先行 / 秒开） ----------------
 * 为什么要有：冷启动时页面 onShow 先同步读 Storage 渲染，再去云端拉最新数据 —— 不用盯白屏。
 * 约定：
 *   写：只在 pullPosts / pullApplications 成功后落盘（云端是唯一真相，本地只是快照）
 *   读：hydrateFromCache() 把快照灌回内存缓存（仅当内存为空），页面继续用 getPosts() / getApplications()
 *   下拉刷新：一律直接走 syncPosts() / syncApplications()，不读快照（用户主动要最新数据）
 *   隐私：帖子是公开数据；申请本来只拉到自己相关的记录，且退出登录时会清掉
 */

function readSnapshot(key) {
  try {
    const data = wx.getStorageSync(key);
    if (!data || !Array.isArray(data.list)) return null;
    return data;
  } catch (err) {
    console.warn('[store] 读取本地快照失败 key=' + key + '：', err);
    return null;
  }
}

function writeSnapshot(key, list) {
  try {
    wx.setStorageSync(key, { updateTime: Date.now(), list: list });
  } catch (err) {
    // 超出 Storage 上限 / 序列化失败：快照只是体验优化，写不进去不影响主流程
    console.warn('[store] 写本地快照失败 key=' + key + '：', err);
  }
}

function clearSnapshot(key) {
  try {
    wx.removeStorageSync(key);
  } catch (err) {
    console.warn('[store] 清理本地快照失败 key=' + key + '：', err);
  }
}

/**
 * 缓存先行：把本地快照灌回内存缓存（只在内存为空时灌，不覆盖已经拉到的云数据）
 * 页面用法：store.hydrateFromCache() -> 同步读 store.getPosts() / getApplications() -> setData
 * @return {{posts: number, applications: number}} 本次实际灌入的条数（0 表示没快照）
 */
function hydrateFromCache() {
  let posts = 0;
  let applications = 0;

  if (!cache.posts.length) {
    const snapshot = readSnapshot(STORAGE_KEYS.CACHE_POSTS);
    if (snapshot) {
      cache.posts = snapshot.list
        .map(normalizePost)
        .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
      posts = cache.posts.length;
    }
  }

  if (!cache.applications.length) {
    const snapshot = readSnapshot(STORAGE_KEYS.CACHE_APPLICATIONS);
    if (snapshot) {
      cache.applications = snapshot.list
        .map(normalizeApplication)
        .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
      applications = cache.applications.length;
    }
  }

  return { posts: posts, applications: applications };
}

/* ---------------- 初始化 ---------------- */

// 只拉数据、不触发 ensureInit，避免与 doInit 互相递归
// maxFetch 默认 POSTS_FETCH_LIMIT=20（内测降本：1 次 get 就够），
// 需要更多时（比如后台排查）传 { max: 100 }，仍然受 MAX_FETCH 封顶。
async function pullPosts(maxFetch) {
  try {
    const rows = await fetchPaged(COLLECTIONS.POSTS, null, maxFetch || constants.POSTS_FETCH_LIMIT);
    cache.posts = rows
      .map(normalizePost)
      .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    writeSnapshot(STORAGE_KEYS.CACHE_POSTS, cache.posts); // 缓存先行：落盘快照，下次冷启动秒开
    return cache.posts;
  } catch (err) {
    reportFetchError(COLLECTIONS.POSTS, err);
    throw err;
  }
}

/* 删除说明（v1.3.0）：旧的「两次 where 直读 applications」降级通道已彻底删除。
   原因：那条通道让客户端直接读 applications 文档，pending 状态下就能拿到申请人
   联系方式与完整学号 —— 云函数里做的脱敏被绕过。现在 applications 权限设为
   「所有用户不可读写」，读取与写入全部收拢到 cloudfunctions/application。*/

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
   业务规则：同一用户同时只允许存在一条「占用发帖名额」的帖子 ——
   active（进行中）与 auditing（审查中）都占名额，ended 不占（口径「四、帖子状态机」）。
   这里只查内存缓存（同步），页面点 + 号 / 发布时先用它做体验层拦截；
   云函数 publish 里还有一道查重（ALREADY_HAS_ACTIVE），那才是改包也绕不过的防线。*/

const QUOTA_STATUS_LIST = ['active', 'auditing'];

function isQuotaStatus(status) {
  return QUOTA_STATUS_LIST.indexOf(String(status || '')) > -1;
}

function findMyActivePost() {
  const openid = cache.openid;
  if (!openid) return null;
  return cache.posts.find(function (item) {
    return item.authorOpenid === openid && isQuotaStatus(item.status);
  }) || null;
}

// 异步版：先把云端帖子刷一遍再判定（发布页用，保证不是拿陈旧缓存下的结论）
async function syncMyActivePost() {
  await ensureInit();
  await pullPosts();
  return findMyActivePost();
}

async function syncPosts(options) {
  await ensureInit();
  return pullPosts(options && options.max);
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

/* ---------------- 帖子状态写入（全部走云函数 post） ----------------
   v1.3.0（P0-4）：以前 endPost 是客户端 doc(id).update({ status: 'ended' })，
   靠的只是「posts 仅创建者可读写」—— 安全规则只判断「是不是你这条」，不限制「能改哪些字段」，
   于是作者可以自己把 auditing 改回 active（撤销举报审查）、改 heat、改 title/content。
   现在改为：posts 对客户端只读（write=false），状态变更只能走 cloudfunctions/post，
   服务端校验 authorOpenid === 当前 openid，并且只写 status / endTime 这两个字段。*/

// 统一调用 post 云函数（结束 / 删除 / 取联系方式）
async function callPostFunction(data) {
  let res;
  try {
    res = await wx.cloud.callFunction({ name: CLOUD_FUNCTIONS.POST, data: data });
  } catch (err) {
    const wrapped = new Error('post 云函数调用失败，请确认已上传并部署');
    wrapped.code = 'FUNCTION_CALL_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    const err = new Error(result.message || '操作失败，请稍后重试');
    err.code = result.code || 'POST_ACTION_FAILED';
    throw err;
  }
  return result;
}

/**
 * 结束自己的帖子：status -> 'ended' + endTime（云端校验作者身份，客户端不再直写）
 * @return {number} endTime 时间戳
 */
async function endPost(postId) {
  if (!postId) throw new Error('缺少帖子 ID');
  await ensureInit();

  let result;
  try {
    result = await callPostFunction({ action: 'end', postId: postId });
  } catch (err) {
    console.error('[store] 结束帖子失败 code=' + ((err && err.code) || '') + '：', err);
    throw err;
  }

  const endTime = Number(result.endTime) || Date.now();

  // 同步内存缓存：详情页返回大厅时（onShow 之前）也不会渲染成「进行中」
  const cached = cache.posts.find(function (item) { return item.id === postId; });
  if (cached) {
    cached.status = 'ended';
    cached.endTime = endTime;
  }

  try {
    await pullPosts();
  } catch (err) {
    console.warn('[store] 结束后重新拉取帖子失败，已用本地缓存兜底：', err);
  }

  return endTime;
}

/**
 * 取帖子联系方式（详情页作者本人需要看自己填的联系方式）：
 * contact 已从 posts 迁到 post_contacts（客户端零权限），只能由云函数按关系下发。
 * 非作者、也没有 accepted 申请的一律返回空串（云端兜底）。
 * @return {Promise<string>} 联系方式（拿不到就空串，不抛错）
 */
async function fetchPostContact(postId) {
  if (!postId) return '';
  try {
    const result = await callPostFunction({ action: 'contact', postId: postId });
    return String(result.contact || '');
  } catch (err) {
    console.warn('[store] 获取联系方式失败（按空处理）：', err);
    return '';
  }
}

/* ---------------- 申请 applications（读与写全部走云函数 application） ----------------
   设计变更（v1.3.0，修复真机两个致命 Bug）：
     1) 「同意 / 拒绝」以前是客户端 doc(id).update() 直写。收帖人改的是**别人创建**的文档，
        权限完全靠控制台那条自定义安全规则；规则一有偏差就是 -502003，页面只能提示「操作失败」。
        现在写入全部收到 cloudfunctions/application，越权判定写进代码（receiverId === openid）。
     2) 申请人昵称 / 简历 / 附言必须和 users 联查，而 users 对客户端不可读 —— 前端拿不到这条通道，
        所以改由服务端联查后整张卡片下发。*/

// 统一调用 application 云函数，把「函数未部署」「业务校验失败」都变成可捕获的错误
async function callApplicationFunction(data) {
  let res;
  try {
    res = await wx.cloud.callFunction({ name: CLOUD_FUNCTIONS.APPLICATION, data: data });
  } catch (err) {
    const wrapped = new Error('application 云函数调用失败，请确认已上传并部署');
    wrapped.code = 'FUNCTION_CALL_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    const err = new Error(result.message || '申请操作失败，请稍后重试');
    err.code = result.code || 'APPLICATION_FAILED';
    err.hitWord = result.hitWord || '';
    throw err;
  }
  return result;
}

// 两个 Tab 的数据合并成一份缓存（详情页判断「我有没有申请过」要看全集）
function mergeApplications(sent, received) {
  const seen = {};
  const merged = [];
  (sent || []).concat(received || []).forEach(function (app) {
    if (!app || !app.id || seen[app.id]) return;
    seen[app.id] = true;
    merged.push(app);
  });
  return merged.sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
}

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

/**
 * 拉申请列表：唯一通道是云函数 application（联查 posts + users 后脱敏下发）。
 * 【v1.3.0】已删除 pullApplicationsDirect() 直读降级通道：
 *   applications 现在设为「所有用户不可读写」，客户端连 where 查询都不允许；
 *   而且降级模式看不到附言 / 姓名 / 简历，体验价值远低于「pending 就能直接拿到申请人
 *   联系方式与完整学号」的隐私风险。云函数未部署时宁可报错让用户下拉重试。
 */
async function pullApplications() {
  try {
    const result = await callApplicationFunction({ action: 'list' });
    cache.applications = mergeApplications(
      (result.sent || []).map(normalizeApplication),
      (result.received || []).map(normalizeApplication)
    );
    cache.applicationsError = null;
    writeSnapshot(STORAGE_KEYS.CACHE_APPLICATIONS, cache.applications); // 缓存先行：落盘快照
    return cache.applications;
  } catch (err) {
    console.error('[store] application 云函数拉取失败（是否已上传并部署 cloudfunctions/application？）：', err);
    cache.applicationsError = err;
    throw err;
  }
}

/**
 * 提交申请（附言必填）
 * 申请人昵称 / 学号 / 联系方式 / 简历全部由服务端取 users 真实资料，前端只传 postId + applyNote。
 * @param {{postId:string, applyNote:string}} application
 */
async function addApplication(application) {
  const postId = (application && application.postId) || '';
  const applyNote = ((application && application.applyNote) || '').trim();

  if (!postId) throw new Error('缺少帖子信息，请返回详情页重试');
  if (!applyNote) {
    const err = new Error('请填写申请附言后再提交');
    err.code = 'APPLY_NOTE_REQUIRED';
    throw err;
  }

  await ensureInit();
  const result = await callApplicationFunction({
    action: 'apply',
    postId: postId,
    applyNote: applyNote.slice(0, constants.APPLY_NOTE_MAX)
  });

  // 云端已落库：重新拉一次，任务页两边都能立刻看到这条申请
  try {
    await pullApplications();
  } catch (err) {
    console.warn('[store] 申请已提交，但列表刷新失败（下次进任务页会重拉）：', err);
  }

  return {
    id: result.id || '',
    postId: postId,
    applicantId: cache.openid,
    applyNote: applyNote,
    status: result.status || 'pending'
  };
}

/**
 * 同意 / 拒绝（只有「收到申请的人」能调，越权拦在云函数的 receiverId 校验里）
 * 返回云端最新结论；同时把缓存里的状态先改掉，页面 renderList 能立刻渲染出
 * 「已同意 + 联系方式已解锁」，不用等下一次拉取。
 * @param {string} applicationId 申请文档 _id
 * @param {'accepted'|'rejected'} status
 */
async function updateApplicationStatus(applicationId, status) {
  if (!applicationId) {
    const err = new Error('缺少申请信息，请下拉刷新后重试');
    err.code = 'APPLICATION_ID_REQUIRED';
    throw err;
  }
  if (status !== 'accepted' && status !== 'rejected') {
    const err = new Error('只能同意或拒绝该申请');
    err.code = 'STATUS_INVALID';
    throw err;
  }

  await ensureInit();
  const result = await callApplicationFunction({
    action: 'updateStatus',
    applicationId: applicationId,
    status: status
  });

  // 1) 先同步缓存：页面 await 完就能立即渲染，联系人立刻可见
  const cached = cache.applications.find(function (item) {
    return item && item.id === applicationId;
  });
  if (cached) {
    cached.status = result.status || status;
    cached.statusUpdateTime = result.statusUpdateTime || Date.now();
    if (result.applicantName) cached.applicantName = result.applicantName;
    if (result.applicantResume) cached.applicantResume = result.applicantResume;
    if (result.applicantContact) cached.applicantContact = result.applicantContact;
    if (result.applicantStudentId) cached.applicantStudentId = result.applicantStudentId;
    writeSnapshot(STORAGE_KEYS.CACHE_APPLICATIONS, cache.applications);
  }

  // 2) 再静默拉一次全量（拿到帖子/简历的最新联查结果），失败不影响本次操作结果
  try {
    await pullApplications();
  } catch (err) {
    console.warn('[store] 状态已更新，但列表刷新失败（已用本地缓存兜底）：', err);
  }

  return result;
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
    // 云端本地词库命中时会回传具体违规词，页面提示用（与 publish 的 hitWord 同一约定）
    err.hitWord = result.hitWord || '';
    throw err;
  }
  return result;
}

// 云端文档 -> 内存对象；没有文档才是 null（文档存在但昵称没填时仍返回对象，表单能带出已填的部分）。
// 是否「完善」（昵称 + 联系方式 + 学号）由 isProfileReady() 判定；
// role / warningCount 只用于展示（管理后台入口、警告次数），写入永远只能走云函数或控制台。
function normalizeProfile(doc) {
  if (!doc) return null;
  return {
    nickname: doc.nickname || '',
    // 真实姓名（v1.4.0）：只用于组队沟通背书，仅云端私有存储，不在任何页面 / 帖子 / 申请里展示
    realName: doc.realName || '',
    studentId: doc.studentId || '',
    resume: doc.resume || '',
    contact: doc.contact || '',
    // 角色 / 警告次数只读展示（写只能来自云函数或控制台）
    role: String(doc.role || 'user').toLowerCase(),
    warningCount: Number(doc.warningCount) || 0,
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

// 资料是否「完善」：昵称 + 真实姓名 + 联系方式都非空，且学号能过广工 10 位正则、真实姓名能过 2-4 汉字正则
// 这是「能不能使用大厅功能」的唯一判定点（guard / profile / 发布 / 申请共用）
// 【v1.4.0】真实姓名加入完备性校验：老用户没填的会直接被拦，强制他到「我的」补全。
function isProfileReady() {
  const profile = cache.profile;
  if (!profile) return false;
  const nickname = (profile.nickname || '').trim();
  const realName = (profile.realName || '').trim();
  const contact = (profile.contact || '').trim();
  const studentId = (profile.studentId || '').trim();
  return nickname !== '' && contact !== '' &&
    constants.REAL_NAME_REGEX.test(realName) &&
    constants.STUDENT_ID_REGEX.test(studentId);
}

// 同步读：真实姓名是否已「合法绑定」（前端决定输入框是否禁用；真正的锁在 user 云函数）
function isRealNameBound() {
  const profile = cache.profile;
  if (!profile) return false;
  return constants.REAL_NAME_REGEX.test((profile.realName || '').trim());
}

// 保存资料：写云端，同时更新内存缓存；不写任何本地 Storage
async function saveProfile(profile) {
  await ensureInit();
  const input = {
    nickname: (profile.nickname || '').trim(),
    realName: (profile.realName || '').trim(),
    studentId: (profile.studentId || '').trim(),
    resume: (profile.resume || '').trim(),
    contact: (profile.contact || '').trim()
  };
  if (!input.nickname) {
    throw new Error('昵称不能为空');
  }

  // 真实姓名：必填 + 2-4 个汉字（云端还有同样一道，防绕过）
  if (!constants.REAL_NAME_REGEX.test(input.realName)) {
    const err = new Error(constants.REAL_NAME_INVALID_MESSAGE);
    err.code = 'REAL_NAME_INVALID';
    throw err;
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
   防刷规则完全在云端：同一个帖子 + 同一个被评价人，一个评价人只能提交一次
   （一个帖子招多个队友时，B 和 C 要能分别评）；写入前先查
   postId + reviewerOpenid + revieweeOpenid，已存在直接回 ALREADY_REVIEWED，
   **只有 add、没有 update** —— 提交后不可修改。
   客户端这边只负责：标记「这条帖子里的这个人我是否已经评价过」、把匿名评价交给个人页。
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
    // 合作上下文快照（如「【组队-挑战杯】」）；老数据没有这个字段 -> ''，页面判空后不渲染
    contextSnapshot: String(doc.contextSnapshot || ''),
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

// 同步读：我发出的评价（内存缓存）
function getMyReviews() {
  return cache.myReviews.slice();
}

// 同步读：我对「这条帖子里的这个人」是不是已经评价过了
// 查重主键是 postId + revieweeOpenid —— 一个帖子招多个队友时，B 和 C 要能分别评，
// 与云端 handleSubmit 的 where 条件保持一致
// 只传 postId 时退化成「这条帖子我评过任何人没」，仅供调试/排障用
function findMyReviewByPost(postId, revieweeOpenid) {
  if (!postId) return null;
  const reviewee = revieweeOpenid || '';
  return cache.myReviews.find(function (item) {
    if (item.postId !== postId) return false;
    return reviewee ? item.revieweeOpenid === reviewee : true;
  }) || null;
}

// 同步读：「这条帖子里我对这个人」能不能再评（按钮置灰判定）
// 必须带上 revieweeOpenid：否则评了 B 之后 C 的按钮也会被误锁
function hasReviewedPost(postId, revieweeOpenid) {
  return !!findMyReviewByPost(postId, revieweeOpenid);
}

function mergeMyReview(review) {
  if (!review) return;
  const index = cache.myReviews.findIndex(function (item) {
    return item.postId === review.postId && item.revieweeOpenid === review.revieweeOpenid;
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
 * 单条查询：我对「这条帖子里的这个人」是否已经评价过（云端确认）
 * 先看内存缓存，缓存没有才向云端确认 —— 避免依赖陈旧缓存把已评价的按钮又点亮
 * @param {string} postId
 * @param {string} revieweeOpenid 被评价人（一个帖子可能招多人，必须带）
 * @return {Promise<object|null>}
 */
async function fetchMyReviewByPost(postId, revieweeOpenid) {
  if (!postId || !revieweeOpenid) return null;
  await ensureInit();
  const result = await callReviewFunction({
    action: 'get',
    postId: postId,
    revieweeOpenid: revieweeOpenid
  });
  const review = result.review ? normalizeReview(result.review) : null;

  // 云端说没有 -> 清掉缓存里这条「帖子 + 这个人」的旧记录；有 -> 合并进缓存
  const index = cache.myReviews.findIndex(function (item) {
    return item.postId === postId && item.revieweeOpenid === revieweeOpenid;
  });
  if (review) {
    mergeMyReview(review);
  } else if (index > -1) {
    cache.myReviews.splice(index, 1);
  }
  return review;
}

/**
 * 提交评价（云端查重后只 add，提交后不可修改）
 * 重复提交时云端回 `ALREADY_REVIEWED`，store 把它原样抛给页面展示
 * @param {{postId:string, revieweeOpenid:string, rating:number, content:string}} input
 */
async function submitReview(input) {
  const revieweeOpenid = (input && input.revieweeOpenid) || '';
  if (!revieweeOpenid) throw new Error('缺少被评价人');

  const postId = ((input && input.postId) || '').trim();
  if (!postId) {
    const err = new Error('缺少帖子信息，请刷新后重试');
    err.code = 'POST_ID_REQUIRED';
    throw err;
  }

  const rating = Number(input.rating);
  if (rating !== 1 && rating !== 0) {
    const err = new Error('请选择满意或不满意');
    err.code = 'RATING_INVALID';
    throw err;
  }

  await ensureInit();
  const result = await callReviewFunction({
    action: 'submit',
    postId: postId,
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

/* ---------------- 发布者名片（详情页用，云函数 getAuthorProfile 一次查全） ----------------
   为什么不做缓存：名片属于「别人的数据」，且每次进详情看的都是不同的人，
   缓存只会在别人刚改完简历 / 刚收到新评价时给出过期结果，不划算。
   一次 callFunction 同时拿 users 简历 + reviews 匿名统计，前端不做任何多表串联。 */

// 兜底名片：云函数未部署 / 网络失败 / 对方没资料时，页面拿到的永远是这个完整结构（绝无 undefined）
function emptyAuthorCard() {
  return {
    nickname: '',
    avatarText: '',
    resume: '',
    hasResume: false,
    reviewTotal: 0,
    reviewGoodCount: 0,
    reviewRate: 0,
    showRate: false,
    reviewPendingText: constants.REVIEW_PENDING_TEXT,
    anonymousName: constants.REVIEW_ANONYMOUS_NAME,
    reviews: []
  };
}

// 云端结果 -> 页面字段：所有字段都做类型兜底，云端少给任何一个也不会让 wxml 取到 undefined
function normalizeAuthorCard(result) {
  const card = emptyAuthorCard();
  const author = (result && result.author) || {};
  const review = (result && result.review) || {};

  const nickname = String(author.nickname || '');
  const resume = String(author.resume || '');
  const total = Number(review.total) || 0;

  card.nickname = nickname;
  card.avatarText = String(author.avatarText || (nickname ? nickname.slice(0, 1) : ''));
  card.resume = resume;
  card.hasResume = resume.trim() !== '';
  card.reviewTotal = total;
  card.reviewGoodCount = Number(review.goodCount) || 0;
  card.reviewRate = Number(review.rate) || 0;
  // 不足 REVIEW_MIN_COUNT 条时一律不展示好评率（与个人页同一套规则）
  card.showRate = total >= constants.REVIEW_MIN_COUNT;
  card.reviewPendingText = review.pendingText || constants.REVIEW_PENDING_TEXT;
  card.anonymousName = review.anonymousName || constants.REVIEW_ANONYMOUS_NAME;
  card.reviews = (Array.isArray(review.list) ? review.list : [])
    .filter(function (item) { return !!item; })
    .map(function (item, index) {
      const isGood = item.rating === 1;
      return {
        id: (item.createTime || 0) + '_' + index,
        isGood: isGood,
        ratingText: item.ratingText || (isGood ? '满意' : '不满意'),
        content: String(item.content || ''),
        // 合作上下文快照：老数据（部署前提交的评价）没有这个字段 -> ''，wxml 判空后整块不渲染
        contextSnapshot: String(item.contextSnapshot || ''),
        createTime: Number(item.createTime) || 0
      };
    });

  return card;
}

/**
 * 拉取发帖人的「发布者名片」：昵称 / 简历 / 满意度 / 最近 3 条匿名文字评价
 * 失败一律返回空名片（不抛错），详情页因此永远不会因为名片而白屏。
 * @param {{postId?:string, authorOpenid?:string}} input
 * @return {Promise<object>} 结构见 emptyAuthorCard()
 */
async function fetchAuthorProfile(input) {
  const postId = (input && input.postId) || '';
  const authorOpenid = (input && input.authorOpenid) || '';
  if (!postId && !authorOpenid) return emptyAuthorCard();

  try {
    await ensureInit();
  } catch (err) {
    console.warn('[store] 初始化失败，发布者名片降级为空：', err);
  }

  let res;
  try {
    res = await wx.cloud.callFunction({
      name: CLOUD_FUNCTIONS.GET_AUTHOR_PROFILE,
      data: { postId: postId, authorOpenid: authorOpenid }
    });
  } catch (err) {
    console.warn('[store] getAuthorProfile 云函数调用失败（是否已上传并部署？）：', err);
    return emptyAuthorCard();
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    console.warn('[store] 发布者名片返回失败 code=' + (result.code || '') + '：' + (result.message || ''));
  }
  // 失败时云端也会回空结构，走同一套归一化（等价于空名片），前端无需分叉
  return normalizeAuthorCard(result);
}

/* ---------------- 消息中心（云函数 message） ----------------
  messages / announcements 对客户端都是「所有用户不可读写」：
    · 个人通知：谁的通知只有谁看得见，归属判定必须在服务端（改包也看不到别人的）；
    · 全体公告：全局数据，没有「按人已读」概念 —— 已读只存在本设备（lastReadMessageTime），
      最新公告时间比它新就亮红点（个人通知另有 isRead 字段，存在云端）。
  因此：列表 / 标记已读 / 红点统计全部走云函数，本地只存一个时间戳。*/

async function callMessageFunction(data) {
  let res;
  try {
    res = await wx.cloud.callFunction({ name: CLOUD_FUNCTIONS.MESSAGE, data: data });
  } catch (err) {
    const wrapped = new Error('message 云函数调用失败，请确认已上传并部署');
    wrapped.code = 'FUNCTION_CALL_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    const err = new Error(result.message || '消息加载失败，请稍后重试');
    err.code = result.code || 'MESSAGE_FAILED';
    throw err;
  }
  return result;
}

// 字段全兜底：云端少给任何一个字段，页面也不会拿到 undefined
function normalizeMessage(doc) {
  const raw = doc || {};
  return {
    id: raw.id || raw._id || '',
    kind: 'message',
    type: String(raw.type || 'system'),
    title: String(raw.title || ''),
    content: String(raw.content || ''),
    isRead: !!raw.isRead,
    createTime: Number(raw.createTime) || 0
  };
}

function normalizeAnnouncement(doc) {
  const raw = doc || {};
  return {
    id: raw.id || raw._id || '',
    kind: 'announcement',
    title: String(raw.title || ''),
    content: String(raw.content || ''),
    isRead: true, // 公告没有「按人已读」，展示层不需要未读圆点
    createTime: Number(raw.createTime) || 0
  };
}

/**
 * 拉消息中心：最新 20 条个人通知 + 最新 3 条公告（云函数已排序、已按归属裁剪）
 * @return {Promise<{announcements: Array, messages: Array}>}
 */
async function fetchMessageCenter() {
  await ensureInit();
  const result = await callMessageFunction({ action: 'list' });

  const announcements = (Array.isArray(result.announcements) ? result.announcements : [])
    .map(normalizeAnnouncement)
    .filter(function (item) { return !!item.id; });
  const messages = (Array.isArray(result.messages) ? result.messages : [])
    .map(normalizeMessage)
    .filter(function (item) { return !!item.id; });

  cache.messageCenter = { announcements: announcements, messages: messages };
  return cache.messageCenter;
}

/**
 * 标记单条通知已读（只能标记自己的，云端按归属字段校验）
 * 成功后就地更新缓存，页面无需重新拉列表
 */
async function markMessageRead(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return false;

  await ensureInit();
  await callMessageFunction({ action: 'read', messageId: id });

  if (cache.messageCenter) {
    cache.messageCenter.messages.forEach(function (item) {
      if (item.id === id) item.isRead = true;
    });
  }
  return true;
}

// 本地「最近一次进入消息中心」的时间戳（公告红点判定用）
function getLastReadMessageTime() {
  return Number(wx.getStorageSync(STORAGE_KEYS.LAST_READ_MESSAGE_TIME)) || 0;
}

// 进入消息页后调用：把时间戳推到当下，公告红点随即消失
function markMessagesSeen() {
  const now = Date.now();
  try {
    wx.setStorageSync(STORAGE_KEYS.LAST_READ_MESSAGE_TIME, now);
  } catch (err) {
    console.warn('[store] 写入消息已读时间失败：', err);
  }
  return now;
}

/**
 * 红点判定：有未读个人通知（云端 isRead === false）或 有比本地时间更新的公告
 * 失败不抛错（个人页 onShow 调，不能因此报错）：统一回 { hasUnread: false }
 * @return {Promise<{hasUnread: boolean, unreadCount: number, newAnnouncement: boolean}>}
 */
async function fetchMessageBadge() {
  const none = { hasUnread: false, unreadCount: 0, newAnnouncement: false };
  try {
    await ensureInit();
    const result = await callMessageFunction({ action: 'badge' });
    const unreadCount = Number(result.unreadCount) || 0;
    const latest = Number(result.latestAnnouncementTime) || 0;
    const newAnnouncement = latest > 0 && latest > getLastReadMessageTime();
    return {
      hasUnread: unreadCount > 0 || newAnnouncement,
      unreadCount: unreadCount,
      newAnnouncement: newAnnouncement
    };
  } catch (err) {
    console.warn('[store] 消息红点查询失败（已按无红点处理）：', err);
    return none;
  }
}

// 当前用户是不是管理员（role 由 users 集合提供，前端只用来决定是否显示「进入管理后台」入口）
function isAdmin() {
  return !!(cache.profile && String(cache.profile.role || '').toLowerCase() === 'admin');
}

// 当前用户是不是受罚者（role === 'banned'）：前端只用于入口拦截（详情 / 发布 / 申请 / 评价 / 举报），
// 真正的拦截在各云函数（publish / review / application / report 各自查 users.role）。
function isBanned() {
  return String((cache.profile && cache.profile.role) || '').toLowerCase() === 'banned';
}

/* ---------------- 管理后台（云函数 admin） ----------------
   reports / users 对客户端「所有用户不可读写」，因此后台的列表、搜索、惩罚全部只能走云函数；
   客户端只负责把结果渲染成卡片。role === 'admin' 的校验在云函数第一行，前端藏按钮只是体验层。*/

async function callAdminFunction(data) {
  let res;
  try {
    res = await wx.cloud.callFunction({ name: CLOUD_FUNCTIONS.ADMIN, data: data });
  } catch (err) {
    const wrapped = new Error('admin 云函数调用失败，请确认已上传并部署');
    wrapped.code = 'FUNCTION_CALL_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  const result = (res && res.result) || {};
  if (!result.ok) {
    const err = new Error(result.message || '后台操作失败，请稍后重试');
    err.code = result.code || 'ADMIN_FAILED';
    throw err;
  }
  return result;
}

// 待处理举报列表（云端已联查帖子标题 / 状态 / 权重）
async function fetchAdminReports() {
  await ensureInit();
  const result = await callAdminFunction({ action: 'getReports' });
  return {
    total: Number(result.total) || 0,
    list: Array.isArray(result.list) ? result.list : []
  };
}

/**
 * 处理一条举报
 * @param {'ignore'|'violate'} action ignore = 忽略（权重 -1）/ violate = 确认违规（权重 +2 + 警告）
 */
async function adminHandleReport(action, input) {
  if (action !== 'ignore' && action !== 'violate') {
    const err = new Error('未知的处罚动作');
    err.code = 'ACTION_INVALID';
    throw err;
  }

  const reportId = (input && input.reportId) || '';
  const postId = (input && input.postId) || '';
  if (!reportId) {
    const err = new Error('缺少举报记录 ID');
    err.code = 'REPORT_ID_REQUIRED';
    throw err;
  }

  await ensureInit();
  const result = await callAdminFunction({
    action: action,
    reportId: reportId,
    postId: postId
  });

  // 帖子状态 / 权重已经变了，顺手刷一次帖子缓存（失败不影响后台操作结果）
  try {
    await pullPosts();
  } catch (err) {
    console.warn('[store] 后台操作后刷新帖子缓存失败：', err);
  }

  return result;
}

// 按学号查绑定者（可能是多条：历史脏数据，后台逐条展示）
async function adminSearchUser(studentId) {
  const value = String(studentId || '').trim();
  if (!value) {
    const err = new Error('请输入学号');
    err.code = 'STUDENT_ID_REQUIRED';
    throw err;
  }

  await ensureInit();
  const result = await callAdminFunction({ action: 'searchUser', studentId: value });
  return {
    total: Number(result.total) || 0,
    list: Array.isArray(result.list) ? result.list : []
  };
}

// 强制解绑学号（申诉处理）：把目标用户 studentId 置空，写 admin_logs
async function adminUnbind(targetOpenid) {
  const openid = String(targetOpenid || '').trim();
  if (!openid) {
    const err = new Error('缺少目标用户');
    err.code = 'TARGET_REQUIRED';
    throw err;
  }

  await ensureInit();
  return callAdminFunction({ action: 'unbind', targetOpenid: openid });
}

/**
 * 发布全体公告（写 announcements；客户端零权限，只能走 admin 云函数）
 * 公告不需要给每个人写一条 messages：它的已读是「设备本地时间」概念。
 * @param {{title:string, content:string}} input
 */
async function adminPublishAnnouncement(input) {
  const title = String((input && input.title) || '').trim();
  const content = String((input && input.content) || '').trim();

  if (!title) {
    const err = new Error('请填写公告标题');
    err.code = 'TITLE_REQUIRED';
    throw err;
  }
  if (!content) {
    const err = new Error('请填写公告内容');
    err.code = 'CONTENT_REQUIRED';
    throw err;
  }

  await ensureInit();
  return callAdminFunction({
    action: 'publishAnnouncement',
    title: title,
    content: content
  });
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
  cache.messageCenter = null;  // 站内通知属于个人数据，退出即清
  cache.applications = [];     // 申请含联系方式 / 学号，退出即清（含本地快照）
  clearSnapshot(STORAGE_KEYS.CACHE_APPLICATIONS);
  try {
    // 已读时间也是个人状态：换账号登录时不能继承上一个人的「已看过公告」
    wx.removeStorageSync(STORAGE_KEYS.LAST_READ_MESSAGE_TIME);
  } catch (err) {
    console.warn('[store] 清理消息已读时间失败：', err);
  }
}

// openid 由 app.js 启动时预热，页面里同步取用
function getOpenId() {
  return cache.openid;
}

module.exports = {
  init,
  getState,
  getOpenId,
  hydrateFromCache,

  // posts
  getPosts,
  findPost,
  fetchPostById,
  fetchPostContact,
  syncPosts,
  savePost,
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
  isRealNameBound,
  submitReport,

  // 消息中心（云函数 message）
  fetchMessageCenter,
  markMessageRead,
  fetchMessageBadge,
  markMessagesSeen,
  getLastReadMessageTime,

  // reviews（双向评价，全部走云函数）
  getMyReviews,
  syncMyReviews,
  findMyReviewByPost,
  hasReviewedPost,
  fetchMyReviewByPost,
  submitReview,
  syncReceivedReviews,
  getReceivedReviews,

  // 发布者名片（详情页，云函数 getAuthorProfile）
  fetchAuthorProfile,
  emptyAuthorCard,

  // 管理后台（云函数 admin，仅 role === 'admin' 可用）
  isAdmin,
  // 受罚者（role === 'banned'）：入口拦截用
  isBanned,
  fetchAdminReports,
  adminHandleReport,
  adminSearchUser,
  adminUnbind,
  adminPublishAnnouncement,

  // auth
  isLoggedIn,
  setLoggedIn,
  login,
  logout
};

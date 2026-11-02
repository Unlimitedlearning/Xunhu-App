// cloudfunctions/admin/index.js
// 管理后台唯一入口（v1.2.0）。
//
// 为什么必须有这个云函数：
//   reports / users 两个集合对客户端「所有用户不可读写」（举报内容与学号都不能外泄），
//   所以后台的列表、搜索、处罚操作全部只能走服务端，前端拿到的永远是这里筛过的字段。
//
// 权限：每个 action 都先校验「当前 openid 的 users.role === 'admin'」，不通过直接 FORBIDDEN。
//   注意：role 只能由控制台或本云函数之外的服务端逻辑写入，客户端改包也提不了权。
//
// 入参统一用 action 区分：
//   { action: 'getReports' }                      -> { ok, total, list }  待处理举报（含原因 / 补充说明 / 脱敏举报人）
//   { action: 'ignore', reportId, postId }        -> 帖子 reportWeight -1（最低 0）；auditing 且未定性违规 -> 恢复 active
//   { action: 'violate', reportId, postId }       -> 帖子 reportWeight +2 + 打码下架 + 发帖人警告 +1
//   { action: 'searchUser', studentId }           -> { ok, total, list }  按学号查绑定者
//   { action: 'unbind', targetOpenid }            -> 把目标用户 studentId 置空（申诉处理）
//   ignore / violate / unbind 都会写 admin_logs（adminOpenid / action / targetId / createTime）。
//
// 【阈值同步】REPORT_WEIGHT_AUDIT_THRESHOLD / WARNING_BAN_THRESHOLD 与
//   cloudfunctions/report/index.js、utils/constants.js 三处同值，改一处必须同步其余两处。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const POSTS = 'posts';
const REPORTS = 'reports';
const USERS = 'users';
const ADMIN_LOGS = 'admin_logs';

// 自动风控阈值（与 cloudfunctions/report、utils/constants.js 三处同值）
const REPORT_WEIGHT_AUDIT_THRESHOLD = 5;
const WARNING_BAN_THRESHOLD = 3;

// 后台一次最多回多少条（举报积压时先看最新的，处理完再刷新）
const REPORT_LIST_LIMIT = 100;
const SEARCH_LIMIT = 20;

const ROLE_ADMIN = 'admin';

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1;
}

function weightOf(doc) {
  const value = Number(doc && doc.reportWeight);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function warningOf(doc) {
  const value = Number(doc && doc.warningCount);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/* ---------------- 脱敏工具 ----------------
 * 【隐私红线】后台只展示「能完成判断的最少信息」：
 *   · 举报人 openid：只给前 4 + 后 4，足够区分「同一个人多次举报」，但无法拼回完整身份；
 *   · 学号：只给前 2 + 后 4（「31****1234」），管理员已经用完整学号搜索过，足以核对；
 *   · 联系方式（users.contact / posts.contact）：一律不下发，管理员也没必要看到。*/

function maskOpenid(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return raw.slice(0, 2) + '***';
  return raw.slice(0, 4) + '***' + raw.slice(-4);
}

function maskStudentId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 6) return '****';
  return raw.slice(0, 2) + '****' + raw.slice(-4);
}

/* ---------------- 基础查询 ---------------- */

// 找用户文档（兼容 _openid / openid 两种历史写法）
async function loadUserDoc(db, openid) {
  if (!openid) return null;
  const conditions = [{ _openid: openid }, { openid: openid }];
  for (let i = 0; i < conditions.length; i++) {
    try {
      const res = await db.collection(USERS).where(conditions[i]).limit(1).get();
      const doc = ((res && res.data) || [])[0];
      if (doc) return doc;
    } catch (err) {
      if (isMissingCollection(err)) return null;
      console.warn('[admin] 读取 users 文档失败：', err && err.message);
    }
  }
  return null;
}

async function getPost(db, postId) {
  if (!postId) return null;
  try {
    const res = await db.collection(POSTS).doc(postId).get();
    return (res && res.data) || null;
  } catch (err) {
    console.warn('[admin] 读取帖子失败 postId=' + postId + '：', err && err.message);
    return null;
  }
}

// 批量取帖子（_.in 一次最多 20 个 id，分批串行，避免打爆单次查询限制）
async function fetchPostsByIds(db, ids) {
  const _ = db.command;
  const map = {};
  const unique = [];
  const seen = {};

  (ids || []).forEach(function (id) {
    if (!id || seen[id]) return;
    seen[id] = true;
    unique.push(id);
  });

  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    try {
      const res = await db.collection(POSTS).where({ _id: _.in(chunk) }).limit(20).get();
      ((res && res.data) || []).forEach(function (doc) {
        if (doc && doc._id) map[doc._id] = doc;
      });
    } catch (err) {
      console.warn('[admin] 批量读取帖子失败，跳过本批：', err && err.message);
    }
  }

  return map;
}

/* ---------------- 写日志 / 标记举报已处理 ---------------- */

async function writeLog(db, adminOpenid, action, targetId, extra) {
  const data = Object.assign({
    adminOpenid: adminOpenid,
    action: action,
    targetId: String(targetId || ''),
    createTime: Date.now()
  }, extra || {});

  try {
    await db.collection(ADMIN_LOGS).add({ data: data });
    return true;
  } catch (err) {
    if (isMissingCollection(err)) {
      // 集合首次使用时自动建（安全规则仍需控制台设置「所有用户不可读写」）
      try {
        await db.createCollection(ADMIN_LOGS);
        await db.collection(ADMIN_LOGS).add({ data: data });
        return true;
      } catch (retryErr) {
        console.error('[admin] admin_logs 写入失败（集合是否已创建？）：', retryErr && retryErr.message);
        return false;
      }
    }
    console.error('[admin] admin_logs 写入失败：', err && err.message);
    return false;
  }
}

async function markReportDone(db, reportId, action, adminOpenid, extra) {
  if (!reportId) return false;
  const data = Object.assign({
    status: 'done',
    handleAction: action,
    handleAdminOpenid: adminOpenid,
    handleTime: Date.now()
  }, extra || {});

  try {
    await db.collection(REPORTS).doc(reportId).update({ data: data });
    return true;
  } catch (err) {
    console.warn('[admin] 举报标记完成失败 reportId=' + reportId + '：', err && err.message);
    return false;
  }
}

/**
 * 给发帖人记一次违规警告，达到阈值即封禁（与 cloudfunctions/report 同实现）
 * 管理员账号不参与自动封禁，避免把唯一管理员封掉导致后台彻底进不去
 */
async function bumpUserWarning(db, userOpenid) {
  const doc = await loadUserDoc(db, userOpenid);
  if (!doc) return { found: false, warningCount: 0, banned: false };

  const current = warningOf(doc);
  const next = current + 1;
  const role = String(doc.role || 'user').toLowerCase();

  const data = { warningCount: next, updateTime: Date.now() };
  let banned = role === 'banned';

  if (!banned && next >= WARNING_BAN_THRESHOLD && role !== ROLE_ADMIN) {
    data.role = 'banned';
    // 与 cloudfunctions/report 一致：只标记状态 + 留痕，不切断前端（不清会话、不下线）
    data.banSource = 'admin-violate';
    data.banTime = data.updateTime;
    banned = true;
  }

  try {
    await db.collection(USERS).doc(doc._id).update({ data: data });
  } catch (err) {
    console.error('[admin] 写入警告次数失败：', err && err.message);
    return { found: true, warningCount: current, banned: role === 'banned' };
  }

  return { found: true, warningCount: next, banned: banned };
}

/* ---------------- action: getReports ---------------- */

async function handleGetReports(db) {
  let rows = [];
  try {
    const res = await db.collection(REPORTS)
      .orderBy('createTime', 'desc')
      .limit(REPORT_LIST_LIMIT)
      .get();
    rows = (res && res.data) || [];
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: true, total: 0, list: [] }; // 还没人举报过
    }
    return {
      ok: false,
      code: errCodeOf(err) || 'REPORT_QUERY_FAILED',
      message: '举报列表读取失败，请确认 reports 集合已创建'
    };
  }

  // 只回「待处理」：老记录没有 status 字段，按 pending 处理（否则历史举报永远刷不出来）
  const pending = rows.filter(function (doc) {
    return String((doc && doc.status) || 'pending').toLowerCase() !== 'done';
  });

  const postMap = await fetchPostsByIds(db, pending.map(function (doc) {
    return doc && doc.postId;
  }));

  const list = pending.map(function (doc) {
    const post = postMap[doc.postId] || null;
    const snapshot = doc.postSnapshot || {};
    return {
      reportId: doc._id || '',
      postId: doc.postId || '',
      reason: doc.reason || '',
      desc: doc.desc || '',
      // 举报人：脱敏后下发（只用于区分「同一人反复举报」，不暴露完整 openid）
      reporterOpenid: maskOpenid(doc.reporterOpenid || doc._openid),
      createTime: doc.createTime || 0,
      // 帖子已删除时仍要把举报留在队列里（后台可标记忽略，不能点「确认违规」降权）
      postExists: !!post,
      postTitle: post ? String(post.title || '') : String(snapshot.title || ''),
      postStatus: post ? String(post.status || '') : 'deleted',
      postAuthorName: post ? String(post.authorName || '') : String(snapshot.authorName || ''),
      postWeight: post ? weightOf(post) : 0,
      postViolated: !!(post && post.violated)
      // 注意：这里绝不能加 posts.contact / users.* 的任何字段 ——
      // 管理员看举报只需要「帖子里写了什么 + 被举报理由」，联系方式与学号与审核判断无关。
    };
  });

  // 二次排序兜底：orderBy 对缺失 createTime 的老数据不保证顺序
  list.sort(function (a, b) {
    return (b.createTime || 0) - (a.createTime || 0);
  });

  return { ok: true, total: list.length, list: list };
}

/* ---------------- action: ignore ----------------
 * 【产品口径】「忽略」= 管理员判定该帖子没有违规，所以要做两件事：
 *   1) 撤销本条举报带来的权重：reportWeight -1（最低 0）；
 *   2) 撤销自动审查：若帖子正处于 auditing、且从未被真正定性违规（violated !== true），
 *      立即把 status 改回 active —— 否则发帖人会以为自己的帖子凭空消失。
 * 哪些情况不恢复：
 *   · status === 'ended'：已结束的内容不需要恢复上线；
 *   · violated === true：曾被管理员「确认违规」下架，人工结论不能被一次忽略推翻。
 * 为什么不怕「举报 → 忽略 → 再举报」来回刷：
 *   每个举报人只算一次（同人同帖去重），权重到 3 才进审查，刷状态的成本远高于收益。
 * 【日志】恢复动作会以 statusBefore / statusAfter / restored / note 四个字段写进 admin_logs，
 *   后台日志里直接读 note 就能看出这条处罚到底改了什么。*/
async function handleIgnore(db, adminOpenid, payload) {
  const reportId = String(payload.reportId || '').trim();
  const postId = String(payload.postId || '').trim();

  if (!reportId) {
    return { ok: false, code: 'REPORT_ID_REQUIRED', message: '缺少举报记录 ID' };
  }

  const post = await getPost(db, postId);
  const now = Date.now();

  let weight = 0;
  let statusBefore = '';
  let statusAfter = '';
  let restored = false;
  const notes = [];

  if (post) {
    // 1. 权重回撤（最低 0，不会变成负数）
    const before = weightOf(post);
    weight = Math.max(0, before - 1);
    statusBefore = String(post.status || '');
    notes.push('举报权重 ' + before + ' → ' + weight);

    const data = { reportWeight: weight };

    // 2. 状态恢复：仅当「正在审查中」且「从未被定性违规」
    const shouldRestore = statusBefore === 'auditing' && !post.violated;
    if (shouldRestore) {
      data.status = 'active';
      data.restoreTime = now;
      data.restoreBy = adminOpenid;
      data.restoreSource = 'admin-ignore';
      // 标记「人工已判定无违规」：同一帖子再次被报到阈值时只下架审查，不再重复扣发帖人警告
      // （否则「3 个举报 → 忽略 → 第 4 个举报」就能把无违规的作者封号）
      data.auditDismissed = true;
      data.auditDismissedTime = now;
      restored = true;
      statusAfter = 'active';
      notes.push('状态 审核中 → 进行中（忽略举报，自动审查已撤销）');
    } else {
      statusAfter = statusBefore;
      if (statusBefore === 'auditing' && post.violated) {
        notes.push('状态保持审核中（该帖已被定性违规，不自动恢复）');
      }
    }

    try {
      await db.collection(POSTS).doc(postId).update({ data: data });
    } catch (err) {
      return {
        ok: false,
        code: errCodeOf(err) || 'POST_UPDATE_FAILED',
        message: '帖子权重更新失败，请稍后重试'
      };
    }
  }

  const reportMarked = await markReportDone(db, reportId, 'ignore', adminOpenid, {
    weightAfter: weight,
    statusAfter: statusAfter,
    restored: restored
  });

  const logged = await writeLog(db, adminOpenid, 'ignore', postId || reportId, {
    reportId: reportId,
    postId: postId,
    weightAfter: weight,
    postExists: !!post,
    statusBefore: statusBefore,
    statusAfter: statusAfter,
    restored: restored,
    // 备注：后台/控制台直接读 note 就能看懂这条日志改了什么
    note: post
      ? (notes.join('；') || '忽略举报，未改动帖子')
      : '帖子已不存在，仅标记举报完成'
  });

  return {
    ok: true,
    postExists: !!post,
    reportWeight: weight,
    statusBefore: statusBefore,
    statusAfter: statusAfter,
    restored: restored,
    reportMarked: reportMarked,
    logged: logged
  };
}

/* ---------------- action: violate ---------------- */

async function handleViolate(db, adminOpenid, payload) {
  const reportId = String(payload.reportId || '').trim();
  const postId = String(payload.postId || '').trim();

  if (!reportId) {
    return { ok: false, code: 'REPORT_ID_REQUIRED', message: '缺少举报记录 ID' };
  }
  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子 ID' };
  }

  const post = await getPost(db, postId);
  const now = Date.now();

  // 帖子已被作者删除：举报仍可处理（标记完成 + 写日志），但没有任何可降权的对象
  if (!post) {
    const reportMarked = await markReportDone(db, reportId, 'violate', adminOpenid, { weightAfter: 0 });
    const logged = await writeLog(db, adminOpenid, 'violate', postId, {
      reportId: reportId,
      postId: postId,
      weightAfter: 0,
      postExists: false
    });
    return {
      ok: true,
      postExists: false,
      reportWeight: 0,
      reportMarked: reportMarked,
      logged: logged,
      message: '帖子已不存在，举报已标记处理'
    };
  }

  const before = weightOf(post);
  const weight = before + 2; // 确认违规：一次算两条举报的权重
  const status = String(post.status || '');
  const alreadyViolated = !!post.violated; // 同一条帖子重复点「确认违规」不重复记警告
  const authorOpenid = post.authorOpenid || post._openid || '';

  const data = {
    reportWeight: weight,
    violated: true,
    violatedTime: now,
    violatedBy: adminOpenid
  };

  let auditing = false;
  if (status !== 'ended') {
    // 管理员确认违规 = 内容确实违规，一律打码下架（不等权重阈值）
    data.status = 'auditing';
    data.auditReason = '管理员确认违规';
    data.auditSource = 'admin-violate';
    data.auditTime = now;
    auditing = true;
  }

  try {
    await db.collection(POSTS).doc(postId).update({ data: data });
  } catch (err) {
    return {
      ok: false,
      code: errCodeOf(err) || 'POST_UPDATE_FAILED',
      message: '帖子状态更新失败，请稍后重试'
    };
  }

  // 自动封禁逻辑：人工确认违规必记一次警告（不依赖阈值），累计 >= 3 次即 banned
  let warning = null;
  if (!alreadyViolated && authorOpenid) {
    warning = await bumpUserWarning(db, authorOpenid);
    console.log('[admin] 确认违规 postId=' + postId + ' author=' + authorOpenid +
      ' warningCount=' + (warning && warning.warningCount) + ' banned=' + (warning && warning.banned));
  }

  const reportMarked = await markReportDone(db, reportId, 'violate', adminOpenid, { weightAfter: weight });
  const logged = await writeLog(db, adminOpenid, 'violate', postId, {
    reportId: reportId,
    postId: postId,
    weightAfter: weight,
    postStatus: data.status || status,
    warningCount: warning ? warning.warningCount : null,
    banned: warning ? warning.banned : false
  });

  return {
    ok: true,
    postExists: true,
    postStatus: data.status || status,
    auditing: auditing,
    reportWeight: weight,
    warningCount: warning ? warning.warningCount : null,
    banned: warning ? warning.banned : false,
    reportMarked: reportMarked,
    logged: logged
  };
}

/* ---------------- action: searchUser ---------------- */

async function handleSearchUser(db, payload) {
  const studentId = String(payload.studentId || '').trim();
  if (!studentId) {
    return { ok: false, code: 'STUDENT_ID_REQUIRED', message: '请输入学号' };
  }

  let rows = [];
  try {
    const res = await db.collection(USERS).where({ studentId: studentId }).limit(SEARCH_LIMIT).get();
    rows = (res && res.data) || [];
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: true, total: 0, list: [] };
    }
    return {
      ok: false,
      code: errCodeOf(err) || 'USER_QUERY_FAILED',
      message: '用户查询失败，请确认 users 集合已创建'
    };
  }

  const list = rows.map(function (doc) {
    return {
      // 解绑需要知道目标 openid（只下发给管理员），同时也是列表的 key
      openid: doc._openid || doc.openid || '',
      nickname: doc.nickname || '',
      // 【隐私】只下发脱敏学号：管理员是用完整学号搜进来的，展示层不需要回传完整值；
      // 联系方式 contact 一律不返回（申诉处理不需要联系当事人）。
      studentIdMasked: maskStudentId(doc.studentId),
      role: String(doc.role || 'user').toLowerCase(),
      warningCount: warningOf(doc),
      updateTime: doc.updateTime || doc.createTime || 0
    };
  });

  return { ok: true, total: list.length, list: list };
}

/* ---------------- action: unbind ---------------- */

async function handleUnbind(db, adminOpenid, payload) {
  const targetOpenid = String(payload.targetOpenid || '').trim();
  if (!targetOpenid) {
    return { ok: false, code: 'TARGET_REQUIRED', message: '缺少目标用户' };
  }

  const doc = await loadUserDoc(db, targetOpenid);
  if (!doc) {
    return { ok: false, code: 'USER_NOT_FOUND', message: '没有找到该用户的资料' };
  }

  const oldStudentId = String(doc.studentId || '');

  try {
    await db.collection(USERS).doc(doc._id).update({
      data: {
        studentId: '',
        updateTime: Date.now()
      }
    });
  } catch (err) {
    return {
      ok: false,
      code: errCodeOf(err) || 'USER_UPDATE_FAILED',
      message: '解绑失败，请稍后重试'
    };
  }

  const logged = await writeLog(db, adminOpenid, 'unbind', targetOpenid, {
    oldStudentId: oldStudentId,
    nickname: doc.nickname || ''
  });

  return {
    ok: true,
    targetOpenid: targetOpenid,
    oldStudentId: oldStudentId,
    logged: logged
  };
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;

  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '拿不到 openid，请从小程序端调用' };
  }

  const payload = event || {};
  const action = String(payload.action || '').trim();
  const db = cloud.database();

  // 【权限】所有后台 action 一律先验角色，校验不通过连一条数据都不返回
  const me = await loadUserDoc(db, openid);
  const role = String((me && me.role) || 'user').toLowerCase();
  if (role !== ROLE_ADMIN) {
    console.warn('[admin] 越权访问被拦截 openid=' + openid + ' action=' + action + ' role=' + role);
    return { ok: false, code: 'FORBIDDEN', message: '仅管理员可操作' };
  }

  if (action === 'getReports') return handleGetReports(db);
  if (action === 'ignore') return handleIgnore(db, openid, payload);
  if (action === 'violate') return handleViolate(db, openid, payload);
  if (action === 'searchUser') return handleSearchUser(db, payload);
  if (action === 'unbind') return handleUnbind(db, openid, payload);

  return { ok: false, code: 'UNKNOWN_ACTION', message: '未知 action：' + action };
};

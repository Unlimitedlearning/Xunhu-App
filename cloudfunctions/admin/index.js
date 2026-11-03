// cloudfunctions/admin/index.js
// 管理后台唯一入口（v1.7.0：统一审核流 —— 后台只保留一张「待办清单」）。
//
// 为什么必须有这个云函数：
//   reports / users 两个集合对客户端「所有用户不可读写」（举报内容与学号都不能外泄），
//   所以后台的列表、搜索、处罚操作全部只能走服务端，前端拿到的永远是这里筛过的字段。
//
// 权限：每个 action 都先校验「当前 openid 的 users.role === 'admin'」，不通过直接 FORBIDDEN。
//   注意：role 只能由控制台或本云函数之外的服务端逻辑写入，客户端改包也提不了权。
//
// 入参统一用 action 区分（v1.7.0 合并后只有三个审核类动作 + 三个用户/公告动作）：
//   { action: 'getAuditQueue' }                        -> { ok, total, list } 内容审核待办队列
//   { action: 'approve', postId, reportId? }           -> status = 'active'；该帖所有 pending 举报置 resolved；通知作者
//   { action: 'reject', postId, reportId?, reason? }   -> status = 'deleted'；发帖人 warningCount +1（满 3 自动 banned）；
//                                                         该帖所有 pending 举报置 resolved；通知作者（原因 + 警告次数）
//   { action: 'searchUser', studentId }                -> { ok, total, list }  按学号查绑定者
//   { action: 'addWarning', targetOpenid }             -> 目标用户 warningCount +1（满 3 次自动 banned）
//   { action: 'banUser', targetOpenid, reason }        -> role = 'banned' + 写 blacklist
//   { action: 'unbind', targetOpenid }                 -> 把目标用户 studentId 置空（申诉处理）
//   { action: 'publishAnnouncement', title, content }  -> 发布全体公告（写 announcements）
//
// 【v1.7.0 合并说明（统一审核流）】
//   getReports + getAuditingPosts          -> getAuditQueue（只查 status === 'auditing' 的帖子，举报次数是帖子的一个标签）
//   ignore + violate + approvePost + deletePost -> approve / reject
//   旧 action 仍会被识别并返回 ACTION_DEPRECATED，只作为排障提示（前端已同步改完）。
//
//   approve / reject / addWarning / banUser / unbind / publishAnnouncement 都会写 admin_logs
//   （adminOpenid / action / targetId / createTime + 业务留痕字段）。
//
// 【站内通知】approve / reject / addWarning / banUser / unbind 执行成功后，会向被处置人投递一条 messages 系统通知
//   （归属字段 = 目标用户；messages 集合客户端零权限，只有他本人的消息中心能看到）。
//   通知投递失败（集合未建 / 权限异常）绝不能影响主流程结果：只记 warn 并继续。
//
// 【阈值同步】REPORT_WEIGHT_AUDIT_THRESHOLD / WARNING_BAN_THRESHOLD 与
//   cloudfunctions/report/index.js、utils/constants.js 三处同值，改一处必须同步其余两处。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const POSTS = 'posts';
const REPORTS = 'reports';
const USERS = 'users';
const ADMIN_LOGS = 'admin_logs';
const MESSAGES = 'messages';
const ANNOUNCEMENTS = 'announcements';
// v1.6.0：黑名单（只记 openid + 原因），客户端零权限
const BLACKLIST = 'blacklist';

// 公告长度上限 / 通知类型（与小程序端 constants 同值）
const ANNOUNCEMENT_TITLE_MAX = 30;
const ANNOUNCEMENT_CONTENT_MAX = 200;
const MESSAGE_TYPE_SYSTEM = 'system';
// 对外联系邮箱（口径「十、违规处置」：处罚通知必须给出真实邮箱）
const ADMIN_CONTACT_EMAIL = 'xunhu_app@qq.com';

// 自动风控阈值（与 cloudfunctions/report、utils/constants.js 三处同值）
const REPORT_WEIGHT_AUDIT_THRESHOLD = 5;
const WARNING_BAN_THRESHOLD = 3;

// 审核队列一次最多回多少条（首帖 / 有前科 / 被举报的帖子都会落在这里，处理完再刷新）
const AUDIT_LIST_LIMIT = 100;
const SEARCH_LIMIT = 20;
// 批量联查的批大小：_.in 每批最多放 10 个 id，单批结果上限 1000 条。
// 审核队列要求「拿到帖子列表后批量查 reports 与 users，严禁在 map 循环里单条查库」，
// 这两个常数就是那个约束的落点。
const BATCH_SIZE = 10;
const BATCH_FETCH_LIMIT = 1000;

const ROLE_ADMIN = 'admin';

// v1.7.0 已废弃的 action（仍识别，但直接回可读错误）：
// getReports + getAuditingPosts -> getAuditQueue；ignore + violate + approvePost + deletePost -> approve / reject
const DEPRECATED_ACTIONS = [
  'getReports', 'getAuditingPosts', 'ignore', 'violate', 'approvePost', 'deletePost'
];

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
 *   · 实名 openid：v1.7.0 起审核队列不再下发（列表只需要「被举报几次」，不需要知道是谁）；
 *   · 学号：只给前 2 + 后 4（「31****1234」），管理员已经用完整学号搜索过，足以核对；
 *   · 联系方式（users.contact / posts.contact）：一律不下发，管理员也没必要看到。*/

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

/* ---------------- 批量联查工具（审核队列专用） ----------------
 * 【性能红线】审核队列拿到 posts 列表后，reports（举报次数）与 users（发帖人状态）
 *   必须一次性批量取回，绝不能在 map / forEach 循环里单条查库：
 *   100 条待审帖 × 2 次查询 = 200 次数据库往返，云函数 3 秒超时直接就挂了。
 *   这里的做法：按 BATCH_SIZE 个 id 一批发 _.in 查询，回来后在内存里按 key 分组。*/

// 一条举报是否还「待处理」：老记录没有 status 字段 -> 按 pending 处理；
// 'done' 是 v1.6.0 之前的已处理状态，'resolved' 是 v1.7.0 统一后的已处理状态。
function isPendingReport(doc) {
  const status = String((doc && doc.status) || 'pending').toLowerCase();
  return status !== 'done' && status !== 'resolved';
}

// 批量取「多个帖子」的待处理举报 -> { postId: [{ reportId, reason, createTime }] }
async function loadPendingReportsByPostIds(db, postIds) {
  const _ = db.command;
  const map = {};
  const unique = [];
  const seen = {};

  (postIds || []).forEach(function (id) {
    if (!id || seen[id]) return;
    seen[id] = true;
    unique.push(id);
  });

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    try {
      const res = await db.collection(REPORTS)
        .where({ postId: _.in(chunk) })
        .limit(BATCH_FETCH_LIMIT)
        .get();
      ((res && res.data) || []).forEach(function (doc) {
        if (!doc || !isPendingReport(doc)) return;
        const key = String(doc.postId || '');
        if (!key) return;
        if (!map[key]) map[key] = [];
        map[key].push({
          reportId: doc._id || '',
          reason: String(doc.reason || ''),
          createTime: Number(doc.createTime) || 0
        });
      });
    } catch (err) {
      if (!isMissingCollection(err)) {
        console.warn('[admin] 批量读取举报失败，跳过本批：', err && err.message);
      }
    }
  }

  return map;
}

// 批量统计「发帖人历史发帖数」-> { openid: 帖子条数（含当前这条待审帖） }
// 只用来判断「是不是 0（新用户首帖）」，所以只取 authorOpenid 一列，不拉正文。
async function countPostsByAuthors(db, openids) {
  const _ = db.command;
  const map = {};
  const unique = [];
  const seen = {};

  (openids || []).forEach(function (id) {
    if (!id || seen[id]) return;
    seen[id] = true;
    unique.push(id);
  });

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    try {
      const res = await db.collection(POSTS)
        .where({ authorOpenid: _.in(chunk) })
        .field({ authorOpenid: true })
        .limit(BATCH_FETCH_LIMIT)
        .get();
      ((res && res.data) || []).forEach(function (doc) {
        const key = String((doc && doc.authorOpenid) || '');
        if (!key) return;
        map[key] = (map[key] || 0) + 1;
      });
    } catch (err) {
      if (!isMissingCollection(err)) {
        console.warn('[admin] 批量统计发帖数失败，跳过本批：', err && err.message);
      }
    }
  }

  return map;
}

/* ---------------- 写日志 ---------------- */

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

/* ---------------- 站内通知（messages） ----------------
 * 写入时同时带两个归属字段：
 *   _openid  ：云开发标准的用户标识（消息云函数优先按它查）；
 *   toOpenid ：兜底字段（部分环境服务端 SDK 不允许显式写 _openid，此时降级只用它）。
 * 消息云函数两个字段都会查并按 _id 去重，所以写入端能不能写 _openid 都不影响送达。
 * 这里只负责「投递」，已读（isRead）只能由消息云函数写。
 */
async function sendUserMessage(db, targetOpenid, title, content, extra) {
  const openid = String(targetOpenid || '').trim();
  if (!openid) return false;

  const base = Object.assign({
    toOpenid: openid,
    type: MESSAGE_TYPE_SYSTEM,
    title: String(title || '').trim(),
    content: String(content || '').trim(),
    isRead: false,
    createTime: Date.now()
  }, extra || {});

  const withOwner = Object.assign({ _openid: openid }, base);

  try {
    await db.collection(MESSAGES).add({ data: withOwner });
    return true;
  } catch (err) {
    const message = String((err && err.message) || '');

    // 1) 集合不存在：建完重试一次
    if (isMissingCollection(err)) {
      try {
        await db.createCollection(MESSAGES);
        await db.collection(MESSAGES).add({ data: withOwner });
        return true;
      } catch (retryErr) {
        console.error('[admin] messages 写入失败（集合是否已创建？）：', retryErr && retryErr.message);
        return false;
      }
    }

    // 2) 运行环境不允许服务端写 _openid：降级成只用 toOpenid（消息云函数兼容）
    if (message.indexOf('_openid') > -1) {
      try {
        await db.collection(MESSAGES).add({ data: base });
        return true;
      } catch (fallbackErr) {
        console.error('[admin] messages 降级写入失败：', fallbackErr && fallbackErr.message);
        return false;
      }
    }

    console.error('[admin] messages 写入失败：', message);
    return false;
  }
}

/* ---------------- 举报结案（approve / reject 共用） ----------------
 * 【v1.7.0】一个帖子被通过或被下架，它名下所有「待处理」举报都要一起结案：
 *   · 不结案 = 同一批举报永远留在队列里，管理员会反复处理同一个帖子；
 *   · 只结案「点开的那一条」= 其余举报仍在 pending，队列依旧清不干净。
 * 实现：先按 postId 拉一次该帖的举报（一次查询），再用 _.in 批量 update（每批 10 条，服务端批量更新），
 *   批量失败才降级逐条更新 —— 保证「至少被点开的那条」一定落状态。
 * reportId 允许为空（审核队列里的帖子可能没有举报记录，比如首帖审核）。*/
async function resolveReportsForPost(db, postId, reportId, handleAction, adminOpenid, extra) {
  const _ = db.command;
  const now = Date.now();
  const ids = [];
  const seen = {};

  if (reportId && !seen[reportId]) {
    seen[reportId] = true;
    ids.push(reportId);
  }

  if (postId) {
    try {
      const res = await db.collection(REPORTS)
        .where({ postId: postId })
        .limit(BATCH_FETCH_LIMIT)
        .get();
      ((res && res.data) || []).forEach(function (doc) {
        if (!doc || !doc._id || seen[doc._id] || !isPendingReport(doc)) return;
        seen[doc._id] = true;
        ids.push(doc._id);
      });
    } catch (err) {
      if (!isMissingCollection(err)) {
        console.warn('[admin] 读取帖子举报失败 postId=' + postId + '：', err && err.message);
      }
    }
  }

  if (!ids.length) return { count: 0, updated: 0 };

  const data = Object.assign({
    status: 'resolved',
    handleAction: handleAction,
    handleAdminOpenid: adminOpenid,
    handleTime: now,
    resolvedTime: now
  }, extra || {});

  let updated = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    try {
      await db.collection(REPORTS).where({ _id: _.in(chunk) }).update({ data: data });
      updated += chunk.length;
    } catch (err) {
      console.warn('[admin] 批量标记举报失败，降级逐条处理：', err && err.message);
      for (let j = 0; j < chunk.length; j++) {
        try {
          await db.collection(REPORTS).doc(chunk[j]).update({ data: data });
          updated += 1;
        } catch (singleErr) {
          console.warn('[admin] 举报标记失败 reportId=' + chunk[j] + '：', singleErr && singleErr.message);
        }
      }
    }
  }

  return { count: ids.length, updated: updated };
}

/**
 * 给发帖人记一次违规警告，达到阈值即封禁（与 cloudfunctions/report 同实现）
 * 管理员账号不参与自动封禁，避免把唯一管理员封掉导致后台彻底进不去
 * @param {string} source 留痕用（admin-violate / admin-warning）
 */
async function bumpUserWarning(db, userOpenid, source) {
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
    data.banSource = source || 'admin-violate';
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

/* ---------------- auditReason 标签（v1.7.0） ----------------
 * 一个帖子可能同时命中多个进审原因，所以用数组拼、逗号连接，例如「被用户举报(2次),违规用户发布」：
 *   · reportCount > 0    -> 被用户举报(X次)（只数「未处理」的举报，已结案的不算）
 *   · warningCount > 0   -> 违规用户发布（发帖人 users.warningCount）
 *   · historyCount === 0 -> 新用户首帖（该用户除当前这条以外的历史发帖数为 0）
 * type 只给前端上色用（report / warning 红橙，newbie 蓝，other 灰）；文案完全由服务端定，前端不拼字符串。*/
function buildAuditTags(reportCount, warningCount, historyCount) {
  const tags = [];

  if (reportCount > 0) {
    tags.push({ type: 'report', text: '被用户举报(' + reportCount + '次)' });
  }
  if (warningCount > 0) {
    tags.push({ type: 'warning', text: '违规用户发布' });
  }
  if (historyCount === 0) {
    tags.push({ type: 'newbie', text: '新用户首帖' });
  }

  return tags;
}

/* ---------------- action: approve（统一审核通过，替代旧 ignore / approvePost） ----------------
 * 【口径】通过 = 内容无违规：
 *   1) posts.status = 'active'（大厅立即展示）；
 *   2) 该帖名下所有「待处理」举报一并置 resolved（审核队列是唯一待办清单，不留尾巴）；
 *   3) 写 auditDismissed：人工已判定无违规，report 云函数再次触顶时只下架复查、不重复扣作者警告；
 *   4) 给作者发一条站内通知（不通知他会以为帖子凭空消失）。
 * reportId 可选：审核队列里的帖子可能根本没被举报（首帖审核），只传 postId 也能过。*/
async function handleApprove(db, adminOpenid, payload) {
  const postId = String(payload.postId || '').trim();
  const reportId = String(payload.reportId || '').trim();

  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子 ID' };
  }

  const post = await getPost(db, postId);
  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '帖子不存在或已被删除' };
  }

  const now = Date.now();
  try {
    await db.collection(POSTS).doc(postId).update({
      data: {
        status: 'active',
        auditReason: '',
        // 人工判定无违规：与举报风控共用同一个标记，避免「通过后又被几个举报把作者警告扣满」
        auditDismissed: true,
        auditDismissedTime: now,
        reviewTime: now,
        reviewedBy: adminOpenid,
        reviewSource: 'admin-approve'
      }
    });
  } catch (err) {
    return {
      ok: false,
      code: errCodeOf(err) || 'POST_UPDATE_FAILED',
      message: '审核结果写入失败，请稍后重试'
    };
  }

  // 举报一并结案：帖子已经上线，pending 举报再留在队列里就是重复劳动
  const resolved = await resolveReportsForPost(db, postId, reportId, 'approve', adminOpenid);

  // 站内通知：告诉发帖人「帖子已上线」，否则他会一直以为丢了
  const authorOpenid = String(post.authorOpenid || post._openid || '');
  const notified = authorOpenid ? await sendUserMessage(
    db,
    authorOpenid,
    '内容审核已通过',
    '您发布的「' + (String(post.title || '').trim().slice(0, 30) || '未命名信息') + '」已通过审核，现已在大厅展示。',
    { postId: postId }
  ) : false;

  const logged = await writeLog(db, adminOpenid, 'auditApprove', postId, {
    postId: postId,
    reportId: reportId,
    resolvedReports: resolved.count,
    notified: notified
  });

  return {
    ok: true,
    postId: postId,
    status: 'active',
    resolvedReports: resolved.count,
    notified: notified,
    logged: logged
  };
}

/* ---------------- action: reject（统一审核下架，替代旧 violate / deletePost） ----------------
 * 【口径】下架 = 内容违规：
 *   1) posts.status = 'deleted'（大厅与往期历史都不展示）+ 记 deleteReason；
 *   2) 发帖人 warningCount +1；若加完 >= WARNING_BAN_THRESHOLD 则 role = 'banned'
 *      （只标记 + banSource / banTime 留痕，不切断前端；管理员账号不参与自动封禁）；
 *   3) 该帖名下所有 pending 举报置 resolved；
 *   4) 给发帖人发站内通知：下架原因 + 当前警告次数 + 申诉邮箱。
 * 防重复扣警告：帖子已经是 deleted 时直接返回 ALREADY_REJECTED（重复点下架不会把作者封号）。*/
async function handleReject(db, adminOpenid, payload) {
  const postId = String(payload.postId || '').trim();
  const reportId = String(payload.reportId || '').trim();
  const reason = String(payload.reason || '').trim();

  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子 ID' };
  }

  const post = await getPost(db, postId);
  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '帖子不存在或已被删除' };
  }

  const statusBefore = String(post.status || '');
  if (statusBefore === 'deleted') {
    return { ok: false, code: 'ALREADY_REJECTED', message: '该内容已下架，无需重复处理' };
  }

  const deleteReason = reason || '审核不通过';
  const now = Date.now();

  try {
    await db.collection(POSTS).doc(postId).update({
      data: {
        status: 'deleted',
        auditReason: '',
        deleteTime: now,
        deleteReason: deleteReason,
        // violated 是 v1.6.0 的人工定性标记，保留给历史数据与后台日志追溯
        violated: true,
        violatedTime: now,
        violatedBy: adminOpenid,
        reviewTime: now,
        reviewedBy: adminOpenid,
        reviewSource: 'admin-reject'
      }
    });
  } catch (err) {
    return {
      ok: false,
      code: errCodeOf(err) || 'POST_UPDATE_FAILED',
      message: '下架失败，请稍后重试'
    };
  }

  // 发帖人警告 +1（bumpUserWarning 内部已处理「满 3 自动 banned、管理员不参与封禁」）
  const authorOpenid = String(post.authorOpenid || post._openid || '');
  const warning = authorOpenid
    ? await bumpUserWarning(db, authorOpenid, 'admin-reject')
    : { found: false, warningCount: 0, banned: false };

  if (warning.banned) {
    console.log('[admin] 下架触发自动封禁 openid=' + authorOpenid + ' warningCount=' + warning.warningCount);
  }

  // 举报一并结案
  const resolved = await resolveReportsForPost(db, postId, reportId, 'reject', adminOpenid, {
    rejectReason: deleteReason
  });

  // 站内通知：原因 / 警告次数 / 申诉渠道都要说到，静默下架是最容易招投诉的做法
  const title = String(post.title || '').trim().slice(0, 30) || '未命名信息';
  const parts = ['您发布的「' + title + '」未通过审核，已被下架（原因：' + deleteReason + '）。'];
  if (warning.found) {
    parts.push('本次记一次违规警告，当前累计 ' + warning.warningCount + '/' + WARNING_BAN_THRESHOLD + ' 次。');
    parts.push(warning.banned
      ? '违规累计已达 ' + WARNING_BAN_THRESHOLD + ' 次，账号已被限制发布与报名。'
      : '累计满 ' + WARNING_BAN_THRESHOLD + ' 次将限制账号使用。');
  }
  parts.push('如有疑问请联系管理员邮箱：' + ADMIN_CONTACT_EMAIL);

  const notified = authorOpenid ? await sendUserMessage(
    db,
    authorOpenid,
    '内容审核未通过',
    parts.join(''),
    { postId: postId, reportId: reportId, warningCount: warning.found ? warning.warningCount : null }
  ) : false;

  const logged = await writeLog(db, adminOpenid, 'auditReject', postId, {
    postId: postId,
    reportId: reportId,
    reason: deleteReason,
    statusBefore: statusBefore,
    warningCount: warning.found ? warning.warningCount : null,
    banned: warning.banned,
    resolvedReports: resolved.count,
    notified: notified
  });

  return {
    ok: true,
    postId: postId,
    status: 'deleted',
    reason: deleteReason,
    warningCount: warning.found ? warning.warningCount : null,
    banned: warning.banned,
    resolvedReports: resolved.count,
    notified: notified,
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

  // 站内通知：解绑是用户感知最强的处置之一，必须告诉他「发生了什么 + 怎么恢复 + 找谁」
  const notified = await sendUserMessage(
    db,
    targetOpenid,
    '学号绑定已解除',
    '管理员已解除您账号上的学号绑定（原学号已清空）。重新绑定广工学号后才能继续发布与报名。' +
    '若您没有发起申诉，或对处理结果有疑问，请联系管理员邮箱：' + ADMIN_CONTACT_EMAIL,
    { oldStudentId: oldStudentId }
  );

  const logged = await writeLog(db, adminOpenid, 'unbind', targetOpenid, {
    oldStudentId: oldStudentId,
    nickname: doc.nickname || '',
    notified: notified
  });

  return {
    ok: true,
    targetOpenid: targetOpenid,
    oldStudentId: oldStudentId,
    notified: notified,
    logged: logged
  };
}

/* ---------------- action: publishAnnouncement ----------------
 * 全体公告：写一条 announcements（title / content / createTime），
 * 不往每个人写一条 messages —— 公告是「所有人共用一条」，个人消息是「一人一条」。
 * 已读由客户端本地 lastReadMessageTime 判定，因此服务端不存已读状态。
 */
async function handlePublishAnnouncement(db, adminOpenid, payload) {
  const title = String(payload.title || '').trim();
  const content = String(payload.content || '').trim();

  if (!title) {
    return { ok: false, code: 'TITLE_REQUIRED', message: '请填写公告标题' };
  }
  if (title.length > ANNOUNCEMENT_TITLE_MAX) {
    return { ok: false, code: 'TITLE_TOO_LONG', message: '公告标题最多 ' + ANNOUNCEMENT_TITLE_MAX + ' 个字' };
  }
  if (!content) {
    return { ok: false, code: 'CONTENT_REQUIRED', message: '请填写公告内容' };
  }
  if (content.length > ANNOUNCEMENT_CONTENT_MAX) {
    return { ok: false, code: 'CONTENT_TOO_LONG', message: '公告内容最多 ' + ANNOUNCEMENT_CONTENT_MAX + ' 个字' };
  }

  const data = {
    title: title,
    content: content,
    createTime: Date.now(),
    // 留痕用：哪一位管理员发的（公告本身不向客户端下发 openid）
    adminOpenid: adminOpenid
  };

  let id = '';
  try {
    const res = await db.collection(ANNOUNCEMENTS).add({ data: data });
    id = (res && res._id) || '';
  } catch (err) {
    if (!isMissingCollection(err)) {
      return {
        ok: false,
        code: errCodeOf(err) || 'ANNOUNCE_FAILED',
        message: '公告发布失败，请稍后重试'
      };
    }
    try {
      await db.createCollection(ANNOUNCEMENTS);
      const retry = await db.collection(ANNOUNCEMENTS).add({ data: data });
      id = (retry && retry._id) || '';
    } catch (retryErr) {
      return {
        ok: false,
        code: errCodeOf(retryErr) || 'ANNOUNCE_FAILED',
        message: '公告发布失败：请在控制台确认 announcements 集合已创建',
      };
    }
  }

  const logged = await writeLog(db, adminOpenid, 'publishAnnouncement', id, {
    title: title,
    contentLength: content.length
  });

  return { ok: true, id: id, createTime: data.createTime, logged: logged };
}

/* ---------------- 审核队列（v1.7.0：getAuditQueue） ----------------
 * 队列 = posts.status === 'auditing'，进审的三种来源：
 *   · publish 首帖强制审核（auditSource = first-post）
 *   · publish 有违规记录强制审核（auditSource = warning-count）
 *   · report 举报后自动审查（auditSource = report）
 * 后台只下发「审核需要的最少信息」：标题 / 正文 / 分类 / 标签 / 作者昵称 / 校区 /
 *   脱敏学号 / 警告次数 / 举报次数 / auditReason 标签 / 时间。联系方式一律不下发。
 */

// 批量取用户文档（兼容 _openid / openid 两种历史写法），返回 { openid: doc }
async function loadUsersByOpenids(db, openids) {
  const _ = db.command;
  const map = {};
  const unique = [];
  const seen = {};

  (openids || []).forEach(function (id) {
    if (!id || seen[id]) return;
    seen[id] = true;
    unique.push(id);
  });

  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    try {
      const byOpenidField = await db.collection(USERS).where({ _openid: _.in(chunk) }).limit(20).get();
      const byLegacyField = await db.collection(USERS).where({ openid: _.in(chunk) }).limit(20).get();
      ((byOpenidField && byOpenidField.data) || []).concat((byLegacyField && byLegacyField.data) || [])
        .forEach(function (doc) {
          if (!doc) return;
          const key = doc._openid || doc.openid || '';
          if (key) map[key] = doc;
        });
    } catch (err) {
      if (!isMissingCollection(err)) {
        console.warn('[admin] 批量读取用户失败，跳过本批：', err && err.message);
      }
    }
  }

  return map;
}

/* ---------------- action: getAuditQueue（唯一待办队列） ----------------
 * 流程：
 *   1) 一次查出所有 status = 'auditing' 的帖子（最新 100 条）；
 *   2) 拿帖子 id / 作者 id 去批量查 reports（举报次数）与 users（发帖人状态），
 *      三个批量查询并发；
 *   3) 再批量统计作者历史发帖数，拼出 auditReason（多条件命中用逗号连接）。
 * 【性能】全程只有 1 + 3×ceil(n/10) 次查询（n = 待审帖数），
 *   绝不在 map 循环里对每条帖子单独查 reports / users。*/
async function handleGetAuditQueue(db) {
  let rows = [];
  try {
    const res = await db.collection(POSTS)
      .where({ status: 'auditing' })
      .orderBy('createTime', 'desc')
      .limit(AUDIT_LIST_LIMIT)
      .get();
    rows = (res && res.data) || [];
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: true, total: 0, list: [] }; // 集合未建 = 队列为空，不算错误
    }
    return {
      ok: false,
      code: errCodeOf(err) || 'AUDIT_QUERY_FAILED',
      message: '审核队列读取失败，请确认 posts 集合已创建'
    };
  }

  if (!rows.length) {
    return { ok: true, total: 0, list: [] };
  }

  const postIds = [];
  const authorIds = [];
  rows.forEach(function (doc) {
    if (doc && doc._id) postIds.push(doc._id);
    const author = String((doc && (doc.authorOpenid || doc._openid)) || '');
    if (author) authorIds.push(author);
  });

  // 三个批量查询并发（不是循环单条查）：举报记录 / 发帖人资料 / 发帖人历史帖数
  const batch = await Promise.all([
    loadPendingReportsByPostIds(db, postIds),
    loadUsersByOpenids(db, authorIds),
    countPostsByAuthors(db, authorIds)
  ]);
  const reportMap = batch[0] || {};
  const userMap = batch[1] || {};
  const postCountMap = batch[2] || {};

  const list = rows.map(function (doc) {
    const postId = doc._id || '';
    const authorOpenid = String(doc.authorOpenid || doc._openid || '');
    const user = userMap[authorOpenid] || {};
    const reports = reportMap[postId] || [];
    const reportCount = reports.length;
    const warningCount = warningOf(user);
    // 历史发帖数 = 该用户总帖数 - 当前这条（它自己也在 posts 里）
    const totalPosts = Number(postCountMap[authorOpenid]) || 0;
    const historyCount = totalPosts > 0 ? totalPosts - 1 : 0;

    const auditTags = buildAuditTags(reportCount, warningCount, historyCount);
    if (!auditTags.length) {
      // 兜底：三个条件都没命中（历史脏数据）也要有标签，不能让卡片顶部空着
      auditTags.push({ type: 'other', text: '人工复核' });
    }

    return {
      postId: postId,
      // reportId 只是「点开的那条」：approve / reject 会按 postId 把这个帖子的举报全部结案
      reportId: reportCount ? reports[0].reportId : '',
      title: String(doc.title || ''),
      content: String(doc.content || ''),
      category: String(doc.category || ''),
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      authorName: String(doc.authorName || user.nickname || ''),
      // 校区：非敏感值，审核时用来判断帖子内容与身份是否自洽
      authorCampus: String(doc.authorCampus || user.campus || ''),
      // 学号：脱敏（管理员用完整学号搜索时才看得到核对入口）
      authorStudentIdMasked: maskStudentId(user.studentId),
      authorWarningCount: warningCount,
      reportCount: reportCount,
      // 最新一条举报理由：管理员扫一眼就知道争议点
      latestReportReason: reportCount ? String(reports[0].reason || '') : '',
      // auditReason：多条件用逗号拼接，例如「被用户举报(2次),新用户首帖」
      auditReason: auditTags.map(function (tag) { return tag.text; }).join(','),
      auditTags: auditTags,
      // 云端原始进审备注（如「管理员确认违规」）：保留给管理员看历史
      sourceReason: String(doc.auditReason || ''),
      auditSource: String(doc.auditSource || ''),
      reportWeight: weightOf(doc),
      createTime: Number(doc.createTime) || 0
    };
  });

  return { ok: true, total: list.length, list: list };
}

/* 旧的 approvePost / deletePost / ignore / violate 已删除，统一走 approve / reject（见上文）。
   为什么不留兼容层：两套写库同时存在，很容易出现「下架了再 approve 上线」这种状态反转，
   审核流的唯一性（一个人、一个队列、两个动作）就守不住了。*/

/* ---------------- 用户处置（v1.6.0）：记警告 / 封禁 ---------------- */

async function handleAddWarning(db, adminOpenid, payload) {
  const targetOpenid = String(payload.targetOpenid || '').trim();
  if (!targetOpenid) {
    return { ok: false, code: 'TARGET_REQUIRED', message: '缺少目标用户' };
  }

  const doc = await loadUserDoc(db, targetOpenid);
  if (!doc) {
    return { ok: false, code: 'USER_NOT_FOUND', message: '没有找到该用户的资料' };
  }
  if (String(doc.role || 'user').toLowerCase() === ROLE_ADMIN) {
    return { ok: false, code: 'TARGET_IS_ADMIN', message: '不能对管理员账号记警告' };
  }

  const warning = await bumpUserWarning(db, targetOpenid, 'admin-warning');

  const notified = await sendUserMessage(
    db,
    targetOpenid,
    '违规警告通知',
    '管理员已对你的账号记一次违规警告（当前 ' + warning.warningCount + '/' + WARNING_BAN_THRESHOLD +
    ' 次）。累计满 ' + WARNING_BAN_THRESHOLD + ' 次将限制账号使用。如有疑问请联系管理员邮箱：' + ADMIN_CONTACT_EMAIL,
    { warningCount: warning.warningCount }
  );

  const logged = await writeLog(db, adminOpenid, 'addWarning', targetOpenid, {
    warningCount: warning.warningCount,
    banned: warning.banned,
    notified: notified
  });

  return {
    ok: true,
    targetOpenid: targetOpenid,
    warningCount: warning.warningCount,
    banned: warning.banned,
    notified: notified,
    logged: logged
  };
}

async function handleBanUser(db, adminOpenid, payload) {
  const targetOpenid = String(payload.targetOpenid || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!targetOpenid) {
    return { ok: false, code: 'TARGET_REQUIRED', message: '缺少目标用户' };
  }

  const doc = await loadUserDoc(db, targetOpenid);
  if (!doc) {
    return { ok: false, code: 'USER_NOT_FOUND', message: '没有找到该用户的资料' };
  }
  if (String(doc.role || 'user').toLowerCase() === ROLE_ADMIN) {
    return { ok: false, code: 'TARGET_IS_ADMIN', message: '不能封禁管理员账号' };
  }

  const now = Date.now();
  try {
    await db.collection(USERS).doc(doc._id).update({
      data: {
        role: 'banned',
        banSource: 'admin-ban',
        banReason: reason || '',
        banTime: now,
        updateTime: now
      }
    });
  } catch (err) {
    return {
      ok: false,
      code: errCodeOf(err) || 'USER_UPDATE_FAILED',
      message: '封禁失败，请稍后重试'
    };
  }

  // 写黑名单：只记 openid + 原因（不写昵称 / 学号 / 联系方式）
  const blacklist = await addToBlacklist(db, targetOpenid, reason || 'admin_ban', 'admin');

  const notified = await sendUserMessage(
    db,
    targetOpenid,
    '账号已被限制使用',
    '您的账号因违规已被限制使用' + (reason ? '（原因：' + reason + '）' : '') +
    '。如有疑问请联系管理员邮箱：' + ADMIN_CONTACT_EMAIL,
    { reason: reason }
  );

  const logged = await writeLog(db, adminOpenid, 'banUser', targetOpenid, {
    reason: reason,
    blacklist: blacklist,
    notified: notified
  });

  return {
    ok: true,
    targetOpenid: targetOpenid,
    role: 'banned',
    blacklist: blacklist,
    notified: notified,
    logged: logged
  };
}

// 写入黑名单（重复封禁不插新行，只刷新原因与时间）
async function addToBlacklist(db, openid, reason, source) {
  const data = {
    openid: String(openid || ''),
    reason: String(reason || 'admin_ban'),
    source: String(source || 'admin'),
    createTime: Date.now()
  };

  try {
    const existed = await db.collection(BLACKLIST).where({ openid: data.openid }).limit(1).get();
    const row = ((existed && existed.data) || [])[0];
    if (row && row._id) {
      await db.collection(BLACKLIST).doc(row._id).update({
        data: { reason: data.reason, source: data.source, updateTime: data.createTime }
      });
      return true;
    }
    await db.collection(BLACKLIST).add({ data: data });
    return true;
  } catch (err) {
    if (!isMissingCollection(err)) {
      console.error('[admin] blacklist 写入失败：', err && err.message);
      return false;
    }
  }

  try {
    await db.createCollection(BLACKLIST);
    await db.collection(BLACKLIST).add({ data: data });
    return true;
  } catch (retryErr) {
    console.error('[admin] 建集合后仍写入 blacklist 失败：', retryErr && retryErr.message);
    return false;
  }
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

  // v1.7.0：统一审核流（旧 getReports / ignore / violate / getAuditingPosts / approvePost / deletePost 已合并）
  if (action === 'getAuditQueue') return handleGetAuditQueue(db);
  if (action === 'approve') return handleApprove(db, openid, payload);
  if (action === 'reject') return handleReject(db, openid, payload);
  if (action === 'searchUser') return handleSearchUser(db, payload);
  // 用户处置（记警告 / 封禁 + 黑名单）
  if (action === 'addWarning') return handleAddWarning(db, openid, payload);
  if (action === 'banUser') return handleBanUser(db, openid, payload);
  if (action === 'unbind') return handleUnbind(db, openid, payload);
  if (action === 'publishAnnouncement') return handlePublishAnnouncement(db, openid, payload);

  // 旧前端（未更新版本）调废弃 action 时给可读提示，而不是笼统的「未知 action」
  if (DEPRECATED_ACTIONS.indexOf(action) > -1) {
    return {
      ok: false,
      code: 'ACTION_DEPRECATED',
      message: '该后台接口已合并，请更新小程序版本（改用 getAuditQueue / approve / reject）'
    };
  }

  return { ok: false, code: 'UNKNOWN_ACTION', message: '未知 action：' + action };
};

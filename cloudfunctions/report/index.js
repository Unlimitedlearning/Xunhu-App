// cloudfunctions/report/index.js
// 作用：举报落库 + 举报权重累加 + 自动化风控（自动审查 / 自动封禁）。
//
// 数据流（v1.2.0）：
//   1) reports 写入一条举报记录（status: 'pending'，供管理后台 getReports 拉取）
//   2) posts.reportWeight +1 —— 仅「新的举报人」才加，同一人对同一帖子重复举报不加权
//   3) reportWeight >= 3（REPORT_WEIGHT_AUDIT_THRESHOLD）
//        -> posts.status = 'auditing'（大厅打码、不可点入）
//        -> 发帖人 users.warningCount +1（同一条帖子只记一次，避免多举报人重复扣）
//   4) 发帖人 warningCount >= 2（WARNING_BAN_THRESHOLD） -> users.role = 'banned'
// 例外：帖子被管理员「忽略」过（posts.auditDismissed = true）时，再次触顶只做下架审查（3），
//   不再重复扣 warningCount —— 人工已经判定过无违规，不能靠“多找几个人举报”把作者封号。
//
// 为什么放服务端：
//   1) 举报人可以改别人的帖子吗？客户端没权限（posts 仅创建者可写），必须服务端改；
//   2) reporterOpenid 只从 cloud.getWXContext() 取，客户端伪造不了举报人；
//   3) 权重 / 警告 / 封禁全是「惩罚」，绝不能由客户端触发；
//   4) reports 集合可以完全不对客户端开放（权限设「所有用户不可读写」），举报内容不外泄。
//
// 调用方式（小程序端）：store.submitReport({ postId, reason, desc })
//   返回 { ok: true, status, duplicate, reportWeight, warningCount, banned }
//
// 【阈值同步】REPORT_WEIGHT_AUDIT_THRESHOLD / WARNING_BAN_THRESHOLD 与
//   cloudfunctions/admin/index.js、utils/constants.js 三处同值，改一处必须同步其余两处。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const POSTS = 'posts';
const REPORTS = 'reports';
const USERS = 'users';

// 与小程序端 utils/constants.js 的 REPORT_CATEGORIES 保持一致
const REPORT_REASONS = ['虚假信息', '违规内容', '骚扰谩骂', '其他'];
const MAX_DESC = 200;

// 同一 openid 对同一帖子只记一条举报（防止刷举报把帖子反复拉进审查 / 反复降权）
const DEDUPE_BY_REPORTER = true;

// 自动风控阈值（与 cloudfunctions/admin 同值）
const REPORT_WEIGHT_AUDIT_THRESHOLD = 3;
const WARNING_BAN_THRESHOLD = 2;

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1;
}

// reports 集合首次使用时自动创建（省得手工去控制台建；安全规则仍需控制台设置）
async function ensureReports(db) {
  try {
    await db.createCollection(REPORTS);
  } catch (err) {
    // 已存在属正常情况
  }
}

function weightOf(doc) {
  const value = Number(doc && doc.reportWeight);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 找发帖人的 users 文档（兼容 _openid / openid 两种历史写法）
 * 查不到 / 集合不存在一律返回 null，绝不让风控查询失败拖垮举报主流程
 */
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
      console.warn('[report] 读取发帖人 users 文档失败：', err && err.message);
    }
  }
  return null;
}

/**
 * 给发帖人记一次违规警告，并在达到阈值时封禁
 * @return {{found: boolean, warningCount: number, banned: boolean}}
 */
async function bumpAuthorWarning(db, authorOpenid) {
  const doc = await loadUserDoc(db, authorOpenid);
  if (!doc) {
    console.warn('[report] 发帖人没有 users 文档，跳过警告累加：', authorOpenid);
    return { found: false, warningCount: 0, banned: false };
  }

  const current = Number(doc.warningCount) || 0;
  const next = current + 1;
  const role = String(doc.role || 'user').toLowerCase();

  const data = { warningCount: next, updateTime: Date.now() };
  let banned = role === 'banned';

  // 管理员账号不参与自动封禁（避免误封掉唯一的管理员，导致后台再也进不去）
  if (!banned && next >= WARNING_BAN_THRESHOLD && role !== 'admin') {
    data.role = 'banned';
    banned = true;
  }

  try {
    await db.collection(USERS).doc(doc._id).update({ data: data });
  } catch (err) {
    console.error('[report] 写入警告次数失败：', err && err.message);
    return { found: true, warningCount: current, banned: role === 'banned' };
  }

  return { found: true, warningCount: next, banned: banned };
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;

  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '拿不到 openid，请从小程序端调用' };
  }

  const payload = event || {};
  const postId = String(payload.postId || '').trim();
  const reason = String(payload.reason || '').trim();
  const desc = String(payload.desc || payload.description || '').trim().slice(0, MAX_DESC);

  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子 ID' };
  }
  if (REPORT_REASONS.indexOf(reason) === -1) {
    return { ok: false, code: 'REASON_INVALID', message: '请选择举报类型' };
  }

  const db = cloud.database();
  const _ = db.command;

  // 1. 帖子必须存在
  let post = null;
  try {
    const res = await db.collection(POSTS).doc(postId).get();
    post = (res && res.data) || null;
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: false, code: 'COLLECTION_MISSING', message: 'posts 集合不存在，请先运行 initDb' };
    }
    return { ok: false, code: errCodeOf(err) || 'POST_NOT_FOUND', message: '该帖子不存在或已被删除' };
  }

  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '该帖子不存在或已被删除' };
  }

  // 2. 不能举报自己的帖子（自己下架请走「结束」/ 删除，不该进审查队列）
  const authorOpenid = post.authorOpenid || post._openid || '';
  if (authorOpenid === openid) {
    return { ok: false, code: 'SELF_REPORT', message: '不能举报自己发布的内容' };
  }

  // 3. 写举报记录（去重：同一人对同一帖子只留一条）
  //    status: 'pending' 供管理后台 getReports 过滤；老记录没有该字段，后台按 pending 处理
  let duplicate = false;
  try {
    let existed = [];
    if (DEDUPE_BY_REPORTER) {
      const res = await db.collection(REPORTS)
        .where({ postId: postId, reporterOpenid: openid })
        .limit(1)
        .get();
      existed = (res && res.data) || [];
    }

    if (existed.length) {
      duplicate = true;
    } else {
      await db.collection(REPORTS).add({
        data: {
          _openid: openid,          // 属于谁：便于按举报人追溯
          postId: postId,
          reporterOpenid: openid,
          reason: reason,
          desc: desc,
          status: 'pending',        // pending 待处理 / done 已处理（后台 ignore / violate）
          createTime: Date.now(),
          // 快照：举报时的帖子状态与作者，复核时不必回溯帖子当前值
          postSnapshot: {
            status: post.status || '',
            authorOpenid: authorOpenid,
            authorName: post.authorName || '',
            title: String(post.title || '').slice(0, 50)
          }
        }
      });
    }
  } catch (err) {
    if (isMissingCollection(err)) {
      try {
        await ensureReports(db);
        await db.collection(REPORTS).add({
          data: {
            _openid: openid,
            postId: postId,
            reporterOpenid: openid,
            reason: reason,
            desc: desc,
            status: 'pending',
            createTime: Date.now()
          }
        });
      } catch (retryErr) {
        return {
          ok: false,
          code: errCodeOf(retryErr) || 'REPORT_WRITE_FAILED',
          message: '举报记录写入失败，请确认 reports 集合已创建'
        };
      }
    } else {
      return {
        ok: false,
        code: errCodeOf(err) || 'REPORT_WRITE_FAILED',
        message: String((err && err.message) || '举报记录写入失败')
      };
    }
  }

  /* ---------- 4. 举报权重：只有「新的举报人」才 +1 ----------
     用原子自增（_.inc）避开并发丢更新，再回读一次拿到权威权重做阈值判定。
     回读失败就退回「原权重 + 1」，宁可少记一次审查也不要让举报流程报错。 */
  const beforeWeight = weightOf(post);
  let weight = beforeWeight;
  let weightFailed = false;

  if (!duplicate) {
    // 老帖子还没有 reportWeight 字段（v1.2.0 之前发布）：直接赋值 1，不依赖 $inc 对缺失字段的行为
    const hasWeightField = typeof post.reportWeight === 'number';
    try {
      await db.collection(POSTS).doc(postId).update({
        data: { reportWeight: hasWeightField ? _.inc(1) : 1 }
      });
      try {
        const fresh = await db.collection(POSTS).doc(postId).get();
        const freshWeight = weightOf((fresh && fresh.data) || null);
        weight = freshWeight > 0 ? freshWeight : beforeWeight + 1;
      } catch (readErr) {
        weight = beforeWeight + 1;
      }
    } catch (err) {
      weightFailed = true;
      console.error('[report] 举报权重自增失败 postId=' + postId + '：', err && err.message);
    }
  }

  /* ---------- 5. 自动审查 + 警告 ----------
     触发条件同时要求「本次是新举报」且「帖子还没处于 auditing」：
     帖子在审查期间不会因为又来一个举报人而重复记警告（详见 5.2 的 auditDismissed 例外）。 */
  const status = String(post.status || '');
  let auditing = false;
  let warning = null;

  const reachedThreshold = !duplicate && !weightFailed && weight >= REPORT_WEIGHT_AUDIT_THRESHOLD;

  if (reachedThreshold && status !== 'auditing') {
    // 5.1 打码下架：已结束的帖子保持 ended（避免已下架内容被重新翻出来打码展示）
    if (status !== 'ended') {
      try {
        await db.collection(POSTS).doc(postId).update({
          data: {
            status: 'auditing',
            auditReason: reason,
            auditSource: 'auto-report',
            auditTime: Date.now()
          }
        });
        auditing = true;
      } catch (err) {
        console.error('[report] 帖子置为审核中失败 postId=' + postId + '：', err && err.message);
      }
    }

    // 5.2 发帖人警告 +1（>= 2 次即封禁）
    //     例外：这条帖子曾经被管理员「忽略」并恢复上线（auditDismissed），
    //     说明人工已判定过无违规，再次触顶只下架复查，不再重复扣警告。
    if (post.auditDismissed) {
      console.log('[report] 帖子曾被人工判定无违规，本次仅下架不记警告 postId=' + postId);
    } else {
      warning = await bumpAuthorWarning(db, authorOpenid);
      if (warning.banned) {
        console.log('[report] 自动封禁 openid=' + authorOpenid + ' warningCount=' + warning.warningCount);
      }
    }
  }

  const result = {
    ok: true,
    status: auditing ? 'auditing' : status,
    duplicate: duplicate,
    reportWeight: weight,
    warningCount: warning ? warning.warningCount : null,
    banned: warning ? warning.banned : false
  };

  // 已结束的帖子：举报照旧记录（权重 / 警告仍然生效），但不需要再改状态
  if (status === 'ended') {
    result.message = '举报已记录，该内容已结束展示';
  }

  return result;
};

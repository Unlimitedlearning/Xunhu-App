// cloudfunctions/report/index.js
// 作用：举报落库 + 帖子打码。
//   reports 集合：一条举报一行（postId / reporterOpenid / reason / desc / createTime）
//   posts   集合：把被举报的帖子 status 改成 'auditing'（大厅打码、不可点入，等人工复核）
//
// 为什么放服务端：
//   1) 举报人可以改别人的帖子吗？客户端没权限（posts 仅创建者可写），必须服务端改；
//   2) reporterOpenid 只从 cloud.getWXContext() 取，客户端伪造不了举报人；
//   3) reports 集合可以完全不对客户端开放（权限设「所有用户不可读写」），举报内容不外泄。
//
// 调用方式（小程序端）：store.submitReport({ postId, reason, desc })
//   返回 { ok: true, status: 'auditing', duplicate: boolean }

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const POSTS = 'posts';
const REPORTS = 'reports';

// 与小程序端 utils/constants.js 的 REPORT_CATEGORIES 保持一致
const REPORT_REASONS = ['虚假信息', '违规内容', '骚扰谩骂', '其他'];
const MAX_DESC = 200;

// 同一 openid 对同一帖子只记一条举报（防止刷举报把帖子反复拉进审查）
const DEDUPE_BY_REPORTER = true;

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

  // 2. 不能举报自己的帖子（自己下架请走「管理申请」/ 删除，不该进审查队列）
  const authorOpenid = post.authorOpenid || post._openid || '';
  if (authorOpenid === openid) {
    return { ok: false, code: 'SELF_REPORT', message: '不能举报自己发布的内容' };
  }

  // 3. 写举报记录（去重：同一人对同一帖子只留一条）
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

  // 4. 帖子进入审查：status -> 'auditing'（大厅打码 + 不可点入，详情页直接拦截）
  //    已结束的帖子保持 ended（举报记录仍然留存，供人工判断）
  const currentStatus = post.status || '';
  if (currentStatus === 'ended') {
    return {
      ok: true,
      status: 'ended',
      duplicate: duplicate,
      message: '举报已记录，该内容已结束展示'
    };
  }

  if (currentStatus !== 'auditing') {
    try {
      await db.collection(POSTS).doc(postId).update({
        data: {
          status: 'auditing',
          auditReason: reason,
          auditTime: Date.now()
        }
      });
    } catch (err) {
      return {
        ok: false,
        code: errCodeOf(err) || 'POST_UPDATE_FAILED',
        message: '举报已记录，但帖子状态更新失败',
        duplicate: duplicate
      };
    }
  }

  return { ok: true, status: 'auditing', duplicate: duplicate };
};

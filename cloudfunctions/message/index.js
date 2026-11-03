// cloudfunctions/message/index.js
// 个人消息中心唯一读入口（v1.4.0）：messages（个人通知） + announcements（全体公告）。
//
// 为什么必须有这个云函数：
//   messages 与 announcements 两个集合对客户端都是「所有用户不可读写」，
//   前端直接 get 一定 -502003；而且「一条通知属于谁」的判定不能放在客户端（改包就能看别人的）。
//
// 【归属判定】写入端（cloudfunctions/admin）会同时写两个字段：
//   _openid  ：云开发标准用户标识（首选）
//   toOpenid ：兜底字段（服务端 SDK 不允许显式写 _openid 时降级使用）
//   这里两次查询后按 _id 去重，所以两种写法都能读到，也不会重复。
//
// 调用方式（小程序端 store.*）：
//   { action: 'list' }                     -> { ok, messages, announcements, latestAnnouncementTime }
//   { action: 'read', messageId }          -> { ok, messageId, isRead:true }  只能标记自己的
//   { action: 'badge' }                    -> { ok, unreadCount, latestAnnouncementTime }
//
// 已读口径：
//   · 个人通知：messages.isRead 落库（服务端写，客户端零权限）；
//   · 全体公告：没有「按人已读」概念，客户端本地存 lastReadMessageTime，
//     最新公告时间比它新就算有新公告（badge 只回时间，判定在 utils/store.js）。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const MESSAGES = 'messages';
const ANNOUNCEMENTS = 'announcements';

// 与小程序端 constants.MESSAGE_LIST_LIMIT / ANNOUNCEMENT_LIST_LIMIT 同值
const MESSAGE_LIST_LIMIT = 20;
const ANNOUNCEMENT_LIST_LIMIT = 3;
// 未读统计最多扫多少条（个人通知量级很小，正常远小于这个数）
const UNREAD_SCAN_LIMIT = 100;

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1;
}

// 归属字段判定：两个字段任一等于当前 openid 即视为「我的」
function ownerOf(doc) {
  return String((doc && (doc._openid || doc.toOpenid)) || '');
}

/**
 * 查询「属于我」的消息（两个归属字段各查一次，按 _id 去重、按时间倒序）
 * @param {object} db
 * @param {string} openid
 * @param {number} limit 每个字段最多取多少条
 * @param {object} extraWhere 附加条件（如 { isRead: false }）
 */
async function queryOwnMessages(db, openid, limit, extraWhere) {
  const conditions = [
    Object.assign({ _openid: openid }, extraWhere || {}),
    Object.assign({ toOpenid: openid }, extraWhere || {})
  ];

  const batches = await Promise.all(conditions.map(async function (where) {
    try {
      const res = await db.collection(MESSAGES)
        .where(where)
        .orderBy('createTime', 'desc')
        .limit(limit)
        .get();
      return (res && res.data) || [];
    } catch (err) {
      if (isMissingCollection(err)) return []; // 还没人收到过通知
      // 单个归属字段查询失败（比如字段不存在）不影响另一条通道
      console.warn('[message] messages 查询失败 where=' + JSON.stringify(where) + '：', err && err.message);
      return [];
    }
  }));

  const seen = {};
  const list = [];
  batches[0].concat(batches[1]).forEach(function (doc) {
    if (!doc || !doc._id || seen[doc._id]) return;
    if (ownerOf(doc) !== openid) return; // 双保险：绝不把别人的通知发出去
    seen[doc._id] = true;
    list.push(doc);
  });

  list.sort(function (a, b) {
    return (Number(b.createTime) || 0) - (Number(a.createTime) || 0);
  });

  return list;
}

// 对外只下发展示需要的字段，openid 永不外泄
function pickMessage(doc) {
  return {
    id: doc._id || '',
    type: String(doc.type || 'system'),
    title: String(doc.title || ''),
    content: String(doc.content || ''),
    isRead: !!doc.isRead,
    createTime: Number(doc.createTime) || 0
  };
}

function pickAnnouncement(doc) {
  return {
    id: doc._id || '',
    title: String(doc.title || ''),
    content: String(doc.content || ''),
    createTime: Number(doc.createTime) || 0
  };
}

// 最新公告时间（红点判定用；没有公告就回 0）
async function latestAnnouncementTime(db) {
  try {
    const res = await db.collection(ANNOUNCEMENTS)
      .orderBy('createTime', 'desc')
      .limit(1)
      .get();
    const doc = ((res && res.data) || [])[0];
    return doc ? (Number(doc.createTime) || 0) : 0;
  } catch (err) {
    if (isMissingCollection(err)) return 0;
    console.warn('[message] 公告查询失败：', err && err.message);
    return 0;
  }
}

/* ---------------- action: list ---------------- */
async function handleList(db, openid) {
  const [messages, announcements, announcementTime] = await Promise.all([
    queryOwnMessages(db, openid, MESSAGE_LIST_LIMIT),
    (async function () {
      try {
        const res = await db.collection(ANNOUNCEMENTS)
          .orderBy('createTime', 'desc')
          .limit(ANNOUNCEMENT_LIST_LIMIT)
          .get();
        return (res && res.data) || [];
      } catch (err) {
        if (isMissingCollection(err)) return [];
        console.warn('[message] 公告列表读取失败：', err && err.message);
        return [];
      }
    })(),
    latestAnnouncementTime(db)
  ]);

  return {
    ok: true,
    messages: messages.slice(0, MESSAGE_LIST_LIMIT).map(pickMessage),
    announcements: announcements.map(pickAnnouncement),
    latestAnnouncementTime: announcementTime
  };
}

/* ---------------- action: read ----------------
 * 只能标记「自己的」通知：先按 _id 取文档，再校验归属字段。
 * 不校验归属就直接 update，等于让任何人传一个 id 就能改别人的已读状态。
 */
async function handleRead(db, openid, payload) {
  const messageId = String(payload.messageId || '').trim();
  if (!messageId) {
    return { ok: false, code: 'MESSAGE_ID_REQUIRED', message: '缺少消息 ID' };
  }

  let doc = null;
  try {
    const res = await db.collection(MESSAGES).doc(messageId).get();
    doc = (res && res.data) || null;
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: false, code: 'MESSAGE_NOT_FOUND', message: '消息不存在' };
    }
    console.warn('[message] 读取消息失败 id=' + messageId + '：', err && err.message);
    return { ok: false, code: 'MESSAGE_NOT_FOUND', message: '消息不存在' };
  }

  if (!doc) {
    return { ok: false, code: 'MESSAGE_NOT_FOUND', message: '消息不存在' };
  }
  if (ownerOf(doc) !== openid) {
    console.warn('[message] 越权标记已读被拦截 openid=' + openid + ' id=' + messageId);
    return { ok: false, code: 'FORBIDDEN', message: '无权操作该消息' };
  }

  if (doc.isRead) {
    return { ok: true, messageId: messageId, isRead: true }; // 幂等：已读就不重复写库
  }

  try {
    await db.collection(MESSAGES).doc(messageId).update({
      data: { isRead: true, readTime: Date.now() }
    });
  } catch (err) {
    return {
      ok: false,
      code: errCodeOf(err) || 'MESSAGE_UPDATE_FAILED',
      message: '标记已读失败，请稍后重试'
    };
  }

  return { ok: true, messageId: messageId, isRead: true };
}

/* ---------------- action: badge ---------------- */
async function handleBadge(db, openid) {
  const [unread, announcementTime] = await Promise.all([
    queryOwnMessages(db, openid, UNREAD_SCAN_LIMIT, { isRead: false }),
    latestAnnouncementTime(db)
  ]);

  return {
    ok: true,
    unreadCount: unread.length,
    latestAnnouncementTime: announcementTime
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

  if (action === 'list' || !action) return handleList(db, openid);
  if (action === 'read') return handleRead(db, openid, payload);
  if (action === 'badge') return handleBadge(db, openid);

  return { ok: false, code: 'UNKNOWN_ACTION', message: '未知 action：' + action };
};

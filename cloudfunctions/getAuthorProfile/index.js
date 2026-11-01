// cloudfunctions/getAuthorProfile/index.js
// 详情页「发布者名片」数据接口：一次调用同时返回 users 里的简历 + reviews 里的匿名评价统计。
//
// 为什么必须放服务端、且必须一次查完：
//   1) reviews 集合权限是「所有用户不可读写」，客户端根本读不到，只能由服务端聚合后匿名下发；
//   2) 详情页如果「先查 users 再查 reviews」就是两次网络往返（都要新建连接 + 安全校验），
//      合并成一个云函数后只有一次 callFunction，弱网下详情页打开速度差别很明显；
//   3) 返回字段白名单化：联系方式 / 学号 / 评价人 openid 一律不下发，
//      前端拿不到任何身份线索，评价天然匿名。
//
// 调用方式（小程序端 store.fetchAuthorProfile）：
//   { postId: 'xxx' }            -> 优先用数据库里这条帖子的 authorOpenid（不信任客户端传的身份）
//   { authorOpenid: 'xxx' }      -> 没有 postId 时的兜底（如分享直达还没拿到帖子）
//
// 返回结构（字段永远存在，不会 undefined，前端可直接 bind）：
//   {
//     ok: true,
//     author: { nickname, avatarText, resume, hasResume },
//     review: { total, goodCount, rate, showRate, minCount, pendingText, anonymousName,
//               list: [{ rating, ratingText, content, createTime }] }
//   }
//
// 【数据兜底】没填简历 -> resume 为 ''、hasResume 为 false；没收到评价 -> list 为 []、total 为 0。
// 任何一个集合不存在 / 查询报错，都降级成空值返回，绝不把 undefined 丢给前端。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const USERS = 'users';
const REVIEWS = 'reviews';
const POSTS = 'posts';

// 与小程序端 utils/constants.js 保持一致（云函数目录独立打包，拿不到前端文件）
const REVIEW_MIN_COUNT = 3;                                   // 评价少于 3 条不展示具体好评率
const REVIEW_PENDING_TEXT = '满意度统计中...';
const REVIEW_ANONYMOUS_NAME = '某同学';                        // 评价人一律匿名
const RECENT_LIMIT = 3;                                       // 详情页只展示最近 3 条文字评价
const RECENT_SCAN = 10;                                       // 多取几条，过滤掉「只打分没写字」的还能凑够 3 条
const RESUME_MAX = 300;                                       // 与 users 集合的简历上限一致
const NICKNAME_MAX = 20;

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1 || message.indexOf('collection not exists') > -1;
}

// users 文档归属的 openid（新文档有 _openid，旧文档只有 openid 字段）
function ownerOf(doc) {
  return (doc && (doc._openid || doc.openid)) || '';
}

function emptyAuthor() {
  return { nickname: '', avatarText: '', resume: '', hasResume: false };
}

function emptyReview() {
  return {
    total: 0,
    goodCount: 0,
    rate: 0,
    showRate: false,
    minCount: REVIEW_MIN_COUNT,
    pendingText: REVIEW_PENDING_TEXT,
    anonymousName: REVIEW_ANONYMOUS_NAME,
    list: []
  };
}

/* ---------------- 帖子 -> 发帖人 openid ---------------- */

/**
 * 优先用数据库里帖子的 authorOpenid，而不是客户端传来的值：
 * 这样客户端无法拿别人的 openid 去「查指定人的名片」，只能查真实存在的帖子的作者。
 * 帖子查不到（本地草稿 / 已被删）时才回退到入参，且入参为空就返回空名片。
 */
async function resolveAuthorOpenid(db, payload) {
  const postId = String(payload.postId || '').trim();
  const fallback = String(payload.authorOpenid || '').trim();
  if (!postId) return fallback;

  try {
    const res = await db.collection(POSTS).doc(postId).get();
    const post = (res && res.data) || null;
    if (post) {
      return String(post.authorOpenid || post._openid || '').trim() || fallback;
    }
  } catch (err) {
    // 草稿 / 已删除 / 集合不存在：不阻断详情页，走入参兜底
    console.warn('[getAuthorProfile] 读取帖子失败 id=' + postId + ' code=' + errCodeOf(err) + '：', err && err.message);
  }
  return fallback;
}

/* ---------------- users：昵称 + 简历（白名单，不含联系方式/学号） ---------------- */

async function queryUsersSafe(db, where) {
  try {
    const res = await db.collection(USERS).where(where).limit(5).get();
    return (res && res.data) || [];
  } catch (err) {
    if (isMissingCollection(err)) return [];
    throw err;
  }
}

async function loadAuthor(db, openid) {
  if (!openid) return emptyAuthor();

  let docs = [];
  try {
    // 兼容两种历史写法：_openid（新）与 openid 字段（旧版脏数据）
    const batches = await Promise.all([
      queryUsersSafe(db, { _openid: openid }),
      queryUsersSafe(db, { openid: openid })
    ]);
    const seen = {};
    batches[0].concat(batches[1]).forEach(function (doc) {
      if (!doc || !doc._id || seen[doc._id]) return;
      if (ownerOf(doc) !== openid) return; // 只认属于这个 openid 的文档
      seen[doc._id] = true;
      docs.push(doc);
    });
    // 有多条脏数据时取最新一条（与 user 云函数的保留策略一致）
    docs.sort(function (a, b) {
      return ((b.updateTime || b.createTime) || 0) - ((a.updateTime || a.createTime) || 0);
    });
  } catch (err) {
    console.warn('[getAuthorProfile] 读取 users 失败 code=' + errCodeOf(err) + '：', err && err.message);
    return emptyAuthor();
  }

  const doc = docs[0] || null;
  if (!doc) return emptyAuthor();

  const nickname = String(doc.nickname || '').trim().slice(0, NICKNAME_MAX);
  const resume = String(doc.resume || '').trim().slice(0, RESUME_MAX);

  return {
    nickname: nickname,
    avatarText: nickname ? nickname.slice(0, 1) : '',
    resume: resume,            // 没填就是 ''
    hasResume: resume !== ''
  };
}

/* ---------------- reviews：匿名评价统计 + 最近 3 条文字评价 ---------------- */

async function loadReviews(db, openid) {
  const empty = emptyReview();
  if (!openid) return empty;

  const where = { revieweeOpenid: openid };

  try {
    const [totalRes, goodRes, listRes] = await Promise.all([
      db.collection(REVIEWS).where(where).count(),
      db.collection(REVIEWS).where({ revieweeOpenid: openid, rating: 1 }).count(),
      db.collection(REVIEWS).where(where).orderBy('createTime', 'desc').limit(RECENT_SCAN).get()
    ]);

    const total = (totalRes && totalRes.total) || 0;
    const goodCount = (goodRes && goodRes.total) || 0;

    // 匿名：只回 rating / ratingText / content / createTime，
    // reviewId、reviewerOpenid、revieweeOpenid 一律不下发（前端拿不到任何评价人线索）
    const list = ((listRes && listRes.data) || [])
      .filter(function (doc) {
        return String((doc && doc.content) || '').trim() !== '';
      })
      .slice(0, RECENT_LIMIT)
      .map(function (doc) {
        const isGood = doc.rating === 1;
        return {
          rating: isGood ? 1 : 0,
          ratingText: isGood ? '满意' : '不满意',
          content: String(doc.content || '').trim(),
          createTime: doc.createTime || 0
        };
      });

    return {
      total: total,
      goodCount: goodCount,
      // 好评率云端算好，前端只负责展示（< 3 条时前端显示「满意度统计中...」）
      rate: total ? Math.round((goodCount / total) * 100) : 0,
      showRate: total >= REVIEW_MIN_COUNT,
      minCount: REVIEW_MIN_COUNT,
      pendingText: REVIEW_PENDING_TEXT,
      anonymousName: REVIEW_ANONYMOUS_NAME,
      list: list
    };
  } catch (err) {
    // 集合不存在 = 还没人评价过，属正常情况；其它错误也只降级，不影响名片其它部分
    if (!isMissingCollection(err)) {
      console.warn('[getAuthorProfile] 读取 reviews 失败 code=' + errCodeOf(err) + '：', err && err.message);
    }
    return empty;
  }
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const payload = event || {};
  const db = cloud.database();

  const authorOpenid = await resolveAuthorOpenid(db, payload);

  // 留一条访问日志：名片查不到内容时（对方没填简历 / 从没收到评价）能一眼看出是「查的无此人」还是「查不到」
  console.log('[getAuthorProfile] viewer=' + (ctx.OPENID || '') + ' author=' + (authorOpenid || '(empty)'));

  if (!authorOpenid) {
    return {
      ok: false,
      code: 'AUTHOR_REQUIRED',
      message: '缺少发帖人信息',
      author: emptyAuthor(),
      review: emptyReview()
    };
  }

  // 两次批量查询并行发起：昵称/简历 与 评价统计互不依赖
  const results = await Promise.all([
    loadAuthor(db, authorOpenid),
    loadReviews(db, authorOpenid)
  ]);

  return {
    ok: true,
    author: results[0],
    review: results[1]
  };
};

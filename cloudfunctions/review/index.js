// cloudfunctions/review/index.js
// 双向评价（防互刷）：reviews 集合的唯一读写入口。
//
// 为什么全部放服务端：
//   1) 「A 对 B 永远只有一条」必须由服务端做查重 + 覆盖更新，客户端 upsert 改包就能刷出无数条；
//   2) 关系校验要联查 applications（accepted）+ posts（ended），客户端没有读别人申请的权限；
//   3) reviews 权限设「所有用户不可读写」后，评价人 openid 不会外泄，匿名展示才真匿名。
//
// 内容安全：评价正文同样是引流重灾区，因此 handleSubmit 在写库前用「本地违禁词库 + 净化匹配」再校一遍，
//   命中即拒绝（文案「评价内容包含违规词汇，请修改」）。词库与 cleanText 是第三份副本，
//   改 utils/constants.js 的词库时要同步 cloudfunctions/publish 与本文件。
//
// 集合字段：reviewId / postId / reviewerOpenid / revieweeOpenid / rating(1满意,0不满意) / content / createTime
//
// 调用方式（小程序端 store.*）：
//   { action: 'submit', postId, revieweeOpenid, rating, content }  -> { ok, created, review }
//   { action: 'get', revieweeOpenid }                              -> { ok, review | null }   我对 TA 的旧评价（弹窗回填）
//   { action: 'mine' }                                             -> { ok, list }            我发出的全部评价（任务页标记「已评价」）
//   { action: 'received' }                                         -> { ok, total, goodCount, rate, list }  我收到的评价（个人页，匿名）

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const REVIEWS = 'reviews';
const APPLICATIONS = 'applications';
const POSTS = 'posts';

// 与小程序端 utils/constants.js 的 REVIEW_CONTENT_MAX 保持一致
const MAX_CONTENT = 50;
const LIST_LIMIT = 100; // 我发出的评价一次最多回传 100 条（任务页只用来做「是否已评价」标记）
const RECEIVED_LIMIT = 20; // 个人页展示的评价条数

// 违禁词命中时的统一文案（与小程序端同一句，前端直接 toast err.message）
const RISKY_MESSAGE = '评价内容包含违规词汇，请修改';

/* ==================== DEV_TEST 自测后门（仅限本地联调） ====================
 * 为什么存在：只有一台设备/一个微信号，无法真开双账号，临时允许「自己评价自己」跑通闭环。
 * 【风险提示】本开关一旦「上传并部署」，就会对当前云环境里所有真实用户生效：
 *   任何人只要在自己已结束的帖子上有一条 accepted 申请，就能刷自己的好评率。
 *   所以：只能用测试环境（或验收完立即改回 false 重新部署），发布/提审前必须恢复为 false。
 * 撤回：把下面一行改为 false 并重新部署，或 `git checkout -- cloudfunctions/review/index.js` 后重部署。
 */
const DEV_ALLOW_SELF_REVIEW = false;

/* ---------------- 违禁词库（与 utils/constants.js、cloudfunctions/publish 同值副本） ----------------
 * 云函数目录独立打包，拿不到小程序端文件，所以必须复制一份；改一处要同步三处。
 * 硬性约定：所有词必须是纯文本（不含空格 / 标点 / 大写），因为匹配前会删掉文本里的空白和标点。
 */

// 学术舞弊
const ACADEMIC_FRAUD = ['代课', '代考', '代写', '替课', '替考', '论文买卖', '包过', '抢手'];

// 诈骗与违规交易
const FRAUD_SCAM = ['刷单', '兼职赚钱', '日结', '博彩', '赌球', '网贷', '裸贷', '套现', '洗钱'];

// 隐私侵害
const PRIVACY_VIOLATION = ['裸聊', '约炮', '开房', '身份证出售', '查开房记录'];

const FORBIDDEN_WORDS = [].concat(ACADEMIC_FRAUD, FRAUD_SCAM, PRIVACY_VIOLATION);

// 拼音兜底词库（防 dai ke / daikao 这类拼音规避），键 = 全拼小写，值 = 中文词
const PINYIN_FORBIDDEN_MAP = {
  daike: '代课',
  daikao: '代考',
  daixie: '代写',
  tike: '替课',
  tikao: '替考',
  lunwenmaimai: '论文买卖',
  baoguo: '包过',
  qiangshou: '抢手',
  shuadan: '刷单',
  jianzhizhuanqian: '兼职赚钱',
  rijie: '日结',
  bocai: '博彩',
  duqiu: '赌球',
  wangdai: '网贷',
  luodai: '裸贷',
  taoxian: '套现',
  xiqian: '洗钱',
  luoliao: '裸聊',
  yuepao: '约炮',
  kaifang: '开房',
  shenfenzhengchushou: '身份证出售',
  chakaifangjilu: '查开房记录'
};

// 零宽字符 / BOM：会把「代课」拆成「代\u200B课」，先干掉
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200D\u2060\uFEFF]/g;

// 全角 ASCII（ａ-ｚ ０-９ ！ 等）转半角：防「ｄａｉｋｅ」这类全角规避
const FULLWIDTH_ASCII_REGEX = /[\uFF01-\uFF5E]/g;

// 标点正则：优先用 Unicode 属性类 \p{P}，老运行时（不支持 u 标志）回退到手写全标点字符集
const FALLBACK_PUNCTUATION_REGEX = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。、；：？！…—–～·「」『』【】《》〈〉（）〔〕［］｛｝“”‘’＄％＃＆＊＠＾＿＋－＝｜＼／＜＞※→←↑↓☆★○●◎◇◆□■△▲▽▼§¶©®™°±×÷]/g;

const CLEAN_TEXT_REGEX = (function () {
  try {
    return new RegExp('[\\s\\p{P}]', 'gu');
  } catch (err) {
    return FALLBACK_PUNCTUATION_REGEX;
  }
})();

/**
 * 净化文本：小写 + 全角转半角 + 删零宽字符 + 删所有空白与标点
 * 例：「代 课」「代*考」「ｄａｉｋｅ」净化后都能被词库命中
 */
function cleanText(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(FULLWIDTH_ASCII_REGEX, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .replace(INVISIBLE_CHARS_REGEX, '')
    .replace(CLEAN_TEXT_REGEX, '');
}

/**
 * 违禁词校验（写入数据库前的最后一道）
 * @return {{pass: boolean, word?: string, type?: string}}
 */
function checkTextViolation(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return { pass: true };

  // 1. 中文词库
  for (let i = 0; i < FORBIDDEN_WORDS.length; i++) {
    const word = FORBIDDEN_WORDS[i];
    if (cleaned.indexOf(word) > -1) {
      return { pass: false, word: word, type: 'word' };
    }
  }

  // 2. 拼音兜底
  const pinyinList = Object.keys(PINYIN_FORBIDDEN_MAP);
  for (let j = 0; j < pinyinList.length; j++) {
    const pinyin = pinyinList[j];
    if (cleaned.indexOf(pinyin) > -1) {
      return { pass: false, word: PINYIN_FORBIDDEN_MAP[pinyin], type: 'pinyin' };
    }
  }

  return { pass: true };
}

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1;
}

// reviews 集合首次使用时自动创建（省得手工去控制台建；安全规则仍需控制台设置）
async function ensureReviews(db) {
  try {
    await db.createCollection(REVIEWS);
  } catch (err) {
    // 已存在属正常情况
  }
}

// 只回传必要字段：默认不带 _openid，避免任何身份线索被顺手带到前端
function pickReview(doc) {
  return {
    reviewId: doc.reviewId || doc._id,
    postId: doc.postId || '',
    reviewerOpenid: doc.reviewerOpenid || '',
    revieweeOpenid: doc.revieweeOpenid || '',
    rating: doc.rating === 1 ? 1 : 0,
    content: doc.content || '',
    createTime: doc.createTime || 0
  };
}

/* ---------------- 关系校验：两人必须存在 accepted 的申请关系 ---------------- */

/**
 * 在「这场帖子」上找到 A、B 之间的 accepted 申请（谁是申请人谁是发帖人都算）
 * 同时带上 postId 过滤：防止拿「别处的旧合作」去评价一条毫不相干的帖子
 */
async function findAcceptedApplication(db, postId, a, b) {
  const base = { postId: postId, status: 'accepted' };
  const [asApplicant, asReceiver] = await Promise.all([
    db.collection(APPLICATIONS).where(Object.assign({}, base, { applicantId: a, receiverId: b })).limit(1).get(),
    db.collection(APPLICATIONS).where(Object.assign({}, base, { applicantId: b, receiverId: a })).limit(1).get()
  ]);

  const rows = ((asApplicant && asApplicant.data) || []).concat((asReceiver && asReceiver.data) || []);
  return rows.length ? rows[0] : null;
}

/* ---------------- 写入：A 对 B 查重后 add / update ---------------- */

async function handleSubmit(db, openid, payload) {
  const postId = String(payload.postId || '').trim();
  const revieweeOpenid = String(payload.revieweeOpenid || '').trim();
  const rating = Number(payload.rating);
  // 校验用完整原文（先截断再检查会让「超长填充 + 违禁词」这种写法漏检），入库再截到 50 字
  const rawContent = String(payload.content || '').trim();
  const content = rawContent.slice(0, MAX_CONTENT);

  if (!revieweeOpenid) {
    return { ok: false, code: 'REVIEWEE_REQUIRED', message: '缺少被评价人' };
  }
  // DEV_TEST：临时放行「自己评价自己」，单账号联调专用，恢复时取消注释即可
  if (!DEV_ALLOW_SELF_REVIEW && revieweeOpenid === openid) {
    return { ok: false, code: 'SELF_REVIEW', message: '不能评价自己' };
  }
  if (rating !== 1 && rating !== 0) {
    return { ok: false, code: 'RATING_INVALID', message: '请选择满意或不满意' };
  }
  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子 ID' };
  }

  // 0. 违禁词校验：放在所有 DB 查询之前（便宜的纯内存判断，命中直接拒，不浪费一次读）
  //    评价正文是黑产引流重灾区（「加 V 代写」「日结 私聊」），不能只靠发帖那层过滤
  const violation = checkTextViolation(rawContent);
  if (!violation.pass) {
    console.warn('[review] 评价内容命中违禁词 word=' + violation.word + ' type=' + violation.type + ' reviewer=' + openid);
    return { ok: false, code: 'CONTENT_RISKY', message: RISKY_MESSAGE };
  }

  // 1. 两人必须在这条帖子上存在 accepted 的申请关系（服务端判定，改包绕不过）
  let application = null;
  try {
    application = await findAcceptedApplication(db, postId, openid, revieweeOpenid);
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: false, code: 'COLLECTION_MISSING', message: 'applications 集合不存在，请先运行 initDb' };
    }
    return { ok: false, code: errCodeOf(err) || 'RELATION_CHECK_FAILED', message: '申请关系校验失败，请稍后重试' };
  }
  if (!application) {
    return { ok: false, code: 'RELATION_REQUIRED', message: '你们还没有在这次寻呼中达成合作，无法评价' };
  }

  // 2. 帖子必须已结束（与任务页「结束才出现评价按钮」同一判定）
  let post = null;
  try {
    const res = await db.collection(POSTS).doc(postId).get();
    post = (res && res.data) || null;
  } catch (err) {
    post = null;
  }
  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '该帖子不存在或已被删除' };
  }
  // DEV_TEST：临时允许「帖子未结束」也能评价（原校验见下方 if 块，恢复时把 !DEV_ALLOW_SELF_REVIEW 去掉即可）
  if (!DEV_ALLOW_SELF_REVIEW && String(post.status || '') !== 'ended') {
    return { ok: false, code: 'POST_NOT_ENDED', message: '该寻呼还未结束，结束后才能评价' };
  }

  // reviewId 用「评价人_被评价人」拼出来：天然唯一、更新后也不变
  const reviewId = openid + '_' + revieweeOpenid;
  const createTime = Date.now();
  const latest = { postId: postId, rating: rating, content: content, createTime: createTime };
  const newDoc = {
    _openid: openid, // 归属：便于按评价人追溯（权限已锁死，前端读不到）
    reviewId: reviewId,
    reviewerOpenid: openid,
    revieweeOpenid: revieweeOpenid,
    rating: rating,
    content: content,
    postId: postId,
    createTime: createTime
  };

  let created = false;
  try {
    // 3. 核心查重：reviewerOpenid == A 且 revieweeOpenid == B
    const existed = await db.collection(REVIEWS)
      .where({ reviewerOpenid: openid, revieweeOpenid: revieweeOpenid })
      .limit(1)
      .get();
    const rows = (existed && existed.data) || [];

    if (rows.length) {
      // 已存在 -> 覆盖更新，只改「最新一次」的四个字段，reviewId / 双方 openid 永不改
      await db.collection(REVIEWS).doc(rows[0]._id).update({ data: latest });
    } else {
      // 不存在 -> 新增
      created = true;
      await db.collection(REVIEWS).add({ data: newDoc });
    }
  } catch (err) {
    if (isMissingCollection(err)) {
      // 集合还没建：建完重试一次（安全规则仍需控制台设置）
      await ensureReviews(db);
      try {
        created = true;
        await db.collection(REVIEWS).add({ data: newDoc });
      } catch (retryErr) {
        return {
          ok: false,
          code: errCodeOf(retryErr) || 'REVIEW_WRITE_FAILED',
          message: '评价写入失败，请确认 reviews 集合已创建'
        };
      }
    } else {
      return {
        ok: false,
        code: errCodeOf(err) || 'REVIEW_WRITE_FAILED',
        message: '评价写入失败，请稍后重试'
      };
    }
  }

  return {
    ok: true,
    created: created,
    review: {
      reviewId: reviewId,
      postId: postId,
      reviewerOpenid: openid,
      revieweeOpenid: revieweeOpenid,
      rating: rating,
      content: content,
      createTime: createTime
    }
  };
}

/* ---------------- 读取：单条（弹窗回填） ---------------- */

async function handleGet(db, openid, payload) {
  const revieweeOpenid = String(payload.revieweeOpenid || '').trim();
  if (!revieweeOpenid) {
    return { ok: false, code: 'REVIEWEE_REQUIRED', message: '缺少被评价人' };
  }

  try {
    const res = await db.collection(REVIEWS)
      .where({ reviewerOpenid: openid, revieweeOpenid: revieweeOpenid })
      .limit(1)
      .get();
    const doc = ((res && res.data) || [])[0] || null;
    return { ok: true, review: doc ? pickReview(doc) : null };
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: true, review: null }; // 集合没建 = 还没人评价过
    }
    return { ok: false, code: errCodeOf(err) || 'REVIEW_QUERY_FAILED', message: '评价读取失败' };
  }
}

/* ---------------- 读取：我发出的（任务页标记已评价） ---------------- */

async function handleMine(db, openid) {
  try {
    const res = await db.collection(REVIEWS)
      .where({ reviewerOpenid: openid })
      .orderBy('createTime', 'desc')
      .limit(LIST_LIMIT)
      .get();
    return { ok: true, list: ((res && res.data) || []).map(pickReview) };
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: true, list: [] };
    }
    return { ok: false, code: errCodeOf(err) || 'REVIEW_QUERY_FAILED', message: '评价读取失败' };
  }
}

/* ---------------- 读取：我收到的（个人页满意度，匿名） ---------------- */

async function handleReceived(db, openid) {
  const where = { revieweeOpenid: openid };

  try {
    const [totalRes, goodRes, listRes] = await Promise.all([
      db.collection(REVIEWS).where(where).count(),
      db.collection(REVIEWS).where({ revieweeOpenid: openid, rating: 1 }).count(),
      db.collection(REVIEWS).where(where).orderBy('createTime', 'desc').limit(RECEIVED_LIMIT).get()
    ]);

    const total = (totalRes && totalRes.total) || 0;
    const goodCount = (goodRes && goodRes.total) || 0;

    // 匿名：列表里只给 rating / content / createTime，reviewId 与评价人身份一律不下发
    const list = ((listRes && listRes.data) || []).map(function (doc) {
      return {
        rating: doc.rating === 1 ? 1 : 0,
        content: doc.content || '',
        createTime: doc.createTime || 0
      };
    });

    return {
      ok: true,
      total: total,
      goodCount: goodCount,
      // 好评率由云端算好，前端只负责展示（< 3 条时前端显示「满意度统计中...」）
      rate: total ? Math.round((goodCount / total) * 100) : 0,
      list: list
    };
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: true, total: 0, goodCount: 0, rate: 0, list: [] };
    }
    return { ok: false, code: errCodeOf(err) || 'REVIEW_QUERY_FAILED', message: '评价读取失败' };
  }
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;

  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '拿不到 openid，请从小程序端调用' };
  }

  const payload = event || {};
  const action = String(payload.action || 'submit');
  const db = cloud.database();

  if (action === 'get') return handleGet(db, openid, payload);
  if (action === 'mine') return handleMine(db, openid);
  if (action === 'received') return handleReceived(db, openid);
  return handleSubmit(db, openid, payload);
};

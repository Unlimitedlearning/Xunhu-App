// cloudfunctions/user/index.js
// 作用：用户资料（昵称 / 校区 / 学号 / 简历 / 联系方式）的读写 + 账号注销，全部落在云端 users 集合。
//
// 为什么放在服务端而不是客户端直接读写：
//   1) 身份的最终把关必须在服务端：openid 只从 cloud.getWXContext() 取，客户端传什么都不认；
//   2) 客户端若传 openid 就能冒用他人资料，这里统一用 openid 过滤，不给任何伪造机会；
//   3) users 集合不需要对客户端开放，天然免疫 -502003 这类安全规则问题。
//
// 【唯一性保证】一个 openid 在 users 里只能有一条文档：
//   保存前先 where({ _openid }).get() 查；
//   - 查到 -> doc(id).update()（绝不 add）
//   - 查不到 -> 才 add（并显式写入 _openid）
//   顺带清理历史脏数据：旧版本用无脑 add 可能写出多条，这里保留最新一条、删除多余行。
//
// 调用方式（均需先「上传并部署」本云函数）：
//   { action: 'get' }                        -> { ok, data: doc | null }
//   { action: 'save', profile: {...} }        -> { ok, data: doc }
//     profile 白名单：nickname / campus / studentId / resume / contact
//     campus（v1.6.0）：必填，只能是 CAMPUS_LIST 里的值，非法值直接拒
//     nickname（v1.8.0）：全局唯一，被其他用户占用时回 NICKNAME_TAKEN（查重排除自己）
//   { action: 'deleteAccount' }               -> { ok, removed: {...}, role, blacklisted }  注销账号 + 级联清理
//     【v1.6.5】按 role 分流：banned -> 写 blacklist（banned_user_deleted）；user -> 不写（可重新注册）
//     【v1.9.1 合规修复】以前只把帖子 status 改成 deleted（正文 / 标签 / 联系方式仍躺在库里），
//       现在改为**物理删除**：posts（我发的全部）+ post_contacts + 级联 applications / reviews / messages。
//       顺序：先收集 postIds -> 删附属数据 -> 删帖子 -> 删 users（帖子删完就再也查不到它名下的数据了）。
//
// 【v1.6.0】资料字段：campus（校区）是唯一的地域属性；早前版本的身份背书字段已下线，
// 老文档里的残留值由下方 LEGACY_FIELDS 统一清除（不再接收、不再下发）。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTION = 'users';
// 黑名单（v1.6.0）：只存 openid + 原因，客户端零权限
const BLACKLIST = 'blacklist';
// 注销 / 封禁后命中黑名单时的统一拦截文案
const BLACKLIST_MESSAGE = '该账号已注销或已被限制使用，如有疑问请联系管理员邮箱：xunhu_app@qq.com';
// 黑名单写入需要权限的集合（客户端不可读写）
const POSTS = 'posts';
const APPLICATIONS = 'applications';
const REVIEWS = 'reviews';
const MESSAGES = 'messages';
const POST_CONTACTS = 'post_contacts';

// 学号校验：广工 10 位，以 31 开头
// 与小程序端 utils/constants.js 的 STUDENT_ID_REGEX 保持一致（云函数目录独立，无法 require 小程序文件）
const STUDENT_ID_REGEX = /^31\d{8}$/;

/* ---------------- 校区（v1.6.0） ----------------
 * 取值域与小程序端 constants.CAMPUS_LIST 同值：改一处必须同步另一处。
 * 为什么校验必须放服务端：picker 只是体验层，改包可以传任意字符串 ——
 *   一旦脏值进库，「按校区展示 / 匹配」就失效，甚至能把广告文本塞进展示字段。
 * 注：CAMPUS_OPTIONS（picker 当前开放项）只在客户端生效，服务端只认 CAMPUS_LIST。
 */
const CAMPUS_LIST = ['揭阳', '大学城', '东风路', '龙洞', '番禺', '沙河'];
const CAMPUS_INVALID_MESSAGE = '校区不在可选范围内，请重新选择';

/* ---------------- 历史字段清除（v1.6.0） ----------------
 * users 已不再收集「真实姓名」类信息，只存 campus。
 * 老文档里可能还留着那个字段：读出时剔除（不下发客户端），保存时物理删除（库里不留已不收集的数据）。
 * 全项目字段名只在这里出现一次 —— 确认线上库里已无该字段后，把 LEGACY_FIELDS 改成空数组即可，
 * 这两个小函数也可以一并删掉。
 */
const LEGACY_FIELDS = ['realName'];

// 读出时剔除历史字段（传 null 也安全）
function dropLegacyFields(doc) {
  if (!doc) return doc;
  for (let i = 0; i < LEGACY_FIELDS.length; i++) {
    delete doc[LEGACY_FIELDS[i]];
  }
  return doc;
}

// 生成「物理删除历史字段」的更新命令（只对确实有值的文档生效）
function buildLegacyRemoval(db, primary) {
  const removal = {};
  for (let i = 0; i < LEGACY_FIELDS.length; i++) {
    const field = LEGACY_FIELDS[i];
    if (primary && primary[field] !== undefined) {
      removal[field] = db.command.remove();
    }
  }
  return removal;
}

/* ---------------- 用户角色（v1.1.0 角色底座） ----------------
 * role 只允许三个值：
 *   user   普通用户（默认；首次建档时由服务端写入）
 *   banned 封禁：publish / review 会在写入前拦住
 *   admin  管理员（目前无后台，仅先在数据层预留，写入只能走控制台）
 * 【安全红线】role 绝不能由客户端指定：
 *   - normalize() 是白名单，只取 nickname / studentId / resume / contact，客户端传的 role 根本进不了 payload；
 *   - 更新已有资料时，role 一律以库里的旧值为准（缺字段时补 user），客户端传 'admin' 也不生效。
 */
const ROLE_USER = 'user';
const ROLE_BANNED = 'banned';
const ROLE_ADMIN = 'admin';
const VALID_ROLES = [ROLE_USER, ROLE_BANNED, ROLE_ADMIN];

/* ---------------- 违禁词库 + 净化匹配（与 utils/constants.js 同值副本） ----------------
 * 为什么写在云函数里：个人主体调不了微信机审（msgSecCheck 48001），本地词库就是主防线，
 *   而客户端能被改包绕过，所以必须再有一份落在服务端。
 * 简历 / 技能描述会在详情页「发布者名片」里公开展示，是黑产发广告（「加 V 代写」「日结 私聊」）的高发区，
 * 因此昵称 / 简历 / 联系方式必须与发帖同一标准校验。
 * 硬性约定：词条必须是纯文本（无空格 / 无标点 / 全小写）—— 匹配前会把文本里的空白与标点全删掉。
 * 改词库时必须同步：utils/constants.js、cloudfunctions/publish、cloudfunctions/review、本文件。
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
const FALLBACK_PUNCTUATION_REGEX = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~，。、；：？！…—–～·「」『』【】《》〈〉（）〔〕［］｛｝“”‘’＄％＃＆＊＠＾＿＋－＝｜＼／＜＞※→←↑↓☆★○●◎◇◆□■△▲▽▼§¶©®™°±×÷]/g;

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

// 文档归属的 openid（新文档有 _openid，旧文档只有 openid 字段）
function ownerOf(doc) {
  return (doc && (doc._openid || doc.openid)) || '';
}

// 文档里的角色：非法/缺失一律当 user（历史文档没有 role 字段，按普通用户处理）
function pickRole(doc) {
  const role = String((doc && doc.role) || '').toLowerCase();
  return VALID_ROLES.indexOf(role) > -1 ? role : ROLE_USER;
}

// 字段白名单：只允许这几个字段被客户端写入。
// 注意：role / warningCount / _openid / openid / createTime 都不在白名单里 —— 这就是「客户端改不了角色」的根本保证。
// 【v1.6.0】白名单是正面清单：不在列表里的字段（含任何历史字段）传上来也会被丢掉。
function normalize(input) {
  const source = input || {};
  return {
    nickname: String(source.nickname || '').trim(),
    campus: String(source.campus || '').trim(),
    studentId: String(source.studentId || '').trim(),
    resume: String(source.resume || '').trim(),
    contact: String(source.contact || '').trim()
  };
}

function isMissingCollection(err) {
  const code = String((err && (err.errCode || err.code)) || '');
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1 || message.indexOf('collection not exists') > -1;
}

// 集合不存在时按需创建（首次部署即可用，不用手动去控制台建集合）
async function ensureCollection(db) {
  try {
    await db.createCollection(COLLECTION);
  } catch (err) {
    // 已存在属正常情况，忽略
  }
}

async function querySafe(db, where) {
  try {
    const res = await db.collection(COLLECTION).where(where).limit(100).get();
    return (res && res.data) || [];
  } catch (err) {
    if (isMissingCollection(err)) return [];
    throw err;
  }
}

/**
 * 找出属于这个 openid 的所有资料文档（可能 >1 条：旧版本重复 add 留下的脏数据）
 * 同时兼容两种写入方式：
 *   _openid : 微信云开发标准的用户标识字段（新版本按这个存）
 *   openid  : 上一版把 openid 当普通字段存的文档（历史兼容，避免同一个人出现两条）
 */
async function findAll(db, openid) {
  const batches = await Promise.all([
    querySafe(db, { _openid: openid }),
    querySafe(db, { openid: openid })
  ]);

  const seen = {};
  const docs = [];
  batches[0].concat(batches[1]).forEach(function (doc) {
    if (!doc || !doc._id || seen[doc._id]) return;
    seen[doc._id] = true;
    docs.push(doc);
  });

  // 最新的一条排在前面（保留它）
  docs.sort(function (a, b) {
    const at = a.updateTime || a.createTime || 0;
    const bt = b.updateTime || b.createTime || 0;
    return bt - at;
  });

  return docs;
}

// 首次写入资料：显式带上 _openid 作为唯一键；
// 若运行环境不允许服务端写 _openid，降级成只用 openid 字段（唯一性仍由 findAll 查询保证）
async function createProfile(db, payload, openid) {
  const doc = Object.assign({}, payload, {
    _openid: openid, // 唯一键（服务端写入，客户端不可伪造）
    openid: openid,  // 兼容字段：历史文档 / 调试识别
    role: ROLE_USER, // 角色默认值：新建用户一律 user，后端才有权改成 banned / admin
    // 违规警告次数（v1.2.0 风控）：只有 report / admin 云函数会 +1，客户端字段白名单里没有它
    warningCount: 0,
    createTime: Date.now()
  });

  let res;
  try {
    res = await db.collection(COLLECTION).add({ data: doc });
  } catch (err) {
    if (isMissingCollection(err)) {
      await ensureCollection(db);
    } else {
      const message = String((err && err.message) || '');
      if (message.indexOf('_openid') === -1) throw err;
      // 降级：不写 _openid，只靠 openid 字段
      const fallback = Object.assign({}, payload, {
        openid: openid,
        role: ROLE_USER,
        warningCount: 0,
        createTime: Date.now()
      });
      const retry = await db.collection(COLLECTION).add({ data: fallback });
      return { id: retry._id, data: Object.assign({ _id: retry._id }, fallback) };
    }
    res = await db.collection(COLLECTION).add({ data: doc });
  }

  return { id: res._id, data: Object.assign({ _id: res._id }, doc) };
}

/* ---------------- 黑名单（v1.6.0） ----------------
 * 用途：注销 / 封禁后，login / user.save / publish / application 在入口直接拒服务。
 * 查询失败一律按「未命中」处理（fail-open）：users 记录已在注销时删除，
 * 黑名单只是第二道锁，不应该因为集合没建就把正常用户全拦在外面。
 */
async function isBlacklisted(db, openid) {
  const value = String(openid || '').trim();
  if (!value) return false;
  try {
    const res = await db.collection(BLACKLIST).where({ openid: value }).limit(1).get();
    return !!((res && res.data) || []).length;
  } catch (err) {
    if (isMissingCollection(err)) return false;
    console.warn('[user] blacklist 查询失败，按未命中处理：', err && err.message);
    return false;
  }
}

// 写入黑名单（已存在则更新原因与时间，绝不重复插一条）
async function addToBlacklist(db, openid, reason, source) {
  const doc = {
    openid: String(openid || ''),
    reason: String(reason || 'user_deleted'),
    source: String(source || 'self'),
    createTime: Date.now()
  };

  try {
    const existed = await db.collection(BLACKLIST)
      .where({ openid: doc.openid })
      .limit(1)
      .get();
    const row = ((existed && existed.data) || [])[0];
    if (row && row._id) {
      await db.collection(BLACKLIST).doc(row._id).update({
        data: { reason: doc.reason, source: doc.source, updateTime: doc.createTime }
      });
      return true;
    }
    await db.collection(BLACKLIST).add({ data: doc });
    return true;
  } catch (err) {
    if (!isMissingCollection(err)) {
      console.error('[user] 写入 blacklist 失败：', err && err.message);
      return false;
    }
  }

  // 集合不存在：建一次后重试（安全规则仍需控制台设置为「所有用户不可读写」）
  try {
    await db.createCollection(BLACKLIST);
    await db.collection(BLACKLIST).add({ data: doc });
    return true;
  } catch (retryErr) {
    console.error('[user] 建集合后仍写入 blacklist 失败：', retryErr && retryErr.message);
    return false;
  }
}

/* ---------------- 级联清理工具（账号注销） ----------------
 * where().remove() 一次能删的条数有上限，所以统一走「每轮取 100 个 _id → 按 _id in 删」的循环。
 * 任何一轮出错都只记日志并停止（不能让某一集合报错把整个注销流程搞挂），
 * 调用方拿到的 removed 是「确已删除」的条数。
 */
async function removeByWhere(db, collection, where, label) {
  const _ = db.command;
  let removed = 0;

  for (let round = 0; round < 50; round++) {
    let ids = [];
    try {
      const res = await db.collection(collection).where(where).limit(100).field({ _id: true }).get();
      ids = ((res && res.data) || []).map(function (doc) {
        return doc && doc._id;
      }).filter(Boolean);
    } catch (err) {
      if (!isMissingCollection(err)) {
        console.warn('[user][deleteAccount] 读取 ' + label + ' 失败，停止本轮清理：', err && err.message);
      }
      return removed;
    }

    if (!ids.length) return removed;

    try {
      await db.collection(collection).where({ _id: _.in(ids) }).remove();
      removed += ids.length;
    } catch (err) {
      console.error('[user][deleteAccount] 删除 ' + label + ' 失败：', err && err.message);
      return removed;
    }
  }

  return removed;
}

// 按「某个字段 in 一批值」删除（值多了自动分批：in 数组过长会被服务端拒绝）
async function removeByValues(db, collection, field, values, label) {
  const _ = db.command;
  const list = (values || []).filter(Boolean);
  let removed = 0;

  for (let i = 0; i < list.length; i += 100) {
    const where = {};
    where[field] = _.in(list.slice(i, i + 100));
    removed += await removeByWhere(db, collection, where, label);
  }

  return removed;
}

// 按 _id 批量物理删除（分批 100，单批出错只记日志）
async function removeByIds(db, collection, ids, label) {
  const _ = db.command;
  let removed = 0;

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      await db.collection(collection).where({ _id: _.in(chunk) }).remove();
      removed += chunk.length;
    } catch (err) {
      console.error('[user][deleteAccount] 删除 ' + label + ' 失败：', err && err.message);
    }
  }

  return removed;
}

/**
 * 【v1.9.1 合规】注销前先收集「我发的所有帖子 _id」
 * 为什么必须先取到：posts 一旦物理删除，就再也查不出这些帖子名下的申请 / 评价 / 联系方式，
 *   结果就是库里留下一堆指向已消失帖子的孤儿数据（合规清理等于没做完）。
 * 兼容两种历史写法：新帖子写 authorOpenid，老帖子只有 _openid。
 */
async function collectPostIds(db, openid) {
  const wheres = [{ authorOpenid: openid }, { _openid: openid }];
  const seen = {};
  const ids = [];

  for (let w = 0; w < wheres.length; w++) {
    for (let page = 0; page < 20; page++) {
      let rows = [];
      try {
        const res = await db.collection(POSTS)
          .where(wheres[w])
          .skip(page * 100)
          .limit(100)
          .field({ _id: true })
          .get();
        rows = (res && res.data) || [];
      } catch (err) {
        if (!isMissingCollection(err)) {
          console.warn('[user][deleteAccount] 读取帖子失败：', err && err.message);
        }
        break;
      }

      rows.forEach(function (doc) {
        const id = doc && doc._id;
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
      });

      if (rows.length < 100) break;
    }
  }

  return ids;
}

/**
 * 【v1.9.1 合规】物理删除我发的所有帖子
 * 旧实现只写 status = 'deleted'：标题 / 正文 / 标签 / 联系方式全留在 posts 里，
 *   「注销」只是把大厅入口关掉，数据一条没删 —— 与隐私政策 3.5「永久删除全部资料与历史记录」不符。
 * 现在：按 _id 批量删干净，再按归属字段补扫一遍（防收集 ID 期间刚好有人发新帖）。
 */
async function deletePosts(db, openid, postIds) {
  let removed = await removeByIds(db, POSTS, postIds, 'posts');
  removed += await removeByWhere(db, POSTS, { authorOpenid: openid }, 'posts(authorOpenid)');
  removed += await removeByWhere(db, POSTS, { _openid: openid }, 'posts(_openid)');
  return removed;
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;
  const action = (event && event.action) || 'get';

  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '拿不到 openid，请从小程序端调用' };
  }

  const db = cloud.database();

  if (action === 'get') {
    try {
      const docs = await findAll(db, openid);
      const doc = docs[0] || null;
      // 【v1.6.0】历史字段不下发给客户端
      dropLegacyFields(doc);
      return { ok: true, data: doc };
    } catch (err) {
      return {
        ok: false,
        code: (err && (err.errCode || err.code)) || '',
        message: String((err && err.message) || '')
      };
    }
  }

  if (action === 'save') {
    // 【v1.6.0】黑名单拦截：已注销 / 已封禁的账号不允许再写资料
    if (await isBlacklisted(db, openid)) {
      console.warn('[user][save] 命中黑名单，拒绝保存资料：', openid);
      return { ok: false, code: 'ACCOUNT_BLOCKED', message: BLACKLIST_MESSAGE };
    }

    // 【role 不可写】客户端若在 profile 里夹带 role（含 role:'admin'），一律丢弃。
    // normalize() 已经是白名单，这里再显式删一次，防止以后有人把实现改成 Object.assign 时漏掉。
    if (event && event.profile && typeof event.profile === 'object') {
      delete event.profile.role;
    }

    const data = normalize(event && event.profile);
    if (!data.nickname) {
      return { ok: false, code: 'NICKNAME_REQUIRED', message: '昵称不能为空' };
    }
    if (data.nickname.length > 20) {
      return { ok: false, code: 'NICKNAME_TOO_LONG', message: '昵称最多 20 个字' };
    }

    // 【校区】v1.6.0 必填门槛：只接受白名单里的值。
    // 前端 picker 只能选 CAMPUS_OPTIONS，这里再校验一次：改包 / 旧版客户端绕过前端时仍会被拒。
    if (!data.campus) {
      return { ok: false, code: 'CAMPUS_REQUIRED', message: '请选择你所在的校区' };
    }
    if (CAMPUS_LIST.indexOf(data.campus) === -1) {
      return { ok: false, code: 'CAMPUS_INVALID', message: CAMPUS_INVALID_MESSAGE };
    }
    if (data.resume.length > 300) {
      return { ok: false, code: 'RESUME_TOO_LONG', message: '简历最多 300 个字' };
    }

    // 【违禁词】昵称 + 简历 + 联系方式 拼成全文再做净化匹配（便宜的纯内存判断，放在所有 DB 查询之前）。
    // 为什么必须拼一起：把「代」写在昵称、「课」写在简历里，分字段查永远命中不了。
    // 这块是绝对防线：前端已拦过一道，但改包就能绕，服务端不认客户端是否做过校验。
    const localText = [data.nickname, data.resume, data.contact].join(' ');
    const violation = checkTextViolation(localText);
    if (!violation.pass) {
      console.warn('[user] 资料命中违禁词 word=' + violation.word + ' type=' + violation.type + ' openid=' + openid);
      return {
        ok: false,
        code: 'CONTENT_RISKY',
        message: '保存失败：包含违规词汇' + (violation.word ? '【' + violation.word + '】' : '') + '，请修改后重试。',
        hitWord: violation.word
      };
    }

    const payload = Object.assign({}, data, { updateTime: Date.now() });

    // 学号：必填 + 格式门禁（前端已校验，这里再校验一次，防止直接调接口绕过）
    if (!STUDENT_ID_REGEX.test(data.studentId)) {
      return {
        ok: false,
        code: 'STUDENT_ID_INVALID',
        message: '学号格式不合法，拒绝保存（请输入广工学号）'
      };
    }

    // 双向唯一：一个学号只能绑一个 openid
    // （反方向「一个 openid 只能绑一个学号」由「一个 openid 只有一条文档」天然保证）
    try {
      const sameStudentDocs = await querySafe(db, { studentId: data.studentId });
      const occupiedByOthers = sameStudentDocs.filter(function (doc) {
        return ownerOf(doc) !== openid;
      });
      if (occupiedByOthers.length) {
        return {
          ok: false,
          code: 'STUDENT_ID_TAKEN',
          message: '该学号已被绑定，请勿盗用他人学号'
        };
      }
    } catch (err) {
      return {
        ok: false,
        code: (err && (err.errCode || err.code)) || '',
        message: String((err && err.message) || '学号查重失败')
      };
    }

    /* 【v1.8.0 昵称查重】昵称是帖子 / 申请 / 评价里唯一展示的身份标识，
     * 允许重名会让「冒充发帖人」变得无法追责（内测已发现该风险），所以昵称必须全局唯一。
     * 为什么必须排除自己：只改简历 / 校区时昵称不变，不能因为「自己占了自己的名字」而保存失败。
     * 为什么放服务端：前端校验改包即可绕过，这里才是唯一有效的关卡。
     * 注：nickname 已在 normalize() 里 trim，所以库里的值与查询值口径一致。
     */
    try {
      const sameNicknameDocs = await querySafe(db, { nickname: data.nickname });
      const occupiedByOthers = sameNicknameDocs.filter(function (doc) {
        return ownerOf(doc) !== openid;
      });
      if (occupiedByOthers.length) {
        console.warn('[user][save] 昵称已被占用，拒绝保存：', openid, 'nickname=', data.nickname);
        return { ok: false, code: 'NICKNAME_TAKEN', message: '该昵称已被占用，请换一个吧' };
      }
    } catch (err) {
      return {
        ok: false,
        code: (err && (err.errCode || err.code)) || '',
        message: String((err && err.message) || '昵称查重失败')
      };
    }

    try {
      const docs = await findAll(db, openid);

      // 已有资料 -> 只 update，绝不 add
      if (docs.length) {
        const primary = docs[0];

        // 【角色不可改】以库里的值为准；历史文档没有 role 时顺手补默认 user（一次懒迁移）
        const existingRole = pickRole(primary);
        if (primary.role !== existingRole) {
          payload.role = existingRole;
        }

        // 【学号锁】已「合法绑定」过学号时，忽略本次请求传入的 studentId，强制用库里的旧值。
        // 前端 disabled 只是体验，这里才是真正的锁：抓包改包也改不掉。
        // 注：旧值不合法（早期选填时随手填的脏数据）时不锁，否则用户将永远无法修正。
        const boundStudentId = String(primary.studentId || '').trim();
        const studentIdLocked = STUDENT_ID_REGEX.test(boundStudentId);
        if (studentIdLocked && payload.studentId !== boundStudentId) {
          console.warn('[user] 学号已绑定，忽略请求中的新学号：', openid, '->', boundStudentId);
          payload.studentId = boundStudentId;
        }

        // 【历史字段清理】写入时顺手物理删除：不再收集的数据不该继续躺在库里
        Object.assign(payload, buildLegacyRemoval(db, primary));

        await db.collection(COLLECTION).doc(primary._id).update({ data: payload });

        // 清理历史重复行（只删自己的 openid，且只保留最新一条）
        let removed = 0;
        for (let i = 1; i < docs.length; i++) {
          try {
            await db.collection(COLLECTION).doc(docs[i]._id).remove();
            removed++;
          } catch (err) {
            // 删不掉不影响主记录，记一笔就好
            console.warn('[user] 清理重复资料失败：', docs[i]._id, err && err.message);
          }
        }

        return {
          ok: true,
          data: Object.assign({}, primary, payload),
          removed: removed,
          studentIdLocked: studentIdLocked
        };
      }

      // 没有资料 -> 首次 add（唯一键写入成功后立即复查一次，防连点造成的并发重复行）
      const created = await createProfile(db, payload, openid);
      const verified = await findAll(db, openid);
      let removed = 0;
      for (let i = 0; i < verified.length; i++) {
        if (verified[i]._id === created.id) continue;
        try {
          await db.collection(COLLECTION).doc(verified[i]._id).remove();
          removed++;
        } catch (err) {
          console.warn('[user] 并发重复资料清理失败：', verified[i]._id, err && err.message);
        }
      }

      return { ok: true, data: created.data, removed: removed };
    } catch (err) {
      return {
        ok: false,
        code: (err && (err.errCode || err.code)) || '',
        message: String((err && err.message) || '')
      };
    }
  }

  // 【v1.6.0】账号注销（合规必需）/ 【v1.6.5】按「是否被封禁」分流
  //   普通用户主动注销：只删数据，**不写黑名单** —— 同一个微信号之后登录就是全新用户；
  //   被封禁用户注销：写黑名单留住违规记录（reason = banned_user_deleted），
  //     否则「违规 -> 注销 -> 重新注册」就能把永封洗掉。
  //   role 只从库里读，客户端传什么都不信（与 save 同一条约定）。
  if (action === 'deleteAccount') {
    let role = ROLE_USER;
    try {
      const existed = await findAll(db, openid);
      if (existed && existed[0]) role = String(existed[0].role || ROLE_USER).toLowerCase();
    } catch (err) {
      console.warn('[user][deleteAccount] 读取 role 失败，按普通用户处理：', err && err.message);
    }

    const isBanned = role === ROLE_BANNED;
    let blacklisted = false;

    if (isBanned) {
      blacklisted = await addToBlacklist(db, openid, 'banned_user_deleted', 'self');
      if (!blacklisted) {
        // 违规记录没留住就不往下删：否则封禁能被「注销 + 重新注册」洗掉
        return {
          ok: false,
          code: 'BLACKLIST_WRITE_FAILED',
          message: '注销失败，请确认 blacklist 集合已创建后重试'
        };
      }
    }

    const removed = { users: 0, posts: 0, applications: 0, reviews: 0, messages: 0, contacts: 0 };

    /* 0) 先把我名下所有帖子 _id 记下来：
     *    帖子删掉之后，applications / reviews / post_contacts 里指向它的记录就再也定位不到了。*/
    const postIds = await collectPostIds(db, openid);
    console.log('[user][deleteAccount] openid=' + openid + ' 待清理帖子数=' + postIds.length);

    /* 1) 帖子附属数据并行清理（互不依赖，减少整体耗时，避免云函数超时）：
     *    · 申请：我发出的 / 我收到的 / 我的帖子上别人交的
     *    · 评价：我写的 / 我收到的 / 我的帖子上产生的
     *    · 通知：发给我 / 我创建的
     *    · 联系方式：我写的 + 挂在我帖子上的（_id = postId）*/
    const results = await Promise.all([
      removeByWhere(db, APPLICATIONS, { applicantId: openid }, 'applications(applicantId)'),
      removeByWhere(db, APPLICATIONS, { receiverId: openid }, 'applications(receiverId)'),
      removeByWhere(db, APPLICATIONS, { _openid: openid }, 'applications(_openid)'),
      removeByValues(db, APPLICATIONS, 'postId', postIds, 'applications(postId)'),
      removeByWhere(db, REVIEWS, { reviewerOpenid: openid }, 'reviews(reviewer)'),
      removeByWhere(db, REVIEWS, { revieweeOpenid: openid }, 'reviews(reviewee)'),
      removeByValues(db, REVIEWS, 'postId', postIds, 'reviews(postId)'),
      removeByWhere(db, MESSAGES, { _openid: openid }, 'messages(_openid)'),
      removeByWhere(db, MESSAGES, { toOpenid: openid }, 'messages(toOpenid)'),
      removeByWhere(db, POST_CONTACTS, { authorOpenid: openid }, 'post_contacts(author)'),
      removeByValues(db, POST_CONTACTS, '_id', postIds, 'post_contacts(_id=postId)')
    ]);

    removed.applications = results[0] + results[1] + results[2] + results[3];
    removed.reviews = results[4] + results[5] + results[6];
    removed.messages = results[7] + results[8];
    removed.contacts = results[9] + results[10];

    // 2) 物理删除我发的所有帖子（旧实现只改 status，正文一直留在库里）
    removed.posts = await deletePosts(db, openid, postIds);

    // 3) 最后删 users 资料（含历史重复行）：资料是「人的最后一条痕迹」，放最后删更好排障
    try {
      const docs = await findAll(db, openid);
      for (let i = 0; i < docs.length; i++) {
        try {
          await db.collection(COLLECTION).doc(docs[i]._id).remove();
          removed.users++;
        } catch (err) {
          console.warn('[user][deleteAccount] 删除资料失败：', docs[i]._id, err && err.message);
        }
      }
    } catch (err) {
      console.warn('[user][deleteAccount] 读取资料失败：', err && err.message);
    }

    console.log('[user][deleteAccount] openid=' + openid + ' role=' + role + ' blacklisted=' + blacklisted + ' 完成：', JSON.stringify(removed));
    return { ok: true, removed: removed, role: role, blacklisted: blacklisted };
  }

  // 对外公开信息已下线：详情页不再展示学号徽章，因此不保留任何「跨用户读别人资料」的接口
  // （少一个接口，少一个被枚举的攻击面；要恢复请在服务端加 accepted 关系校验）
  return { ok: false, code: 'UNKNOWN_ACTION', message: '未知 action：' + action };
};

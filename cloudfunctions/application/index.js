// cloudfunctions/application/index.js
// 作用：申请的**唯一读写入口** —— apply（申请）/ updateStatus（同意·拒绝）/ list（联查列表）。
//
// 为什么必须收到云函数（这是本次真机两个 Bug 的共同根因）：
//   1) 「同意 / 拒绝」是**收帖人**去改**申请人创建**的文档。以前前端直接 doc(id).update()，
//      权限完全依赖控制台里那条 applications 自定义安全规则；规则一有偏差就 -502003，
//      而前端只能看到一个「操作失败，请稍后重试」，无法分辨是权限、网络还是越权。
//      现在把判定写进代码：只有 doc.receiverId === 当前 openid 才能改，报错也有明确 code。
//   2) 客户端直写还留下一个越权漏洞：申请人自己的 _openid 满足写规则，可以把自己的申请
//      status 直接改成 accepted 白拿发帖人联系方式。收进云函数后这条通道彻底关掉
//      （控制台把 applications 的 write 置 false，见 BETA_CHECKLIST）。
//   3) 申请人昵称 / 简历 / 附言要和 users 联查，而 users 对客户端「所有用户不可读写」，
//      前端不可能自己联查，只能由服务端拼好整张卡片再下发。
//
// 调用方式（小程序端 utils/store.js 已封装，页面不要直接 callFunction）：
//   { action: 'apply', postId, applyNote }
//     -> { ok: true, id, status: 'pending', reapply }
//   { action: 'updateStatus', applicationId, status: 'accepted' | 'rejected' }
//     -> { ok: true, id, status, statusUpdateTime,
//          applicantName, applicantResume, applicantContact, applicantStudentId }
//        （applicantContact / applicantStudentId 只在 accepted 时有值）
//   { action: 'list' }
//     -> { ok: true, sent: [...], received: [...] }  已联查 posts / users，字段见 handleList
//
// 隐私红线（与 store / task 页一致）：
//   pending / rejected 的申请，**永远不下发**对方的联系方式与完整学号；
//   只有 accepted 才给（此时业务上双方本来就要互相联系）。
// 【v1.3.0 / P0-3】申请文档里不再存联系方式与完整学号（以前 pending 就写进去了，
//   一旦 applications 能被客户端直读，隐私就裸奔）；accepted 时一律现查 users 下发。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const APPLICATIONS = 'applications';
const POSTS = 'posts';
// 发帖人联系方式单独存放在这里（v1.3.0）：_id = postId，客户端「所有用户不可读写」
const POST_CONTACTS = 'post_contacts';
const USERS = 'users';

const STATUS_PENDING = 'pending';
const STATUS_ACCEPTED = 'accepted';
const STATUS_REJECTED = 'rejected';

// 申请附言上限（与小程序端 constants.APPLY_NOTE_MAX 同一值，改一处必须同步另一处）
const APPLY_NOTE_MAX = 100;

// 学号校验：广工 10 位，以 31 开头（与 utils/constants.js、cloudfunctions/user 同值）
const STUDENT_ID_REGEX = /^31\d{8}$/;

const BANNED_MESSAGE = '您的账号因违规已被限制使用';

const MAX_ROWS = 100; // 单次 list 的拉取上限（服务端 SDK 上限 1000，内测量级 100 足够）

/* ---------------- 违禁词库 + 净化匹配（与 utils/constants.js 同值副本） ----------------
 * 为什么申请附言也要查：附言会直接出现在发帖人的屏幕上，是骚扰 / 广告（「加 V 代写」）的高发区。
 * 改词库时必须同步：utils/constants.js、cloudfunctions/publish、cloudfunctions/user、
 *                  cloudfunctions/review、本文件。
 * 词条硬性约定：纯文本（无空格 / 无标点 / 全小写）—— 匹配前会把待检文本的空白与标点全删掉。
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

// 零宽字符 / BOM：会把「代课」拆成「代\u200B课」
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200D\u2060\uFEFF]/g;

// 全角 ASCII（ａ-ｚ ０-９ ！ 等）转半角：防「ｄａｉｋｅ」这类全角规避
const FULLWIDTH_ASCII_REGEX = /[\uFF01-\uFF5E]/g;

// 标点正则：优先用 Unicode 属性类 \p{P}，老运行时不支持 u 标志时回退到手写全标点字符集
const FALLBACK_PUNCTUATION_REGEX = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。、；：？！…—–～·「」『』【】《》〈〉（）〔〕［］｛｝“”‘’＄％＃＆＊＠＾＿＋－＝｜＼／＜＞※→←↑↓☆★○●◎◇◆□■△▲▽▼§¶©®™°±×÷]/g;

const CLEAN_TEXT_REGEX = (function () {
  try {
    return new RegExp('[\\s\\p{P}]', 'gu');
  } catch (err) {
    return FALLBACK_PUNCTUATION_REGEX;
  }
})();

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

  for (let i = 0; i < FORBIDDEN_WORDS.length; i++) {
    const word = FORBIDDEN_WORDS[i];
    if (cleaned.indexOf(word) > -1) {
      return { pass: false, word: word, type: 'word' };
    }
  }

  const pinyinList = Object.keys(PINYIN_FORBIDDEN_MAP);
  for (let j = 0; j < pinyinList.length; j++) {
    const pinyin = pinyinList[j];
    if (cleaned.indexOf(pinyin) > -1) {
      return { pass: false, word: PINYIN_FORBIDDEN_MAP[pinyin], type: 'pinyin' };
    }
  }

  return { pass: true };
}

/* ---------------- 基础工具 ---------------- */

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1 || message.indexOf('collection not exists') > -1;
}

function isMissingDoc(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502004' || message.indexOf('does not exist') > -1 || message.indexOf('not exist') > -1;
}

function uniq(list) {
  const seen = {};
  const out = [];
  (list || []).forEach(function (item) {
    const value = String(item || '').trim();
    if (!value || seen[value]) return;
    seen[value] = true;
    out.push(value);
  });
  return out;
}

// 集合不存在时按需创建（首次部署即可用，不用先去控制台建）
async function ensureCollection(db, name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    // 已存在属正常情况
  }
}

// 文档归属 openid（新文档 _openid，旧文档只有 openid 字段）
function ownerOf(doc) {
  return String((doc && (doc._openid || doc.openid)) || '');
}

/* ---------------- 数据读取 ---------------- */

// 单条帖子（不存在 / 参数非法一律返回 null，不抛错）
async function getPost(db, postId) {
  if (!postId) return null;
  try {
    const res = await db.collection(POSTS).doc(String(postId)).get();
    return (res && res.data) || null;
  } catch (err) {
    if (!isMissingDoc(err)) {
      console.warn('[application] 读取帖子失败 postId=' + postId + ' code=' + errCodeOf(err) + '：', err && err.message);
    }
    return null;
  }
}

// 单条申请
async function getApplication(db, applicationId) {
  if (!applicationId) return null;
  try {
    const res = await db.collection(APPLICATIONS).doc(String(applicationId)).get();
    return (res && res.data) || null;
  } catch (err) {
    console.warn('[application] 读取申请失败 id=' + applicationId + ' code=' + errCodeOf(err) + '：', err && err.message);
    return null;
  }
}

// 条件查一条（集合不存在时当成「没有」）
async function findApplication(db, where) {
  try {
    const res = await db.collection(APPLICATIONS).where(where).limit(1).get();
    return ((res && res.data) || [])[0] || null;
  } catch (err) {
    if (isMissingCollection(err)) return null;
    throw err;
  }
}

// 按条件拉多条
async function queryApplications(db, where) {
  try {
    const res = await db.collection(APPLICATIONS).where(where).orderBy('createTime', 'desc').limit(MAX_ROWS).get();
    return (res && res.data) || [];
  } catch (err) {
    if (isMissingCollection(err)) return [];
    console.warn('[application] 查询申请失败 code=' + errCodeOf(err) + '：', err && err.message);
    return [];
  }
}

/**
 * 读用户资料（兼容 _openid / openid 两种历史写法）
 * 返回 { [openid]: doc }，查不到就是空对象 —— 调用方一律做兜底
 */
async function loadProfiles(db, openids) {
  const map = {};
  const ids = uniq(openids);
  if (!ids.length) return map;

  const _ = db.command;
  const batches = [
    { _openid: _.in(ids) },
    { openid: _.in(ids) }
  ];

  for (let i = 0; i < batches.length; i++) {
    try {
      const res = await db.collection(USERS).where(batches[i]).limit(MAX_ROWS).get();
      ((res && res.data) || []).forEach(function (doc) {
        const key = ownerOf(doc);
        if (!key) return;
        // 同一人多条时保留更新时间最新的一条（与 cloudfunctions/user 的取舍一致）
        const current = map[key];
        if (!current || (doc.updateTime || 0) > (current.updateTime || 0)) map[key] = doc;
      });
    } catch (err) {
      if (!isMissingCollection(err)) {
        console.warn('[application] 联查 users 失败(第 ' + (i + 1) + ' 批) code=' + errCodeOf(err) + '：', err && err.message);
      }
    }
  }

  return map;
}

// 批量读帖子（_id in [...]），返回 { [postId]: doc }
async function loadPosts(db, postIds) {
  const map = {};
  const ids = uniq(postIds);
  if (!ids.length) return map;

  try {
    const res = await db.collection(POSTS).where({ _id: db.command.in(ids) }).limit(MAX_ROWS).get();
    ((res && res.data) || []).forEach(function (doc) {
      if (doc && doc._id) map[doc._id] = doc;
    });
  } catch (err) {
    console.warn('[application] 联查 posts 失败 code=' + errCodeOf(err) + '：', err && err.message);
  }

  return map;
}

/**
 * 批量读发帖人联系方式（v1.3.0 / P0-2）
 * contact 已从 posts 迁到 post_contacts（客户端零权限），只能服务端读；
 * 只给「我发出的、且已同意」的申请用，其它一律不下发。
 * 老帖子还没迁移时回退到 post.contact（调用方自己兜底）。
 */
async function loadContacts(db, postIds) {
  const map = {};
  const ids = uniq(postIds);
  if (!ids.length) return map;

  // 分批 20 条，避免 in 过长
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const res = await db.collection(POST_CONTACTS).where({ _id: db.command.in(chunk) }).limit(20).get();
      ((res && res.data) || []).forEach(function (doc) {
        if (doc && doc._id) map[doc._id] = String(doc.contact || '');
      });
    } catch (err) {
      if (!isMissingCollection(err)) {
        console.warn('[application] 读 post_contacts 失败 code=' + errCodeOf(err) + '：', err && err.message);
      }
      return map; // 集合还不存在：全部走 post.contact 兜底
    }
  }

  return map;
}

// 申请人资料（申请快照优先，缺字段再用 users 里的最新值补）
// 【P0-3】联系方式 / 学号不再信任文档快照（新文档根本不存），一律从 users 现查；
// 老文档里残留的 applicantContact 只作最后的兼容兜底（该集合已对客户端不可读）。
async function resolveApplicant(db, app) {
  const applicantOpenid = String((app && (app.applicantId || app._openid)) || '');
  const profiles = applicantOpenid ? await loadProfiles(db, [applicantOpenid]) : {};
  const profile = profiles[applicantOpenid] || {};

  return {
    applicantOpenid: applicantOpenid,
    nickname: String(app.applicantName || profile.nickname || '').trim(),
    resume: String(app.applicantResume || profile.resume || '').trim(),
    contact: String(profile.contact || app.applicantContact || '').trim(),
    studentId: String(profile.studentId || app.applicantStudentId || '').trim()
  };
}

/* ---------------- apply：提交申请 ---------------- */

async function handleApply(db, openid, event) {
  const postId = String((event && event.postId) || '').trim();
  const applyNote = String((event && event.applyNote) || '').trim();

  console.log('[application][apply] openid=' + openid + ' postId=' + postId + ' noteLen=' + applyNote.length);

  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子信息，请返回详情页重试' };
  }
  // 产品规则：申请附言必填（前端弹窗采集，这里是绕不过的防线，直接调云函数也拦）
  if (!applyNote) {
    return { ok: false, code: 'APPLY_NOTE_REQUIRED', message: '请填写申请附言后再提交' };
  }
  if (applyNote.length > APPLY_NOTE_MAX) {
    return { ok: false, code: 'APPLY_NOTE_TOO_LONG', message: '申请附言最多 ' + APPLY_NOTE_MAX + ' 个字' };
  }

  const violation = checkTextViolation(applyNote);
  if (!violation.pass) {
    console.log('[application][apply] 附言命中违禁词：', violation.word, '(' + violation.type + ')');
    return {
      ok: false,
      code: 'CONTENT_RISKY',
      message: '报名失败：包含违规词汇' + (violation.word ? '【' + violation.word + '】' : '') + '，请修改后重试。',
      hitWord: violation.word
    };
  }

  const post = await getPost(db, postId);
  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '这条信息不存在或已被删除' };
  }

  const postStatus = String(post.status || '');
  if (postStatus !== 'active') {
    console.log('[application][apply] 帖子状态不可申请：', postStatus);
    return {
      ok: false,
      code: 'POST_NOT_ACTIVE',
      message: postStatus === 'ended' ? '该信息已结束，无法再申请' : '该信息正在审查中，暂时无法申请'
    };
  }

  const receiverId = String(post.authorOpenid || post._openid || '');
  if (!receiverId) {
    return { ok: false, code: 'RECEIVER_MISSING', message: '这条信息缺少发帖人信息，无法申请' };
  }
  if (receiverId === openid) {
    return { ok: false, code: 'SELF_APPLY', message: '不能申请自己发布的信息' };
  }

  // 身份：昵称 / 学号 / 联系方式 / 简历 全部取 users 里的真实资料（客户端传什么都不认）
  const profiles = await loadProfiles(db, [openid]);
  const profile = profiles[openid] || {};

  if (String(profile.role || 'user').toLowerCase() === 'banned') {
    console.log('[application][apply] 账号已被封禁，拦截申请：', openid);
    return { ok: false, code: 'ACCOUNT_BANNED', message: BANNED_MESSAGE };
  }

  const applicantName = String(profile.nickname || '').trim();
  const applicantContact = String(profile.contact || '').trim();
  const applicantStudentId = String(profile.studentId || '').trim();
  const applicantResume = String(profile.resume || '').trim();

  if (!applicantName || !applicantContact || !STUDENT_ID_REGEX.test(applicantStudentId)) {
    return {
      ok: false,
      code: 'PROFILE_NOT_READY',
      message: '请先在「我的」页面完善昵称、学号与联系方式后再申请'
    };
  }

  const now = Date.now();
  /* 【P0-3 隐私修复】文档里不再存 applicantContact / applicantStudentId 明文：
     以前这些字段在 pending 状态就写进去了，只要 applications 还能被收帖人直读，
     「同意后才可见」就是摆设。现在：
       - 联系方式 / 学号一律在「同意」后由服务端现查 users 下发（users 对客户端零权限）；
       - 文档里只留展示用的昵称 / 简历 / 附言快照，即使将来权限出现偏差也不泄露隐私。*/
  const snapshot = {
    postId: postId,
    postTitle: String(post.title || ''),
    postStatus: postStatus,
    applicantId: openid,
    applicantName: applicantName,
    applicantResume: applicantResume,
    applyNote: applyNote,
    receiverId: receiverId,
    status: STATUS_PENDING,
    createTime: now,
    statusUpdateTime: 0
  };

  let existed = null;
  try {
    existed = await findApplication(db, { postId: postId, applicantId: openid });
  } catch (err) {
    console.warn('[application][apply] 查重失败，继续尝试写入 code=' + errCodeOf(err) + '：', err && err.message);
  }

  if (existed) {
    const current = String(existed.status || STATUS_PENDING);
    if (current === STATUS_PENDING || current === STATUS_ACCEPTED) {
      return {
        ok: false,
        code: 'ALREADY_APPLIED',
        message: current === STATUS_ACCEPTED
          ? '对方已同意你的申请，请到「任务」页查看联系方式'
          : '你已经申请过这条信息了，请等待对方回复'
      };
    }
    // 之前被拒绝 -> 允许重新申请：复用同一条文档，刷新附言与资料快照
    try {
      await db.collection(APPLICATIONS).doc(existed._id).update({
        data: Object.assign({}, snapshot, {
          reapplyCount: (Number(existed.reapplyCount) || 0) + 1
        })
      });
      console.log('[application][apply] 重新申请，复用文档 id=' + existed._id);
      return { ok: true, id: existed._id, status: STATUS_PENDING, reapply: true };
    } catch (err) {
      console.error('[application][apply] 重新申请写入失败 code=' + errCodeOf(err) + '：', err);
      return { ok: false, code: errCodeOf(err) || 'APPLY_FAILED', message: '申请提交失败，请稍后重试' };
    }
  }

  const doc = Object.assign({}, snapshot, {
    // 显式写 _openid：保留「这条申请归申请人所有」的语义（历史规则与控制台排查都靠它）
    _openid: openid
  });

  try {
    const res = await db.collection(APPLICATIONS).add({ data: doc });
    console.log('[application][apply] 写入成功 id=' + res._id);
    return { ok: true, id: res._id, status: STATUS_PENDING, reapply: false };
  } catch (err) {
    if (!isMissingCollection(err)) {
      console.error('[application][apply] 写入失败 code=' + errCodeOf(err) + '：', err);
      return { ok: false, code: errCodeOf(err) || 'APPLY_FAILED', message: '申请提交失败，请稍后重试' };
    }
    // 集合不存在：建一次后重试
    await ensureCollection(db, APPLICATIONS);
    try {
      const retry = await db.collection(APPLICATIONS).add({ data: doc });
      return { ok: true, id: retry._id, status: STATUS_PENDING, reapply: false };
    } catch (retryErr) {
      console.error('[application][apply] 建集合后重试仍失败：', retryErr);
      return { ok: false, code: errCodeOf(retryErr) || 'APPLY_FAILED', message: '申请提交失败，请稍后重试' };
    }
  }
}

/* ---------------- updateStatus：同意 / 拒绝 ---------------- */

/**
 * 同意后要立刻解锁的联系方式 / 学号（只在 accepted 时下发）
 * 联系方式 / 学号一律从 users 现查（users 对客户端零权限），不再写回申请文档（见 P0-3）。
 * 顺带自愈历史脏数据：早期文档可能没存 applicantName / applicantResume，这里补回。
 */
async function buildDecisionPayload(db, app, status) {
  const applicant = await resolveApplicant(db, app);

  if (status !== STATUS_ACCEPTED) {
    // pending / rejected：联系方式一律不下发
    return {
      applicantName: applicant.nickname,
      applicantResume: applicant.resume,
      applicantContact: '',
      applicantStudentId: ''
    };
  }

  // 自愈：只补空字段，绝不覆盖已有快照。
  // 【P0-3】不再把联系方式 / 学号写回文档：它们只在 accepted 时现查 users 下发，
  // 落库就又多一份明文（历史教训）。
  const patch = {};
  if (!app.applicantName && applicant.nickname) patch.applicantName = applicant.nickname;
  if (!app.applicantResume && applicant.resume) patch.applicantResume = applicant.resume;

  if (Object.keys(patch).length) {
    try {
      await db.collection(APPLICATIONS).doc(app._id).update({ data: patch });
      console.log('[application] 已补全申请文档的历史缺失字段 id=' + app._id + ' 字段=' + Object.keys(patch).join(','));
    } catch (err) {
      console.warn('[application] 补全历史字段失败（不影响本次操作）：', err && err.message);
    }
  }

  return {
    applicantName: applicant.nickname,
    applicantResume: applicant.resume,
    applicantContact: applicant.contact,
    applicantStudentId: applicant.studentId
  };
}

async function handleUpdateStatus(db, openid, event) {
  const applicationId = String((event && event.applicationId) || '').trim();
  const status = String((event && event.status) || '').trim();

  // 真机排障第一现场：把入参原样打出来（前端 dataset 拿不到 id 时会立刻暴露成空串）
  console.log('[application][updateStatus] openid=' + openid +
    ' applicationId=' + (applicationId || '(空)') +
    ' status=' + (status || '(空)'));

  if (!applicationId) {
    return { ok: false, code: 'APPLICATION_ID_REQUIRED', message: '缺少申请信息，请下拉刷新后重试' };
  }
  if (status !== STATUS_ACCEPTED && status !== STATUS_REJECTED) {
    return { ok: false, code: 'STATUS_INVALID', message: '只能同意或拒绝该申请' };
  }

  const app = await getApplication(db, applicationId);
  if (!app) {
    return { ok: false, code: 'APPLICATION_NOT_FOUND', message: '这条申请不存在或已被删除' };
  }

  // 【越权拦截】只有「这条申请的收帖人」能处理
  // 历史文档缺 receiverId 时，用帖子作者兜底判定，避免老数据永远处理不了
  let receiverId = String(app.receiverId || '');
  if (!receiverId) {
    const post = await getPost(db, app.postId);
    receiverId = String((post && (post.authorOpenid || post._openid)) || '');
    if (receiverId) {
      console.log('[application][updateStatus] 历史文档缺少 receiverId，按帖子作者兜底：' + receiverId);
    }
  }

  if (receiverId !== openid) {
    console.warn('[application][updateStatus] 越权拦截：申请 receiverId=' + (receiverId || '(空)') +
      ' 当前 openid=' + openid + ' applicationId=' + applicationId);
    return { ok: false, code: 'NOT_RECEIVER', message: '只有收到申请的人才能处理这条申请' };
  }

  const current = String(app.status || STATUS_PENDING);

  // 幂等：连点 / 重复提交同一结论直接当成功（不报错，也不重复写库）
  if (current === status) {
    const payload = await buildDecisionPayload(db, app, status);
    console.log('[application][updateStatus] 重复提交，按成功处理 id=' + applicationId + ' status=' + status);
    return Object.assign({ ok: true, id: applicationId, status: status, already: true }, payload);
  }

  if (current !== STATUS_PENDING) {
    return {
      ok: false,
      code: 'STATUS_NOT_PENDING',
      message: current === STATUS_ACCEPTED ? '这条申请已经同意过了' : '这条申请已经拒绝过了'
    };
  }

  // 同意前再确认帖子没结束（帖子结束后不该再放新人进来；拒绝不受影响）
  if (status === STATUS_ACCEPTED) {
    const post = await getPost(db, app.postId);
    if (!post) {
      return { ok: false, code: 'POST_NOT_FOUND', message: '这条信息已被删除，无法再同意申请' };
    }
    if (String(post.status || '') === 'ended') {
      return { ok: false, code: 'POST_ENDED', message: '该信息已结束，无法再同意新的申请' };
    }
  }

  const now = Date.now();
  try {
    await db.collection(APPLICATIONS).doc(applicationId).update({
      data: {
        status: status,
        statusUpdateTime: now,
        handledBy: openid // 留痕：谁处理的（便于后台/控制台排查）
      }
    });
  } catch (err) {
    console.error('[application][updateStatus] 更新失败 id=' + applicationId +
      ' code=' + errCodeOf(err) + '：', err);
    return {
      ok: false,
      code: errCodeOf(err) || 'UPDATE_FAILED',
      message: '操作失败，请稍后重试'
    };
  }

  const payload = await buildDecisionPayload(db, app, status);
  console.log('[application][updateStatus] 成功 id=' + applicationId + ' -> ' + status +
    ' 申请人=' + (payload.applicantName || '(空)'));

  return Object.assign({
    ok: true,
    id: applicationId,
    status: status,
    statusUpdateTime: now
  }, payload);
}

/* ---------------- list：我发出的 + 我收到的（联查 posts / users） ---------------- */

function buildSentItem(app, postMap, contactMap) {
  const post = postMap[app.postId] || null;
  const status = String(app.status || STATUS_PENDING);

  return {
    id: app._id,
    postId: String(app.postId || ''),
    postTitle: String((post && post.title) || app.postTitle || ''),
    postStatus: String((post && post.status) || ''),
    // 身份字段照样下发：前端按 applicantId / receiverId 区分「我发出的 / 我收到的」
    applicantId: String(app.applicantId || app._openid || ''),
    receiverId: String(app.receiverId || ''),
    authorName: String((post && post.authorName) || ''),
    authorOpenid: String((post && (post.authorOpenid || post._openid)) || ''),
    applyNote: String(app.applyNote || ''),
    status: status,
    createTime: Number(app.createTime) || 0,
    statusUpdateTime: Number(app.statusUpdateTime) || 0,
    // 只有 accepted 才下发发帖人联系方式（pending / rejected 一律空）
    // 联系方式优先取 post_contacts（客户端读不到），老帖子未迁移时回退 post.contact
    contact: status === STATUS_ACCEPTED && post
      ? String(((contactMap || {})[app.postId]) || post.contact || '')
      : ''
  };
}

function buildReceivedItem(app, postMap, profileMap) {
  const post = postMap[app.postId] || null;
  const status = String(app.status || STATUS_PENDING);
  const applicantOpenid = String(app.applicantId || app._openid || '');
  const profile = profileMap[applicantOpenid] || {};
  const isAccepted = status === STATUS_ACCEPTED;

  return {
    id: app._id,
    postId: String(app.postId || ''),
    postTitle: String((post && post.title) || app.postTitle || ''),
    postStatus: String((post && post.status) || ''),
    applicantId: applicantOpenid,
    receiverId: String(app.receiverId || ''),
    // 展示名 / 简历取「users 最新值」优先，快照兜底：老数据没存快照也能正常显示
    applicantName: String(profile.nickname || app.applicantName || ''),
    applicantResume: String(profile.resume || app.applicantResume || ''),
    applyNote: String(app.applyNote || ''),
    status: status,
    createTime: Number(app.createTime) || 0,
    statusUpdateTime: Number(app.statusUpdateTime) || 0,
    // 联系方式 / 学号：只在 accepted 后给收帖人；值一律现查 users（不依赖文档里的明文快照）
    applicantContact: isAccepted ? String(profile.contact || app.applicantContact || '') : '',
    applicantStudentId: isAccepted ? String(profile.studentId || app.applicantStudentId || '') : ''
  };
}

async function handleList(db, openid) {
  const started = Date.now();

  const batches = await Promise.all([
    queryApplications(db, { applicantId: openid }), // 我发出的（历史文档可能只有 _openid）
    queryApplications(db, { receiverId: openid }),  // 我收到的
    queryApplications(db, { _openid: openid })      // 兜底：老数据没有 applicantId 字段
  ]);

  // 我发出的：三批按 _id 去重（自己给自己申请现在会被拦，这里只是防御历史脏数据）
  const sentDocs = [];
  const sentSeen = {};
  batches[0].concat(batches[2]).forEach(function (doc) {
    if (!doc || !doc._id || sentSeen[doc._id]) return;
    sentSeen[doc._id] = true;
    sentDocs.push(doc);
  });

  // 我收到的：不能和「我发出的」重复计数（同一条既是发出又是收到的脏数据只算发出）
  const receivedDocs = [];
  const receivedSeen = {};
  batches[1].forEach(function (doc) {
    if (!doc || !doc._id || receivedSeen[doc._id] || sentSeen[doc._id]) return;
    receivedSeen[doc._id] = true;
    receivedDocs.push(doc);
  });

  const postMap = await loadPosts(db, sentDocs.concat(receivedDocs).map(function (doc) {
    return doc.postId;
  }));

  const profileMap = await loadProfiles(db, receivedDocs.map(function (doc) {
    return doc.applicantId || doc._openid;
  }));

  // 发帖人联系方式（post_contacts）：只为「我发出的、已同意」的帖子读，别的一律不碰
  const acceptedPostIds = sentDocs
    .filter(function (doc) { return String(doc.status || '') === STATUS_ACCEPTED; })
    .map(function (doc) { return String(doc.postId || ''); });
  const contactMap = await loadContacts(db, acceptedPostIds);

  const sent = sentDocs
    .map(function (doc) { return buildSentItem(doc, postMap, contactMap); })
    .sort(function (a, b) { return b.createTime - a.createTime; });

  const received = receivedDocs
    .map(function (doc) { return buildReceivedItem(doc, postMap, profileMap); })
    .sort(function (a, b) { return b.createTime - a.createTime; });

  console.log('[application][list] openid=' + openid + ' 发出=' + sent.length +
    ' 收到=' + received.length + ' 帖子=' + Object.keys(postMap).length +
    ' 用户=' + Object.keys(profileMap).length + ' 耗时=' + (Date.now() - started) + 'ms');

  return { ok: true, sent: sent, received: received };
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;
  const action = String((event && event.action) || 'list');

  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '拿不到 openid，请从小程序端调用' };
  }

  const db = cloud.database();

  try {
    if (action === 'apply') return await handleApply(db, openid, event);
    if (action === 'updateStatus') return await handleUpdateStatus(db, openid, event);
    if (action === 'list') return await handleList(db, openid);
  } catch (err) {
    // 兜底：任何未预期异常都转成可读错误，绝不把原始异常抛给页面
    console.error('[application] action=' + action + ' 未捕获异常 code=' + errCodeOf(err) + '：', err);
    return {
      ok: false,
      code: errCodeOf(err) || 'INTERNAL_ERROR',
      message: '服务异常，请稍后重试'
    };
  }

  return { ok: false, code: 'UNKNOWN_ACTION', message: '未知 action：' + action };
};

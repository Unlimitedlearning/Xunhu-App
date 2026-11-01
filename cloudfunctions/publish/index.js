// cloudfunctions/publish/index.js
// 作用：发布帖子的唯一写入口 —— 写入数据库前先过「本地严格防御」（可再叠微信机审），通过后直接上线（status = 'active'）。
//
// 风控体系（个人主体拿不到机审权限 48001，所以本地词库才是主防线）：
//   第一层 前端轻量拦截：pages/publish 用同一份词库 + 同一套净化匹配，体验上即时提示
//   第二层 云端绝对防线（这里）：写入前重新拼全文（title + content + tags + contact）再校一遍，
//          客户端改包、直接调云函数都绕不过；文案统一「内容包含违规信息」
//   第三层 微信机审 msgSecCheck（能调就调，失败降级放行，见 SEC_CHECK_FAIL_OPEN）
//   第四层 上线后被举报 -> report 云函数把 status 改回 'auditing'（大厅打码、不可点入）
//
// 净化匹配（两处同实现，改一处必须同步另一处）：小写 + 全角转半角 + 删零宽字符 + 删全部空白标点
//   + 拼音兜底词库，拆字（代 课）/ 插标点（代*考）/ 拼音（dai ke）都会被拦。
//
// 为什么必须放云函数，而不是在 store.savePost 里直接 add：
//   1) openapi 接口只在服务端可用（需要 access_token）；
//   2) status / authorOpenid 由服务端决定，客户端改不了，抓包也伪造不了「机审通过」；
//   3) 昵称取 users 集合里的真实资料，防止冒用他人姓名发帖。
//
// 调用方式（小程序端）：store.savePost(...) 内部已封装
//   { category, title, content, tags, contact }
//   返回 { ok: true, id, status: 'active', authorName, secChecked, suggest }
//   一人一帖命中返回 { ok: false, code: 'ALREADY_HAS_ACTIVE', message, postId }

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const POSTS = 'posts';
const USERS = 'users';

const CATEGORIES = ['team', 'resume', 'partner'];

// 与小程序端 utils/constants.js 保持一致：云函数目录独立打包，拿不到小程序文件，
// 这是「绝对防线」：客户端校验能被改包绕过，真正拦得住的是这里，改一处必须同步另一处。
//
// 词库硬性约定：所有词必须是纯文本（不含空格 / 标点 / 大写），因为匹配前会删掉文本里的空白和标点。

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

// 标点正则：优先用 Unicode 属性类 \p{P}，老运行时（不支持 u 标志）回退到手写全标点字符集
const FALLBACK_PUNCTUATION_REGEX = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。、；：？！…—–～·「」『』【】《》〈〉（）〔〕［］｛｝“”‘’＄％＃＆＊＠＾＿＋－＝｜＼／＜＞※→←↑↓☆★○●◎◇◆□■△▲▽▼§¶©®™°±×÷]/g;

const CLEAN_TEXT_REGEX = (function () {
  try {
    return new RegExp('[\\s\\p{P}]', 'gu');
  } catch (err) {
    return FALLBACK_PUNCTUATION_REGEX;
  }
})();

const STUDENT_ID_REGEX = /^31\d{8}$/;

const MAX_TITLE = 15;
const MAX_CONTENT = 500;
const MAX_TAGS = 4;
const MAX_TAG_LENGTH = 10;
const MAX_CONTACT = 50;

// 机审单次请求的内容上限：全文（标题+描述+标签）拼接后一般不到 500 字，
// 取官方限制内的保守值，过长就截前 2500 字符送审（正文本身有字数限制）
const SEC_CHECK_MAX_CHARS = 2500;

// 微信内容安全返回的「违规」错误码：87014 = 内容含有违法违规内容
const RISKY_ERR_CODES = ['87014'];

// 机审接口本身调用失败（未开通 / 个人主体无权限 48001 / 环境未授权 / 超频）时的策略：
//   true  = 降级放行（本地违禁词 + 事后举报打码兜底）
//   false = 拦截（宁可不发，也不能发不合规内容）
const SEC_CHECK_FAIL_OPEN = true;

const RISKY_MESSAGE = '您发布的内容涉嫌违规，请修改后重试';
// 本地词库命中时的统一文案（前端「轻量拦截」对应，这里是绕不过的绝对防线）
const LOCAL_RISKY_MESSAGE = '内容包含违规信息';
// 一人一帖：与小程序端 constants.ACTIVE_POST_LIMIT_MESSAGE 保持同一份文案
const ACTIVE_LIMIT_MESSAGE = '您已有一条寻呼中的信息，请先结束后再发布新信息。';

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1;
}

/* ---------------- 内容安全机审 ---------------- */

/**
 * 调用微信官方文本内容安全接口
 * 返回 { pass: boolean, suggest: 'pass'|'review'|'risky'|'', checked: boolean, degraded: boolean, label, errCode, message }
 *   pass=false  : 明确判违规 -> 拦截
 *   checked=false / degraded=true : 接口本身不可用（未开通 / 权限不足 48001 / 超频）-> 降级放行，只做本地违禁词兜底
 */
async function secCheck(content, openid) {
  const text = String(content || '').slice(0, SEC_CHECK_MAX_CHARS);
  if (!text) return { pass: true, suggest: 'pass', checked: false, degraded: false, label: 0 };

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: text,
      version: 2,   // v2 返回 suggest 建议值，比 v1 只看 errCode 更准
      scene: 2,     // 1 资料 / 2 评论 / 3 论坛 / 4 社交日志
      openid: openid
    });

    const suggest = (res && res.result && res.result.suggest) || '';
    const label = (res && res.result && res.result.label) || 0;

    // 'pass' 才算通过；'review'（疑似）/ 'risky'（确定违规）一律拦截，
    // 折中方案下没有人工复核队列，宁可让用户改一版
    if (suggest === 'risky' || suggest === 'review') {
      return { pass: false, suggest: suggest, checked: true, degraded: false, label: label };
    }

    return { pass: true, suggest: suggest || 'pass', checked: true, degraded: false, label: label };
  } catch (err) {
    const code = errCodeOf(err);

    // v1 风格的「违规」是按异常抛出来的
    if (RISKY_ERR_CODES.indexOf(code) > -1) {
      return { pass: false, suggest: 'risky', checked: true, degraded: false, label: 0, errCode: code };
    }

    // 接口不可用（未开通内容安全 / 个人主体无权限 48001 / 环境未授权 / 超频）
    console.warn('[publish] msgSecCheck 调用失败 code=' + code + '：', err && err.message);
    if (!SEC_CHECK_FAIL_OPEN) {
      return { pass: false, suggest: 'unknown', checked: false, degraded: true, label: 0, errCode: code };
    }
    return {
      pass: true,
      suggest: '',
      checked: false,
      degraded: true,
      label: 0,
      errCode: code,
      message: String((err && err.message) || '')
    };
  }
}

// 标题 / 正文 / 标签 已拼接为全文，一次性送审（见 buildSecCheckText），不再逐项送审

/* ---------------- 违禁词净化匹配（与小程序端同实现） ---------------- */

/**
 * 净化文本：小写 + 全角转半角 + 删零宽字符 + 删所有空白与标点
 * 例：「代 课」「代*考」「代　课」「dai ke」「ｄａｉｋｅ」净化后都是可被词库命中的密接串
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
 * 严格校验（写入数据库前的最后一道）
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

  // 2. 拼音兜底：dai ke / daikao 这类拼音规避
  const pinyinList = Object.keys(PINYIN_FORBIDDEN_MAP);
  for (let j = 0; j < pinyinList.length; j++) {
    const pinyin = pinyinList[j];
    if (cleaned.indexOf(pinyin) > -1) {
      return { pass: false, word: PINYIN_FORBIDDEN_MAP[pinyin], type: 'pinyin' };
    }
  }

  return { pass: true };
}

/**
 * 机审送审文本：title + ' ' + content + ' ' + tags.join(' ') 拼成一个完整字符串一次性送审
 * 为什么拼一起：拆成多段送审会被「拆字」绕过（标题写「代」、正文写「课」）
 * 为什么不送联系方式：微信号 / 手机号容易被误判成广告，把正常发布也堵了
 */
function buildSecCheckText(title, content, tags) {
  return (title + ' ' + content + ' ' + (tags || []).join(' ')).trim();
}

/* ---------------- 字段规范化 ---------------- */

function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(' ');
  const out = [];
  raw.forEach(function (item) {
    const tag = String(item || '').trim();
    if (!tag) return;
    if (out.length >= MAX_TAGS) return;
    out.push(tag.slice(0, MAX_TAG_LENGTH));
  });
  return out;
}

// 发布人展示名 / 联系方式优先取 users 集合里的真实资料（客户端传什么都不认）
async function loadProfile(db, openid) {
  try {
    const res = await db.collection(USERS).where({ _openid: openid }).limit(1).get();
    return ((res && res.data) || [])[0] || null;
  } catch (err) {
    if (isMissingCollection(err)) return null;
    console.warn('[publish] 读取 users 资料失败，回退到入参：', err && err.message);
    return null;
  }
}

/* ---------------- 主流程 ---------------- */

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;

  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '拿不到 openid，请从小程序端调用' };
  }

  const payload = event || {};
  const category = String(payload.category || '').trim();
  const title = String(payload.title || '').trim();
  const content = String(payload.content || '').trim();
  let contact = String(payload.contact || '').trim();
  const tags = normalizeTags(payload.tags);

  // 1. 基础校验（前端已做，这里再拦一次，防止直接调云函数绕过）
  if (CATEGORIES.indexOf(category) === -1) {
    return { ok: false, code: 'CATEGORY_INVALID', message: '请选择正确的分类' };
  }
  if (!title || !content) {
    return { ok: false, code: 'CONTENT_EMPTY', message: '标题与描述不能为空' };
  }
  if (title.length > MAX_TITLE) {
    return { ok: false, code: 'TITLE_TOO_LONG', message: '标题最多 ' + MAX_TITLE + ' 个字' };
  }
  if (content.length > MAX_CONTENT) {
    return { ok: false, code: 'CONTENT_TOO_LONG', message: '描述最多 ' + MAX_CONTENT + ' 个字' };
  }
  if (contact.length > MAX_CONTACT) {
    return { ok: false, code: 'CONTACT_TOO_LONG', message: '联系方式过长' };
  }

  const db = cloud.database();

  // 2. 身份：必须已完善资料（昵称 + 学号 + 联系方式都在 users 里）
  const profile = await loadProfile(db, openid);
  if (!profile || !String(profile.nickname || '').trim()) {
    return { ok: false, code: 'PROFILE_NOT_READY', message: '请先在「我的」页面完善资料后再发布' };
  }
  if (!STUDENT_ID_REGEX.test(String(profile.studentId || '').trim())) {
    return { ok: false, code: 'PROFILE_NOT_READY', message: '请先在「我的」页面绑定广工 10 位学号后再发布' };
  }

  const authorName = String(profile.nickname).trim();
  if (!contact) contact = String(profile.contact || '').trim();
  if (!contact) {
    return { ok: false, code: 'PROFILE_NOT_READY', message: '请先在「我的」页面填写联系方式后再发布' };
  }

  // 3. 一人一帖：同一用户同时只允许一条 active（寻呼中）的帖子
  //    前端在「大厅 + 号」和「发布按钮」上已拦过一道，但客户端能改包绕过，这里才是绝对防线
  try {
    const dedupe = await db.collection(POSTS)
      .where({ authorOpenid: openid, status: 'active' })
      .limit(1)
      .get();
    const existed = (dedupe && dedupe.data) || [];
    if (existed.length) {
      console.log('[publish] 一人一帖拦截，已有 active 帖子：', existed[0]._id);
      return {
        ok: false,
        code: 'ALREADY_HAS_ACTIVE',
        message: ACTIVE_LIMIT_MESSAGE,
        postId: existed[0]._id || ''
      };
    }
  } catch (err) {
    if (isMissingCollection(err)) {
      // posts 集合还不存在，那肯定没有 active 帖子，放行（写入时会自动建集合）
      console.warn('[publish] posts 集合不存在，跳过一人一帖查重');
    } else {
      // 查重失败时不放行：宁可让用户重试一次，也不能破「一人一帖」这条业务红线
      return {
        ok: false,
        code: errCodeOf(err) || 'DEDUPE_FAILED',
        message: '发布前校验失败，请稍后重试'
      };
    }
  }

  // 4. 本地违禁词（绝对防线）：标题 + 描述 + 标签 + 联系方式 合并成全文，做「净化匹配」
  //    净化 = 小写 + 删空白 + 删全部标点 + 删零宽字符 + 拼音兜底，拆字/插标点/换拼音都躲不过
  //    联系方式也参与本地匹配（与前端一致），但不送 msgSecCheck（微信号/手机号易被误判成广告）
  const localText = [title, content, tags.join(' '), contact].join(' ');
  const violation = checkTextViolation(localText);
  if (!violation.pass) {
    console.log('[publish] 本地违禁词命中：', violation.word, '(' + violation.type + ')');
    return {
      ok: false,
      code: 'CONTENT_RISKY',
      message: LOCAL_RISKY_MESSAGE,
      hitWord: violation.word,
      hitType: violation.type,
      field: 'fullText'
    };
  }

  // 5. 微信官方机审：标题 + 描述 + 标签 拼接成一个完整字符串，一次性送审
  //    （不送联系方式：微信号/手机号容易被误判成广告而阻断发布）
  const secCheckText = buildSecCheckText(title, content, tags);
  const secCheckResult = await secCheck(secCheckText, openid);

  // 排障日志：区分「权限不足降级（degraded=true + errCode=48001）」和「真被微信判 risky 拦截」
  console.log('[publish] 机审结果：', secCheckResult);

  if (!secCheckResult.pass) {
    return {
      ok: false,
      code: 'CONTENT_RISKY',
      message: RISKY_MESSAGE,
      field: 'fullText',
      suggest: secCheckResult.suggest,
      errCode: secCheckResult.errCode
    };
  }

  // 6. 全部校验通过 -> 直接上线
  const now = Date.now();
  const doc = {
    // 显式写 _openid：posts 权限是「仅创建者可读写」，靠它认主（服务端写入，客户端伪造不了）
    _openid: openid,
    category: category,
    title: title,
    content: content,
    tags: tags,
    authorOpenid: openid,
    authorName: authorName,
    contact: contact,
    status: 'active', // 机审通过即上线（寻呼中）
    heat: 0,
    createTime: now,
    // 留痕：机审结论，事后被举报时方便判断是「漏审」还是「改了内容」
    secCheck: {
      suggest: secCheckResult.suggest || '',
      checked: !!secCheckResult.checked,
      degraded: !!secCheckResult.degraded,
      errCode: secCheckResult.errCode || '',
      checkTime: now
    }
  };

  try {
    const res = await db.collection(POSTS).add({ data: doc });
    return {
      ok: true,
      id: res._id,
      status: doc.status,
      authorName: authorName,
      contact: contact,
      secChecked: !!secCheckResult.checked,
      suggest: doc.secCheck.suggest
    };
  } catch (err) {
    const code = errCodeOf(err);

    if (isMissingCollection(err)) {
      // 集合不存在时顺手建一次（首次部署即可用）
      try {
        await db.createCollection(POSTS);
        const retry = await db.collection(POSTS).add({ data: doc });
        return { ok: true, id: retry._id, status: doc.status, authorName: authorName, contact: contact, secChecked: !!secCheckResult.checked };
      } catch (retryErr) {
        return {
          ok: false,
          code: errCodeOf(retryErr),
          message: String((retryErr && retryErr.message) || '写入失败，请确认 posts 集合已创建')
        };
      }
    }

    return {
      ok: false,
      code: code,
      message: String((err && err.message) || '写入数据库失败')
    };
  }
};

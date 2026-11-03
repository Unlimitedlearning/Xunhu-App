// cloudfunctions/post/index.js
// 作用：帖子「状态写入」的唯一入口（v1.3.0 / P0-4 + P0-2）
//
// 为什么必须有这个云函数：
//   以前 endPost 是客户端直接 doc(id).update({ status: 'ended' })，依据只是 posts 的
//   「仅创建者可读写」规则。安全规则只判断「这条是不是你创建的」，不限制「你能改哪些字段」，
//   于是发帖人（改包 / 开发者工具 / 控制台脚本）可以对自己这条文档写：
//     status: 'auditing' -> 'active'（撤销举报审查，重新上大厅）
//     title / content（绕过词库与机审已通过的结论）
//     heat（刷最热榜）、authorOpenid（冒用他人身份）
//   也就是说：风控在「作者本人」这个最需要约束的角色上完全失效。
//   现在 posts 对客户端零读写（控制台把 posts 权限收成「所有用户不可读写」），
//   读取走本函数的 list / get，状态变更走 end，服务端校验 authorOpenid === 当前 openid，
//   并且只写 status / endTime。
//
// 同时收口联系方式（P0-2）：contact 已从 posts 迁到 post_contacts（客户端「所有用户不可读写」），
//   只有本函数按关系下发 —— 作者本人，或该帖子上有 accepted 申请的人。
//
// action 一览：
//   { action: 'list', limit }            大厅列表（客户端对 posts 零权限，只能由这里下发）
//                                         -> { ok: true, list: [...] }（白名单字段）
//   { action: 'get', postId }             单条帖子（分享直达 / 缓存没命中）-> { ok: true, post }
//   { action: 'end', postId }            结束自己的帖子（仅 active）-> { ok: true, status: 'ended', endTime }
//                                        审查中 -> { ok: false, code: 'POST_AUDITING' }
//   { action: 'delete', postId }         删除自己的帖子（仅 active，连带 post_contacts）-> { ok: true }
//                                        审查中 -> { ok: false, code: 'POST_AUDITING' }
//   { action: 'contact', postId }        取联系方式（作者 / 已同意申请人）-> { ok: true, contact }
//   { action: 'migrateContacts' }        【一次性迁移】把历史 posts.contact 搬到 post_contacts
//                                        （只能从云开发控制台调用，或 role === 'admin' 的账号）
//
// 调用方：小程序端 store.endPost() / store.fetchPostContact()（页面不直接 callFunction）
//
// 【v1.7.2 安全修复】end / delete 增加状态闸门（此前只校验作者身份，没校验帖子状态）：
//   漏洞路径：作者发违规内容 -> 被举报/机审进入 auditing -> 立刻自己「结束」或「删除」。
//   end 会把帖子打进「往期历史」照常可读（绕过审核队列），delete 更是直接把被举报的内容销毁
//   （后台审核卡片点开就是「信息不存在」，证据全丢）。
//   现在：status === 'auditing' 一律直接拦截，不写任何字段；只有 active 才允许作者改状态。
//   放行 / 下架的唯一决定权在 cloudfunctions/admin 的 approve / reject（role === 'admin' 校验）。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const POSTS = 'posts';
const POST_CONTACTS = 'post_contacts';
const APPLICATIONS = 'applications';
const USERS = 'users';

// 迁移时的单次批大小（服务端 SDK 上限 1000，内测量级取 100 足够）
const MIGRATE_BATCH = 100;

function errCodeOf(err) {
  return String((err && (err.errCode || err.code)) || '');
}

function isMissingCollection(err) {
  const code = errCodeOf(err);
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1;
}

// 集合不存在时按需创建（安全规则仍需控制台设置：post_contacts 必须「所有用户不可读写」）
async function ensureCollection(db, name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    // 已存在属正常情况
  }
}

// 单条帖子（不存在 / 参数非法一律返回 null，不抛错）
async function getPost(db, postId) {
  if (!postId) return null;
  try {
    const res = await db.collection(POSTS).doc(String(postId)).get();
    return (res && res.data) || null;
  } catch (err) {
    return null;
  }
}

// 帖子的作者 openid（兼容历史两种写法）
function authorOf(post) {
  return String((post && (post.authorOpenid || post._openid)) || '');
}

// 读联系方式：优先 post_contacts，读不到再兜底历史 posts.contact（迁移前的老帖子）
async function readContact(db, post) {
  const postId = String((post && post._id) || '');
  if (!postId) return '';
  try {
    const res = await db.collection(POST_CONTACTS).doc(postId).get();
    const doc = (res && res.data) || null;
    if (doc && doc.contact) return String(doc.contact);
  } catch (err) {
    // 集合不存在 / 尚未迁移：走下面的兜底
  }
  return String((post && post.contact) || '');
}

// 这个人在该帖子下有没有被同意过的申请（同意后才允许看联系方式）
async function hasAcceptedApplication(db, postId, openid) {
  const conditions = [
    { postId: postId, applicantId: openid, status: 'accepted' },
    { postId: postId, _openid: openid, status: 'accepted' }
  ];
  for (let i = 0; i < conditions.length; i++) {
    try {
      const res = await db.collection(APPLICATIONS).where(conditions[i]).limit(1).get();
      if (((res && res.data) || []).length) return true;
    } catch (err) {
      if (isMissingCollection(err)) return false;
      console.warn('[post] 查申请关系失败：', err && err.message);
    }
  }
  return false;
}

/* ---------------- action: list / get（客户端对 posts 零权限，列表只能由这里下发） ----------------
 * posts 权限收成「所有用户不可读写」之后，大厅与详情页的读取全部收拢到这里。
 * 为什么用白名单而不是原样返回整条文档：
 *   以前客户端一次 get 能把整条文档捞走 —— 历史遗留的 contact（迁移前的老帖子）
 *   以及风控字段（reportWeight / secCheck / auditReason）全都跟着下发。
 *   现在只给页面渲染真正需要的字段，以后再往文档里加什么私密字段也不会自动泄露。 */

const CLIENT_POST_FIELDS = [
  'category', 'title', 'content', 'tags', 'status', 'heat',
  'createTime', 'endTime', 'authorOpenid', 'authorName'
];

const LIST_LIMIT_DEFAULT = 20; // 与小程序端 constants.POSTS_FETCH_LIMIT 同值
const LIST_LIMIT_MAX = 100;    // 服务端单次上限（内测降本：不让一次调用拖回 1000 条）

function toClientPost(doc) {
  const raw = doc || {};
  const post = { _id: String(raw._id || '') };
  for (let i = 0; i < CLIENT_POST_FIELDS.length; i++) {
    const key = CLIENT_POST_FIELDS[i];
    if (raw[key] !== undefined) post[key] = raw[key];
  }
  // 老文档可能只写了 _openid 没写 authorOpenid：补上，否则详情页判不出「是不是我发的」
  if (!post.authorOpenid && raw._openid) post.authorOpenid = String(raw._openid);
  return post;
}

// 列表：按 createTime 倒序取最新 N 条（状态过滤交给前端 Tab，减少一次查询维度）
async function handleList(db, event) {
  const input = Number(event && event.limit);
  const limit = Math.min(Math.max(input || LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);

  let rows = [];
  try {
    const res = await db.collection(POSTS).orderBy('createTime', 'desc').limit(limit).get();
    rows = (res && res.data) || [];
  } catch (err) {
    if (isMissingCollection(err)) return { ok: true, list: [] };
    console.error('[post][list] 查询失败 code=' + errCodeOf(err) + '：', err && err.message);
    return { ok: false, code: errCodeOf(err) || 'LIST_FAILED', message: '加载失败，请稍后重试' };
  }

  return { ok: true, list: rows.map(toClientPost) };
}

// 单条：分享直达 / 缓存里没有时按 _id 直取（不受分页与排序影响）
async function handleGet(db, event) {
  const postId = String((event && event.postId) || '').trim();
  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子信息，请返回大厅重试' };
  }

  const post = await getPost(db, postId);
  // 不存在不当错误：详情页展示「信息不存在」即可，不要用一个失败弹窗拦住用户
  return { ok: true, post: post ? toClientPost(post) : null };}

/* ---------------- action: end ---------------- */

async function handleEnd(db, openid, event) {
  const postId = String((event && event.postId) || '').trim();
  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子信息，请返回大厅重试' };
  }

  const post = await getPost(db, postId);
  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '这条信息不存在或已被删除' };
  }

  const author = authorOf(post);
  if (!author || author !== openid) {
    console.warn('[post][end] 越权拦截：author=' + (author || '(空)') + ' openid=' + openid + ' postId=' + postId);
    return { ok: false, code: 'NOT_AUTHOR', message: '只能操作自己发布的信息' };
  }

  const status = String(post.status || '');
  // 幂等：已经结束过就直接返回原来的时间（连点 / 双设备）
  if (status === 'ended') {
    return { ok: true, status: 'ended', endTime: Number(post.endTime) || Date.now(), already: true };
  }
  // 【v1.7.2】审查中的帖子绝对拦截（先判状态，再判完才写库）：
  //   结束后的帖子会进「往期历史」照常可读，等于让被举报的内容绕过审核队列；
  //   所以只要 status === 'auditing'，作者改不了任何状态，只能等管理员通过 / 下架。
  if (status === 'auditing') {
    console.warn('[post][end] 审核中拦截 postId=' + postId + ' openid=' + openid);
    return { ok: false, code: 'POST_AUDITING', message: '该信息正在审核中，无法自行操作' };
  }
  // 只有 active（进行中）才允许结束：draft / deleted / 未知状态一律不放行
  if (status !== 'active') {
    console.warn('[post][end] 状态不可操作拦截 status=' + (status || '(空)') + ' postId=' + postId + ' openid=' + openid);
    return { ok: false, code: 'POST_NOT_ACTIVE', message: '该信息当前不可操作，请刷新后重试' };
  }

  const now = Date.now();
  try {
    // 只写这两个字段：即使有人伪造请求，也改不了 title / content / heat / authorOpenid
    await db.collection(POSTS).doc(postId).update({
      data: { status: 'ended', endTime: now }
    });
  } catch (err) {
    console.error('[post][end] 更新失败 postId=' + postId + ' code=' + errCodeOf(err) + '：', err);
    return { ok: false, code: errCodeOf(err) || 'END_FAILED', message: '操作失败，请稍后重试' };
  }

  console.log('[post][end] 成功 postId=' + postId + ' openid=' + openid);
  return { ok: true, status: 'ended', endTime: now };
}

/* ---------------- action: delete ---------------- */

async function handleDelete(db, openid, event) {
  const postId = String((event && event.postId) || '').trim();
  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子信息，请返回大厅重试' };
  }

  const post = await getPost(db, postId);
  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '这条信息不存在或已被删除' };
  }

  const author = authorOf(post);
  if (!author || author !== openid) {
    console.warn('[post][delete] 越权拦截：author=' + (author || '(空)') + ' openid=' + openid);
    return { ok: false, code: 'NOT_AUTHOR', message: '只能操作自己发布的信息' };
  }

  // 【v1.7.2】与 end 同一道闸，而且是更关键的一道：
  //   删除会连帖子带 post_contacts 一起销毁，被举报的内容一旦删掉，后台审核卡片就只剩「信息不存在」，
  //   举报证据和 warningCount 依据全丢。所以审查中一律拒绝，任何字段都不写。
  const status = String(post.status || '');
  if (status === 'auditing') {
    console.warn('[post][delete] 审核中拦截 postId=' + postId + ' openid=' + openid);
    return { ok: false, code: 'POST_AUDITING', message: '该信息正在审核中，无法自行操作' };
  }
  // 只有 active（进行中）才允许删除：draft / ended / deleted / 未知状态一律不放行
  if (status !== 'active') {
    console.warn('[post][delete] 状态不可删除拦截 status=' + (status || '(空)') + ' postId=' + postId + ' openid=' + openid);
    return { ok: false, code: 'POST_NOT_ACTIVE', message: '该信息当前不可删除，请刷新后重试' };
  }

  try {
    await db.collection(POSTS).doc(postId).remove();
  } catch (err) {
    console.error('[post][delete] 删除失败 postId=' + postId + ' code=' + errCodeOf(err) + '：', err);
    return { ok: false, code: errCodeOf(err) || 'DELETE_FAILED', message: '操作失败，请稍后重试' };
  }

  // 联系方式是「附属数据」，删帖子时一起清掉（失败不影响主流程）
  try {
    await db.collection(POST_CONTACTS).doc(postId).remove();
  } catch (err) {
    console.warn('[post][delete] 联系方式清理失败（不影响结果）：', err && err.message);
  }

  console.log('[post][delete] 成功 postId=' + postId + ' openid=' + openid);
  return { ok: true };
}

/* ---------------- action: contact ---------------- */

async function handleContact(db, openid, event) {
  const postId = String((event && event.postId) || '').trim();
  if (!postId) {
    return { ok: false, code: 'POST_ID_REQUIRED', message: '缺少帖子信息，请返回大厅重试' };
  }

  const post = await getPost(db, postId);
  if (!post) {
    return { ok: false, code: 'POST_NOT_FOUND', message: '这条信息不存在或已被删除' };
  }

  const author = authorOf(post);
  // 1) 作者本人：看自己填的联系方式
  if (author && author === openid) {
    return { ok: true, contact: await readContact(db, post) };
  }

  // 2) 被同意过的申请人：看到发帖人的联系方式
  if (await hasAcceptedApplication(db, postId, openid)) {
    return { ok: true, contact: await readContact(db, post) };
  }

  // 3) 其它人：一律空串（不是错误，页面按「无联系方式」渲染即可）
  return { ok: true, contact: '' };
}

/* ---------------- action: migrateContacts（一次性迁移） ---------------- */

// 调用者必须可信：控制台直接测试（拿不到 OPENID）或 role === 'admin'
async function isTrustedCaller(db, openid) {
  if (!openid) return true; // 云开发控制台「测试」调用，OPENID 为空
  try {
    const res = await db.collection(USERS).where({ _openid: openid }).limit(1).get();
    const doc = ((res && res.data) || [])[0];
    return String((doc && doc.role) || 'user').toLowerCase() === 'admin';
  } catch (err) {
    return false;
  }
}

async function handleMigrateContacts(db, openid) {
  if (!(await isTrustedCaller(db, openid))) {
    return { ok: false, code: 'FORBIDDEN', message: '没有权限执行数据迁移' };
  }

  const _ = db.command;
  await ensureCollection(db, POST_CONTACTS);

  let scanned = 0;
  let migrated = 0;
  let failed = 0;

  // 注意：不能靠 skip 翻页 —— 每轮都会把 contact 从文档上删掉，
  // 结果集本身在缩小，skip 会跳过还没处理的数据。
  // 正确做法：每轮都从 filter 头拉一批，处理过的自然会从 filter 里消失。
  for (let round = 0; round < 100; round++) {
    let rows = [];
    let clearedThisRound = 0;
    try {
      const res = await db.collection(POSTS)
        .where({ contact: _.exists(true) })
        .limit(MIGRATE_BATCH)
        .get();
      rows = (res && res.data) || [];
    } catch (err) {
      console.error('[post][migrate] 读取 posts 失败：', err && err.message);
      break;
    }
    if (!rows.length) break;
    scanned += rows.length;

    for (let i = 0; i < rows.length; i++) {
      const post = rows[i];
      const postId = String(post._id || '');
      const contact = String(post.contact || '').trim();
      if (!postId) continue;

      if (contact) {
        try {
          await db.collection(POST_CONTACTS).doc(postId).set({
            data: {
              _openid: authorOf(post),
              postId: postId,
              authorOpenid: authorOf(post),
              contact: contact,
              createTime: Number(post.createTime) || Date.now()
            }
          });
          migrated += 1;
        } catch (err) {
          failed += 1;
          console.error('[post][migrate] 写入 post_contacts 失败 postId=' + postId + '：', err && err.message);
          continue; // 没搬成功就先不删原字段，避免联系方式彻底丢失
        }
      }

      // 搬完（或本来就是空串）再把字段从 posts 里删掉，客户端直读 posts 就再也拿不到联系方式
      try {
        await db.collection(POSTS).doc(postId).update({ data: { contact: _.remove() } });
        clearedThisRound += 1;
      } catch (err) {
        failed += 1;
        console.warn('[post][migrate] 清理 posts.contact 失败 postId=' + postId + '：', err && err.message);
      }
    }

    // 一轮下来一个都没清掉：说明剩下的都卡住了，再循环也是白烧次数，直接收工
    if (!clearedThisRound) break;
    if (rows.length < MIGRATE_BATCH) break;
  }

  console.log('[post][migrate] 扫描=' + scanned + ' 迁移=' + migrated + ' 失败=' + failed);
  return { ok: true, scanned: scanned, migrated: migrated, failed: failed };
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID || '';
  const action = String((event && event.action) || '');

  const db = cloud.database();

  try {
    // 迁移是运维动作，允许控制台调用（无 OPENID），但内部还会再校验一次身份
    if (action === 'migrateContacts') return await handleMigrateContacts(db, openid);

    if (!openid) {
      return { ok: false, code: 'NO_OPENID', message: '拿不到 openid，请从小程序端调用' };
    }

    if (action === 'end') return await handleEnd(db, openid, event);
    if (action === 'delete') return await handleDelete(db, openid, event);
    if (action === 'contact') return await handleContact(db, openid, event);
    // 读取（posts 对客户端零权限，只能从这里走）
    if (action === 'list') return await handleList(db, event);
    if (action === 'get') return await handleGet(db, event);
  } catch (err) {
    console.error('[post] action=' + action + ' 未捕获异常 code=' + errCodeOf(err) + '：', err);
    return { ok: false, code: errCodeOf(err) || 'INTERNAL_ERROR', message: '服务异常，请稍后重试' };
  }

  return { ok: false, code: 'UNKNOWN_ACTION', message: '未知 action：' + (action || '(空)') };
};

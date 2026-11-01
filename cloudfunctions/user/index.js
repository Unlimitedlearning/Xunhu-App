// cloudfunctions/user/index.js
// 作用：用户资料（昵称 / 学号 / 简历 / 联系方式）的读写，全部落在云端 users 集合。
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

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTION = 'users';

// 学号校验：广工 10 位，以 31 开头
// 与小程序端 utils/constants.js 的 STUDENT_ID_REGEX 保持一致（云函数目录独立，无法 require 小程序文件）
const STUDENT_ID_REGEX = /^31\d{8}$/;

// 文档归属的 openid（新文档有 _openid，旧文档只有 openid 字段）
function ownerOf(doc) {
  return (doc && (doc._openid || doc.openid)) || '';
}

function normalize(input) {
  const source = input || {};
  return {
    nickname: String(source.nickname || '').trim(),
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
      const fallback = Object.assign({}, payload, { openid: openid, createTime: Date.now() });
      const retry = await db.collection(COLLECTION).add({ data: fallback });
      return { id: retry._id, data: Object.assign({ _id: retry._id }, fallback) };
    }
    res = await db.collection(COLLECTION).add({ data: doc });
  }

  return { id: res._id, data: Object.assign({ _id: res._id }, doc) };
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
      return { ok: true, data: docs[0] || null };
    } catch (err) {
      return {
        ok: false,
        code: (err && (err.errCode || err.code)) || '',
        message: String((err && err.message) || '')
      };
    }
  }

  if (action === 'save') {
    const data = normalize(event && event.profile);
    if (!data.nickname) {
      return { ok: false, code: 'NICKNAME_REQUIRED', message: '昵称不能为空' };
    }
    if (data.nickname.length > 20) {
      return { ok: false, code: 'NICKNAME_TOO_LONG', message: '昵称最多 20 个字' };
    }
    if (data.resume.length > 300) {
      return { ok: false, code: 'RESUME_TOO_LONG', message: '简历最多 300 个字' };
    }

    const payload = Object.assign({}, data, { updateTime: Date.now() });

    // 学号：必填 + 格式门禁（前端已校验，这里再校验一次，防止直接调接口绕过）
    if (!STUDENT_ID_REGEX.test(data.studentId)) {
      return {
        ok: false,
        code: 'STUDENT_ID_INVALID',
        message: '学号格式不合法，拒绝保存（请输入广工 10 位学号，以 31 开头）'
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

    try {
      const docs = await findAll(db, openid);

      // 已有资料 -> 只 update，绝不 add
      if (docs.length) {
        const primary = docs[0];

        // 【学号锁】已「合法绑定」过学号时，忽略本次请求传入的 studentId，强制用库里的旧值。
        // 前端 disabled 只是体验，这里才是真正的锁：抓包改包也改不掉。
        // 注：旧值不合法（早期选填时随手填的脏数据）时不锁，否则用户将永远无法修正。
        const boundStudentId = String(primary.studentId || '').trim();
        const studentIdLocked = STUDENT_ID_REGEX.test(boundStudentId);
        if (studentIdLocked && payload.studentId !== boundStudentId) {
          console.warn('[user] 学号已绑定，忽略请求中的新学号：', openid, '->', boundStudentId);
          payload.studentId = boundStudentId;
        }

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

  // 对外公开信息已下线：详情页不再展示学号徽章，因此不保留任何「跨用户读别人资料」的接口
  // （少一个接口，少一个被枚举的攻击面；要恢复请在服务端加 accepted 关系校验）
  return { ok: false, code: 'UNKNOWN_ACTION', message: '未知 action：' + action };
};
